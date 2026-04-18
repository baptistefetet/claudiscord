const cron = require('node-cron');
const { ALLOWED_TOOLS, CLAUDE_TIMEOUT_MS, JOB_MODEL, JOB_EFFORT } = require('./config');
const { getSystemPrompt } = require('./prompts');
const { executeForMode } = require('./executor');
const { loadAllJobs, jobKey, recordJobRun } = require('./jobs-store');
const { sendToChannel, getClient } = require('./discord');
const log = require('./logger');

/** @type {Map<string, import('node-cron').ScheduledTask>} */
const tasks = new Map();

/** @type {Map<string, string>} jobKey -> lastRun minute string */
const lastRunMinutes = new Map();

/** Lock set for scheduled jobs (per job key) */
const jobLocks = new Set();

function acquireJobLock(key) {
	if (jobLocks.has(key)) return false;
	jobLocks.add(key);
	return true;
}

function releaseJobLock(key) {
	jobLocks.delete(key);
}

/**
 * Fetch the current Discord name of a channel (DM recipient name or guild channel name).
 * Returns null if the channel can't be resolved.
 */
async function fetchChannelName(channelId) {
	try {
		const channel = await getClient().channels.fetch(channelId);
		if (!channel) return null;
		if (channel.isDMBased?.()) {
			return channel.recipient?.username || channel.recipient?.globalName || '<dm>';
		}
		return channel.name || null;
	} catch (err) {
		log.warn(`fetchChannelName(${channelId}) failed: ${err.message}`);
		return null;
	}
}

async function executeJob(job) {
	const { id, prompt, channelId, notify, notifyPattern } = job;
	const key = jobKey(job);

	if (!acquireJobLock(key)) {
		log.warn(`Job '${key}' skipped (already running)`);
		return;
	}

	// Avoid double-run inside the same wall-clock minute (cron edge case)
	const nowMinute = new Date().toISOString().slice(0, 16);
	if (lastRunMinutes.get(key) === nowMinute) {
		releaseJobLock(key);
		return;
	}

	log.info(`Job '${key}' starting`);

	const today = new Date().toISOString().slice(0, 10);
	const fullPrompt = `Today's date: ${today}\n\n${prompt}`;
	let channelName = null;

	try {
		channelName = await fetchChannelName(channelId);
		const jobSystemPrompt = getSystemPrompt({ jobId: id });
		const jobOptions = {
			sessionId: null,
			systemPrompt: jobSystemPrompt,
			allowedTools: ALLOWED_TOOLS,
			model: JOB_MODEL,
			effort: JOB_EFFORT,
			outputFormat: 'text',
			timeoutMs: CLAUDE_TIMEOUT_MS,
		};
		const { result: output } = await executeForMode(job.mode, fullPrompt, jobOptions);

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
		if (notify && output && patternMatches) {
			await sendToChannel(channelId, `\u{1F4CB} **Job '${id}'**\n${output}`);
		}
	} catch (err) {
		if (err.code === 124) {
			log.error(`Job '${key}': TIMEOUT`);
			if (notify) {
				await sendToChannel(channelId, `\u{1F6A8} **Job '${id}' \u2014 TIMEOUT**\nNo response after ${CLAUDE_TIMEOUT_MS / 1000}s.`).catch(e => log.error('Notify failed:', e.message));
			}
		} else {
			log.error(`Job '${key}': ERROR (code ${err.code || 'unknown'})`, err.message);
			if (notify) {
				await sendToChannel(channelId, `\u{1F6A8} **Job '${id}' \u2014 ERROR**\nClaude failed with code ${err.code || 'unknown'}.`).catch(e => log.error('Notify failed:', e.message));
			}
		}
	} finally {
		lastRunMinutes.set(key, nowMinute);
		try {
			recordJobRun(job, { channelName });
		} catch (err) {
			log.error(`Failed to update job '${key}':`, err.message);
		}
		// Reload tasks in case remaining reached 0 (job removed from file)
		reloadJobs();
		releaseJobLock(key);
	}
}

function reloadJobs() {
	for (const task of tasks.values()) task.stop();
	tasks.clear();

	const jobs = loadAllJobs();
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
	}
	log.info(`Scheduler reloaded: ${tasks.size} active job(s)`);
}

function start() {
	reloadJobs();
}

function stop() {
	for (const task of tasks.values()) task.stop();
	tasks.clear();
	log.info('Scheduler stopped');
}

module.exports = { start, stop, reloadJobs };
