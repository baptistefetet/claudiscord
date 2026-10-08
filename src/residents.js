/**
 * Agent processes kept alive between prompts, at most one per channel, so a
 * prompt (a voice delegation above all) does not pay the CLI's startup and
 * session load every time. Agent-agnostic: the agent supplies the process
 * (`spawn.js::spawnResident`) and the signature that says what it was started
 * with.
 *
 * Reuse is decided at each prompt, inside the channel FIFO, by two checks:
 *   - `signature`: everything fixed at spawn (environment, model, system prompt,
 *     flags). A text prompt and a voice delegation in the same channel differ
 *     here, so alternating between them respawns.
 *   - `sessionId`: the session the process holds must be the one the channel
 *     holds now. Every reset (/new, mode or agent switch, voice join) nulls the
 *     channel's, which retires a process still holding the old one.
 * A mismatch retires the old process and starts a new one; it costs latency,
 * never correctness.
 *
 * Only the channel FIFO's head may acquire, so a process never serves two
 * prompts at once. Anything else that writes to a channel's session (a
 * scheduled run, one-shot) must `retire()` its process first: two processes
 * appending to one session would fork it.
 */

const { onMaintenance } = require('./queue');
const { AGENT_IDLE_TIMEOUT_MS } = require('./config');
const log = require('./logger');

// key -> { proc, signature, sessionId, idleTimer }
const entries = new Map();

function retireEntry(key, entry, reason) {
	entries.delete(key);
	clearTimeout(entry.idleTimer);
	// A process mid-turn finishes it: release() closes it afterwards.
	if (entry.proc.busy) return;
	log.info(`${entry.proc.label}: closing resident process for ${key} (${reason})`);
	entry.proc.close();
}

/**
 * The live process for `key` if it matches, else a new one from `spawn()`.
 * Returns `{ entry, warm }`; hand the entry back with `release()` once the
 * turn is over, whatever its outcome.
 */
function acquire(key, { signature, sessionId, spawn }) {
	let entry = entries.get(key);
	if (entry && entry.proc.alive && entry.signature === signature && entry.sessionId === sessionId) {
		clearTimeout(entry.idleTimer);
		return { entry, warm: true };
	}
	if (entry) retireEntry(key, entry, 'context changed');

	entry = { proc: spawn(), signature, sessionId, idleTimer: null };
	entries.set(key, entry);
	const created = entry;
	created.proc.exited.then(() => {
		if (entries.get(key) !== created) return;
		clearTimeout(created.idleTimer);
		entries.delete(key);
	});
	return { entry, warm: false };
}

/**
 * Back to idle after a turn. `sessionId` is the session the channel now holds,
 * which the process holds too. An entry retired during the turn is closed now.
 */
function release(key, entry, sessionId) {
	if (entries.get(key) !== entry) {
		entry.proc.close();
		return;
	}
	entry.sessionId = sessionId;
	clearTimeout(entry.idleTimer);
	entry.idleTimer = setTimeout(() => {
		if (entries.get(key) === entry) retireEntry(key, entry, 'idle');
	}, AGENT_IDLE_TIMEOUT_MS);
	entry.idleTimer.unref?.();
}

function retire(key, reason = 'retired') {
	const entry = entries.get(key);
	if (entry) retireEntry(key, entry, reason);
}

/**
 * The channel lost its session: retire a process holding one. A fresh process
 * (no session yet) stays, it is what the next prompt wants — that is how a
 * prewarm made just before a voice join's reset survives it.
 */
function sessionCleared(key) {
	const entry = entries.get(key);
	if (entry?.sessionId) retireEntry(key, entry, 'session cleared');
}

// /login, !shell and /upgrade can change what a running CLI would only pick
// up at startup (credentials, binaries). Nothing runs during maintenance, so
// every process is idle.
onMaintenance(() => {
	for (const [key, entry] of entries) retireEntry(key, entry, 'maintenance');
});

module.exports = { acquire, release, retire, sessionCleared };
