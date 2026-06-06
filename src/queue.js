/**
 * Global sequential execution queue.
 *
 * Every agent prompt (admin/sandbox, DM/channel, interactive/scheduled)
 * goes through runQueued() so that at most one agent process runs at a time.
 * The sequentiality simplifies many invariants (no concurrent writes on jobs
 * files, no concurrent container exec, etc.).
 *
 * isBusy() reflects whether a task is currently running OR waiting in the
 * queue, so callers can show a "please wait" hint to the user.
 */

let queue = Promise.resolve();
let pending = 0;

function isBusy() {
	return pending > 0;
}

function runQueued(fn) {
	pending++;
	const p = queue.then(() => fn());
	queue = p.catch(() => {}).finally(() => { pending--; });
	return p;
}

module.exports = { runQueued, isBusy };
