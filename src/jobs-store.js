const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { JOBS_FILE, DATA_DIR, SANDBOX_JOBS_PATH } = require('./config');
const log = require('./logger');

const REQUIRED_FIELDS = ['id', 'prompt', 'cron', 'enabled'];

function loadJobs() {
	try {
		const raw = fs.readFileSync(JOBS_FILE, 'utf8');
		return JSON.parse(raw);
	} catch (err) {
		if (err.code !== 'ENOENT') log.error('Failed to load jobs:', err.message);
		return [];
	}
}

function saveJobs(jobs) {
	const tmp = JOBS_FILE + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2), 'utf8');
	fs.renameSync(tmp, JOBS_FILE);
}

/**
 * Atomic read-modify-write: reads the latest jobs, applies updateFn, writes back.
 * Minimizes the race window by keeping read → modify → write synchronous.
 * updateFn(jobs) must return { jobs, changed, ...extra }. Extra fields are passed through.
 */
function updateJobs(updateFn) {
	const jobs = loadJobs();
	const result = updateFn(jobs);
	if (result.changed) saveJobs(result.jobs);
	return result;
}

function jobKey(job) {
	return job.userId ? `${job.userId}:${job.id}` : job.id;
}

function validateJob(job) {
	if (!job || typeof job !== 'object') return false;
	for (const field of REQUIRED_FIELDS) {
		if (job[field] === undefined || job[field] === null) return false;
	}
	if (typeof job.id !== 'string' || !job.id) return false;
	if (typeof job.prompt !== 'string' || !job.prompt) return false;
	if (typeof job.cron !== 'string' || !cron.validate(job.cron)) return false;
	if (typeof job.enabled !== 'boolean') return false;
	return true;
}

function syncRemovedSandboxJob(removed) {
	if (!removed?.userId) return;
	try {
		const userJobsFile = path.join(DATA_DIR, removed.userId, 'home', SANDBOX_JOBS_PATH.replace('/home/claude/', ''));
		const raw = fs.readFileSync(userJobsFile, 'utf8');
		const userJobs = JSON.parse(raw);
		if (!Array.isArray(userJobs)) return;

		const filtered = userJobs.filter(j => j.id !== removed.jobId);
		if (filtered.length !== userJobs.length) {
			fs.writeFileSync(userJobsFile, JSON.stringify(filtered, null, 2), 'utf8');
			log.info(`Job '${removed.jobId}' also removed from sandbox file for user ${removed.userId}`);
		}
	} catch (err) {
		log.warn('Failed to sync sandbox file after job removal:', err.message);
	}
}

function recordJobRun(key) {
	const { removed } = updateJobs(jobs => {
		const idx = jobs.findIndex(j => jobKey(j) === key);
		if (idx === -1) return { jobs, changed: false, removed: null };

		jobs[idx].lastRun = new Date().toISOString();
		let removed = null;

		// Remaining counter: 0 = infinite, >0 = decrement then remove at 0
		if (typeof jobs[idx].remaining === 'number' && jobs[idx].remaining > 0) {
			jobs[idx].remaining--;
			if (jobs[idx].remaining === 0) {
				removed = { userId: jobs[idx].userId, jobId: jobs[idx].id };
				jobs.splice(idx, 1);
				log.info(`Job '${key}' removed (remaining reached 0)`);
			}
		}

		return { jobs, changed: true, removed };
	});

	syncRemovedSandboxJob(removed);
	return removed;
}

/**
 * Read the user's scheduled-jobs.json from their sandbox home,
 * validate, and merge into the central jobs file.
 * - New jobs are added (with userId stamped)
 * - Modified jobs are updated
 * - Jobs removed from user file are deleted from central file
 * - Invalid files are cleaned up (emptied)
 */
function mergeUserJobs(userId) {
	const userJobsFile = path.join(DATA_DIR, userId, 'home', SANDBOX_JOBS_PATH.replace('/home/claude/', ''));

	let userJobs;
	try {
		const raw = fs.readFileSync(userJobsFile, 'utf8');
		userJobs = JSON.parse(raw);
	} catch (err) {
		if (err.code === 'ENOENT') return;
		log.warn(`Invalid jobs file for user ${userId}, cleaning: ${err.message}`);
		try { fs.writeFileSync(userJobsFile, '[]', 'utf8'); } catch {}
		return;
	}

	if (!Array.isArray(userJobs)) {
		log.warn(`Jobs file for user ${userId} is not an array, cleaning`);
		try { fs.writeFileSync(userJobsFile, '[]', 'utf8'); } catch {}
		return;
	}

	const validJobs = [];
	let hadInvalid = false;
	for (const job of userJobs) {
		if (validateJob(job)) {
			validJobs.push(job);
		} else {
			log.warn(`Invalid job in user ${userId} file: ${JSON.stringify(job)?.slice(0, 200)}`);
			hadInvalid = true;
		}
	}

	if (hadInvalid) {
		try { fs.writeFileSync(userJobsFile, JSON.stringify(validJobs, null, 2), 'utf8'); } catch {}
	}

	const centralUserJobs = loadJobs()
		.filter(j => j.userId === userId)
		.map(({ userId: _uid, ...rest }) => rest);
	if (JSON.stringify(validJobs) === JSON.stringify(centralUserJobs)) {
		return;
	}

	const { userJobsFromCentral } = updateJobs(centralJobs => {
		const existingUserJobIds = new Set();
		for (const job of centralJobs) {
			if (job.userId === userId) {
				existingUserJobIds.add(job.id);
			}
		}

		const currentUserJobIds = new Set(validJobs.map(j => j.id));
		const removedIds = new Set();
		for (const id of existingUserJobIds) {
			if (!currentUserJobIds.has(id)) {
				removedIds.add(id);
			}
		}

		const filteredJobs = [];
		const centralIndex = new Map();
		for (const job of centralJobs) {
			if (job.userId === userId && removedIds.has(job.id)) {
				log.info(`Removed job '${userId}:${job.id}' (deleted by user)`);
				continue;
			}
			if (job.userId === userId) {
				centralIndex.set(job.id, filteredJobs.length);
			}
			filteredJobs.push(job);
		}

		for (const userJob of validJobs) {
			const mergedJob = { ...userJob, userId };
			const idx = centralIndex.get(userJob.id);
			if (idx !== undefined) {
				// Preserve scheduler-managed fields from central (authoritative source)
				mergedJob.lastRun = filteredJobs[idx].lastRun;
				if (typeof filteredJobs[idx].remaining === 'number') {
					mergedJob.remaining = filteredJobs[idx].remaining;
				}
				filteredJobs[idx] = mergedJob;
				log.info(`Updated job '${userId}:${userJob.id}'`);
			} else {
				filteredJobs.push(mergedJob);
				log.info(`Added job '${userId}:${userJob.id}'`);
			}
		}

		const changed = JSON.stringify(filteredJobs) !== JSON.stringify(centralJobs);
		const userJobsFromCentral = filteredJobs
			.filter(j => j.userId === userId)
			.map(({ userId: _uid, ...rest }) => rest);

		return { jobs: filteredJobs, changed, userJobsFromCentral };
	});

	try {
		fs.writeFileSync(userJobsFile, JSON.stringify(userJobsFromCentral, null, 2), 'utf8');
	} catch (err) {
		log.warn(`Failed to write back jobs for user ${userId}:`, err.message);
	}
}

module.exports = { loadJobs, jobKey, mergeUserJobs, recordJobRun };
