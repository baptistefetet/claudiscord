const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
	SANDBOX_HOME_DIR,
	CONTAINER_HOME,
	CONTAINER_NAME,
	DOCKER_IMAGE,
	CONTAINER_MEMORY,
	CONTAINER_CPUS,
	CLAUDE_TIMEOUT_MS,
	DOCKER_CMD_TIMEOUT,
	ALLOWED_TOOLS,
	DISALLOWED_TOOLS,
	JOBS_RELATIVE,
} = require('./config');
const { getDefaultClaudeMd } = require('./prompts');
const { buildClaudeArgs, spawnWithTimeout, parseClaudeOutput } = require('./claude');
const log = require('./logger');

const DOCKERFILE_DIR = path.resolve(__dirname, '..');

// UID/GID of the 'claude' user inside the container. By convention the
// container is built (via scripts/rebuild-sandbox.sh) with IDs that match
// SANDBOX_HOME_DIR's owner, so we read them back from the directory itself.
// Falls back to 1001:1001 if the directory doesn't exist yet.
function readSandboxIds() {
	try {
		const st = fs.statSync(SANDBOX_HOME_DIR);
		return { uid: st.uid, gid: st.gid };
	} catch {
		return { uid: 1001, gid: 1001 };
	}
}
const { uid: CONTAINER_UID, gid: CONTAINER_GID } = readSandboxIds();

// Sandbox availability: requires both Docker installed AND SANDBOX_HOME_DIR
// configured. Either missing piece disables sandbox mode gracefully.
// The flag is exported as DOCKER_AVAILABLE for backward compat with callers,
// but it now reflects the combined precondition.
let DOCKER_AVAILABLE = true;
try {
	execFileSync('docker', ['--version'], { stdio: 'ignore', timeout: 5000 });
} catch {
	DOCKER_AVAILABLE = false;
	log.warn('Docker not detected — sandbox mode disabled');
}
if (DOCKER_AVAILABLE && !SANDBOX_HOME_DIR) {
	DOCKER_AVAILABLE = false;
	log.warn('SANDBOX_HOME_DIR unset — sandbox mode disabled');
}

function docker(...args) {
	return execFileSync('docker', args, { encoding: 'utf8', timeout: DOCKER_CMD_TIMEOUT }).trim();
}

// docker inspect on a non-existent object prints a Go template error to
// stderr that we otherwise don't care about (we already treat the throw as
// "doesn't exist"). Silencing stderr here keeps journald clean.
function dockerQuiet(...args) {
	return execFileSync('docker', args, {
		encoding: 'utf8',
		timeout: DOCKER_CMD_TIMEOUT,
		stdio: ['ignore', 'pipe', 'ignore'],
	}).trim();
}

function ensureImage() {
	if (!DOCKER_AVAILABLE) return;
	try {
		dockerQuiet('image', 'inspect', DOCKER_IMAGE);
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

function chownContainerUser(target) {
	try {
		execFileSync('chown', [`${CONTAINER_UID}:${CONTAINER_GID}`, target], { timeout: 5000 });
	} catch (err) {
		log.warn(`chown ${target} failed: ${err.message}`);
	}
}

function ensureStorage() {
	const home = SANDBOX_HOME_DIR;
	const isNew = !fs.existsSync(home);
	fs.mkdirSync(home, { recursive: true });
	if (isNew) chownContainerUser(home);

	// Seed a default CLAUDE.md (customizable)
	const claudeMd = path.join(home, 'CLAUDE.md');
	if (!fs.existsSync(claudeMd)) {
		fs.writeFileSync(claudeMd, getDefaultClaudeMd());
		chownContainerUser(claudeMd);
		log.info(`Created CLAUDE.md in ${home}`);
	}

	// .claude: created root-owned when home is pre-populated externally,
	// so chown it whenever we create it. Credentials are written later via /login.
	const claudeDir = path.join(home, '.claude');
	const claudeDirIsNew = !fs.existsSync(claudeDir);
	fs.mkdirSync(claudeDir, { recursive: true });
	if (claudeDirIsNew) chownContainerUser(claudeDir);

	const claudiscordDir = path.join(home, '.claudiscord');
	const claudiscordDirIsNew = !fs.existsSync(claudiscordDir);
	fs.mkdirSync(claudiscordDir, { recursive: true });
	if (claudiscordDirIsNew) chownContainerUser(claudiscordDir);
	const jobsFile = path.join(home, JOBS_RELATIVE);
	if (!fs.existsSync(jobsFile)) {
		fs.writeFileSync(jobsFile, '[]', 'utf8');
		chownContainerUser(jobsFile);
	}
}

function ensureContainer() {
	if (!DOCKER_AVAILABLE) throw new Error('Docker is not installed on this host');
	ensureStorage();

	// Check if container exists (silencing stderr: a missing container makes
	// `docker inspect` write a Go template error that otherwise reaches journald)
	try {
		const state = dockerQuiet('inspect', '-f', '{{.State.Status}}', CONTAINER_NAME);
		if (state === 'running') return;
		docker('start', CONTAINER_NAME);
		log.info(`Started existing container '${CONTAINER_NAME}'`);
		return;
	} catch {
		// Container doesn't exist, create it
	}

	docker(
		'create',
		'--name', CONTAINER_NAME,
		'--init',
		'--memory', CONTAINER_MEMORY,
		'--cpus', String(CONTAINER_CPUS),
		'--restart', 'unless-stopped',
		'-e', 'TZ=Europe/Paris',
		'-v', `${SANDBOX_HOME_DIR}:${CONTAINER_HOME}`,
		DOCKER_IMAGE,
	);
	docker('start', CONTAINER_NAME);
	log.info(`Created and started container '${CONTAINER_NAME}'`);
}

/**
 * Kill all non-essential processes inside the container (cleanup after timeout).
 * Killing docker exec only kills the host-side pipe, not the container process.
 * With --init, PID 1 is tini; we also spare the 'sleep' process that keeps the container alive.
 */
function killClaudeInContainer(label) {
	try {
		execFileSync('docker', ['exec', CONTAINER_NAME, 'sh', '-c',
			'for proc in /proc/[0-9]*; do pid=${proc#/proc/}; [ "$pid" = 1 ] && continue; [ "$pid" = "$$" ] && continue; comm=$(cat "$proc/comm" 2>/dev/null || true); [ "$comm" = "sleep" ] && continue; kill -9 "$pid" 2>/dev/null || true; done; true',
		], { timeout: 5000 });
		log.info(`${label}: killed orphaned processes`);
	} catch {
		// Process already dead or nothing to kill — either way, fine
	}
}

async function executeClaudeInContainer(prompt, claudeOptions, {
		timeoutMs = CLAUDE_TIMEOUT_MS,
		label = `Container [${CONTAINER_NAME}]`,
	} = {}) {
	const claudeArgs = buildClaudeArgs(prompt, claudeOptions);
	try {
		return await spawnWithTimeout(
			'docker', ['exec', '-i', CONTAINER_NAME, 'claude', ...claudeArgs],
			{ timeoutMs, label },
		);
	} catch (err) {
		if (err.code === 124) {
			// Timeout: docker exec was killed but claude may still run inside the container
			killClaudeInContainer(label);
		}
		throw err;
	}
}

async function executeInContainer(prompt, {
		sessionId = null,
		sessionStarted = false,
		systemPrompt = null,
		allowedTools = ALLOWED_TOOLS,
		disallowedTools = DISALLOWED_TOOLS,
		model = null,
		effort = null,
		outputFormat = 'json',
		timeoutMs = CLAUDE_TIMEOUT_MS,
	} = {}) {
	ensureContainer();
	const claudeOptions = {
		sessionId,
		sessionStarted,
		systemPrompt,
		allowedTools,
		disallowedTools,
		model,
		effort,
		outputFormat,
		extraArgs: ['--dangerously-skip-permissions'],
	};

	const label = `Container [${CONTAINER_NAME}]`;
	const attach = sessionId
		? (sessionStarted ? `resume ${sessionId}` : `new ${sessionId}`)
		: 'no session';
	log.info(`${label}: ${attach}, prompt length: ${prompt.length}`);

	const result = await executeClaudeInContainer(prompt, claudeOptions, {
		timeoutMs,
		label,
	});

	if (result.code !== 0) {
		const combined = (result.stdout + result.stderr).toLowerCase();
		if (combined.includes('not authenticated') || combined.includes('auth') || combined.includes('login') || combined.includes('api key')) {
			throw Object.assign(new Error('NOT_AUTHENTICATED'), { code: result.code });
		}
		const errMsg = result.stdout.slice(-500) || `exit code ${result.code}`;
		throw Object.assign(new Error(errMsg), { code: result.code });
	}

	return parseClaudeOutput(result.stdout, outputFormat, label, SANDBOX_HOME_DIR, sessionId);
}

/**
 * Write Claude Code credentials into the sandbox volume.
 * The user obtains these by running `claude auth login` on their own machine
 * and copying ~/.claude/.credentials.json.
 */
function writeCredentials(credentialsJson) {
	ensureStorage();
	const credPath = path.join(SANDBOX_HOME_DIR, '.claude', '.credentials.json');
	const tmp = credPath + '.tmp';
	fs.writeFileSync(tmp, credentialsJson, { mode: 0o600 });
	fs.renameSync(tmp, credPath);
	execFileSync('chown', [`${CONTAINER_UID}:${CONTAINER_GID}`, credPath], { timeout: 5000 });
	log.info('Wrote sandbox credentials');
}

function hasCredentials() {
	const credPath = path.join(SANDBOX_HOME_DIR, '.claude', '.credentials.json');
	return fs.existsSync(credPath);
}

module.exports = {
	DOCKER_AVAILABLE,
	ensureImage,
	ensureContainer,
	executeInContainer,
	writeCredentials,
	hasCredentials,
};
