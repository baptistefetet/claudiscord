const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
	SANDBOX_HOST_HOME,
	SANDBOX_USER_HOME,
	STATE_DIR,
	JOBS_FILENAME,
	CONTAINER_NAME,
	DOCKER_IMAGE,
	CONTAINER_CPUS,
	DOCKER_CMD_TIMEOUT,
} = require('./config');
const { getDefaultClaudeMd } = require('./prompts');
const { spawnCollect } = require('./spawn');
const log = require('./logger');

const DOCKERFILE_DIR = path.resolve(__dirname, '..');
const SANDBOX_CODEX_CONFIG = `cli_auth_credentials_store = "file"
`;

// UID/GID of the 'claude' user inside the container. By convention the
// container is built (via scripts/rebuild-sandbox.sh) with IDs that match
// SANDBOX_HOME's owner, so we read them back from the directory itself.
// Falls back to 1001:1001 if the directory doesn't exist yet.
function readSandboxIds() {
	try {
		const st = fs.statSync(SANDBOX_HOST_HOME);
		return { uid: st.uid, gid: st.gid };
	} catch {
		return { uid: 1001, gid: 1001 };
	}
}
const { uid: SANDBOX_UID, gid: SANDBOX_GID } = readSandboxIds();

// Sandbox availability: requires both Docker installed AND SANDBOX_HOME
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
if (DOCKER_AVAILABLE && !SANDBOX_HOST_HOME) {
	DOCKER_AVAILABLE = false;
	log.warn('SANDBOX_HOME unset — sandbox mode disabled');
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
		execFileSync('chown', [`${SANDBOX_UID}:${SANDBOX_GID}`, target], { timeout: 5000 });
	} catch (err) {
		log.warn(`chown ${target} failed: ${err.message}`);
	}
}

function ensureStorage() {
	const home = SANDBOX_HOST_HOME;
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
	// so chown it whenever we create it.
	const claudeDir = path.join(home, '.claude');
	const claudeDirIsNew = !fs.existsSync(claudeDir);
	fs.mkdirSync(claudeDir, { recursive: true });
	if (claudeDirIsNew) chownContainerUser(claudeDir);

	const codexDir = path.join(home, '.codex');
	const codexDirIsNew = !fs.existsSync(codexDir);
	fs.mkdirSync(codexDir, { recursive: true });
	if (codexDirIsNew) chownContainerUser(codexDir);
	const codexConfig = path.join(codexDir, 'config.toml');
	if (!fs.existsSync(codexConfig)) {
		fs.writeFileSync(codexConfig, SANDBOX_CODEX_CONFIG, { encoding: 'utf8', mode: 0o600 });
		chownContainerUser(codexConfig);
	}

	const claudiscordDir = path.join(home, STATE_DIR);
	const claudiscordDirIsNew = !fs.existsSync(claudiscordDir);
	fs.mkdirSync(claudiscordDir, { recursive: true });
	if (claudiscordDirIsNew) chownContainerUser(claudiscordDir);
	const jobsFile = path.join(home, STATE_DIR, JOBS_FILENAME);
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
		'--cpus', String(CONTAINER_CPUS),
		'--restart', 'unless-stopped',
		'-e', 'TZ=Europe/Paris',
		'-v', `${SANDBOX_HOST_HOME}:${SANDBOX_USER_HOME}`,
		DOCKER_IMAGE,
	);
	docker('start', CONTAINER_NAME);
	log.info(`Created and started container '${CONTAINER_NAME}'`);
}

// Sandbox environment for Claude: run `claude` inside the container with
// permissions skipped (the container IS the sandbox boundary). A factory because
// ensureContainer() must run before each use.
function sandboxClaudeEnv() {
	ensureContainer();
	const label = `Container [${CONTAINER_NAME}]`;
	return {
		label,
		extraArgs: ['--dangerously-skip-permissions'],
		spawn: args => spawnCollect(
			'docker', ['exec', '-i', CONTAINER_NAME, 'claude', ...args],
			{ label },
		),
	};
}

function isCodexAvailableInContainer() {
	if (!DOCKER_AVAILABLE) return false;
	try {
		ensureContainer();
		execFileSync('docker', [
			'exec',
			'-e', `CODEX_HOME=${path.posix.join(SANDBOX_USER_HOME, '.codex')}`,
			CONTAINER_NAME,
			'codex',
			'--version',
		], { stdio: 'ignore', timeout: 10000 });
		return true;
	} catch {
		return false;
	}
}

// Sandbox environment for Codex: run `codex` inside the container with CODEX_HOME
// pointing at the sandbox user's config. Missing-binary detection is env-specific
// (docker exec exits non-zero with a "not found" stderr rather than ENOENT).
function sandboxCodexEnv() {
	ensureContainer();
	const label = `Codex container [${CONTAINER_NAME}]`;
	const codexHome = path.posix.join(SANDBOX_USER_HOME, '.codex');
	return {
		label,
		spawn: (args, { input }) => spawnCollect(
			'docker',
			['exec', '-i', '-e', `CODEX_HOME=${codexHome}`, '-w', SANDBOX_USER_HOME,
				CONTAINER_NAME, 'codex', ...args],
			{ label, input },
		),
		isUnavailable: (execution) => execution.stderr.includes('executable file not found')
			|| execution.stderr.includes('codex: not found'),
	};
}

/**
 * Write an uploaded file into the sandbox volume's .claudiscord/files dir, then
 * chown it to the container's `claude` user so the non-root process can read it
 * through the bind-mount.
 */
function writeSandboxUpload(filename, buffer) {
	const dir = path.join(SANDBOX_HOST_HOME, STATE_DIR, 'files');
	const isNew = !fs.existsSync(dir);
	fs.mkdirSync(dir, { recursive: true });
	if (isNew) chownContainerUser(dir);
	const dest = path.join(dir, filename);
	fs.writeFileSync(dest, buffer);
	chownContainerUser(dest);
}

module.exports = {
	DOCKER_AVAILABLE,
	ensureImage,
	ensureContainer,
	sandboxClaudeEnv,
	isCodexAvailableInContainer,
	sandboxCodexEnv,
	writeSandboxUpload,
};
