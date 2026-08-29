/**
 * FIFO queues keyed by Discord channel ID, plus one stop-the-world maintenance
 * gate for rare operations. Different keys run concurrently; tasks sharing a
 * key never overlap.
 *
 * Also holds the process currently running for a key, so `/stop` can end it:
 * that is the same per-key execution state the queue is built around, and
 * `stop(key)` is the counterpart of `isBusy(key)`.
 */

const queues = new Map();
const running = new Map();
let totalPending = 0;
let maintenanceActive = false;
let maintenanceDone = Promise.resolve();

async function runMaintenance(fn) {
	if (maintenanceActive || totalPending > 0) {
		throw Object.assign(new Error('EXECUTION_BUSY'), { code: 'EXECUTION_BUSY' });
	}
	maintenanceActive = true;
	let release;
	maintenanceDone = new Promise(resolve => { release = resolve; });
	try {
		return await fn();
	} finally {
		maintenanceActive = false;
		release();
		maintenanceDone = Promise.resolve();
	}
}

function isBusy(key) {
	if (key === undefined) return maintenanceActive || totalPending > 0;
	return maintenanceActive || (queues.get(key)?.pending || 0) > 0;
}

function runQueued(key, fn) {
	if (key === undefined || key === null || key === '') throw new Error('Queue key is required');
	let entry = queues.get(key);
	if (!entry) {
		entry = { tail: Promise.resolve(), pending: 0 };
		queues.set(key, entry);
	}

	entry.pending++;
	totalPending++;

	const execution = entry.tail.then(async () => {
		await maintenanceDone;
		return fn();
	});
	const settled = execution.finally(() => {
		entry.pending--;
		totalPending--;
		if (entry.pending === 0) queues.delete(key);
	});
	entry.tail = settled.catch(() => {});
	return settled;
}
/**
 * Publish the process running under `key`. Called by `spawn.js`, which owns the
 * child and supplies its `stop()`; nothing else registers.
 */
function registerRun(key, run) {
	if (key) running.set(key, run);
}

// Guarded against the entry of a later run: a spawn that ends after its
// successor registered must not delete the successor's.
function unregisterRun(key, run) {
	if (key && running.get(key) === run) running.delete(key);
}

/**
 * Stop the run for `key`. Returns its label, or null when there is nothing left
 * to stop — no process yet (a task still waiting its turn), one already
 * finishing, or one a previous stop already signalled.
 */
function stopRun(key) {
	const run = running.get(key);
	if (!run) return null;
	return run.stop() ? run.label : null;
}

module.exports = {
	runQueued,
	runMaintenance,
	isBusy,
	registerRun,
	unregisterRun,
	stopRun,
};
