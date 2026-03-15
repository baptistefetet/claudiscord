const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, DOCKER_IMAGE, CONTAINER_MEMORY, CONTAINER_CPUS, CLAUDE_TIMEOUT_MS, ALLOWED_TOOLS, DISALLOWED_TOOLS } = require('./config');
const log = require('./logger');

const DOCKERFILE_DIR = path.resolve(__dirname, '..');

/** Per-userId promise queues */
const containerQueues = new Map();

function docker(...args) {
	return execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
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
	fs.mkdirSync(userHome, { recursive: true });

	// Seed a default CLAUDE.md for new sandbox users (customizable)
	const claudeMd = path.join(userHome, 'CLAUDE.md');
	if (!fs.existsSync(claudeMd)) {
		const { getDefaultClaudeMd } = require('./prompts');
		fs.writeFileSync(claudeMd, getDefaultClaudeMd());
		log.info(`Created CLAUDE.md for user ${userId}`);
	}

	// Ensure .claude dir exists for auth persistence
	const claudeDir = path.join(userHome, '.claude');
	fs.mkdirSync(claudeDir, { recursive: true });

	// Ensure .claudiscord dir exists for scheduled jobs
	const claudiscordDir = path.join(userHome, '.claudiscord');
	fs.mkdirSync(claudiscordDir, { recursive: true });

	// Ensure all files are owned by the container's claude user
	execFileSync('chown', ['-R', `${CONTAINER_UID}:${CONTAINER_GID}`, userHome], { timeout: 5000 });
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

function executeInContainerInternal(userId, prompt, options = {}) {
	const {
		sessionId = null,
		systemPrompt = null,
		allowedTools = ALLOWED_TOOLS,
		disallowedTools = DISALLOWED_TOOLS,
		model = 'opus',
		outputFormat = 'json',
		timeoutMs = CLAUDE_TIMEOUT_MS,
	} = options;

	ensureContainer(userId);
	const name = containerName(userId);

	return new Promise((resolve, reject) => {
		const claudeArgs = ['-p', '--dangerously-skip-permissions'];

		if (sessionId) {
			claudeArgs.push('--resume', sessionId);
		}
		if (systemPrompt) {
			claudeArgs.push('--system-prompt', systemPrompt);
		}

		claudeArgs.push('--output-format', outputFormat);
		claudeArgs.push('--allowedTools', allowedTools);
		claudeArgs.push('--disallowedTools', disallowedTools);
		claudeArgs.push('--model', model);
		claudeArgs.push('--', prompt);

		const args = ['exec', '-i', name, 'claude', ...claudeArgs];

		log.info(`Container exec [${name}]: ${sessionId ? `resume ${sessionId}` : 'new session'}, prompt length: ${prompt.length}`);

		const child = spawn('docker', args, {
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
			log.warn(`Container exec timeout after ${timeoutMs}ms, killing`);
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
			if (stderr) log.warn('Container stderr:', stderr.slice(0, 500));
			resolve({ stdout, stderr, code });
		});

		child.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
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

	let result;

	// First attempt
	try {
		result = await executeInContainerInternal(userId, prompt, {
			sessionId,
			systemPrompt,
			allowedTools,
			disallowedTools,
			outputFormat,
			timeoutMs,
		});
	} catch (err) {
		throw err;
	}

	// Fallback: if resume failed, retry with new session
	if (result.code !== 0 && sessionId) {
		log.warn(`Container resume failed (exit ${result.code}), retrying with new session...`);
		try {
			result = await executeInContainerInternal(userId, prompt, {
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

	// Parse output
	if (outputFormat === 'json') {
		try {
			const parsed = JSON.parse(result.stdout);
			return {
				result: parsed.result || '',
				sessionId: parsed.session_id || null,
			};
		} catch (err) {
			log.error('Failed to parse container JSON output:', result.stdout.slice(0, 200));
			return { result: result.stdout, sessionId: null };
		}
	}

	return { result: result.stdout, sessionId: null };
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
