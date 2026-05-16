const { spawn } = require('child_process');
const { CLAUDE_BIN, CONTAINER_NAME, ADMIN_HOME } = require('./config');
const sessions = require('./sessions');
const log = require('./logger');

// Sandbox CPU is capped at 1 core; under load the claude daemon can take 15+s
// to claim a spare worker, so we allow a generous window. `earlyMatch` keeps
// the common case (instant agent ID on stdout) fast.
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 15_000;

// `claude --bg ... --remote-control <name>` prints `backgrounded · <agentId>`
// on stdout (8 lowercase hex chars). Anchored to start-of-line so a future
// trailing message can't trip us up.
const AGENT_ID_REGEX = /^backgrounded\s+·\s+([0-9a-f]{8})/m;

// `claude stop <id>` prints one of these on success/no-op. We match early so a
// sandbox `docker exec` that hangs on the wrapper pipe doesn't keep us waiting
// the full timeout.
const STOP_DONE_REGEX = /(?:^|\b)(stopped|couldn't confirm|not found|already stopped)\b/im;

/**
 * Spawn a one-shot wrapper command. When `earlyMatch` matches against stdout
 * we SIGTERM the wrapper immediately and treat it as success — this matters
 * for `docker exec claude --bg ...` (and `claude stop` in sandbox), where the
 * in-container daemon inherits the docker exec pipe and keeps the wrapper
 * alive until we hit the timeout. SIGTERMing the docker exec wrapper does
 * NOT kill the in-container daemon (same mechanism leveraged by
 * `executeClaudeInContainer`), so the started session survives.
 */
function spawnOnce(cmd, args, { timeoutMs, label, cwd, earlyMatch }) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		child.stdin.end();
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let earlyMatched = false;
		const timer = setTimeout(() => {
			timedOut = true;
			log.warn(`${label} timeout after ${timeoutMs}ms, sending SIGTERM`);
			child.kill('SIGTERM');
			setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
		}, timeoutMs);
		child.stdout.on('data', c => {
			stdout += c;
			if (earlyMatch && !earlyMatched && earlyMatch.test(stdout)) {
				earlyMatched = true;
				clearTimeout(timer);
				log.info(`${label}: success detected on stdout, unhooking wrapper`);
				child.kill('SIGTERM');
				setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 1000);
			}
		});
		child.stderr.on('data', c => { stderr += c; });
		child.on('close', (code) => {
			clearTimeout(timer);
			// earlyMatched → success (we killed the wrapper ourselves).
			// timedOut → no output AND no exit → real failure.
			const finalCode = earlyMatched ? 0 : (timedOut ? 124 : code);
			resolve({ stdout, stderr, code: finalCode });
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code: -1, errMessage: err.message });
		});
	});
}

/**
 * Start a remote-controlled background Claude session for a channel. Spawns
 * `claude --bg [--resume <uuid>] --remote-control <channelName>` (host or
 * container) and returns the 8-hex agent ID parsed from stdout.
 *
 * When sessionId+sessionStarted are passed, `--resume` makes `--bg` copy the
 * existing Discord conversation into its newly-allocated bg JSONL — so the
 * mobile user starts with the Discord history. `--bg` warns "--bg manages
 * the session id; ignoring --session-id" and allocates its own UUID, which
 * is why we don't bother trying to thread the UUID through; the caller wipes
 * the channel's Discord sessionId so the next post-stop Discord message
 * starts fresh.
 */
async function startRemote({ mode, sessionId, sessionStarted, channelName }) {
	const claudeArgs = ['--bg'];
	if (sessionId && sessionStarted) claudeArgs.push('--resume', sessionId);
	claudeArgs.push('--remote-control', channelName);

	let result;
	if (mode === 'admin') {
		result = await spawnOnce(CLAUDE_BIN, claudeArgs, { timeoutMs: START_TIMEOUT_MS, label: 'remote-start admin', cwd: ADMIN_HOME, earlyMatch: AGENT_ID_REGEX });
	} else if (mode === 'sandbox') {
		result = await spawnOnce('docker', ['exec', CONTAINER_NAME, 'claude', ...claudeArgs], { timeoutMs: START_TIMEOUT_MS, label: 'remote-start sandbox', earlyMatch: AGENT_ID_REGEX });
	} else {
		throw new Error(`Unknown mode: ${mode}`);
	}

	// Agent ID first: a successful start in sandbox can return with non-zero
	// exit (wrapper SIGTERM) yet still have created the session — the only
	// reliable success signal is the parsed agent ID.
	const match = result.stdout.match(AGENT_ID_REGEX);
	if (match) {
		log.info(`Remote started: mode=${mode} agentId=${match[1]}`);
		return match[1];
	}

	const tail = ((result.stdout || '') + (result.stderr || '')).slice(-500) || result.errMessage || `exit code ${result.code}`;
	throw new Error(`remote start failed: ${tail.trim()}`);
}

/**
 * Stop a remote session by agent ID. We consider any return "best effort": the
 * CLI sometimes prints "couldn't confirm…" yet the daemon log shows the stop
 * is effective. The caller clears the channel's remoteId regardless.
 */
async function stopRemote({ mode, remoteId }) {
	let result;
	if (mode === 'admin') {
		result = await spawnOnce(CLAUDE_BIN, ['stop', remoteId], { timeoutMs: STOP_TIMEOUT_MS, label: 'remote-stop admin', cwd: ADMIN_HOME, earlyMatch: STOP_DONE_REGEX });
	} else if (mode === 'sandbox') {
		result = await spawnOnce('docker', ['exec', CONTAINER_NAME, 'claude', 'stop', remoteId], { timeoutMs: STOP_TIMEOUT_MS, label: 'remote-stop sandbox', earlyMatch: STOP_DONE_REGEX });
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
