const cron = require('node-cron');
const {
	ALLOWED_TOOLS,
	AUTHORIZED_USER_ID,
	PROMPT_TIMEOUT_MS,
	EFFORT_BY_MODEL,
	VALID_MODELS,
	CHANNEL_DEFAULT_MODEL,
	VALID_AGENTS,
	CHANNEL_DEFAULT_AGENT,
} = require('./config');
const { getSystemPrompt } = require('./prompts');
const { executePrompt } = require('./executor');
const { loadAllJobs, jobKey, recordJobRun } = require('./jobs-store');
const { sendToChannel, getClient } = require('./discord');
const sessions = require('./sessions');
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
 * Job context always needs bot/user identity.
 * Channel-specific data is added only if the channelId resolves on Discord.
 */
async function fetchJobPromptContext(channelId) {
	const context = {
		botName: getClient().user?.displayName || getClient().user?.username || 'claudiscord',
		userName: null,
		channelId: null,
		isDM: false,
		channelName: null,
		channelTopic: null,
	};

	try {
		const user = await getClient().users.fetch(AUTHORIZED_USER_ID);
		context.userName = user?.globalName || user?.username || null;
	} catch (err) {
		log.warn(`fetchJobPromptContext(user ${AUTHORIZED_USER_ID}) failed: ${err.message}`);
	}

	if (!channelId) return context;

	try {
		const channel = await getClient().channels.fetch(channelId);
		if (!channel) return context;

		context.channelId = channelId;
		if (channel.isDMBased?.()) {
			context.isDM = true;
			context.channelName = channel.recipient?.globalName
				|| channel.recipient?.username
				|| '<dm>';
			return context;
		}

		context.channelName = channel.name || null;
		context.channelTopic = typeof channel.topic === 'string' ? channel.topic : null;
		return context;
	} catch (err) {
		log.warn(`fetchJobPromptContext(channel ${channelId}) failed: ${err.message}`);
		return context;
	}
}

async function executeJob(job) {
	const { id, prompt, channelId, notify, notifyPattern } = job;
	const key = jobKey(job);

	// While a sandbox remote is live we cannot run another sandbox agent:
	// `killAgentProcessesInContainer` on timeout would also kill the remote
	// daemon. Skip silently — the next cron tick will pick it back up.
	if (job.mode === 'sandbox' && sessions.hasActiveSandboxRemote()) {
		log.warn(`Job '${key}' skipped (sandbox remote active)`);
		return;
	}

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
	let resolvedChannelName = null;
	let promptContext = null;

	try {
		promptContext = await fetchJobPromptContext(channelId);
		if (!promptContext.userName) {
			throw new Error(`Could not resolve authorized user name for job '${key}'`);
		}
		resolvedChannelName = promptContext?.channelName || job.channelName || null;
		const jobAgent = VALID_AGENTS.includes(job.agent) ? job.agent : CHANNEL_DEFAULT_AGENT;
		const jobModel = VALID_MODELS.includes(job.model) ? job.model : CHANNEL_DEFAULT_MODEL;
		const jobSystemPrompt = getSystemPrompt({
			botName: promptContext.botName,
			userName: promptContext.userName,
			mode: job.mode,
			channelId: promptContext.channelId,
			channelName: resolvedChannelName,
			channelTopic: promptContext?.channelTopic,
			isDM: Boolean(promptContext?.isDM),
			jobId: id,
			channelAgent: jobAgent,
			channelModel: jobModel,
		});
		const jobOptions = {
			sessionId: null,
			systemPrompt: jobSystemPrompt,
			allowedTools: ALLOWED_TOOLS,
			model: jobModel,
			effort: EFFORT_BY_MODEL[jobModel],
			outputFormat: 'text',
			timeoutMs: PROMPT_TIMEOUT_MS,
		};
		const { result: output } = await executePrompt(jobAgent, job.mode, fullPrompt, jobOptions);

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
		if (notify && !promptContext.channelId) {
			log.warn(`Job '${key}': notification skipped (unresolved channelId '${channelId}')`);
		} else if (notify && output && patternMatches) {
			await sendToChannel(channelId, `\u{1F4CB} **Job '${id}'**\n${output}`);
		}
	} catch (err) {
		if (err.code === 124) {
			log.error(`Job '${key}': TIMEOUT`);
			if (notify && promptContext?.channelId) {
				await sendToChannel(channelId, `\u{1F6A8} **Job '${id}' \u2014 TIMEOUT**\nNo response after ${PROMPT_TIMEOUT_MS / 1000}s.`).catch(e => log.error('Notify failed:', e.message));
			} else if (notify) {
				log.warn(`Job '${key}': timeout notification skipped (unresolved channelId '${channelId}')`);
			}
		} else {
			log.error(`Job '${key}': ERROR (code ${err.code || 'unknown'})`, err.message);
			if (notify && promptContext?.channelId) {
				await sendToChannel(channelId, `\u{1F6A8} **Job '${id}' \u2014 ERROR**\nAgent failed with code ${err.code || 'unknown'}.`).catch(e => log.error('Notify failed:', e.message));
			} else if (notify) {
				log.warn(`Job '${key}': error notification skipped (unresolved channelId '${channelId}')`);
			}
		}
	} finally {
		lastRunMinutes.set(key, nowMinute);
		try {
			recordJobRun(job, { channelName: resolvedChannelName });
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
