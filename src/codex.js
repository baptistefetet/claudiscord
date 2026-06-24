const { execFileSync, spawn } = require('child_process');
const {
	CODEX_BIN,
	CODEX_REASONING_EFFORT,
	PROMPT_TIMEOUT_MS,
	ADMIN_USER_HOME,
} = require('./config');
const { spawnWithTimeout } = require('./claude');
const log = require('./logger');

const CODEX_USAGE_TIMEOUT_MS = 10000;

let CODEX_AVAILABLE = true;
try {
	execFileSync(CODEX_BIN, ['--version'], {
		stdio: 'ignore',
		timeout: 5000,
	});
} catch {
	CODEX_AVAILABLE = false;
	log.warn('Codex not detected — Codex agent disabled');
}

function buildCodexArgs(options = {}) {
	const {
		sessionId = null,
		systemPrompt = null,
	} = options;

	const executionArgs = [
		'--yolo',
		'--skip-git-repo-check',
		'--json',
		'-c',
		`model_reasoning_effort=${JSON.stringify(CODEX_REASONING_EFFORT)}`,
	];
	if (systemPrompt) {
		executionArgs.push(
			'-c',
			`developer_instructions=${JSON.stringify(systemPrompt)}`,
		);
	}

	if (sessionId) {
		return ['exec', 'resume', ...executionArgs, sessionId, '-'];
	}
	return ['exec', ...executionArgs, '-'];
}

function parseCodexOutput(stdout) {
	let sessionId = null;
	let result = '';

	for (const line of (stdout || '').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let event;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
			sessionId = event.thread_id;
		}
		if (
			event.type === 'item.completed'
			&& event.item?.type === 'agent_message'
			&& typeof event.item.text === 'string'
		) {
			result = event.item.text;
		}
	}

	return { result, sessionId };
}

function isCodexAuthError(stdout = '', stderr = '') {
	const output = `${stderr}\n${stdout}`.toLowerCase();
	return output.includes('not logged in')
		|| output.includes('login required')
		|| output.includes('authentication required')
		|| output.includes('please run codex login')
		|| output.includes('unauthorized')
		|| output.includes('token expired');
}

/**
 * Read ChatGPT account rate limits through Codex App Server. This uses the
 * host Codex credentials and does not run a model turn or consume quota.
 */
async function getCodexUsage() {
	if (!CODEX_AVAILABLE) return { available: false, reason: 'no-cli' };

	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(CODEX_BIN, ['app-server'], {
				cwd: ADMIN_USER_HOME,
				env: process.env,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (err) {
			log.warn('getCodexUsage spawn error:', err.message);
			resolve({ available: false, reason: 'error' });
			return;
		}
		let settled = false;
		let stdout = '';
		let stderr = '';

		const timer = setTimeout(() => {
			log.warn('getCodexUsage timed out');
			finish({ available: false, reason: 'error' });
		}, CODEX_USAGE_TIMEOUT_MS);

		function finish(result) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (!child.killed) child.kill('SIGTERM');
			resolve(result);
		}

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk) => {
			stderr = `${stderr}${chunk}`.slice(-2000);
		});
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
			let newline;
			while ((newline = stdout.indexOf('\n')) !== -1) {
				const line = stdout.slice(0, newline).trim();
				stdout = stdout.slice(newline + 1);
				if (!line) continue;

				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (message.id !== 1) continue;
				if (message.error) {
					const error = JSON.stringify(message.error);
					const reason = isCodexAuthError(error, stderr) ? 'expired' : 'error';
					log.warn('getCodexUsage App Server error');
					finish({ available: false, reason });
					return;
				}

				const limits = message.result?.rateLimitsByLimitId?.codex
					|| message.result?.rateLimits;
				const windows = [limits?.primary, limits?.secondary].filter(Boolean);
				const fiveHour = windows.find(window => window.windowDurationMins === 300)
					|| limits?.primary;
				const weekly = windows.find(window => window.windowDurationMins === 10080)
					|| limits?.secondary;
				if (!Number.isFinite(fiveHour?.usedPercent) || !Number.isFinite(weekly?.usedPercent)) {
					finish({ available: false, reason: 'no-subscription' });
					return;
				}

				const resetAt = (seconds) => Number.isFinite(seconds)
					? new Date(seconds * 1000).toISOString()
					: null;
				finish({
					available: true,
					fiveHour: fiveHour.usedPercent,
					weekly: weekly.usedPercent,
					fiveHourResetAt: resetAt(fiveHour.resetsAt),
					weeklyResetAt: resetAt(weekly.resetsAt),
				});
				return;
			}
		});
		child.on('error', (err) => {
			log.warn('getCodexUsage spawn error:', err.message);
			finish({ available: false, reason: err.code === 'ENOENT' ? 'no-cli' : 'error' });
		});
		child.on('close', (code) => {
			if (settled) return;
			log.warn(`getCodexUsage App Server exited with code ${code}: ${stderr.slice(-300)}`);
			finish({
				available: false,
				reason: isCodexAuthError('', stderr) ? 'expired' : 'error',
			});
		});
		child.stdin.on('error', (err) => {
			if (settled) return;
			log.warn('getCodexUsage stdin error:', err.message);
			finish({ available: false, reason: 'error' });
		});

		child.stdin.write([
			{
				method: 'initialize',
				id: 0,
				params: {
					clientInfo: {
						name: 'claudiscord',
						title: 'Claudiscord',
						version: '2.0.0',
					},
				},
			},
			{ method: 'initialized', params: {} },
			{ method: 'account/rateLimits/read', id: 1, params: null },
		].map(message => JSON.stringify(message)).join('\n') + '\n');
	});
}

async function executeCodexCommand(prompt, options = {}) {
	const {
		sessionId = null,
		systemPrompt = null,
		timeoutMs = PROMPT_TIMEOUT_MS,
	} = options;

	if (!CODEX_AVAILABLE) {
		throw Object.assign(new Error('CODEX_NOT_AVAILABLE'), {
			code: 'CODEX_NOT_AVAILABLE',
		});
	}
	if (!systemPrompt) {
		throw new Error('executeCodexCommand requires systemPrompt');
	}

	const attach = sessionId ? `resume ${sessionId}` : 'new session';
	log.info(`Spawning codex: ${attach}, prompt length: ${prompt.length}`);

	let execution;
	try {
		execution = await spawnWithTimeout(
			CODEX_BIN,
			buildCodexArgs({ sessionId, systemPrompt }),
			{
				timeoutMs,
				cwd: ADMIN_USER_HOME,
				env: process.env,
				label: 'Codex',
				input: prompt,
			},
		);
	} catch (err) {
		err.sessionId = parseCodexOutput(err.stdout).sessionId;
		if (err.code === 'ENOENT') {
			err.code = 'CODEX_NOT_AVAILABLE';
			err.message = 'CODEX_NOT_AVAILABLE';
		}
		throw err;
	}

	const parsed = parseCodexOutput(execution.stdout);
	if (execution.code !== 0) {
		if (isCodexAuthError(execution.stdout, execution.stderr)) {
			throw Object.assign(new Error('CODEX_NOT_AUTHENTICATED'), {
				code: 'CODEX_NOT_AUTHENTICATED',
				sessionId: parsed.sessionId,
			});
		}
		const errMsg = execution.stderr.slice(-500)
			|| execution.stdout.slice(-500)
			|| `exit code ${execution.code}`;
		throw Object.assign(new Error(errMsg), {
			code: execution.code,
			sessionId: parsed.sessionId,
		});
	}
	if (!parsed.sessionId) {
		log.warn('Codex: no thread.started event in JSON output');
	}

	return parsed;
}

module.exports = {
	CODEX_AVAILABLE,
	buildCodexArgs,
	parseCodexOutput,
	getCodexUsage,
	executeCodexCommand,
};
