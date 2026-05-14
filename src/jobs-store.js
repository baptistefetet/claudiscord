const fs = require('fs');
const cron = require('node-cron');
const { ADMIN_JOBS_FILE, SANDBOX_JOBS_FILE, VALID_MODELS } = require('./config');
const log = require('./logger');

const REQUIRED_FIELDS = ['id', 'prompt', 'cron', 'enabled', 'channelId'];

function fileFor(mode) {
	if (mode === 'admin') return ADMIN_JOBS_FILE;
	if (mode === 'sandbox') {
		if (!SANDBOX_JOBS_FILE) throw new Error('Sandbox is not configured (SANDBOX_HOME_DIR unset)');
		return SANDBOX_JOBS_FILE;
	}
	throw new Error(`Unknown job mode: ${mode}`);
}

function readJobsFile(file) {
	try {
		const raw = fs.readFileSync(file, 'utf8');
		const data = JSON.parse(raw);
		if (!Array.isArray(data)) {
			log.warn(`Jobs file ${file} is not an array, ignoring`);
			return [];
		}
		return data;
	} catch (err) {
		if (err.code !== 'ENOENT') log.warn(`Failed to read jobs file ${file}: ${err.message}`);
		return [];
	}
}

function writeJobsFile(file, jobs) {
	const tmp = file + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2), 'utf8');
	fs.renameSync(tmp, file);
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
	if (typeof job.channelId !== 'string' || !job.channelId) return false;
	if (job.model !== undefined && !VALID_MODELS.includes(job.model)) return false;
	return true;
}

/**
 * Load jobs from both admin and sandbox files. Each returned job has
 * `mode` stamped on it so the scheduler knows where to run and which
 * file to update.
 */
function loadAllJobs() {
	const admin = readJobsFile(ADMIN_JOBS_FILE)
		.filter(j => {
			if (validateJob(j)) return true;
			log.warn(`Skipping invalid admin job: ${JSON.stringify(j)?.slice(0, 200)}`);
			return false;
		})
		.map(j => ({ ...j, mode: 'admin' }));
	const sandbox = SANDBOX_JOBS_FILE
		? readJobsFile(SANDBOX_JOBS_FILE)
			.filter(j => {
				if (validateJob(j)) return true;
				log.warn(`Skipping invalid sandbox job: ${JSON.stringify(j)?.slice(0, 200)}`);
				return false;
			})
			.map(j => ({ ...j, mode: 'sandbox' }))
		: [];
	return [...admin, ...sandbox];
}

function jobKey(job) {
	return `${job.mode}:${job.id}`;
}

/**
 * Update lastRun / remaining / channelName for a job. Writes back to the
 * matching file (admin or sandbox). If remaining reaches 0, removes the job.
 * Returns true if the job was removed.
 */
function recordJobRun(job, { channelName = null } = {}) {
	const file = fileFor(job.mode);
	const jobs = readJobsFile(file);
	const idx = jobs.findIndex(j => j.id === job.id);
	if (idx === -1) return false;

	jobs[idx].lastRun = new Date().toISOString();
	if (channelName && jobs[idx].channelName !== channelName) {
		jobs[idx].channelName = channelName;
	}

	let removed = false;
	if (typeof jobs[idx].remaining === 'number' && jobs[idx].remaining > 0) {
		jobs[idx].remaining--;
		if (jobs[idx].remaining === 0) {
			jobs.splice(idx, 1);
			removed = true;
			log.info(`Job '${jobKey(job)}' removed (remaining reached 0)`);
		}
	}

	writeJobsFile(file, jobs);
	return removed;
}

module.exports = { loadAllJobs, jobKey, recordJobRun };
