const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { CLAUDE_BIN, CLAUDE_TIMEOUT_MS, ALLOWED_TOOLS, DISALLOWED_TOOLS, ADMIN_USER_HOME } = require('./config');
const log = require('./logger');

// systemd's inherited PATH usually omits ~/.local/bin, where `claude` itself
// lives. Without this, Bash tool calls like `claude --version` fail with
// "command not found" inside the agent.
const CLAUDE_BIN_DIR = path.dirname(CLAUDE_BIN);
const ADMIN_ENV = {
	...process.env,
	PATH: `${CLAUDE_BIN_DIR}:${process.env.PATH || ''}`,
};

/**
 * Build Claude CLI arguments from options.
 * Extra args (e.g. --dangerously-skip-permissions) can be prepended via extraArgs.
 *
 * Session attach strategy:
 *   - sessionId + !sessionStarted -> `--session-id <uuid>` (creates the session).
 *   - sessionId +  sessionStarted -> `--resume <uuid>`     (reuses the existing session;
 *                                                          --session-id would error with
 *                                                          "Session ID X is already in use").
 *   - !sessionId                  -> no flag (scheduled jobs run in a fresh session).
 */
function buildClaudeArgs(prompt, options = {}) {
	const {
		sessionId = null,
		sessionStarted = false,
		systemPrompt = null,
		allowedTools = ALLOWED_TOOLS,
		disallowedTools = DISALLOWED_TOOLS,
		model = null,
		effort = null,
		outputFormat = 'json',
		extraArgs = [],
	} = options;

	const args = ['-p', ...extraArgs];

	if (sessionId) {
		args.push(sessionStarted ? '--resume' : '--session-id', sessionId);
	}
	if (systemPrompt) {
		args.push('--system-prompt', systemPrompt);
	}

	args.push('--output-format', outputFormat);
	if (outputFormat === 'stream-json') args.push('--verbose');
	args.push('--allowedTools', allowedTools);
	args.push('--disallowedTools', disallowedTools);
	if (model) args.push('--model', model);
	if (effort) args.push('--effort', effort);
	args.push('--', prompt);

	return args;
}

/**
 * Spawn a command with timeout, stdout/stderr collection, and SIGTERM→SIGKILL.
 * Returns { stdout, stderr, code }. Waits for the process to exit naturally —
 * if Claude launches a background task (e.g. forced by the harness when a
 * `sleep` is too long), we wait for it to complete rather than killing early.
 * The trade-off is that truly interactive commands (`gws auth login`, ssh to
 * an unknown host, `apt install` without `-y`) will hang until CLAUDE_TIMEOUT_MS.
 */
function spawnWithTimeout(cmd, args, options = {}) {
	const {
		timeoutMs = CLAUDE_TIMEOUT_MS,
		cwd,
		env,
		label = 'process',
	} = options;

	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		child.stdin.end();

		let stdout = '';
		let stderr = '';

		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });

		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			log.warn(`${label} timeout after ${timeoutMs}ms, sending SIGTERM`);
			child.kill('SIGTERM');
			setTimeout(() => {
				try { child.kill('SIGKILL'); } catch (_) {}
			}, 5000);
		}, timeoutMs);

		child.on('close', (code) => {
			clearTimeout(timer);
			if (killed) {
				reject(Object.assign(new Error('timeout'), { code: 124 }));
				return;
			}
			if (stderr) log.warn(`${label} stderr:`, stderr.slice(0, 500));
			resolve({ stdout, stderr, code });
		});

		child.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Extract assistant text blocks from the most recent turn of a session JSONL.
 * "Most recent turn" = every assistant entry after the last real user prompt
 * (tool_result entries are also typed `user` and must be skipped). Used as
 * fallback when the CLI result field is empty (happens when the last
 * assistant turn ends on a tool_use instead of end_turn).
 */
function extractLastTextFromSessionLog(sessionId, claudeHome) {
	if (!sessionId || !claudeHome) return '';
	try {
		const projectsDir = path.join(claudeHome, '.claude', 'projects');
		if (!fs.existsSync(projectsDir)) return '';

		let jsonlPath = null;
		for (const dir of fs.readdirSync(projectsDir)) {
			const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
			if (fs.existsSync(candidate)) { jsonlPath = candidate; break; }
		}
		if (!jsonlPath) return '';

		const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n');
		const entries = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try { entries.push(JSON.parse(line)); } catch {}
		}

		// Walk backwards to the last real user prompt, then collect every text
		// block from every assistant entry that follows.
		let startIdx = 0;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type !== 'user') continue;
			const content = e.message?.content;
			const isToolResult = Array.isArray(content)
				&& content.some(b => b && b.type === 'tool_result');
			if (!isToolResult) { startIdx = i + 1; break; }
		}

		const texts = [];
		for (let i = startIdx; i < entries.length; i++) {
			const e = entries[i];
			if (e.type !== 'assistant') continue;
			const content = e.message?.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (block.type === 'text' && block.text) texts.push(block.text);
			}
		}
		return texts.join('\n\n');
	} catch (err) {
		log.warn(`Failed to read session log for ${sessionId}:`, err.message);
		return '';
	}
}

/**
 * Collect the user-visible text from a stream-json stdout.
 *
 * The `result` event only carries the final text block, so a naive read
 * loses intermediate text when the conversation interleaves text with
 * tool_use. But collecting *every* assistant text block goes too far the
 * other way: it pulls in the preamble Claude often narrates before tool
 * calls ("I'll check the logs…", "Let me look at this…"), frequently in
 * English even when the final answer is in the user's language, which
 * looks like leaked thinking on the Discord side.
 *
 * Heuristic: only text blocks emitted *after* the last `tool_result` are
 * part of the final answer. Anything before is interstitial narration and
 * is dropped. If no tool_result exists in the stream (no tools were used),
 * we collect everything — the only assistant text IS the answer.
 *
 * Edge case: if the last assistant turn ends on `tool_use` (no closing
 * text), there is no text after the last tool_result and this returns ''.
 * The caller falls back to `resultEvent.result` in that case.
 */
function collectStreamJsonText(stdout) {
	const events = [];
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try { events.push(JSON.parse(trimmed)); } catch {}
	}

	let startIdx = 0;
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.type !== 'user') continue;
		const content = e.message?.content;
		const isToolResult = Array.isArray(content)
			&& content.some(b => b && b.type === 'tool_result');
		if (isToolResult) { startIdx = i + 1; break; }
	}

	const texts = [];
	for (let i = startIdx; i < events.length; i++) {
		const e = events[i];
		if (e.type !== 'assistant') continue;
		const content = e.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block.type === 'text' && block.text) texts.push(block.text);
		}
	}
	return texts.join('\n\n');
}

/**
 * Parse Claude CLI output (JSON, stream-json, or text).
 * claudeHome + sessionId are used by the JSONL fallback when the CLI's
 * `result` field is empty (last assistant turn ended on tool_use).
 */
function parseClaudeOutput(stdout, outputFormat, label = 'Claude', claudeHome = null, sessionId = null) {
	if (outputFormat === 'stream-json') {
		let resultEvent = null;
		const lines = stdout.split('\n');
		for (let i = lines.length - 1; i >= 0; i--) {
			const trimmed = lines[i].trim();
			if (!trimmed) continue;
			try {
				const event = JSON.parse(trimmed);
				if (event.type === 'result') { resultEvent = event; break; }
			} catch (_) {}
		}
		if (!resultEvent) {
			log.warn(`${label}: no result event in stream-json output`);
			return { result: stdout.slice(-500) };
		}
		const allText = collectStreamJsonText(stdout);
		return { result: allText || resultEvent.result || '' };
	}

	if (outputFormat === 'json') {
		try {
			const parsed = JSON.parse(stdout);
			let result = parsed.result || '';

			if (!result && sessionId) {
				result = extractLastTextFromSessionLog(sessionId, claudeHome);
				if (result) log.info(`${label}: recovered text from session log (result was empty)`);
			}

			return { result };
		} catch (err) {
			log.error(`Failed to parse ${label} JSON output:`, stdout.slice(0, 200));
			return { result: stdout };
		}
	}
	return { result: stdout };
}

async function executeClaudeCommand(prompt, options = {}) {
	const {
		sessionId = null,
		sessionStarted = false,
		systemPrompt = null,
		allowedTools = ALLOWED_TOOLS,
		disallowedTools = DISALLOWED_TOOLS,
		model = null,
		effort = null,
		outputFormat = 'json',
		timeoutMs = CLAUDE_TIMEOUT_MS,
	} = options;

	if (!systemPrompt) {
		throw new Error('executeClaudeCommand requires systemPrompt');
	}

	const spawnOpts = { sessionId, sessionStarted, systemPrompt, allowedTools, disallowedTools, model, effort, outputFormat };

	const attach = sessionId
		? (sessionStarted ? `resume ${sessionId}` : `new ${sessionId}`)
		: 'no session';
	log.info(`Spawning claude: ${attach}, prompt length: ${prompt.length}, format: ${outputFormat}`);

	const result = await spawnWithTimeout(
		CLAUDE_BIN,
		buildClaudeArgs(prompt, spawnOpts),
		{ timeoutMs, cwd: ADMIN_USER_HOME, env: ADMIN_ENV, label: 'Claude' },
	);

	if (result.code !== 0) {
		const errMsg = result.stdout.slice(-500) || `exit code ${result.code}`;
		throw Object.assign(new Error(errMsg), { code: result.code });
	}

	return parseClaudeOutput(result.stdout, outputFormat, 'Claude', ADMIN_USER_HOME, sessionId);
}

module.exports = { ADMIN_ENV, buildClaudeArgs, spawnWithTimeout, parseClaudeOutput, executeClaudeCommand };
