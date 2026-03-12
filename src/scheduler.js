const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { JOBS_FILE, DATA_DIR, SANDBOX_JOBS_PATH, ALLOWED_TOOLS, CLAUDE_TIMEOUT_MS, AUTHORIZED_USER_ID, getJobSystemPrompt } = require('./config');
const { executeClaudeCommand, acquireJobLock, releaseJobLock } = require('./claude');
const { executeInContainerQueued } = require('./container');
const { sendDM } = require('./discord');
const log = require('./logger');

const JOBS_DIR = path.dirname(JOBS_FILE);
const JOBS_BASENAME = path.basename(JOBS_FILE);

/** @type {Map<string, import('node-cron').ScheduledTask>} */
const tasks = new Map();

/** @type {Map<string, string>} jobId -> lastRun minute string */
const lastRunMinutes = new Map();

let fileWatcher = null;
let debounceTimer = null;

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

	// Load central jobs
	const centralJobs = loadJobs();

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
		// Stamp userId
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

	// Save if anything changed
	if (JSON.stringify(filteredJobs) !== JSON.stringify(centralJobs)) {
		saveJobs(filteredJobs);
		// fs.watch will detect this and trigger scheduleTasks()
	}

	// Write back user's jobs to sandbox file (sync central → sandbox)
	// This ensures the sandbox always has the complete, up-to-date list
	// (including lastRun updates) so the user can always see and manage their jobs
	const userJobsFromCentral = filteredJobs
		.filter(j => j.userId === userId)
		.map(({ userId: _uid, ...rest }) => rest);
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
	const fullPrompt = `Date du jour : ${today}\n\n${prompt}`;
	const targetUser = userId || AUTHORIZED_USER_ID;

	try {
		let output;

		const jobSystemPrompt = getJobSystemPrompt(id);

		if (userId) {
			// Sandbox job: execute in user's container
			const { result } = await executeInContainerQueued(userId, fullPrompt, {
				sessionId: null,
				systemPrompt: jobSystemPrompt,
				allowedTools: ALLOWED_TOOLS,
				outputFormat: 'text',
				timeoutMs: CLAUDE_TIMEOUT_MS,
			});
			output = result;
		} else {
			// Host job: execute on host with admin tools
			const { result } = await executeClaudeCommand(fullPrompt, {
				sessionId: null,
				systemPrompt: jobSystemPrompt,
				allowedTools: ALLOWED_TOOLS,
				outputFormat: 'text',
				timeoutMs: CLAUDE_TIMEOUT_MS,
			});
			output = result;
		}

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
				await sendDM(targetUser, `\u{1F6A8} **Job '${id}' \u2014 TIMEOUT**\nPas de reponse apres ${CLAUDE_TIMEOUT_MS / 1000}s.`).catch(e => log.error('Notify failed:', e.message));
			}
		} else {
			log.error(`Job '${key}': ERROR (code ${err.code || 'unknown'})`, err.message);
			if (notify) {
				await sendDM(targetUser, `\u{1F6A8} **Job '${id}' \u2014 ERREUR**\nClaude a echoue avec le code ${err.code || 'unknown'}.`).catch(e => log.error('Notify failed:', e.message));
			}
		}
	} finally {
		// Update lastRun + handle remaining counter
		lastRunMinutes.set(key, nowMinute);
		try {
			const jobs = loadJobs();
			const idx = jobs.findIndex(j => jobKey(j) === key);
			if (idx !== -1) {
				const jobEntry = jobs[idx];
				jobEntry.lastRun = new Date().toISOString();

				// Remaining counter: 0 = infinite, >0 = decrement then remove at 0
				if (typeof jobEntry.remaining === 'number' && jobEntry.remaining > 0) {
					jobEntry.remaining--;
					if (jobEntry.remaining === 0) {
						jobs.splice(idx, 1);
						log.info(`Job '${key}' removed (remaining reached 0)`);
					}
				}

				saveJobs(jobs);
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
