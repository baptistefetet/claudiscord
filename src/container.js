const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
	ADMIN_USER_HOME,
	SANDBOX_HOST_HOME,
	SANDBOX_USER_HOME,
	STATE_DIR,
	JOBS_FILENAME,
	CONTAINER_NAME,
	DOCKER_IMAGE,
	CONTAINER_CPUS,
	PROMPT_TIMEOUT_MS,
	DOCKER_CMD_TIMEOUT,
	ALLOWED_TOOLS,
	DISALLOWED_TOOLS,
	CODEX_REASONING_EFFORT,
} = require('./config');
const { getDefaultClaudeMd } = require('./prompts');
const {
	buildClaudeArgs,
	spawnWithTimeout,
	extractClaudeSessionId,
	hasResultEvent,
	parseClaudeOutput,
} = require('./claude');
const {
	buildCodexArgs,
	parseCodexOutput,
} = require('./codex');
const log = require('./logger');

const DOCKERFILE_DIR = path.resolve(__dirname, '..');
const SANDBOX_CODEX_CONFIG = `cli_auth_credentials_store = "file"
model_reasoning_effort = "${CODEX_REASONING_EFFORT}"
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

function writeSandboxCredentials(credentialsJson) {
	const credPath = path.join(SANDBOX_HOST_HOME, '.claude', '.credentials.json');
	const tmp = `${credPath}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(tmp, credentialsJson, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
		fs.renameSync(tmp, credPath);
		fs.chmodSync(credPath, 0o600);
		execFileSync('chown', [`${SANDBOX_UID}:${SANDBOX_GID}`, credPath], { timeout: 5000 });
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

function writeSandboxCodexAuth(authJson) {
	const authPath = path.join(SANDBOX_HOST_HOME, '.codex', 'auth.json');
	const tmp = `${authPath}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(tmp, authJson, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
		fs.renameSync(tmp, authPath);
		fs.chmodSync(authPath, 0o600);
		execFileSync('chown', [`${SANDBOX_UID}:${SANDBOX_GID}`, authPath], { timeout: 5000 });
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

function seedCredentialsFromHost() {
	const sandboxCredPath = path.join(SANDBOX_HOST_HOME, '.claude', '.credentials.json');
	if (fs.existsSync(sandboxCredPath)) return false;

	const hostCredPath = path.join(ADMIN_USER_HOME, '.claude', '.credentials.json');
	let credentialsJson;
	try {
		credentialsJson = fs.readFileSync(hostCredPath, 'utf8');
		const parsed = JSON.parse(credentialsJson);
		if (!parsed.claudeAiOauth?.accessToken) {
			log.warn(`Host credentials at ${hostCredPath} are missing claudeAiOauth.accessToken`);
			return false;
		}
	} catch (err) {
		if (err.code !== 'ENOENT') {
			log.warn(`Could not read host credentials at ${hostCredPath}: ${err.message}`);
		}
		return false;
	}

	writeSandboxCredentials(credentialsJson);
	log.info('Seeded sandbox credentials from host');
	return true;
}

function seedCodexCredentialsFromHost() {
	const sandboxAuthPath = path.join(SANDBOX_HOST_HOME, '.codex', 'auth.json');
	if (fs.existsSync(sandboxAuthPath)) return false;

	const hostAuthPath = path.join(ADMIN_USER_HOME, '.codex', 'auth.json');
	let authJson;
	try {
		authJson = fs.readFileSync(hostAuthPath, 'utf8');
		const parsed = JSON.parse(authJson);
		const hasApiKey = typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY;
		const hasAccessToken = typeof parsed.tokens?.access_token === 'string' && parsed.tokens.access_token;
		if (!hasApiKey && !hasAccessToken) {
			log.warn(`Host Codex credentials at ${hostAuthPath} contain no usable credential`);
			return false;
		}
	} catch (err) {
		if (err.code !== 'ENOENT') {
			log.warn(`Could not read host Codex credentials at ${hostAuthPath}: ${err.message}`);
		}
		return false;
	}

	writeSandboxCodexAuth(authJson);
	log.info('Seeded sandbox Codex credentials from host');
	return true;
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

	seedCredentialsFromHost();
	seedCodexCredentialsFromHost();
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

/**
 * Kill all non-essential processes inside the container (cleanup after timeout).
 * Killing docker exec only kills the host-side pipe, not the container process.
 * With --init, PID 1 is tini; we also spare the 'sleep' process that keeps the container alive.
 */
function killAgentProcessesInContainer(label) {
	try {
		execFileSync('docker', ['exec', CONTAINER_NAME, 'sh', '-c',
			'for proc in /proc/[0-9]*; do pid=${proc#/proc/}; [ "$pid" = 1 ] && continue; [ "$pid" = "$$" ] && continue; comm=$(cat "$proc/comm" 2>/dev/null || true); [ "$comm" = "sleep" ] && continue; kill -9 "$pid" 2>/dev/null || true; done; true',
		], { timeout: 5000 });
		log.info(`${label}: killed orphaned processes`);
	} catch {
		// Process already dead or nothing to kill — either way, fine
	}
}

async function spawnClaudeInContainer(prompt, claudeOptions, {
		timeoutMs = PROMPT_TIMEOUT_MS,
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
			// Timeout: docker exec was killed but the agent may still run inside the container
			killAgentProcessesInContainer(label);
		}
		throw err;
	}
}

// Delete a sandbox agent's credentials file so the next run re-seeds it from the
// host (the seed* functions seed when the file is absent). Called only after an
// AUTHENTICATION failure (the run never reached the API): the token expired and
// the in-container CLI could not refresh it, so re-seeding from the host self-heals
// on the next run. A run that authenticated but errored afterwards (e.g. a usage
// limit) must NOT come here — its credentials are valid.
function dropSandboxAuthFile(relPath, label) {
	const target = path.join(SANDBOX_HOST_HOME, relPath);
	try {
		fs.rmSync(target, { force: true });
		log.warn(`Removed sandbox ${label} after a failed run; it will be re-seeded from the host on the next run`);
	} catch (err) {
		log.warn(`Failed to remove sandbox ${label}: ${err.message}`);
	}
}

// Atomically write `buf` to `target`, then set mode 0600 and ownership.
function writeFileAtomicOwned(target, buf, uid, gid) {
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(tmp, buf, { mode: 0o600, flag: 'wx' });
		fs.renameSync(tmp, target);
		fs.chmodSync(target, 0o600);
		fs.chownSync(target, uid, gid);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

// Keep an agent's host and sandbox credentials in sync. Both share one account,
// and the provider rotates the refresh token on use, so whichever side refreshed
// last holds the only valid token and the other copy goes stale. Called after a
// SUCCESSFUL run (so the credentials used were valid): if that run refreshed its
// token, propagate the file to the other side, so the next run — host or sandbox
// — starts with the current token. Executions are serialized through the global
// queue, so there is never a concurrent refresh. The mtime only decides the
// direction; the copy is skipped when the contents already match, so it never
// loops.
function syncAgentCredentials(agent) {
	try {
		if (!SANDBOX_HOST_HOME) return;
		const rel = agent === 'codex'
			? path.join('.codex', 'auth.json')
			: path.join('.claude', '.credentials.json');
		const hostPath = path.join(ADMIN_USER_HOME, rel);
		const sandboxPath = path.join(SANDBOX_HOST_HOME, rel);

		let hostStat, sandboxStat;
		try { hostStat = fs.statSync(hostPath); } catch { return; }
		try { sandboxStat = fs.statSync(sandboxPath); } catch { return; }

		const hostBuf = fs.readFileSync(hostPath);
		const sandboxBuf = fs.readFileSync(sandboxPath);
		if (hostBuf.equals(sandboxBuf)) return;

		if (sandboxStat.mtimeMs > hostStat.mtimeMs) {
			writeFileAtomicOwned(hostPath, sandboxBuf, 0, 0);
			log.info(`Synced ${agent} credentials: sandbox -> host`);
		} else {
			writeFileAtomicOwned(sandboxPath, hostBuf, SANDBOX_UID, SANDBOX_GID);
			log.info(`Synced ${agent} credentials: host -> sandbox`);
		}
	} catch (err) {
		log.warn(`syncAgentCredentials(${agent}) failed: ${err.message}`);
	}
}

async function executeClaudeInContainer(prompt, {
		sessionId = null,
		systemPrompt = null,
		allowedTools = ALLOWED_TOOLS,
		disallowedTools = DISALLOWED_TOOLS,
		model = null,
		effort = null,
		timeoutMs = PROMPT_TIMEOUT_MS,
	} = {}) {
	ensureContainer();
	const claudeOptions = {
		sessionId,
		systemPrompt,
		allowedTools,
		disallowedTools,
		model,
		effort,
		extraArgs: ['--dangerously-skip-permissions'],
	};

	const label = `Container [${CONTAINER_NAME}]`;
	const attach = sessionId ? `resume ${sessionId}` : 'new session';
	log.info(`${label}: ${attach}, prompt length: ${prompt.length}`);

	let result;
	try {
		result = await spawnClaudeInContainer(prompt, claudeOptions, { timeoutMs, label });
	} catch (err) {
		err.sessionId = extractClaudeSessionId(err.stdout);
		throw err;
	}

	if (result.code !== 0) {
		if (hasResultEvent(result.stdout)) {
			// Authenticated but the turn errored (e.g. a usage/credit limit). The
			// credentials are valid — keep them and propagate any token rotation to
			// the host so the shared account is never stranded with a spent refresh
			// token. Dropping here was the bug that forced a host re-login.
			syncAgentCredentials('claude');
		} else {
			// No completed turn: most likely an expired sandbox token the in-container
			// CLI can no longer refresh. Drop the credentials so the next run re-seeds
			// them from the host.
			dropSandboxAuthFile(path.join('.claude', '.credentials.json'), 'Claude credentials');
		}
		const errMsg = result.stdout.slice(-500) || `exit code ${result.code}`;
		throw Object.assign(new Error(errMsg), {
			code: result.code,
			sessionId: extractClaudeSessionId(result.stdout),
		});
	}

	return parseClaudeOutput(result.stdout, label);
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

async function executeCodexInContainer(prompt, {
		sessionId = null,
		systemPrompt = null,
		timeoutMs = PROMPT_TIMEOUT_MS,
	} = {}) {
	ensureContainer();
	if (!systemPrompt) {
		throw new Error('executeCodexInContainer requires systemPrompt');
	}

	const label = `Codex container [${CONTAINER_NAME}]`;
	const attach = sessionId ? `resume ${sessionId}` : 'new session';
	log.info(`${label}: ${attach}, prompt length: ${prompt.length}`);

	let execution;
	try {
		execution = await spawnWithTimeout(
			'docker',
			[
				'exec',
				'-i',
				'-e', `CODEX_HOME=${path.posix.join(SANDBOX_USER_HOME, '.codex')}`,
				'-w', SANDBOX_USER_HOME,
				CONTAINER_NAME,
				'codex',
				...buildCodexArgs({ sessionId, systemPrompt }),
			],
			{
				timeoutMs,
				label,
				input: prompt,
			},
		);
	} catch (err) {
		err.sessionId = parseCodexOutput(err.stdout).sessionId;
		if (err.code === 124) killAgentProcessesInContainer(label);
		throw err;
	}

	const parsed = parseCodexOutput(execution.stdout);
	if (execution.code !== 0) {
		const unavailable = execution.stderr.includes('executable file not found')
			|| execution.stderr.includes('codex: not found');
		if (unavailable) {
			throw Object.assign(new Error('CODEX_NOT_AVAILABLE'), {
				code: 'CODEX_NOT_AVAILABLE',
				sessionId: parsed.sessionId,
			});
		}
		// Mirror the Claude path. A thread id means Codex authenticated and the run
		// reached the API (e.g. a usage/credit limit) — keep the auth and sync any
		// rotated token. Its absence points at an unrefreshable token, so drop the
		// auth to re-seed from the host on the next run.
		if (parsed.sessionId) {
			syncAgentCredentials('codex');
		} else {
			dropSandboxAuthFile(path.join('.codex', 'auth.json'), 'Codex auth');
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
		log.warn(`${label}: no thread.started event in JSON output`);
	}

	return parsed;
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
	executeClaudeInContainer,
	isCodexAvailableInContainer,
	executeCodexInContainer,
	writeSandboxUpload,
	syncAgentCredentials,
};
