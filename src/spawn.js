const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { KILL_GRACE_MS } = require('./config');
const { registerRun, unregisterRun } = require('./queue');
const log = require('./logger');

const VERSION_TIMEOUT_MS = 10_000;

/**
 * SIGTERM a child, then SIGKILL it KILL_GRACE_MS later. A detached child leads
 * its own process group, so the signal reaches the tools the CLI spawned and not
 * just the CLI.
 *
 * `killInContainer` is the sandbox's other half: `docker exec` leaves the
 * process it started in the container running when its client dies, so the
 * local kill alone would orphan the agent. The escalation is NOT cancelled when
 * the local child exits: killing a `docker exec` client is instant and says
 * nothing about the process it started in the container, so the container-side
 * SIGKILL has to survive that exit to be worth anything.
 */
function terminate(child, { detached = false, killInContainer = null } = {}) {
	const signalLocal = (signal) => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			if (detached) process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch { /* already gone */ }
	};
	signalLocal('SIGTERM');
	if (killInContainer) killInContainer('TERM');
	const timer = setTimeout(() => {
		signalLocal('SIGKILL');
		if (killInContainer) killInContainer('KILL');
	}, KILL_GRACE_MS);
	timer.unref?.();
}

// Feeds decoded stdout chunks in, calls `emit` once per complete non-blank
// line. Cuts at the last newline instead of splitting the whole accumulator on
// every chunk: the remainder then never grows past a single line.
function lineSplitter(emit) {
	let pending = '';
	return {
		push(chunk) {
			pending += chunk;
			const cut = pending.lastIndexOf('\n');
			if (cut === -1) return;
			const complete = pending.slice(0, cut);
			pending = pending.slice(cut + 1);
			for (const line of complete.split('\n')) {
				if (line.trim()) emit(line);
			}
		},
		// A last event without its trailing newline is still an event.
		flush() {
			if (pending.trim()) emit(pending);
			pending = '';
		},
	};
}

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
 * `cancelKey` (a channelId) publishes the run to `queue.js` so `/stop` can reach
 * it; a cancelled run rejects with code CANCELLED, carrying the output produced
 * so far so the caller can still recover the session id from it.
 *
 * `killInContainer` and `detached` are how a stop reaches the whole agent, in
 * the container and on the host respectively (see terminate()).
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
		// Called with each complete stdout line as it arrives. Both agents emit
		// one JSON event per line, which is what makes progress relayable at all.
		onLine = null,
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
				terminate(child, { detached, killInContainer });
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
			markSettled();
		};

		// Decoded by the stream, not by coercing each Buffer: a multi-byte
		// character split across two chunks would otherwise decode as two
		// replacement characters, in the collected stdout as much as in onLine.
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');

		// A caller's progress line must never take the run down with it.
		const emitLine = (line) => {
			try { onLine(line); } catch (err) { log.warn(`${label} onLine failed:`, err.message); }
		};

		const lines = onLine ? lineSplitter(emitLine) : null;
		child.stdout.on('data', chunk => {
			stdout += chunk;
			lines?.push(chunk);
		});
		child.stderr.on('data', chunk => { stderr += chunk; });

		child.on('close', (code) => {
			lines?.flush();
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
 * Spawn an agent process that outlives a single prompt: each `send()` writes one
 * turn to its stdin and resolves when `isTurnEnd(line)` matches a stdout line,
 * leaving the process up for the next one. That is what spares a prompt the
 * CLI's startup and session load (most of a simple voice question's latency).
 *
 * A turn resolves `{ stdout, stderr, code }` like spawnCollect, with only the
 * turn's own output: `code` is null when the turn ended and the process lives
 * on, the exit code when the process died mid-turn. `/stop` and a deadline kill
 * the whole process, not just the turn (the CLI's own interrupt would leave a
 * process whose state nobody can vouch for), so a cancelled turn rejects
 * CANCELLED / TIMEOUT exactly as a spawnCollect run does.
 *
 * Lines written between turns belong to no prompt and are dropped. `exited`
 * resolves once the process is gone, whatever ended it; `close()` ends it
 * gracefully (stdin EOF), escalating to terminate() if it lingers.
 */
function spawnResident(cmd, args, options = {}) {
	const {
		cwd,
		env,
		label = 'process',
		killInContainer = null,
		detached = false,
		isTurnEnd,
	} = options;

	const child = spawn(cmd, args, {
		cwd,
		env,
		detached,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	child.stdin.on('error', () => {});
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');

	let gone = false;
	let closing = false;
	let markExited;
	const exited = new Promise(resolve => { markExited = resolve; });
	// The current turn: { stdout, stderr, onLine, run, timeoutTimer, resolve, reject }.
	let turn = null;
	// stderr written between turns, logged with the next turn or the exit.
	let idleStderr = '';

	const endTurn = () => {
		const ended = turn;
		turn = null;
		unregisterRun(ended.cancelKey, ended.run);
		clearTimeout(ended.timeoutTimer);
		if (ended.stderr) log.warn(`${label} stderr:`, ended.stderr.slice(0, 500));
		return ended;
	};

	const lines = lineSplitter((line) => {
		if (!turn) return;
		turn.stdout += `${line}\n`;
		if (turn.onLine) {
			// A caller's progress line must never take the run down with it.
			try { turn.onLine(line); } catch (err) { log.warn(`${label} onLine failed:`, err.message); }
		}
		if (isTurnEnd(line)) {
			const { stdout, stderr, resolve } = endTurn();
			resolve({ stdout, stderr, code: null });
		}
	});
	child.stdout.on('data', chunk => lines.push(chunk));
	child.stderr.on('data', chunk => {
		if (turn) turn.stderr += chunk;
		else idleStderr += chunk;
	});

	const onGone = (code, err = null) => {
		if (gone) return;
		gone = true;
		lines.flush();
		if (idleStderr) log.warn(`${label} stderr:`, idleStderr.slice(0, 500));
		if (turn) {
			const { stdout, stderr, run, resolve, reject } = endTurn();
			if (err) reject(Object.assign(err, { stdout, stderr }));
			else if (run.cancelled) {
				const reason = run.timedOut ? 'TIMEOUT' : 'CANCELLED';
				reject(Object.assign(new Error(reason), { code: reason, stdout, stderr }));
			} else resolve({ stdout, stderr, code });
		}
		markExited();
	};
	child.on('close', code => onGone(code));
	// A spawn failure (ENOENT) may never be followed by 'close'.
	child.on('error', err => onGone(null, err));

	return {
		label,
		exited,
		// Can take a turn: not dead, not on its way out.
		get alive() { return !gone && !closing; },
		get busy() { return turn !== null; },

		/**
		 * Write one turn (`input`, newline-terminated) and wait for its end. Same
		 * `cancelKey` / `timeoutMs` / `stopInfo` / `onLine` as spawnCollect.
		 */
		send(input, { cancelKey = null, timeoutMs = 0, stopInfo = {}, onLine = null } = {}) {
			if (turn) return Promise.reject(new Error(`${label}: a turn is already running`));
			if (gone || closing) return Promise.reject(new Error(`${label}: process has exited`));
			return new Promise((resolve, reject) => {
				const run = {
					label,
					stopLabel: stopInfo.label || 'the current prompt',
					stopNote: stopInfo.note || 'the conversation is intact',
					settled: exited,
					cancelled: false,
					timedOut: false,
					stop(reason = 'user') {
						if (this.cancelled || turn?.run !== this) return false;
						this.cancelled = true;
						this.timedOut = reason === 'timeout';
						log.info(`Stopping ${label}${this.timedOut ? ' (timeout)' : ''}`);
						terminate(child, { detached, killInContainer });
						return true;
					},
				};
				if (idleStderr) log.warn(`${label} stderr:`, idleStderr.slice(0, 500));
				idleStderr = '';
				turn = { stdout: '', stderr: '', onLine, run, cancelKey, timeoutTimer: null, resolve, reject };
				registerRun(cancelKey, run);
				if (timeoutMs > 0) {
					turn.timeoutTimer = setTimeout(() => run.stop('timeout'), timeoutMs);
					turn.timeoutTimer.unref?.();
				}
				child.stdin.write(input);
			});
		},

		close() {
			if (gone || closing) return;
			closing = true;
			child.stdin.end();
			const timer = setTimeout(() => {
				if (!gone) terminate(child, { detached, killInContainer });
			}, KILL_GRACE_MS);
			timer.unref?.();
		},
	};
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

module.exports = { spawnCollect, spawnResident, probeVersion };
