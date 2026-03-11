const { spawn } = require('child_process');
const { CLAUDE_BIN, CLAUDE_TIMEOUT_MS, getSystemPrompt, ALLOWED_TOOLS, DISALLOWED_TOOLS } = require('./config');
const log = require('./logger');

// Mutex for DM requests (one Claude at a time)
let dmQueue = Promise.resolve();

// Lock set for scheduled jobs (per job ID)
const jobLocks = new Set();

function spawnClaude(prompt, options = {}) {
	const {
		sessionId = null,
		systemPrompt = null,
		allowedTools = ALLOWED_TOOLS,
		disallowedTools = DISALLOWED_TOOLS,
		model = 'opus',
		outputFormat = 'json',
		timeoutMs = CLAUDE_TIMEOUT_MS,
		cwd = '/root',
	} = options;

	return new Promise((resolve, reject) => {
		const args = ['-p'];

		if (sessionId) {
			args.push('--resume', sessionId);
		} else if (systemPrompt) {
			// TODO: switch to --append-system-prompt to preserve Claude Code's native system prompt
			args.push('--system-prompt', systemPrompt);
		}

		args.push('--output-format', outputFormat);
		args.push('--allowedTools', allowedTools);
		args.push('--disallowedTools', disallowedTools);
		args.push('--model', model);
		args.push('--', prompt);

		log.info(`Spawning claude: ${sessionId ? `resume ${sessionId}` : 'new session'}, prompt length: ${prompt.length}, format: ${outputFormat}`);

		const child = spawn(CLAUDE_BIN, args, {
			cwd,
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
			log.warn(`Claude timeout after ${timeoutMs}ms, sending SIGTERM`);
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
			if (stderr) log.warn('Claude stderr:', stderr.slice(0, 500));
			resolve({ stdout, code });
		});

		child.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

async function executeClaudeCommand(prompt, options = {}) {
	const {
		sessionId = null,
		systemPrompt = getSystemPrompt(),
		allowedTools = ALLOWED_TOOLS,
		disallowedTools = DISALLOWED_TOOLS,
		outputFormat = 'json',
		timeoutMs = CLAUDE_TIMEOUT_MS,
	} = options;

	let result;

	// First attempt: with resume if sessionId provided, otherwise new session
	try {
		result = await spawnClaude(prompt, {
			sessionId,
			systemPrompt: sessionId ? null : systemPrompt,
			allowedTools,
			disallowedTools,
			outputFormat,
			timeoutMs,
		});
	} catch (err) {
		if (err.code === 124) throw err;
		throw err;
	}

	// Fallback: if resume failed, retry with new session
	if (result.code !== 0 && sessionId) {
		log.warn(`Resume failed (exit ${result.code}), retrying with new session...`);
		try {
			result = await spawnClaude(prompt, {
				sessionId: null,
				systemPrompt,
				allowedTools,
				disallowedTools,
				outputFormat,
				timeoutMs,
			});
		} catch (err) {
			throw err;
		}
	}

	if (result.code !== 0) {
		const errMsg = result.stdout.slice(-500) || `exit code ${result.code}`;
		throw Object.assign(new Error(errMsg), { code: result.code });
	}

	// Parse output
	if (outputFormat === 'json') {
		try {
			const parsed = JSON.parse(result.stdout);
			return {
				result: parsed.result || '',
				sessionId: parsed.session_id || null,
			};
		} catch (err) {
			log.error('Failed to parse Claude JSON output:', result.stdout.slice(0, 200));
			return { result: result.stdout, sessionId: null };
		}
	}

	return { result: result.stdout, sessionId: null };
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

module.exports = { executeClaudeCommand, executeDM, acquireJobLock, releaseJobLock };
