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
 * Deliberately unbounded: only the operator knows how long a given prompt should
 * take, so a run ends when it ends, or when `/stop` ends it. Interactive
 * commands (`apt install` without `-y`, ssh to an unknown host) therefore hang
 * until one of the two happens.
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
	} = options;

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
		const run = {
			label,
			cancelled: false,
			stop() {
				if (this.cancelled || exited) return false;
				this.cancelled = true;
				log.info(`Stopping ${label}`);
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

		const settle = () => {
			exited = true;
			unregisterRun(cancelKey, run);
			if (!run.cancelled) clearTimeout(killTimer);
		};

		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });

		child.on('close', (code) => {
			settle();
			if (stderr) log.warn(`${label} stderr:`, stderr.slice(0, 500));
			if (run.cancelled) {
				reject(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED', stdout, stderr }));
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
