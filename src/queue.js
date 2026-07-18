/**
 * FIFO queues keyed by Discord channel ID, plus fair shared/exclusive resource
 * locks for environment-wide maintenance. Different keys run concurrently;
 * tasks sharing a key never overlap.
 */

const queues = new Map();
const locks = new Map();
const scopePending = new Map();
let totalPending = 0;

function getLock(scope) {
	let lock = locks.get(scope);
	if (!lock) {
		lock = { readers: 0, writer: false, waiters: [] };
		locks.set(scope, lock);
	}
	return lock;
}

function pump(lock) {
	if (lock.writer || lock.readers > 0 || lock.waiters.length === 0) return;
	if (lock.waiters[0].mode === 'exclusive') {
		lock.writer = true;
		lock.waiters.shift().resolve();
		return;
	}
	while (lock.waiters[0]?.mode === 'shared') {
		lock.readers++;
		lock.waiters.shift().resolve();
	}
}

function acquire(scope, mode) {
	if (mode !== 'shared' && mode !== 'exclusive') {
		throw new Error(`Invalid lock mode: ${mode}`);
	}
	const lock = getLock(scope);
	const writerWaiting = lock.waiters.some(waiter => waiter.mode === 'exclusive');
	if (mode === 'shared' && !lock.writer && !writerWaiting) {
		lock.readers++;
		return Promise.resolve();
	}
	if (mode === 'exclusive' && !lock.writer && lock.readers === 0 && lock.waiters.length === 0) {
		lock.writer = true;
		return Promise.resolve();
	}
	return new Promise(resolve => lock.waiters.push({ mode, resolve }));
}

function release(scope, mode) {
	const lock = locks.get(scope);
	if (!lock) throw new Error(`Unknown lock scope: ${scope}`);
	if (mode === 'exclusive') lock.writer = false;
	else lock.readers--;
	pump(lock);
	if (!lock.writer && lock.readers === 0 && lock.waiters.length === 0) locks.delete(scope);
}

async function runWithLocks(requested, fn) {
	const acquired = [];
	try {
		for (const request of requested) {
			await acquire(request.scope, request.mode);
			acquired.push(request);
		}
		return await fn();
	} finally {
		for (let i = acquired.length - 1; i >= 0; i--) {
			release(acquired[i].scope, acquired[i].mode);
		}
	}
}

function trackScopes(requested, delta) {
	for (const { scope } of requested) {
		const next = (scopePending.get(scope) || 0) + delta;
		if (next > 0) scopePending.set(scope, next);
		else scopePending.delete(scope);
	}
}

function isBusy(key) {
	if (key === undefined) return totalPending > 0;
	return (queues.get(key)?.pending || 0) > 0;
}

function isScopeBusy(scope) {
	return (scopePending.get(scope) || 0) > 0;
}

function runQueued(key, fn, { locks: requestedLocks = [] } = {}) {
	if (key === undefined || key === null || key === '') throw new Error('Queue key is required');
	let entry = queues.get(key);
	if (!entry) {
		entry = { tail: Promise.resolve(), pending: 0 };
		queues.set(key, entry);
	}

	entry.pending++;
	totalPending++;
	trackScopes(requestedLocks, 1);

	const execution = entry.tail.then(
		() => runWithLocks(requestedLocks, fn),
	);
	const settled = execution.finally(() => {
		entry.pending--;
		totalPending--;
		trackScopes(requestedLocks, -1);
		if (entry.pending === 0) queues.delete(key);
	});
	entry.tail = settled.catch(() => {});
	return settled;
}

function executionLocks(mode, environmentMode = 'shared') {
	if (mode !== 'admin' && mode !== 'sandbox') throw new Error(`Unknown execution mode: ${mode}`);
	return [
		{ scope: 'global', mode: 'shared' },
		{ scope: mode, mode: environmentMode },
	];
}

module.exports = {
	runQueued,
	runWithLocks,
	isBusy,
	isScopeBusy,
	executionLocks,
};
