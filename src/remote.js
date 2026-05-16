const { spawn } = require('child_process');
const { CLAUDE_BIN, CONTAINER_NAME, ADMIN_HOME } = require('./config');
const sessions = require('./sessions');
const log = require('./logger');

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;

// `claude --bg ... --remote-control <name>` prints `backgrounded · <agentId>`
// on stdout (8 lowercase hex chars). Anchored to start-of-line so a future
// trailing message can't trip us up.
const AGENT_ID_REGEX = /^backgrounded\s+·\s+([0-9a-f]{8})/m;

function spawnOnce(cmd, args, { timeoutMs, label, cwd }) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		child.stdin.end();
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			log.warn(`${label} timeout after ${timeoutMs}ms, sending SIGTERM`);
			child.kill('SIGTERM');
			setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
		}, timeoutMs);
		child.stdout.on('data', c => { stdout += c; });
		child.stderr.on('data', c => { stderr += c; });
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code: timedOut ? 124 : code });
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code: -1, errMessage: err.message });
		});
	});
}

/**
 * Start a remote-controlled background Claude session for a channel.
 * Spawns `claude --bg --remote-control <channelName>` (host or container) with
 * the channel's pre-allocated session UUID. Returns the 8-hex agent ID parsed
 * from stdout.
 *
 * Session flag follows the same rule as foreground prompts: --session-id for
 * the first invocation, --resume thereafter.
 */
async function startRemote({ mode, sessionId, sessionStarted, channelName }) {
	const sessionFlag = sessionStarted ? '--resume' : '--session-id';
	const claudeArgs = [sessionFlag, sessionId, '--bg', '--remote-control', channelName];

	let result;
	if (mode === 'admin') {
		result = await spawnOnce(CLAUDE_BIN, claudeArgs, { timeoutMs: START_TIMEOUT_MS, label: 'remote-start admin', cwd: ADMIN_HOME });
	} else if (mode === 'sandbox') {
		result = await spawnOnce('docker', ['exec', CONTAINER_NAME, 'claude', ...claudeArgs], { timeoutMs: START_TIMEOUT_MS, label: 'remote-start sandbox' });
	} else {
		throw new Error(`Unknown mode: ${mode}`);
	}

	if (result.code !== 0) {
		const tail = ((result.stdout || '') + (result.stderr || '')).slice(-500) || result.errMessage || `exit code ${result.code}`;
		throw new Error(`remote start failed: ${tail.trim()}`);
	}

	const match = result.stdout.match(AGENT_ID_REGEX);
	if (!match) {
		const tail = ((result.stdout || '') + (result.stderr || '')).slice(-500);
		throw new Error(`remote start: no agent ID in output: ${tail.trim()}`);
	}
	log.info(`Remote started: mode=${mode} agentId=${match[1]} session=${sessionId}`);
	return match[1];
}

/**
 * Stop a remote session by agent ID. We consider any return "best effort": the
 * CLI sometimes prints "couldn't confirm…" yet the daemon log shows the stop
 * is effective. The caller clears the channel's remoteId regardless.
 */
async function stopRemote({ mode, remoteId }) {
	let result;
	if (mode === 'admin') {
		result = await spawnOnce(CLAUDE_BIN, ['stop', remoteId], { timeoutMs: STOP_TIMEOUT_MS, label: 'remote-stop admin', cwd: ADMIN_HOME });
	} else if (mode === 'sandbox') {
		result = await spawnOnce('docker', ['exec', CONTAINER_NAME, 'claude', 'stop', remoteId], { timeoutMs: STOP_TIMEOUT_MS, label: 'remote-stop sandbox' });
	} else {
		throw new Error(`Unknown mode: ${mode}`);
	}
	const summary = (result.stdout + result.stderr).trim().slice(0, 200);
	log.info(`Remote stop ${remoteId} (mode=${mode}): exit=${result.code} ${summary}`);
	return result.code === 0;
}

/**
 * On startup, every channel with a remoteId is stale (the daemon may or may
 * not still be alive). Best-effort stop + clear. Failures are expected (machine
 * reboot → daemon gone) and logged at info level.
 */
async function reconcileRemotes() {
	const remotes = sessions.listRemoteChannels();
	if (remotes.length === 0) return;
	log.info(`reconcileRemotes: ${remotes.length} stale remote(s) to settle`);
	for (const { channelId, mode, remoteId } of remotes) {
		try {
			await stopRemote({ mode, remoteId });
		} catch (err) {
			log.info(`reconcileRemotes: stop failed for ${remoteId} (already gone?): ${err.message}`);
		}
		sessions.setRemoteId(channelId, null);
	}
}

module.exports = { startRemote, stopRemote, reconcileRemotes };
