const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { JOBS_FILE, ALLOWED_TOOLS, CLAUDE_TIMEOUT_MS, AUTHORIZED_USER_ID, JOB_MODEL, JOB_EFFORT } = require('./config');
const { getJobSystemPrompt } = require('./prompts');
const { executeForUser } = require('./executor');
const { loadJobs, jobKey, mergeUserJobs, recordJobRun } = require('./jobs-store');
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
		if (userId != null) {
			try {
				mergeUserJobs(userId);
			} catch (syncErr) {
				log.warn(`Failed to merge jobs for user ${userId}:`, syncErr.message);
			}
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
				await sendDM(targetUser, `\u{1F6A8} **Job '${id}' \u2014 TIMEOUT**\nNo response after ${CLAUDE_TIMEOUT_MS / 1000}s.`).catch(e => log.error('Notify failed:', e.message));
			}
		} else {
			log.error(`Job '${key}': ERROR (code ${err.code || 'unknown'})`, err.message);
			if (notify) {
				await sendDM(targetUser, `\u{1F6A8} **Job '${id}' \u2014 ERROR**\nClaude failed with code ${err.code || 'unknown'}.`).catch(e => log.error('Notify failed:', e.message));
			}
		}
	} finally {
		lastRunMinutes.set(key, nowMinute);
		try {
			recordJobRun(key);
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

module.exports = { start, stop };
