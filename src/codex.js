const { execFileSync, spawn } = require('child_process');
const {
	CODEX_BIN,
	ADMIN_USER_HOME,
	CONTAINER_NAME,
	SANDBOX_USER_HOME,
	SANDBOX_CODEX_HOME,
	REASONING_EFFORT,
} = require('./config');
const { ensureContainer, isCodexAvailableInContainer } = require('./container');
const { spawnCollect, probeVersion } = require('./spawn');
const log = require('./logger');

const CODEX_USAGE_TIMEOUT_MS = 10000;
const CODEX_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const CODEX_LOGIN_URL_TIMEOUT_MS = 15 * 1000;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const URL_RE = /https?:\/\/[^\s<>"')]+/g;

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

function stripAnsi(output) {
	return output.replace(ANSI_RE, '');
}

function extractCodexLoginUrl(output) {
	const urls = stripAnsi(output).match(URL_RE) || [];
	if (urls.length === 0) return null;
	const preferred = urls.find(url => /openai|chatgpt|device/i.test(url)) || urls[0];
	return preferred.replace(/[.,;:]+$/, '');
}

function extractCodexDeviceCode(output) {
	const stripped = stripAnsi(output);
	const patterns = [
		/\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/,
		/(?:user\s+code|device\s+code|one-time\s+code)\s*[:=]\s*([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)/i,
		/(?:user\s+code|device\s+code|one-time\s+code)[^\n]*(?:\r?\n\s*)+([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})?)/i,
	];
	for (const pattern of patterns) {
		const match = stripped.match(pattern);
		if (match) return match[1].toUpperCase();
	}
	return null;
}

function buildCodexLoginFlow(mode, child) {
	const target = mode === 'sandbox' ? 'sandbox' : 'host';
	const label = `Codex ${target}`;
	return {
		agent: 'codex',
		mode,
		label,
		child,
		timeoutMs: CODEX_LOGIN_TIMEOUT_MS,
		urlTimeoutMs: CODEX_LOGIN_URL_TIMEOUT_MS,
		awaitsDiscordInput: false,
		extractUrl: extractCodexLoginUrl,
		formatUrlMessage: (url, output) => {
			const code = extractCodexDeviceCode(output);
			return [
				`Codex login started for **${target}**.`,
				'Open this link on your iPhone:',
				`<${url}>`,
				code ? `Enter this code: \`${code}\`` : 'Complete the browser authorization.',
				'I will confirm here when Codex finishes.',
				'This login expires in 10 minutes. Use `/login cancel` to abort.',
			].join('\n');
		},
		pendingHint: 'Finish the browser authorization, or use `/login cancel`.',
		inputHint: 'Finish the browser authorization, or use `/login cancel`.',
		inputReceivedMessage: null,
		cancelMessage: `${label} login cancelled.`,
		noUrlMessage: `${label} login did not produce a login URL. Check the service logs and try again.`,
		successMessage: `${label} login completed.`,
		cleanup: mode === 'sandbox'
			? () => {
				execFileSync('docker', [
					'exec',
					CONTAINER_NAME,
					'sh',
					'-c',
					'pkill -f "[c]odex login --device-auth" || true',
				], { stdio: 'ignore', timeout: 5000 });
			}
			: null,
		formatFailureMessage: ({ killed }) => {
			if (killed) return `${label} login expired or was cancelled. Run \`/login\` to start again.`;
			return `${label} login failed. Run \`/login\` to try again.`;
		},
	};
}

function startCodexLogin(mode) {
	let child;
	if (mode === 'sandbox') {
		ensureContainer();
		if (!isCodexAvailableInContainer()) {
			throw Object.assign(new Error('CODEX_NOT_AVAILABLE'), { code: 'CODEX_NOT_AVAILABLE' });
		}
		child = spawn('docker', [
			'exec',
			'-i',
			'-e', `CODEX_HOME=${SANDBOX_CODEX_HOME}`,
			'-w', SANDBOX_USER_HOME,
			CONTAINER_NAME,
			'codex',
			'login',
			'--device-auth',
		], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	} else if (mode === 'admin') {
		if (!CODEX_AVAILABLE) {
			throw Object.assign(new Error('CODEX_NOT_AVAILABLE'), { code: 'CODEX_NOT_AVAILABLE' });
		}
		child = spawn(CODEX_BIN, ['login', '--device-auth'], {
			cwd: ADMIN_USER_HOME,
			env: process.env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	} else {
		throw new Error(`Unknown execution mode: ${mode}`);
	}
	return buildCodexLoginFlow(mode, child);
}

function buildCodexArgs(options = {}) {
	const {
		sessionId = null,
		systemPrompt = null,
		model = null,
	} = options;

	// -m and -c both belong to the OPTIONS block, which precedes <SESSION_ID> in
	// the `exec resume` form. The -c override wins over any config.toml value, so
	// host and sandbox run the same model and effort.
	const executionArgs = [
		'--yolo',
		'--skip-git-repo-check',
		'--json',
		'-c',
		`model_reasoning_effort="${REASONING_EFFORT}"`,
	];
	if (model) executionArgs.push('-m', model);
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

function spawnCodexAppServer(mode) {
	if (mode === 'sandbox') {
		if (!isCodexAvailableInContainer()) {
			throw Object.assign(new Error('CODEX_NOT_AVAILABLE'), { code: 'CODEX_NOT_AVAILABLE' });
		}
		return {
			label: 'getCodexUsage(sandbox)',
			child: spawn('docker', [
				'exec',
				'-i',
				'-e', `CODEX_HOME=${SANDBOX_CODEX_HOME}`,
				'-w', SANDBOX_USER_HOME,
				CONTAINER_NAME,
				'codex',
				'app-server',
			], {
				stdio: ['pipe', 'pipe', 'pipe'],
			}),
			cleanup: () => {
				execFileSync('docker', [
					'exec',
					CONTAINER_NAME,
					'sh',
					'-c',
					'pkill -f "[c]odex app-server" || true',
				], { stdio: 'ignore', timeout: 5000 });
			},
		};
	}

	if (!CODEX_AVAILABLE) {
		throw Object.assign(new Error('CODEX_NOT_AVAILABLE'), { code: 'CODEX_NOT_AVAILABLE' });
	}
	return {
		label: 'getCodexUsage(host)',
		child: spawn(CODEX_BIN, ['app-server'], {
			cwd: ADMIN_USER_HOME,
			env: process.env,
			stdio: ['pipe', 'pipe', 'pipe'],
		}),
		cleanup: null,
	};
}

/**
 * Read ChatGPT account rate limits through Codex App Server. This uses the
 * credentials for the selected execution environment and does not run a model
 * turn or consume quota.
 */
async function getCodexUsage(mode = 'admin') {
	return new Promise((resolve) => {
		let child;
		let cleanup = null;
		let label = `getCodexUsage(${mode})`;
		try {
			const appServer = spawnCodexAppServer(mode);
			child = appServer.child;
			cleanup = appServer.cleanup;
			label = appServer.label;
		} catch (err) {
			if (err.code !== 'CODEX_NOT_AVAILABLE') {
				log.warn(`${label} spawn error:`, err.message);
			}
			resolve({ available: false, reason: err.code === 'CODEX_NOT_AVAILABLE' ? 'no-cli' : 'error' });
			return;
		}
		let settled = false;
		let stdout = '';
		let stderr = '';

		const timer = setTimeout(() => {
			log.warn(`${label} timed out`);
			finish({ available: false, reason: 'error' });
		}, CODEX_USAGE_TIMEOUT_MS);

		function finish(result) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (!child.killed) child.kill('SIGTERM');
			try {
				if (cleanup) cleanup();
			} catch (err) {
				log.warn(`${label} cleanup failed:`, err.message);
			}
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
					log.warn(`${label} App Server error`);
					finish({ available: false, reason });
					return;
				}

				const limits = message.result?.rateLimitsByLimitId?.codex
					|| message.result?.rateLimits;
				const windows = [limits?.primary, limits?.secondary].filter(Boolean);
				// Match windows by their duration, no positional fallback: the API may
				// omit the 5h window entirely (OpenAI dropped it), leaving only weekly.
				const fiveHour = windows.find(window => window.windowDurationMins === 300);
				const weekly = windows.find(window => window.windowDurationMins === 10080);
				const hasFiveHour = Number.isFinite(fiveHour?.usedPercent);
				const hasWeekly = Number.isFinite(weekly?.usedPercent);
				if (!hasFiveHour && !hasWeekly) {
					finish({ available: false, reason: 'no-subscription' });
					return;
				}

				const resetAt = (seconds) => Number.isFinite(seconds)
					? new Date(seconds * 1000).toISOString()
					: null;
				finish({
					available: true,
					fiveHour: hasFiveHour ? fiveHour.usedPercent : null,
					weekly: hasWeekly ? weekly.usedPercent : null,
					fiveHourResetAt: hasFiveHour ? resetAt(fiveHour.resetsAt) : null,
					weeklyResetAt: hasWeekly ? resetAt(weekly.resetsAt) : null,
				});
				return;
			}
		});
		child.on('error', (err) => {
			log.warn(`${label} spawn error:`, err.message);
			finish({ available: false, reason: err.code === 'ENOENT' ? 'no-cli' : 'error' });
		});
		child.on('close', (code) => {
			if (settled) return;
			log.warn(`${label} App Server exited with code ${code}: ${stderr.slice(-300)}`);
			finish({
				available: false,
				reason: isCodexAuthError('', stderr) ? 'expired' : 'error',
			});
		});
		child.stdin.on('error', (err) => {
			if (settled) return;
			log.warn(`${label} stdin error:`, err.message);
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

/**
 * Execute Codex in the given environment (host or sandbox). The `env` descriptor
 * abstracts where/how the process runs and the environment-specific error
 * mapping:
 *   - label:         log / diagnostic label
 *   - spawn:         (args, { input }) => Promise<{ stdout, stderr, code }>
 *   - precheck?:     () => void — throw before spawning if the env is unusable
 *   - onSpawnError?: (err) => void — mutate a spawn rejection (e.g. ENOENT remap)
 *   - isUnavailable?:(execution) => bool — true when a non-zero exit means the
 *                    Codex binary is missing in this env
 * The auth-error check is shared, so a sandbox auth failure now also surfaces as
 * CODEX_NOT_AUTHENTICATED (previously only the host path detected it).
 */
async function executeCodex(prompt, options = {}, env) {
	const {
		sessionId = null,
		systemPrompt = null,
		model = null,
		cancelKey = null,
		timeoutMs = 0,
		stopInfo,
	} = options;

	if (env.precheck) env.precheck();
	if (!systemPrompt) {
		throw new Error('executeCodex requires systemPrompt');
	}

	const attach = sessionId ? `resume ${sessionId}` : 'new session';
	log.info(`${env.label}: ${attach}, prompt length: ${prompt.length}`);

	let execution;
	try {
		execution = await env.spawn(
			buildCodexArgs({ sessionId, systemPrompt, model }),
			{ input: prompt, cancelKey, timeoutMs, stopInfo },
		);
	} catch (err) {
		err.sessionId = parseCodexOutput(err.stdout).sessionId;
		if (env.onSpawnError) env.onSpawnError(err);
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
		if (env.isUnavailable && env.isUnavailable(execution)) {
			throw Object.assign(new Error('CODEX_NOT_AVAILABLE'), {
				code: 'CODEX_NOT_AVAILABLE',
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
		log.warn(`${env.label}: no thread.started event in JSON output`);
	}

	return parsed;
}

/**
 * Codex CLI version, null when the probe fails (binary missing…). One version
 * covers both environments: the sandbox bind-mounts this same package.
 */
async function getCodexVersion() {
	if (!CODEX_AVAILABLE) return null;
	return probeVersion(CODEX_BIN, ['--version']);
}

// Host environment: run the `codex` binary directly under the admin home.
const hostCodexEnv = {
	label: 'Codex',
	precheck: () => {
		if (!CODEX_AVAILABLE) {
			throw Object.assign(new Error('CODEX_NOT_AVAILABLE'), { code: 'CODEX_NOT_AVAILABLE' });
		}
	},
	spawn: (args, opts = {}) => spawnCollect(
		CODEX_BIN, args,
		{ cwd: ADMIN_USER_HOME, env: process.env, label: 'Codex', detached: true, ...opts },
	),
	onSpawnError: (err) => {
		if (err.code === 'ENOENT') {
			err.code = 'CODEX_NOT_AVAILABLE';
			err.message = 'CODEX_NOT_AVAILABLE';
		}
	},
};

module.exports = {
	CODEX_AVAILABLE,
	getCodexUsage,
	getCodexVersion,
	executeCodex,
	hostCodexEnv,
	startCodexLogin,
};
