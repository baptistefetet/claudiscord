const fs = require('fs');
const { execFileSync } = require('child_process');
const cron = require('node-cron');
const {
	ADMIN_JOBS_FILE,
	SANDBOX_HOST_JOBS_FILE,
	VALID_MODELS,
	VALID_AGENTS,
} = require('./config');
const log = require('./logger');

const REQUIRED_FIELDS = ['id', 'prompt', 'cron', 'enabled', 'channelId'];

// STRICT rejects mistyped values at insert time — the table is also written
// by agents through the sqlite3 CLI, outside claudiscord's validation.
const SCHEMA = `
PRAGMA user_version = 2;
CREATE TABLE IF NOT EXISTS jobs (
	id              TEXT PRIMARY KEY,
	channel_id      TEXT NOT NULL,
	channel_name    TEXT,
	prompt          TEXT NOT NULL,
	cron            TEXT NOT NULL,
	enabled         INTEGER NOT NULL,
	remaining       INTEGER NOT NULL DEFAULT 0,
	agent           TEXT,
	model           TEXT,
	created         TEXT,
	last_run        TEXT,
	last_session_id TEXT,
	description     TEXT
) STRICT;
`;

function fileFor(mode) {
	if (mode === 'admin') return ADMIN_JOBS_FILE;
	if (mode === 'sandbox') {
		if (!SANDBOX_HOST_JOBS_FILE) throw new Error('Sandbox is not configured (SANDBOX_HOME unset)');
		return SANDBOX_HOST_JOBS_FILE;
	}
	throw new Error(`Unknown job mode: ${mode}`);
}

// busy_timeout is per-connection, so every invocation must set it. The
// .timeout dot-command (unlike PRAGMA busy_timeout) emits no result row,
// which would corrupt -json output.
function runSqlite(file, sql, { json = false } = {}) {
	const args = json ? ['-bail', '-json', file] : ['-bail', file];
	return execFileSync('sqlite3', args, {
		input: `.timeout 5000\n${sql}`,
		encoding: 'utf8',
	});
}

function sqlLit(value) {
	if (value === null || value === undefined) return 'NULL';
	return `'${String(value).replace(/'/g, "''")}'`;
}

function ensureDb(file) {
	runSqlite(file, SCHEMA);
}

function rowToJob(row) {
	return {
		id: row.id,
		prompt: row.prompt,
		cron: row.cron,
		enabled: row.enabled === 1,
		remaining: row.remaining,
		channelId: row.channel_id,
		channelName: row.channel_name,
		// NULL maps to undefined so validateJob's optional-field checks pass.
		agent: row.agent ?? undefined,
		model: row.model ?? undefined,
		created: row.created,
		lastRun: row.last_run,
		lastSessionId: row.last_session_id,
		description: row.description,
	};
}

function readJobsDb(file) {
	// Opening a missing database would create an empty root-owned file (the
	// sandbox db must stay owned by the container user), so bail out first.
	if (!fs.existsSync(file)) return [];
	try {
		// sqlite3 -json prints nothing at all for an empty result set.
		const out = runSqlite(file, 'SELECT * FROM jobs;', { json: true });
		const rows = out.trim() ? JSON.parse(out) : [];
		return rows.map(rowToJob);
	} catch (err) {
		log.warn(`Failed to read jobs db ${file}: ${err.message}`);
		return [];
	}
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
	if (job.agent !== undefined && !VALID_AGENTS.includes(job.agent)) return false;
	if (job.model !== undefined && !VALID_MODELS.includes(job.model)) return false;
	return true;
}

/**
 * Load jobs from both admin and sandbox databases. Each returned job has
 * `mode` stamped on it so the scheduler knows where to run and which
 * database to update.
 */
function loadAllJobs() {
	const admin = readJobsDb(ADMIN_JOBS_FILE)
		.filter(j => {
			if (validateJob(j)) return true;
			log.warn(`Skipping invalid admin job: ${JSON.stringify(j)?.slice(0, 200)}`);
			return false;
		})
		.map(j => ({ ...j, mode: 'admin' }));
	const sandbox = SANDBOX_HOST_JOBS_FILE
		? readJobsDb(SANDBOX_HOST_JOBS_FILE)
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
 * Update lastRun / remaining / channelName for a job, atomically in a single
 * sqlite3 transaction. If remaining reaches 0, the job row is deleted.
 * Returns true if the job was removed.
 */
function recordJobRun(job, { channelName = null, lastSessionId = null } = {}) {
	const file = fileFor(job.mode);
	const id = sqlLit(job.id);
	const sets = [`last_run = ${sqlLit(new Date().toISOString())}`];
	if (channelName) sets.push(`channel_name = ${sqlLit(channelName)}`);
	// Diagnostic only: UUID of the agent session for this run (Claude/Codex
	// transcript on disk). Jobs always start fresh, so this is never resumed
	// automatically — it lets a later conversation inspect what happened.
	if (lastSessionId) sets.push(`last_session_id = ${sqlLit(lastSessionId)}`);

	// changes() inside the DELETE's WHERE still reports the decrement UPDATE
	// (it only refreshes once the DELETE completes), so an infinite job
	// (remaining = 0, never decremented) is not swept up. The final SELECT
	// reads the DELETE's own count.
	const out = runSqlite(file, `
BEGIN IMMEDIATE;
UPDATE jobs SET ${sets.join(', ')} WHERE id = ${id};
UPDATE jobs SET remaining = remaining - 1 WHERE id = ${id} AND remaining > 0;
DELETE FROM jobs WHERE id = ${id} AND remaining = 0 AND changes() > 0;
COMMIT;
SELECT changes() AS removed;
`, { json: true });

	const removed = JSON.parse(out)[0].removed > 0;
	if (removed) log.info(`Job '${jobKey(job)}' removed (remaining reached 0)`);
	return removed;
}

module.exports = { loadAllJobs, jobKey, recordJobRun, ensureDb };
