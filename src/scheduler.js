const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { JOBS_FILE, DATA_DIR, SANDBOX_JOBS_PATH, ALLOWED_TOOLS, CLAUDE_TIMEOUT_MS, AUTHORIZED_USER_ID, JOB_MODEL, JOB_EFFORT } = require('./config');
const { getJobSystemPrompt } = require('./prompts');
const { executeForUser } = require('./executor');
const { sendDM } = require('./discord');
const log = require('./logger');

const JOBS_DIR = path.dirname(JOBS_FILE);
const JOBS_BASENAME = path.basename(JOBS_FILE);

/** @type {Map<string, import('node-cron').ScheduledTask>} */
const tasks = new Map();

/** @type {Map<string, string>} jobId -> lastRun minute string */
const lastRunMinutes = new Map();

/** Lock set for scheduled jobs (per job ID) */
const jobLocks = new Set();

let fileWatcher = null;
let debounceTimer = null;

function acquireJobLock(jobId) {
	if (jobLocks.has(jobId)) return false;
	jobLocks.add(jobId);
	return true;
}

function releaseJobLock(jobId) {
	jobLocks.delete(jobId);
}

// --- Job file I/O ---

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

// --- Job key (userId + id composite) ---

function jobKey(job) {
	return job.userId ? `${job.userId}:${job.id}` : job.id;
}

// --- Merge user jobs from sandbox ---

const REQUIRED_FIELDS = ['id', 'prompt', 'cron', 'enabled'];

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

	// Read user file
	let userJobs;
	try {
		const raw = fs.readFileSync(userJobsFile, 'utf8');
		userJobs = JSON.parse(raw);
	} catch (err) {
		if (err.code === 'ENOENT') return; // No file = no jobs, nothing to do
		// Invalid JSON: log, clean the file, and return
		log.warn(`Invalid jobs file for user ${userId}, cleaning: ${err.message}`);
		try { fs.writeFileSync(userJobsFile, '[]', 'utf8'); } catch {}
		return;
	}

	// Must be an array
	if (!Array.isArray(userJobs)) {
		log.warn(`Jobs file for user ${userId} is not an array, cleaning`);
		try { fs.writeFileSync(userJobsFile, '[]', 'utf8'); } catch {}
		return;
	}

	// Validate each job, keep only valid ones
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

	// Rewrite user file if we removed invalid entries
	if (hadInvalid) {
		try { fs.writeFileSync(userJobsFile, JSON.stringify(validJobs, null, 2), 'utf8'); } catch {}
	}

	// Early return if sandbox jobs haven't changed since last sync
	const centralUserJobs = loadJobs()
		.filter(j => j.userId === userId)
		.map(({ userId: _uid, ...rest }) => rest);
	if (JSON.stringify(validJobs) === JSON.stringify(centralUserJobs)) {
		return;
	}

	// Merge into central file (atomic read-modify-write via updateJobs)
	const { userJobsFromCentral } = updateJobs(centralJobs => {
		// Build map of existing user jobs in central file (by job id)
		const existingUserJobIds = new Set();
		for (const job of centralJobs) {
			if (job.userId === userId) {
				existingUserJobIds.add(job.id);
			}
		}

		// Build set of user's current job ids
		const currentUserJobIds = new Set(validJobs.map(j => j.id));

		// Remove jobs that user deleted (present in central but not in user file)
		const removedIds = new Set();
		for (const id of existingUserJobIds) {
			if (!currentUserJobIds.has(id)) {
				removedIds.add(id);
			}
		}

		// Filter out removed jobs, build index for update
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

		// Add or update user jobs
		for (const userJob of validJobs) {
			const mergedJob = { ...userJob, userId };
			const idx = centralIndex.get(userJob.id);
			if (idx !== undefined) {
				// Update: preserve lastRun from central
				mergedJob.lastRun = filteredJobs[idx].lastRun;
				filteredJobs[idx] = mergedJob;
				log.info(`Updated job '${userId}:${userJob.id}'`);
			} else {
				// New job
				filteredJobs.push(mergedJob);
				log.info(`Added job '${userId}:${userJob.id}'`);
			}
		}

		const changed = JSON.stringify(filteredJobs) !== JSON.stringify(centralJobs);

		// Compute user's jobs for sync-back to sandbox
		const userJobsFromCentral = filteredJobs
			.filter(j => j.userId === userId)
			.map(({ userId: _uid, ...rest }) => rest);

		return { jobs: filteredJobs, changed, userJobsFromCentral };
	});

	// Write back user's jobs to sandbox file (sync central → sandbox)
	// This ensures the sandbox always has the complete, up-to-date list
	// (including lastRun updates) so the user can always see and manage their jobs
	try {
		fs.writeFileSync(userJobsFile, JSON.stringify(userJobsFromCentral, null, 2), 'utf8');
	} catch (err) {
		log.warn(`Failed to write back jobs for user ${userId}:`, err.message);
	}
}

// --- Job execution ---

async function executeJob(job) {
	const { id, userId, prompt, notify, notifyPattern } = job;
	const key = jobKey(job);

	// Check lock
	if (!acquireJobLock(key)) {
		log.warn(`Job '${key}' skipped (already running)`);
		return;
	}

	// Check duplicate run in same minute
	const nowMinute = new Date().toISOString().slice(0, 16);
	if (lastRunMinutes.get(key) === nowMinute) {
		releaseJobLock(key);
		return;
	}

	log.info(`Job '${key}' starting`);

	const today = new Date().toISOString().slice(0, 10);
	const fullPrompt = `Today's date: ${today}\n\n${prompt}`;
	const targetUser = userId || AUTHORIZED_USER_ID;

	try {
		const jobSystemPrompt = getJobSystemPrompt(id);
		const jobOptions = {
			sessionId: null,
			systemPrompt: jobSystemPrompt,
			allowedTools: ALLOWED_TOOLS,
			model: JOB_MODEL,
			effort: JOB_EFFORT,
			outputFormat: 'text',
			timeoutMs: CLAUDE_TIMEOUT_MS,
		};
		const { result: output } = await executeForUser(userId, fullPrompt, jobOptions);

		log.info(`Job '${key}' completed (output: ${output.length} chars)`);

		let patternMatches = true;
		if (notifyPattern) {
			try {
				const regex = new RegExp(notifyPattern, 's');
				patternMatches = regex.test(output);
			} catch {
				log.warn(`Job '${key}': invalid notifyPattern regex '${notifyPattern}', falling back to includes()`);
				patternMatches = output.includes(notifyPattern);
			}
		}
		const shouldNotify = notify && output && patternMatches;
		if (shouldNotify) {
			await sendDM(targetUser, `\u{1F4CB} **Job '${id}'**\n${output}`);
		}
	} catch (err) {
		if (err.code === 124) {
			log.error(`Job '${key}': TIMEOUT`);
			if (notify) {
				await sendDM(targetUser, `\u{1F6A8} **Job '${id}' \u2014 TIMEOUT**\nNo response after ${CLAUDE_TIMEOUT_MS / 1000}s.`).catch(e => log.error('Notify failed:', e.message));
			}
		} else {
			log.error(`Job '${key}': ERROR (code ${err.code || 'unknown'})`, err.message);
			if (notify) {
				await sendDM(targetUser, `\u{1F6A8} **Job '${id}' \u2014 ERROR**\nClaude failed with code ${err.code || 'unknown'}.`).catch(e => log.error('Notify failed:', e.message));
			}
		}
	} finally {
		// Update lastRun + handle remaining counter (atomic read-modify-write)
		lastRunMinutes.set(key, nowMinute);
		try {
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

			// Sync sandbox file if job was removed (separate file, no conflict)
			if (removed?.userId) {
				try {
					const userJobsFile = path.join(DATA_DIR, removed.userId, 'home', SANDBOX_JOBS_PATH.replace('/home/claude/', ''));
					const raw = fs.readFileSync(userJobsFile, 'utf8');
					const userJobs = JSON.parse(raw);
					if (Array.isArray(userJobs)) {
						const filtered = userJobs.filter(j => j.id !== removed.jobId);
						if (filtered.length !== userJobs.length) {
							fs.writeFileSync(userJobsFile, JSON.stringify(filtered, null, 2), 'utf8');
							log.info(`Job '${removed.jobId}' also removed from sandbox file for user ${removed.userId}`);
						}
					}
				} catch (syncErr) {
					log.warn(`Failed to sync sandbox file after job removal:`, syncErr.message);
				}
			}
		} catch (err) {
			log.error(`Failed to update lastRun for job '${key}':`, err.message);
		}

		releaseJobLock(key);
	}
}

// --- Scheduling ---

function scheduleTasks() {
	// Stop existing tasks
	for (const [id, task] of tasks) {
		task.stop();
	}
	tasks.clear();

	const jobs = loadJobs();
	for (const job of jobs) {
		if (!job.enabled) continue;

		const key = jobKey(job);

		if (!cron.validate(job.cron)) {
			log.error(`Job '${key}': invalid cron expression '${job.cron}'`);
			continue;
		}

		const task = cron.schedule(job.cron, () => {
			executeJob(job).catch(err => log.error(`Job '${key}' unhandled error:`, err));
		});

		tasks.set(key, task);
		log.info(`Scheduled job '${key}' (cron: ${job.cron}${job.userId ? `, user: ${job.userId}` : ''})`);
	}
}

function start() {
	scheduleTasks();

	// Watch the directory instead of the file directly.
	// fs.watch() on a file tracks an inode; rename() (used by atomic writes
	// from saveJobs, jq, or Claude) replaces the inode and breaks the watcher.
	// Watching the directory catches rename events reliably.
	try {
		fileWatcher = fs.watch(JOBS_DIR, (eventType, filename) => {
			if (filename !== JOBS_BASENAME) return;
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				log.info('scheduled-jobs.json changed, reloading...');
				scheduleTasks();
			}, 2000);
		});
		fileWatcher.on('error', () => {});
	} catch (err) {
		log.warn('Could not watch for scheduled-jobs.json changes:', err.message);
	}

	log.info(`Scheduler started with ${tasks.size} job(s)`);
}

function stop() {
	if (fileWatcher) {
		fileWatcher.close();
		fileWatcher = null;
	}
	if (debounceTimer) {
		clearTimeout(debounceTimer);
		debounceTimer = null;
	}
	for (const [id, task] of tasks) {
		task.stop();
	}
	tasks.clear();
	log.info('Scheduler stopped');
}

module.exports = { start, stop, mergeUserJobs };
