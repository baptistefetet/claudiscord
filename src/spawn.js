const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { KILL_GRACE_MS } = require('./config');
const { registerRun, unregisterRun } = require('./queue');
const log = require('./logger');

const VERSION_TIMEOUT_MS = 10_000;

/**
 * Spawn a command with stdout/stderr collection, resolving on exit.
 * Returns { stdout, stderr, code }.
 *
 * Unbounded unless `timeoutMs` says otherwise: only the operator knows how long
 * a given prompt should take, so an interactive run ends when it ends, or when
 * `/stop` ends it. Scheduled runs pass a deadline instead — nobody is watching
 * them. A run past its deadline rejects with code TIMEOUT rather than
 * CANCELLED, so a failure is not read as a decision.
 *
 * `cancelKey` (a channelId) publishes the run to `runs.js` so `/stop` can reach
 * it; a cancelled run rejects with code CANCELLED, carrying the output produced
 * so far so the caller can still recover the session id from it.
 *
 * `killInContainer` is the sandbox's other half: `docker exec` leaves the
 * process it started in the container running when its client dies, so the
 * local kill alone would orphan the agent. `detached` is the host's: it puts
 * the CLI in its own process group so a stop reaches the tools it spawned.
 *
 * Agent-agnostic: used by the Claude, Codex and container executors alike.
 */
function spawnCollect(cmd, args, options = {}) {
	const {
		cwd,
		env,
		label = 'process',
		input = null,
		cancelKey = null,
		killInContainer = null,
		detached = false,
		timeoutMs = 0,
		// How `/stop` reports killing this run. A job fires unannounced, so the
		// defaults must not be the only wording available: someone who started no
		// prompt would be told their prompt was stopped.
		stopInfo = {},
	} = options;
	const stopLabel = stopInfo.label || 'the current prompt';
	const stopNote = stopInfo.note || 'the conversation is intact';

	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd,
			env,
			detached,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		child.stdin.on('error', () => {});
		child.stdin.end(input === null ? undefined : input);

		let stdout = '';
		let stderr = '';

		let exited = false;

		// A detached child leads its own process group, so the signal reaches the
		// tools the CLI spawned and not just the CLI.
		const signalLocal = (signal) => {
			if (exited) return;
			try {
				if (detached) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch { /* already gone */ }
		};

		let killTimer = null;
		let timeoutTimer = null;
		// Resolved once the child is really gone, so `/stop` can answer after the
		// fact instead of announcing an intention it cannot vouch for.
		let markSettled;
		const settled = new Promise(resolve => { markSettled = resolve; });

		const run = {
			label,
			stopLabel,
			stopNote,
			settled,
			cancelled: false,
			timedOut: false,
			// `reason` distinguishes the operator's `/stop` from the deadline, so
			// the caller can tell a decision from a failure.
			stop(reason = 'user') {
				if (this.cancelled || exited) return false;
				this.cancelled = true;
				this.timedOut = reason === 'timeout';
				log.info(`Stopping ${label}${this.timedOut ? ' (timeout)' : ''}`);
				signalLocal('SIGTERM');
				if (killInContainer) killInContainer('TERM');
				// The escalation is NOT cleared when the local child exits. Killing a
				// `docker exec` client is instant and says nothing about the process
				// it started in the container, so the container-side SIGKILL has to
				// survive that exit to be worth anything.
				killTimer = setTimeout(() => {
					signalLocal('SIGKILL');
					if (killInContainer) killInContainer('KILL');
				}, KILL_GRACE_MS);
				killTimer.unref?.();
				return true;
			},
		};
		registerRun(cancelKey, run);

		if (timeoutMs > 0) {
			timeoutTimer = setTimeout(() => run.stop('timeout'), timeoutMs);
			timeoutTimer.unref?.();
		}

		const settle = () => {
			exited = true;
			unregisterRun(cancelKey, run);
			clearTimeout(timeoutTimer);
			if (!run.cancelled) clearTimeout(killTimer);
			markSettled();
		};

		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });

		child.on('close', (code) => {
			settle();
			if (stderr) log.warn(`${label} stderr:`, stderr.slice(0, 500));
			if (run.cancelled) {
				const code = run.timedOut ? 'TIMEOUT' : 'CANCELLED';
				reject(Object.assign(new Error(code), { code, stdout, stderr }));
				return;
			}
			resolve({ stdout, stderr, code });
		});

		child.on('error', (err) => {
			settle();
			err.stdout = stdout;
			err.stderr = stderr;
			reject(err);
		});
	});
}

/**
 * Version number printed by an agent CLI, null when the probe fails. Keeps the
 * number only: `claude --version` prints "2.1.195 (Claude Code)", `codex
 * --version` prints "codex-cli 0.5.0". Backs getClaudeVersion/getCodexVersion.
 */
async function probeVersion(cmd, args, options = {}) {
	try {
		const { stdout } = await execFileAsync(cmd, args, {
			encoding: 'utf8',
			timeout: VERSION_TIMEOUT_MS,
			...options,
		});
		return (stdout.match(/\d+(?:\.\d+)+/) || [])[0] || null;
	} catch {
		return null;
	}
}

module.exports = { spawnCollect, probeVersion };
