const { spawn } = require('child_process');
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
		outputFormat = 'text',
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
 * Heuristic: only text blocks emitted *after* the last tool boundary (the
 * last `tool_result` or `tool_use`) are part of the final answer. Anything
 * before is interstitial narration and is dropped. If no tool activity
 * exists in the stream (no tools were used), we collect everything — the
 * only assistant text IS the answer.
 *
 * Edge case: if the last assistant turn ends on `tool_use` (no closing
 * text), there is no text after the last tool boundary and this returns ''.
 * The caller falls back to `resultEvent.result`.
 */
function collectStreamJsonText(stdout) {
	const events = [];
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try { events.push(JSON.parse(trimmed)); } catch {}
	}

	// Walk back to the last tool boundary — the last event carrying a
	// tool_result (user) OR a tool_use (assistant). The final answer is the
	// assistant text after it. Considering tool_use too (not only tool_result)
	// prevents an interstitial "let me run X" immediately before a tool_use
	// from being mistaken for the final answer.
	let startIdx = 0;
	for (let i = events.length - 1; i >= 0; i--) {
		const content = events[i].message?.content;
		if (!Array.isArray(content)) continue;
		const hasToolActivity = content.some(
			b => b && (b.type === 'tool_result' || b.type === 'tool_use'),
		);
		if (hasToolActivity) { startIdx = i + 1; break; }
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
 * Parse Claude CLI output (stream-json or text).
 */
function parseClaudeOutput(stdout, outputFormat, label = 'Claude') {
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
		outputFormat = 'text',
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

	return parseClaudeOutput(result.stdout, outputFormat, 'Claude');
}

module.exports = { ADMIN_ENV, buildClaudeArgs, spawnWithTimeout, parseClaudeOutput, executeClaudeCommand };
