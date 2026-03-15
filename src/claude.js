const { spawn } = require('child_process');
const { CLAUDE_BIN, CLAUDE_TIMEOUT_MS, ALLOWED_TOOLS, DISALLOWED_TOOLS } = require('./config');
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
		disallowedTools = DISALLOWED_TOOLS,
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
	args.push('--allowedTools', allowedTools);
	args.push('--disallowedTools', disallowedTools);
	args.push('--model', model);
	args.push('--', prompt);

	return args;
}

/**
 * Spawn a command with timeout, stdout/stderr collection, and SIGTERM→SIGKILL.
 * Returns { stdout, stderr, code }.
 */
function spawnWithTimeout(cmd, args, options = {}) {
	const {
		timeoutMs = CLAUDE_TIMEOUT_MS,
		cwd,
		label = 'process',
	} = options;

	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
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
 * Parse Claude CLI output (JSON or text).
 */
function parseClaudeOutput(stdout, outputFormat, label = 'Claude') {
	if (outputFormat === 'json') {
		try {
			const parsed = JSON.parse(stdout);
			return {
				result: parsed.result || '',
				sessionId: parsed.session_id || null,
			};
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
		disallowedTools = DISALLOWED_TOOLS,
		outputFormat = 'json',
		timeoutMs = CLAUDE_TIMEOUT_MS,
	} = options;

	const spawnOpts = { systemPrompt, allowedTools, disallowedTools, outputFormat };

	log.info(`Spawning claude: ${sessionId ? `resume ${sessionId}` : 'new session'}, prompt length: ${prompt.length}, format: ${outputFormat}`);

	// First attempt: with resume if sessionId provided, otherwise new session
	let result = await spawnWithTimeout(
		CLAUDE_BIN,
		buildClaudeArgs(prompt, { ...spawnOpts, sessionId }),
		{ timeoutMs, cwd: '/root', label: 'Claude' },
	);

	// Fallback: if resume failed, retry with new session
	if (result.code !== 0 && sessionId) {
		log.warn(`Resume failed (exit ${result.code}), retrying with new session...`);
		result = await spawnWithTimeout(
			CLAUDE_BIN,
			buildClaudeArgs(prompt, { ...spawnOpts, sessionId: null }),
			{ timeoutMs, cwd: '/root', label: 'Claude' },
		);
	}

	if (result.code !== 0) {
		const errMsg = result.stdout.slice(-500) || `exit code ${result.code}`;
		throw Object.assign(new Error(errMsg), { code: result.code });
	}

	return parseClaudeOutput(result.stdout, outputFormat);
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
