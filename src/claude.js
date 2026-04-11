const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { CLAUDE_BIN, CLAUDE_TIMEOUT_MS, ALLOWED_TOOLS } = require('./config');
const { getSystemPrompt } = require('./prompts');
const log = require('./logger');

// Mutex for DM requests (one Claude at a time)
let dmQueue = Promise.resolve();

// Lock set for scheduled jobs (per job ID)
const jobLocks = new Set();

/**
 * Build Claude CLI arguments from options.
 * Extra args (e.g. --dangerously-skip-permissions) can be prepended via extraArgs.
 */
function buildClaudeArgs(prompt, options = {}) {
	const {
		sessionId = null,
		systemPrompt = null,
		allowedTools = ALLOWED_TOOLS,
		model = 'opus',
		outputFormat = 'json',
		extraArgs = [],
	} = options;

	const args = ['-p', ...extraArgs];

	if (sessionId) {
		args.push('--resume', sessionId);
	}
	if (systemPrompt) {
		args.push('--system-prompt', systemPrompt);
	}

	args.push('--output-format', outputFormat);
	if (outputFormat === 'stream-json') args.push('--verbose');
	args.push('--allowedTools', allowedTools);
	args.push('--model', model);
	args.push('--', prompt);

	return args;
}

/**
 * Spawn a command with timeout, stdout/stderr collection, and SIGTERM→SIGKILL.
 * Returns { stdout, stderr, code }.
 *
 * When streamJson is true (for --output-format stream-json), the promise
 * resolves as soon as the {"type":"result",...} event appears on stdout,
 * without waiting for the process to exit.  This prevents deadlocks when
 * background tasks (e.g. gws auth login) keep the process alive after the
 * conversation has ended.  onEarlyKill is called after killing the process
 * so the caller can clean up (e.g. kill orphaned processes in a container).
 */
function spawnWithTimeout(cmd, args, options = {}) {
	const {
		timeoutMs = CLAUDE_TIMEOUT_MS,
		cwd,
		label = 'process',
		streamJson = false,
		onEarlyKill = null,
	} = options;

	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		child.stdin.end();

		let stdout = '';
		let stderr = '';
		let resolved = false;
		let earlyResult = null;

		child.stdout.on('data', chunk => {
			stdout += chunk;

			// Stream-JSON: capture the result as soon as it appears, then
			// terminate the process but wait for close before resolving.
			if (streamJson && !resolved) {
				for (const line of stdout.split('\n')) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						const event = JSON.parse(trimmed);
						if (event.type === 'result' && !earlyResult) {
							earlyResult = { stdout, stderr, code: 0 };
							clearTimeout(timer);
							log.info(`${label}: stream result received, terminating process`);
							child.kill('SIGTERM');
							setTimeout(() => {
								try { child.kill('SIGKILL'); } catch (_) {}
							}, 5000);
							if (onEarlyKill) onEarlyKill();
							return;
						}
					} catch (_) {}
				}
			}
		});

		child.stderr.on('data', chunk => { stderr += chunk; });

		let killed = false;
		const timer = setTimeout(() => {
			if (resolved) return;
			killed = true;
			log.warn(`${label} timeout after ${timeoutMs}ms, sending SIGTERM`);
			child.kill('SIGTERM');
			setTimeout(() => {
				try { child.kill('SIGKILL'); } catch (_) {}
			}, 5000);
		}, timeoutMs);

		child.on('close', (code) => {
			clearTimeout(timer);
			if (resolved) return;
			if (earlyResult) {
				resolved = true;
				resolve({ stdout: earlyResult.stdout, stderr, code: 0 });
				return;
			}
			if (killed) {
				reject(Object.assign(new Error('timeout'), { code: 124 }));
				return;
			}
			if (stderr) log.warn(`${label} stderr:`, stderr.slice(0, 500));
			resolve({ stdout, stderr, code });
		});

		child.on('error', (err) => {
			clearTimeout(timer);
			if (resolved) return;
			reject(err);
		});
	});
}

/**
 * Extract the last assistant text from a session JSONL file.
 * Used as fallback when the CLI result field is empty (happens when the
 * last assistant turn ends on a tool_use instead of end_turn).
 */
function extractLastTextFromSessionLog(sessionId, claudeHome) {
	if (!sessionId || !claudeHome) return '';
	try {
		// Session logs live under ~/.claude/projects/{cwd-encoded}/
		const projectsDir = path.join(claudeHome, '.claude', 'projects');
		if (!fs.existsSync(projectsDir)) return '';

		// Find the JSONL file matching this session across all project dirs
		let jsonlPath = null;
		for (const dir of fs.readdirSync(projectsDir)) {
			const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
			if (fs.existsSync(candidate)) { jsonlPath = candidate; break; }
		}
		if (!jsonlPath) return '';

		const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n');
		let lastText = '';
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const obj = JSON.parse(line);
				if (obj.type !== 'assistant') continue;
				const content = obj.message?.content;
				if (!Array.isArray(content)) continue;
				for (const block of content) {
					if (block.type === 'text' && block.text) lastText = block.text;
				}
			} catch {}
		}
		return lastText;
	} catch (err) {
		log.warn(`Failed to read session log for ${sessionId}:`, err.message);
		return '';
	}
}

/**
 * Parse Claude CLI output (JSON, stream-json, or text).
 * claudeHome is the home dir where .claude/ lives (for JSONL fallback).
 */
function parseClaudeOutput(stdout, outputFormat, label = 'Claude', claudeHome = null) {
	if (outputFormat === 'stream-json') {
		// Stream JSON: multiple JSON lines, find the result event (scan from end)
		const lines = stdout.split('\n');
		for (let i = lines.length - 1; i >= 0; i--) {
			const trimmed = lines[i].trim();
			if (!trimmed) continue;
			try {
				const event = JSON.parse(trimmed);
				if (event.type === 'result') {
					return { result: event.result || '', sessionId: event.session_id || null };
				}
			} catch (_) {}
		}
		log.warn(`${label}: no result event in stream-json output`);
		return { result: stdout.slice(-500), sessionId: null };
	}

	if (outputFormat === 'json') {
		try {
			const parsed = JSON.parse(stdout);
			let result = parsed.result || '';
			const sessionId = parsed.session_id || null;

			// Fallback: when result is empty (last turn ended on tool_use),
			// extract the last assistant text from the session JSONL
			if (!result && sessionId) {
				result = extractLastTextFromSessionLog(sessionId, claudeHome);
				if (result) log.info(`${label}: recovered text from session log (result was empty)`);
			}

			return { result, sessionId };
		} catch (err) {
			log.error(`Failed to parse ${label} JSON output:`, stdout.slice(0, 200));
			return { result: stdout, sessionId: null };
		}
	}
	return { result: stdout, sessionId: null };
}

async function executeClaudeCommand(prompt, options = {}) {
	const {
		sessionId = null,
		systemPrompt = getSystemPrompt(),
		allowedTools = ALLOWED_TOOLS,
		outputFormat = 'json',
		timeoutMs = CLAUDE_TIMEOUT_MS,
	} = options;

	const spawnOpts = { systemPrompt, allowedTools, outputFormat };
	const isStreamJson = outputFormat === 'stream-json';

	log.info(`Spawning claude: ${sessionId ? `resume ${sessionId}` : 'new session'}, prompt length: ${prompt.length}, format: ${outputFormat}`);

	// First attempt: with resume if sessionId provided, otherwise new session
	let result = await spawnWithTimeout(
		CLAUDE_BIN,
		buildClaudeArgs(prompt, { ...spawnOpts, sessionId }),
		{ timeoutMs, cwd: '/root', label: 'Claude', streamJson: isStreamJson },
	);

	// Fallback: if resume failed, retry with new session
	if (result.code !== 0 && sessionId) {
		log.warn(`Resume failed (exit ${result.code}), retrying with new session...`);
		result = await spawnWithTimeout(
			CLAUDE_BIN,
			buildClaudeArgs(prompt, { ...spawnOpts, sessionId: null }),
			{ timeoutMs, cwd: '/root', label: 'Claude', streamJson: isStreamJson },
		);
	}

	if (result.code !== 0) {
		const errMsg = result.stdout.slice(-500) || `exit code ${result.code}`;
		throw Object.assign(new Error(errMsg), { code: result.code });
	}

	return parseClaudeOutput(result.stdout, outputFormat, 'Claude', '/root');
}

/**
 * Execute a DM command with mutex (one at a time)
 */
function executeDM(prompt, options = {}) {
	const p = dmQueue.then(() => executeClaudeCommand(prompt, options));
	// Update queue regardless of success/failure
	dmQueue = p.catch(() => {});
	return p;
}

/**
 * Try to acquire a job lock. Returns true if acquired.
 */
function acquireJobLock(jobId) {
	if (jobLocks.has(jobId)) return false;
	jobLocks.add(jobId);
	return true;
}

function releaseJobLock(jobId) {
	jobLocks.delete(jobId);
}

module.exports = { buildClaudeArgs, spawnWithTimeout, parseClaudeOutput, executeClaudeCommand, executeDM, acquireJobLock, releaseJobLock };
