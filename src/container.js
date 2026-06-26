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
	extractClaudeResultText,
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

// Numeric "freshness" of an agent's credentials file: higher means more
// recently refreshed, so it holds the live rotating token (the provider rotates
// it on use, stranding the older copy). Missing, unreadable, unparsable, or
// credential-less files return -Infinity so they always lose and get repaired.
function credentialFreshness(agent, filePath) {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		if (agent === 'codex') {
			if (!parsed.tokens?.access_token && !parsed.OPENAI_API_KEY) return -Infinity;
			const t = Date.parse(parsed.last_refresh);
			return Number.isNaN(t) ? 0 : t; // static API key / no timestamp: present but unrotated
		}
		const oauth = parsed.claudeAiOauth;
		if (!oauth?.accessToken || typeof oauth.expiresAt !== 'number') return -Infinity;
		return oauth.expiresAt;
	} catch {
		return -Infinity;
	}
}

// Align an agent's host and sandbox credentials before a run so it starts with
// the freshest copy. Both share one account, and only the most recently
// refreshed file holds a live token, so we overwrite the staler side (a missing
// or corrupt file is -Infinity and is repaired here — this subsumes seeding).
// Executions are serialized through the global queue, so there is no concurrent
// refresh; the copy is skipped when contents already match, so it never loops. A
// destination whose parent dir is absent (environment not provisioned yet) is
// left untouched.
function reconcileAgentCredentials(agent) {
	try {
		if (!SANDBOX_HOST_HOME) return;
		const rel = agent === 'codex'
			? path.join('.codex', 'auth.json')
			: path.join('.claude', '.credentials.json');
		const hostPath = path.join(ADMIN_USER_HOME, rel);
		const sandboxPath = path.join(SANDBOX_HOST_HOME, rel);

		const hostFresh = credentialFreshness(agent, hostPath);
		const sandboxFresh = credentialFreshness(agent, sandboxPath);
		if (hostFresh === -Infinity && sandboxFresh === -Infinity) return;

		const [from, to, uid, gid] = sandboxFresh > hostFresh
			? [sandboxPath, hostPath, 0, 0]
			: [hostPath, sandboxPath, SANDBOX_UID, SANDBOX_GID];
		if (!fs.existsSync(path.dirname(to))) return;

		const fromBuf = fs.readFileSync(from);
		let toBuf = null;
		try { toBuf = fs.readFileSync(to); } catch { /* absent: created below */ }
		if (toBuf && fromBuf.equals(toBuf)) return;

		writeFileAtomicOwned(to, fromBuf, uid, gid);
		log.info(`Reconciled ${agent} credentials: ${from === hostPath ? 'host -> sandbox' : 'sandbox -> host'}`);
	} catch (err) {
		log.warn(`reconcileAgentCredentials(${agent}) failed: ${err.message}`);
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

	reconcileAgentCredentials('claude');
	reconcileAgentCredentials('codex');
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
		const errMsg = extractClaudeResultText(result.stdout)
			|| result.stderr?.slice(-500)
			|| `exit code ${result.code}`;
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
	reconcileAgentCredentials,
};
