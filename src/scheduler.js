const cron = require('node-cron');
const { AUTHORIZED_USER_ID, JOB_TIMEOUT_MS } = require('./config');
const { getSystemPrompt } = require('./prompts');
const { executePrompt } = require('./executor');
const sessions = require('./sessions');
const { loadAllJobs, jobKey, recordJobRun, deleteJob, deleteNonIsolatedJobs } = require('./jobs-store');
const { sendToChannel, getClient } = require('./discord');
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

/**
 * A job opts out of its notification by ending its output with NOTIFY_NONE; the
 * whole output is then dropped. Only the last non-empty line counts and it must
 * BE the token — a substring test would fire on an agent quoting it while
 * writing another job's prompt. Emphasis must be symmetric and no code fence
 * left open, so a truncated report is not read as a trailer. Any miss notifies,
 * which is the recoverable direction.
 */
const NOTIFY_NONE_LINE = /^(\*\*|\*|__|_|`|~~)?NOTIFY_NONE\1\.?$/;

function suppressesNotification(output) {
	const lines = String(output || '').split('\n');
	const last = lines.findLastIndex(l => l.trim());
	if (last < 0 || !NOTIFY_NONE_LINE.test(lines[last].trim())) return false;
	return lines.slice(0, last).filter(l => /^\s*```/.test(l)).length % 2 === 0;
}

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

/**
 * A non-isolated job targets the channel's ongoing conversation; losing that
 * session is permanent, so the job is removed rather than left to fire forever
 * into a fresh session nobody is reading.
 */
async function dropStaleJob(job, reason) {
	const key = jobKey(job);
	log.warn(`Job '${key}': ${reason}, deleting`);
	let removed;
	try {
		removed = deleteJob(job);
	} catch (err) {
		// The row survives and the job will be retried at its next occurrence.
		log.error(`Failed to delete job '${key}':`, err.message);
		return;
	}
	// Already swept by handleSessionCleared, which announced it: stay quiet.
	if (!removed) return;
	await sendToChannel(
		job.channelId,
		`\u{1F5D1}\u{FE0F} **Job '${job.id}' — DELETED**\nThe channel session it was attached to no longer exists.`,
	).catch(e => log.error('Notify failed:', e.message));
}

/**
 * A channel losing its session takes every non-isolated job bound to it: those
 * runs target that exact conversation and a fresh one is not a substitute.
 * Deleting here, at the moment the user destroys the target, is what makes the
 * deletion visible — executeJob's SESSION_REQUIRED guard stays as the backstop
 * for the rows this misses (a run already in flight, a failed delete).
 *
 * Called fire-and-forget from sessions.js, so it must never throw or return a
 * promise the caller is expected to await.
 */
function handleSessionCleared(channelId, reason) {
	const removed = deleteNonIsolatedJobs(channelId);
	if (!removed.length) return;
	reloadJobs();
	const list = removed.map(j => `${j.mode}:${j.id}`).join(', ');
	log.info(`Channel ${channelId}: ${removed.length} non-isolated job(s) deleted (${reason}): ${list}`);
	// Best-effort: on a removed channel there is nobody left to tell, and the
	// deletion is already visible in /jobs.
	sendToChannel(
		channelId,
		`\u{1F5D1}\u{FE0F} **${removed.length} non-isolated job(s) deleted** — ${reason}: ${removed.map(j => `\`${j.id}\``).join(', ')}`,
	).catch(err => log.warn(`Job deletion notice failed for channel ${channelId}: ${err.message}`));
}

async function executeJob(job) {
	const { id, prompt, channelId } = job;
	const key = jobKey(job);

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
	// Set by any path that must not consume a `remaining` or touch last_run:
	// the run did not happen, or the row is already gone.
	let skipRecord = false;

	try {
		promptContext = await fetchJobPromptContext(channelId);
		if (!promptContext.userName) {
			throw new Error(`Could not resolve authorized user name for job '${key}'`);
		}
		// A non-isolated run appends a turn to the shared conversation, so an
		// unresolved channel would leave that turn with no visible trace at all.
		// Transient (a failed fetch), hence a plain skip: retried next occurrence.
		if (!job.isolated && !promptContext.channelId) {
			skipRecord = true;
			log.warn(`Job '${key}': channel unresolved, non-isolated run skipped`);
			return;
		}
		resolvedChannelName = promptContext?.channelName || job.channelName || null;
		// The agent is live — a job stores none, it runs on whatever the channel is
		// set to now. job.mode deliberately is NOT live: it comes from the database
		// the job lives in, which is the admin/sandbox security boundary.
		const jobAgent = sessions.getAgent(channelId);
		const jobSystemPrompt = getSystemPrompt({
			botName: promptContext.botName,
			userName: promptContext.userName,
			mode: job.mode,
			channelId: promptContext.channelId,
			channelName: resolvedChannelName,
			channelTopic: promptContext?.channelTopic,
			isDM: Boolean(promptContext?.isDM),
			// The job block ends with "user replies cannot resume this job", which is
			// exactly what a non-isolated run inverts.
			jobId: job.isolated ? id : null,
			channelAgent: jobAgent,
		});
		// The system prompt is re-sent on every invocation but never lands in the
		// transcript, so a non-isolated run marks itself in-band instead: otherwise
		// the next interactive turn reads the job's instructions as user input.
		const jobPrompt = job.isolated
			? prompt
			: `[scheduled job "${id}" — automatic run, not typed by ${promptContext.userName}]\n\n${prompt}`;
		// Passing channelId is what makes the executor resolve the channel session
		// live and persist the result back; withholding it keeps a job isolated.
		const jobOptions = {
			queueKey: channelId,
			systemPrompt: jobSystemPrompt,
			tier: 'medium',
			// A job runs unannounced, so `/stop` has to name it: the user reaching
			// for that command only knows their channel is busy, not why.
			runLabel: `scheduled job '${id}'`,
			...(job.isolated ? { sessionId: null } : { channelId, requireSession: true }),
		};
		const { result: output, sessionId } = await executePrompt(jobAgent, job.mode, jobPrompt, jobOptions);
		lastSessionId = sessionId || null;

		log.info(`Job '${key}' completed (output: ${output.length} chars)`);

		// An unresolved channel is checked first: it means this job can no longer
		// deliver anything, which outranks what this particular run decided.
		if (!promptContext.channelId) {
			log.warn(`Job '${key}': notification skipped (unresolved channelId '${channelId}')`);
		} else if (suppressesNotification(output)) {
			log.info(`Job '${key}': NOTIFY_NONE, output dropped (${output.length} chars)`);
		} else if (!output) {
			log.warn(`Job '${key}': completed with empty output, nothing to notify`);
		} else {
			await sendToChannel(channelId, `\u{1F4CB} **Job '${id}'**\n${output}`);
		}
	} catch (err) {
		// Only a non-isolated job can raise these: it passes channelId, which arms
		// both guards. Either way its target conversation is gone.
		if (err.code === 'SESSION_REQUIRED' || err.code === 'CHANNEL_CONTEXT_CHANGED') {
			skipRecord = true;
			await dropStaleJob(job, err.code === 'SESSION_REQUIRED'
				? 'channel session gone'
				: 'channel agent or mode changed while queued');
			return;
		}
		// `/stop` in the channel this run occupies. An operator decision, not a
		// failure: no error banner, and the occurrence is not consumed, so a
		// recurring job keeps its schedule and a one-shot is not deleted unrun.
		if (err.code === 'CANCELLED') {
			skipRecord = true;
			log.info(`Job '${key}': stopped by the user`);
			if (promptContext?.channelId) {
				await sendToChannel(channelId, `⏹️ **Job '${id}'** stopped. Its schedule is unchanged.`)
					.catch(e => log.error('Notify failed:', e.message));
			}
			return;
		}
		lastSessionId = err.sessionId || lastSessionId;
		log.error(`Job '${key}': ERROR (code ${err.code || 'unknown'})`, err.message);
		// A crash produces no output, so it cannot opt out: always reported. A
		// timeout is one of those failures \u2014 unlike `/stop` above, nobody decided
		// it \u2014 so the occurrence is consumed like any other failed run.
		const reason = err.code === 'TIMEOUT'
			? `Run exceeded the ${JOB_TIMEOUT_MS / 60000}-minute limit and was killed.`
			: `Agent failed with code ${err.code || 'unknown'}.`;
		if (promptContext?.channelId) {
			await sendToChannel(channelId, `\u{1F6A8} **Job '${id}' \u2014 ERROR**\n${reason}`).catch(e => log.error('Notify failed:', e.message));
		} else {
			log.warn(`Job '${key}': error notification skipped (unresolved channelId '${channelId}')`);
		}
	} finally {
		if (!skipRecord) {
			try {
				recordJobRun(job, { channelName: resolvedChannelName, lastSessionId });
			} catch (err) {
				log.error(`Failed to update job '${key}':`, err.message);
			}
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

module.exports = { start, stop, reloadJobs, handleSessionCleared };
