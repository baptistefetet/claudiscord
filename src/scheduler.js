const fs = require('fs');
const cron = require('node-cron');
const { JOBS_FILE, PROFILES, CLAUDE_TIMEOUT_MS, AUTHORIZED_USER_ID } = require('./config');
const { executeClaudeCommand, acquireJobLock, releaseJobLock } = require('./claude');
const { sendDM } = require('./discord');
const log = require('./logger');

/** @type {Map<string, import('node-cron').ScheduledTask>} */
const tasks = new Map();

/** @type {Map<string, string>} jobId -> lastRun minute string */
const lastRunMinutes = new Map();

let fileWatcher = null;
let debounceTimer = null;

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

async function executeJob(job) {
	const { id, prompt, profile, notify } = job;

	// Check lock
	if (!acquireJobLock(id)) {
		log.warn(`Job '${id}' skipped (already running)`);
		return;
	}

	// Check duplicate run in same minute
	const nowMinute = new Date().toISOString().slice(0, 16);
	if (lastRunMinutes.get(id) === nowMinute) {
		releaseJobLock(id);
		return;
	}

	log.info(`Job '${id}' starting (profile: ${profile})`);

	const allowedTools = PROFILES[profile];
	if (!allowedTools) {
		log.error(`Job '${id}': unknown profile '${profile}', skipped`);
		releaseJobLock(id);
		return;
	}

	const today = new Date().toISOString().slice(0, 10);
	const fullPrompt = `Date du jour : ${today}\n\n${prompt}`;

	try {
		const { result: output } = await executeClaudeCommand(fullPrompt, {
			sessionId: null,
			systemPrompt: null,
			allowedTools,
			outputFormat: 'text',
			timeoutMs: CLAUDE_TIMEOUT_MS,
		});

		log.info(`Job '${id}' completed (output: ${output.length} chars)`);

		if (notify && output) {
			await sendDM(AUTHORIZED_USER_ID, `\u{1F4CB} **[PI4] Job '${id}'**\n${output}`);
		}
	} catch (err) {
		if (err.code === 124) {
			log.error(`Job '${id}': TIMEOUT`);
			if (notify) {
				await sendDM(AUTHORIZED_USER_ID, `\u{1F6A8} **[PI4] Job '${id}' \u2014 TIMEOUT**\nPas de reponse apres ${CLAUDE_TIMEOUT_MS / 1000}s.`).catch(e => log.error('Notify failed:', e.message));
			}
		} else {
			log.error(`Job '${id}': ERROR (code ${err.code || 'unknown'})`, err.message);
			if (notify) {
				await sendDM(AUTHORIZED_USER_ID, `\u{1F6A8} **[PI4] Job '${id}' \u2014 ERREUR**\nClaude a echoue avec le code ${err.code || 'unknown'}.`).catch(e => log.error('Notify failed:', e.message));
			}
		}
	} finally {
		// Update lastRun
		lastRunMinutes.set(id, nowMinute);
		try {
			const jobs = loadJobs();
			const jobEntry = jobs.find(j => j.id === id);
			if (jobEntry) {
				jobEntry.lastRun = new Date().toISOString();
				saveJobs(jobs);
			}
		} catch (err) {
			log.error(`Failed to update lastRun for job '${id}':`, err.message);
		}

		releaseJobLock(id);
	}
}

function scheduleTasks() {
	// Stop existing tasks
	for (const [id, task] of tasks) {
		task.stop();
	}
	tasks.clear();

	const jobs = loadJobs();
	for (const job of jobs) {
		if (!job.enabled) continue;

		if (!cron.validate(job.cron)) {
			log.error(`Job '${job.id}': invalid cron expression '${job.cron}'`);
			continue;
		}

		const task = cron.schedule(job.cron, () => {
			executeJob(job).catch(err => log.error(`Job '${job.id}' unhandled error:`, err));
		});

		tasks.set(job.id, task);
		log.info(`Scheduled job '${job.id}' (cron: ${job.cron}, profile: ${job.profile})`);
	}
}

function start() {
	scheduleTasks();

	// Watch for changes to scheduled-jobs.json
	try {
		fileWatcher = fs.watch(JOBS_FILE, () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				log.info('scheduled-jobs.json changed, reloading...');
				scheduleTasks();
			}, 2000);
		});
		fileWatcher.on('error', () => {});
	} catch (err) {
		log.warn('Could not watch scheduled-jobs.json:', err.message);
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
