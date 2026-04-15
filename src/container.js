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

	// Seed hooks: wait-background.sh blocks until run_in_background tasks complete
	const hooksDir = path.join(claudeDir, 'hooks');
	const hookScript = path.join(hooksDir, 'wait-background.sh');
	if (!fs.existsSync(hookScript)) {
		fs.mkdirSync(hooksDir, { recursive: true });
		fs.copyFileSync(path.join(__dirname, '..', 'claude', 'wait-background.sh'), hookScript);
		fs.chmodSync(hookScript, 0o755);
		log.info(`Created wait-background.sh hook for user ${userId}`);
	}

	// Seed settings.json with hook config
	const settingsFile = path.join(claudeDir, 'settings.json');
	if (!fs.existsSync(settingsFile)) {
		fs.copyFileSync(path.join(__dirname, '..', 'claude', 'settings.json'), settingsFile);
		log.info(`Created settings.json for user ${userId}`);
	}

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
			'for proc in /proc/[0-9]*; do pid=${proc#/proc/}; [ "$pid" = 1 ] && continue; [ "$pid" = "$$" ] && continue; comm=$(cat "$proc/comm" 2>/dev/null || true); [ "$comm" = "sleep" ] && continue; kill -9 "$pid" 2>/dev/null || true; done; true',
		], { timeout: 5000 });
		log.info(`${label}: killed orphaned processes`);
	} catch {
		// Process already dead or nothing to kill — either way, fine
	}
}

async function executeClaudeInContainer(name, prompt, claudeOptions, {
		timeoutMs = CLAUDE_TIMEOUT_MS,
		label = `Container [${name}]`,
		streamJson = false,
	} = {}) {
	const claudeArgs = buildClaudeArgs(prompt, claudeOptions);
	try {
		return await spawnWithTimeout(
			'docker', ['exec', '-i', name, 'claude', ...claudeArgs],
			{
				timeoutMs,
				label,
				streamJson,
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
}

async function executeInContainer(userId, prompt, {
		sessionId = null,
		systemPrompt = null,
		allowedTools = ALLOWED_TOOLS,
		disallowedTools = DISALLOWED_TOOLS,
		model = null,
		effort = null,
		outputFormat = 'json',
		timeoutMs = CLAUDE_TIMEOUT_MS,
	} = {}) {
	ensureContainer(userId);
	const name = containerName(userId);
	const claudeOptions = {
		sessionId,
		systemPrompt,
		allowedTools,
		disallowedTools,
		model,
		effort,
		outputFormat,
		extraArgs: ['--dangerously-skip-permissions'],
	};

	const label = `Container [${name}]`;
	const isStreamJson = outputFormat === 'stream-json';
	log.info(`${label}: ${sessionId ? `resume ${sessionId}` : 'new session'}, prompt length: ${prompt.length}`);

	// First attempt
	let result = await executeClaudeInContainer(name, prompt, claudeOptions, {
		timeoutMs,
		label,
		streamJson: isStreamJson,
	});

	// Fallback: if resume failed, retry with new session
	if (result.code !== 0 && sessionId) {
		log.warn(`${label} resume failed (exit ${result.code}), retrying with new session...`);
		result = await executeClaudeInContainer(name, prompt, { ...claudeOptions, sessionId: null }, {
			timeoutMs,
			label,
			streamJson: isStreamJson,
		});
	}

	if (result.code !== 0) {
		const combined = (result.stdout + result.stderr).toLowerCase();
		if (combined.includes('not authenticated') || combined.includes('auth') || combined.includes('login') || combined.includes('api key')) {
			throw Object.assign(new Error('NOT_AUTHENTICATED'), { code: result.code });
		}
		const errMsg = result.stdout.slice(-500) || `exit code ${result.code}`;
		throw Object.assign(new Error(errMsg), { code: result.code });
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
