const { execFileSync } = require('child_process');
const {
	CODEX_BIN,
	CODEX_REASONING_EFFORT,
	PROMPT_TIMEOUT_MS,
	ADMIN_USER_HOME,
} = require('./config');
const { spawnWithTimeout } = require('./claude');
const log = require('./logger');

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
		|| output.includes('please run codex login');
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
	executeCodexCommand,
};
