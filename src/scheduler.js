const cron = require('node-cron');
const {
	AUTHORIZED_USER_ID,
	PROMPT_TIMEOUT_MS,
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

/** @type {Map<string, {matcher: object, job: object}>} jobKey -> matcher + job */
const scheduled = new Map();

/** Single minute-resolution ticker driving all jobs (see tick()) */
let ticker = null;
const TICK_MS = 30 * 1000;

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

	const nowMinute = new Date().toISOString().slice(0, 16);

	if (!acquireJobLock(key)) {
		// A second sub-minute tick (TICK_MS < 60s) racing the run we just started:
		// collapse it silently. Only a run still held from an EARLIER minute is a
		// real overlap worth warning about.
		if (lastRunMinutes.get(key) !== nowMinute) {
			log.warn(`Job '${key}' skipped (already running)`);
		}
		return;
	}

	// A quick run earlier this same minute already finished and released the lock.
	if (lastRunMinutes.get(key) === nowMinute) {
		releaseJobLock(key);
		return;
	}

	// Record the minute at START (not in finally) so a concurrent same-minute tick
	// can tell this run apart from a cross-minute overlap.
	lastRunMinutes.set(key, nowMinute);

	log.info(`Job '${key}' starting`);

	let resolvedChannelName = null;
	let promptContext = null;
	let lastSessionId = null;

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
			model: jobModel,
			timeoutMs: PROMPT_TIMEOUT_MS,
		};
		const { result: output, sessionId } = await executePrompt(jobAgent, job.mode, prompt, jobOptions);
		lastSessionId = sessionId || null;

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
		lastSessionId = err.sessionId || lastSessionId;
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
		try {
			recordJobRun(job, { channelName: resolvedChannelName, lastSessionId });
		} catch (err) {
			log.error(`Failed to update job '${key}':`, err.message);
		}
		// Rebuild the schedule in case remaining reached 0 (job removed from file)
		reloadJobs();
		releaseJobLock(key);
	}
}

/**
 * Build a job's time matcher without arming node-cron's own timer. We drive
 * execution from a single minute-resolution ticker (see tick()) instead of
 * node-cron's per-job setTimeout, which aimed at an exact second and silently
 * dropped a run when the first heartbeat fired off that second (e.g. clock not
 * yet NTP-synced right after a reboot). createTask() only parses the expression;
 * destroy() discards the throwaway task and unregisters it (no leak).
 */
function buildMatcher(cronExpr) {
	const task = cron.createTask(cronExpr, () => {});
	const matcher = task.timeMatcher;
	try { task.destroy(); } catch { /* ignore */ }
	return matcher;
}

function reloadJobs() {
	scheduled.clear();

	const jobs = loadAllJobs();
	for (const job of jobs) {
		if (!job.enabled) continue;
		const key = jobKey(job);
		if (!cron.validate(job.cron)) {
			log.error(`Job '${key}': invalid cron expression '${job.cron}'`);
			continue;
		}
		const matcher = buildMatcher(job.cron);
		if (!matcher || typeof matcher.match !== 'function') {
			log.error(`Job '${key}': could not build time matcher`);
			continue;
		}
		scheduled.set(key, { matcher, job });
	}
	log.info(`Scheduler reloaded: ${scheduled.size} active job(s)`);
}

/**
 * Fire every job whose cron matches the current minute. Runs a few times per
 * minute (TICK_MS) so a slightly late/drifting tick still lands inside the right
 * minute; the per-job minute lock in executeJob collapses those to a single run.
 * Missed minutes are never replayed later.
 */
function tick() {
	const minute = new Date();
	minute.setSeconds(0, 0);
	for (const { matcher, job } of scheduled.values()) {
		let matched = false;
		try {
			matched = matcher.match(minute);
		} catch (err) {
			log.error(`Job '${jobKey(job)}': match error:`, err.message);
			continue;
		}
		if (matched) {
			executeJob(job).catch(err => log.error(`Job '${jobKey(job)}' unhandled error:`, err));
		}
	}
}

function start() {
	reloadJobs();
	if (!ticker) {
		ticker = setInterval(tick, TICK_MS);
		tick(); // evaluate the current minute now; setInterval's first call is one TICK_MS away
	}
}

function stop() {
	if (ticker) {
		clearInterval(ticker);
		ticker = null;
	}
	scheduled.clear();
	log.info('Scheduler stopped');
}

module.exports = { start, stop, reloadJobs };
