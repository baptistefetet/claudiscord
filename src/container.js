const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
	CLAUDE_BIN,
	CODEX_BIN,
	SANDBOX_HOST_HOME,
	SANDBOX_USER_HOME,
	SANDBOX_CODEX_HOME,
	STATE_DIR,
	JOBS_FILENAME,
	CONTAINER_NAME,
	DOCKER_IMAGE,
	CONTAINER_CPUS,
	DOCKER_CMD_TIMEOUT,
} = require('./config');
const { getDefaultClaudeMd } = require('./prompts');
const { ensureDb } = require('./jobs-store');
const { spawnCollect, probeVersion } = require('./spawn');
const log = require('./logger');

const DOCKERFILE_DIR = path.resolve(__dirname, '..');
const SANDBOX_CODEX_CONFIG = `cli_auth_credentials_store = "file"
`;

// Where the host CLIs appear inside the container. The image reaches them
// through a wrapper at /usr/local/bin/claude reading CLAUDE_BIN_MOUNT, and a
// symlink /usr/local/bin/codex -> CODEX_SCOPE_MOUNT/codex/bin/codex.js.
const CLAUDE_BIN_MOUNT = '/opt/claude-bin';
const CODEX_SCOPE_MOUNT = '/opt/codex-scope';

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
		ensureDb(jobsFile);
		chownContainerUser(jobsFile);
	}
}

/**
 * Absolute host path of `bin`, following a PATH lookup for a bare name and the
 * whole symlink chain. null when it cannot be resolved.
 */
function resolveHostBin(bin) {
	try {
		const abs = bin.includes('/')
			? bin
			: execFileSync('which', [bin], { encoding: 'utf8', timeout: 5000 }).trim();
		return fs.realpathSync(abs);
	} catch {
		return null;
	}
}

/**
 * Mount source for the host Claude: the official installer's `versions/` dir,
 * of which the resolved binary is one `<semver>` file. The directory is the
 * source because an update writes a new file next to the old one and moves the
 * symlink — mounting the file would pin the container to the version present
 * at creation time. The image's wrapper picks the highest version at each run.
 *
 * null when the layout is not the installer's: `CLAUDE_BIN` accepts any path,
 * and mounting the parent of an arbitrary binary would expose whatever else
 * lives beside it to the sandbox.
 */
function claudeMountSource() {
	const claude = resolveHostBin(CLAUDE_BIN);
	if (!claude) {
		log.warn(`Claude binary not found at '${CLAUDE_BIN}' — sandbox Claude disabled`);
		return null;
	}
	const dir = path.dirname(claude);
	if (path.basename(dir) !== 'versions') {
		log.warn(`'${CLAUDE_BIN}' does not resolve into a Claude installer versions/ dir — sandbox Claude disabled`);
		return null;
	}
	// Read-only check: the container's non-root user must be able to traverse
	// the mount, which `scripts/rebuild-sandbox.sh` arranges once. Claudiscord
	// never changes host permissions itself — a sandbox prompt has no business
	// touching the admin environment's filesystem.
	if ((fs.statSync(dir).mode & 0o005) !== 0o005) {
		log.warn(`${dir} is not traversable by the container user — sandbox Claude will fail; rerun scripts/rebuild-sandbox.sh`);
	}
	return dir;
}

/**
 * Mount source for the host Codex: the `@openai` npm scope directory, the
 * resolved binary being `@openai/codex/bin/codex.js`. The scope rather than
 * the package because `npm install -g` replaces the package directory with a
 * fresh inode — a mount of the package would survive as a detached copy of the
 * version installed at creation time, while npm leaves the scope dir in place.
 * The launcher finds its vendored musl binary relative to itself, so the
 * package runs from any mount point.
 *
 * null unless the resolved path has exactly that layout, so an unusual
 * `CODEX_BIN` cannot mount an unrelated tree into the sandbox.
 */
function codexMountSource() {
	const codex = resolveHostBin(CODEX_BIN);
	if (!codex) {
		log.warn(`Codex binary '${CODEX_BIN}' not found — sandbox Codex disabled`);
		return null;
	}
	const pkgRoot = path.dirname(path.dirname(codex));
	const scope = path.dirname(pkgRoot);
	if (path.basename(codex) !== 'codex.js' || path.basename(pkgRoot) !== 'codex' || path.basename(scope) !== '@openai') {
		log.warn(`'${CODEX_BIN}' does not resolve into an @openai/codex npm package — sandbox Codex disabled`);
		return null;
	}
	return scope;
}

/**
 * `-v` flags exposing the host CLIs to the container, read-only. A source that
 * cannot be established is a warning: the container stays useful for the other
 * agent and for `!shell`.
 */
function hostBinMounts() {
	const mounts = [];
	const claude = claudeMountSource();
	if (claude) mounts.push('-v', `${claude}:${CLAUDE_BIN_MOUNT}:ro`);
	const codex = codexMountSource();
	if (codex) mounts.push('-v', `${codex}:${CODEX_SCOPE_MOUNT}:ro`);
	return mounts;
}

function ensureContainer() {
	if (!DOCKER_AVAILABLE) throw new Error('Docker is not installed on this host');
	ensureStorage();

	// Silencing stderr: a missing container makes `docker inspect` write a Go
	// template error that would otherwise reach journald.
	let state = null;
	try {
		state = dockerQuiet('inspect', '-f', '{{.State.Status}}', CONTAINER_NAME);
	} catch {
		// No such container — fall through and create it.
	}
	if (state === 'running') return;
	if (state) {
		// A start of its own can fail (a mount source that vanished, for one).
		// Letting that throw beats falling through to `docker create`, which
		// would only fail again on the name this container already holds.
		docker('start', CONTAINER_NAME);
		log.info(`Started existing container '${CONTAINER_NAME}'`);
		return;
	}

	docker(
		'create',
		'--name', CONTAINER_NAME,
		'--init',
		'--cpus', String(CONTAINER_CPUS),
		'--restart', 'unless-stopped',
		'-e', 'TZ=Europe/Paris',
		'-v', `${SANDBOX_HOST_HOME}:${SANDBOX_USER_HOME}`,
		...hostBinMounts(),
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
			'-e', `CODEX_HOME=${SANDBOX_CODEX_HOME}`,
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
	return {
		label,
		spawn: (args, { input }) => spawnCollect(
			'docker',
			['exec', '-i', '-e', `CODEX_HOME=${SANDBOX_CODEX_HOME}`, '-w', SANDBOX_USER_HOME,
				CONTAINER_NAME, 'codex', ...args],
			{ label, input },
		),
		isUnavailable: (execution) => execution.stderr.includes('executable file not found')
			|| execution.stderr.includes('codex: not found'),
	};
}

/**
 * Versions the agents report from inside the container. The read-only mounts
 * exist so these match the host's, so `/version` compares them and only speaks
 * up on a divergence — which is what a broken mount, a stale container or an
 * unreadable versions dir looks like from the outside.
 *
 * `{ error }` when the container itself cannot be reached.
 */
async function getSandboxVersions() {
	try {
		ensureContainer();
	} catch (err) {
		return { error: err.message };
	}
	const [claude, codex] = await Promise.all([
		probeVersion('docker', ['exec', CONTAINER_NAME, 'claude', '--version']),
		probeVersion('docker', [
			'exec', '-e', `CODEX_HOME=${SANDBOX_CODEX_HOME}`, CONTAINER_NAME, 'codex', '--version',
		]),
	]);
	return { claude, codex };
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
	getSandboxVersions,
	writeSandboxUpload,
};
