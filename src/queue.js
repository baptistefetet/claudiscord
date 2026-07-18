/**
 * FIFO queues keyed by Discord channel ID, plus one stop-the-world maintenance
 * gate for rare operations. Different keys run concurrently; tasks sharing a
 * key never overlap.
 */

const queues = new Map();
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
module.exports = {
	runQueued,
	runMaintenance,
	isBusy,
};
