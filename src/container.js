const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, DOCKER_IMAGE, CONTAINER_MEMORY, CONTAINER_CPUS, CLAUDE_TIMEOUT_MS, DOCKER_CMD_TIMEOUT, ALLOWED_TOOLS, DISALLOWED_TOOLS } = require('./config');
const { getDefaultClaudeMd } = require('./prompts');
const { buildClaudeArgs, spawnWithTimeout, parseClaudeOutput } = require('./claude');
const log = require('./logger');

const DOCKERFILE_DIR = path.resolve(__dirname, '..');

/** Per-userId promise queues */
const containerQueues = new Map();

function docker(...args) {
	return execFileSync('docker', args, { encoding: 'utf8', timeout: DOCKER_CMD_TIMEOUT }).trim();
}

function ensureImage() {
	try {
		docker('image', 'inspect', DOCKER_IMAGE);
		log.info(`Docker image '${DOCKER_IMAGE}' found`);
	} catch {
		log.info(`Docker image '${DOCKER_IMAGE}' not found, building...`);
		execFileSync('docker', ['build', '-t', DOCKER_IMAGE, DOCKERFILE_DIR], {
			encoding: 'utf8',
			timeout: 600000,
			stdio: 'inherit',
		});
		log.info(`Docker image '${DOCKER_IMAGE}' built`);
	}
}

// UID/GID of the 'claude' user inside the container
const CONTAINER_UID = 1001;
const CONTAINER_GID = 1001;

function ensureUserStorage(userId) {
	const userHome = path.join(DATA_DIR, userId, 'home');
	const isNew = !fs.existsSync(userHome);
	fs.mkdirSync(userHome, { recursive: true });

	// Seed a default CLAUDE.md for new sandbox users (customizable)
	const claudeMd = path.join(userHome, 'CLAUDE.md');
	if (!fs.existsSync(claudeMd)) {
		fs.writeFileSync(claudeMd, getDefaultClaudeMd());
		execFileSync('chown', [`${CONTAINER_UID}:${CONTAINER_GID}`, claudeMd], { timeout: 5000 });
		log.info(`Created CLAUDE.md for user ${userId}`);
	}

	// Ensure .claude dir exists for auth persistence
	const claudeDir = path.join(userHome, '.claude');
	fs.mkdirSync(claudeDir, { recursive: true });

	// Ensure .claudiscord dir exists for scheduled jobs
	const claudiscordDir = path.join(userHome, '.claudiscord');
	fs.mkdirSync(claudiscordDir, { recursive: true });

	// Only chown -R on first creation; afterwards the home may contain
	// thousands of files and recursive chown would timeout on the Pi
	if (isNew) {
		execFileSync('chown', ['-R', `${CONTAINER_UID}:${CONTAINER_GID}`, userHome], { timeout: 10000 });
	}
}

function containerName(userId) {
	return `claudiscord-${userId}`;
}

function ensureContainer(userId) {
	ensureUserStorage(userId);
	const name = containerName(userId);
	const userHome = path.join(DATA_DIR, userId, 'home');

	// Check if container exists
	try {
		const state = docker('inspect', '-f', '{{.State.Status}}', name);
		if (state === 'running') return;
		// Exists but not running, start it
		docker('start', name);
		log.info(`Started existing container '${name}'`);
		return;
	} catch {
		// Container doesn't exist, create it
	}

	docker(
		'create',
		'--name', name,
		'--init',
		'--memory', CONTAINER_MEMORY,
		'--cpus', String(CONTAINER_CPUS),
		'--restart', 'unless-stopped',
		'-e', 'TZ=Europe/Paris',
		'-v', `${userHome}:/home/claude`,
		DOCKER_IMAGE,
	);
	docker('start', name);
	log.info(`Created and started container '${name}'`);
}

/**
 * Kill all non-essential processes inside a container (cleanup after timeout/early result).
 * Killing docker exec only kills the host-side pipe, not the container process.
 * With --init, PID 1 is tini; we also spare the 'sleep' process that keeps the container alive.
 */
function killClaudeInContainer(name, label) {
	try {
		execFileSync('docker', ['exec', name, 'sh', '-c',
			'ps -eo pid=,comm= | awk \'$1 != 1 && $2 != "sleep" { print $1 }\' | xargs -r kill -9 2>/dev/null; true',
		], { timeout: 5000 });
		log.info(`${label}: killed orphaned processes`);
	} catch {
		// Process already dead or nothing to kill — either way, fine
	}
}

async function executeInContainer(userId, prompt, options = {}) {
	const {
		sessionId = null,
		systemPrompt = null,
		allowedTools = ALLOWED_TOOLS,
		disallowedTools = DISALLOWED_TOOLS,
		outputFormat = 'json',
		timeoutMs = CLAUDE_TIMEOUT_MS,
	} = options;

	ensureContainer(userId);
	const name = containerName(userId);

	const claudeArgs = buildClaudeArgs(prompt, {
		sessionId,
		systemPrompt,
		allowedTools,
		disallowedTools,
		outputFormat,
		extraArgs: ['--dangerously-skip-permissions'],
	});

	const label = `Container [${name}]`;
	const isStreamJson = outputFormat === 'stream-json';
	log.info(`${label}: ${sessionId ? `resume ${sessionId}` : 'new session'}, prompt length: ${prompt.length}`);

	// First attempt
	let result;
	try {
		result = await spawnWithTimeout(
			'docker', ['exec', '-i', name, 'claude', ...claudeArgs],
			{
				timeoutMs, label,
				streamJson: isStreamJson,
				onEarlyKill: () => killClaudeInContainer(name, label),
			},
		);
	} catch (err) {
		if (err.code === 124) {
			// Timeout: docker exec was killed but claude may still run inside the container
			killClaudeInContainer(name, label);
		}
		throw err;
	}

	// Fallback: if resume failed, retry with new session
	if (result.code !== 0 && sessionId) {
		log.warn(`${label} resume failed (exit ${result.code}), retrying with new session...`);
		const retryArgs = buildClaudeArgs(prompt, {
			sessionId: null,
			systemPrompt,
			allowedTools,
			disallowedTools,
			outputFormat,
			extraArgs: ['--dangerously-skip-permissions'],
		});
		try {
			result = await spawnWithTimeout(
				'docker', ['exec', '-i', name, 'claude', ...retryArgs],
				{
					timeoutMs, label,
					streamJson: isStreamJson,
					onEarlyKill: () => killClaudeInContainer(name, label),
				},
			);
		} catch (err) {
			if (err.code === 124) {
				killClaudeInContainer(name, label);
			}
			throw err;
		}
	}

	if (result.code !== 0) {
		const combined = (result.stdout + result.stderr).toLowerCase();
		if (combined.includes('not authenticated') || combined.includes('auth') || combined.includes('login') || combined.includes('api key')) {
			throw Object.assign(new Error('NOT_AUTHENTICATED'), { code: result.code });
		}
		const errMsg = result.stdout.slice(-500) || `exit code ${result.code}`;
		throw Object.assign(new Error(errMsg), { code: result.code });
	}

	// Merge user scheduled jobs after successful execution
	try {
		const { mergeUserJobs } = require('./scheduler');
		mergeUserJobs(userId);
	} catch (err) {
		log.warn(`Failed to merge jobs for user ${userId}:`, err.message);
	}

	const claudeHome = path.join(DATA_DIR, userId, 'home');
	return parseClaudeOutput(result.stdout, outputFormat, label, claudeHome);
}

/**
 * Queued execution: mutex per userId, concurrent between users
 */
function executeInContainerQueued(userId, prompt, options = {}) {
	if (!containerQueues.has(userId)) containerQueues.set(userId, Promise.resolve());
	const p = containerQueues.get(userId).then(() => executeInContainer(userId, prompt, options));
	containerQueues.set(userId, p.catch(() => {}));
	return p;
}

/**
 * Write credentials JSON to the user's container volume.
 * The user obtains these by running `claude auth login` on their own machine
 * and copying ~/.claude/.credentials.json.
 */
function writeCredentials(userId, credentialsJson) {
	ensureUserStorage(userId);
	const credPath = path.join(DATA_DIR, userId, 'home', '.claude', '.credentials.json');
	const tmp = credPath + '.tmp';
	fs.writeFileSync(tmp, credentialsJson, { mode: 0o600 });
	fs.renameSync(tmp, credPath);
	// Ensure ownership
	execFileSync('chown', [`${CONTAINER_UID}:${CONTAINER_GID}`, credPath], { timeout: 5000 });
	log.info(`Wrote credentials for user ${userId}`);
}

/**
 * Check if a user has credentials in their container volume.
 */
function hasCredentials(userId) {
	const credPath = path.join(DATA_DIR, userId, 'home', '.claude', '.credentials.json');
	return fs.existsSync(credPath);
}

function destroyContainer(userId) {
	const name = containerName(userId);
	try {
		docker('stop', name);
	} catch {}
	try {
		docker('rm', name);
		log.info(`Destroyed container '${name}'`);
	} catch {}
}

module.exports = { ensureImage, ensureContainer, containerName, executeInContainerQueued, writeCredentials, hasCredentials, destroyContainer };
