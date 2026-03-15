const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const REQUIRED_ENV = ['AUTHORIZED_USER_ID', 'DISCORD_TOKEN', 'CLAUDE_BIN', 'DATA_DIR'];
for (const key of REQUIRED_ENV) {
	if (!process.env[key]) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
}

const AUTHORIZED_USER_ID = process.env.AUTHORIZED_USER_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLAUDE_BIN = process.env.CLAUDE_BIN;
const DATA_DIR = process.env.DATA_DIR;

const JOBS_FILE = path.resolve(__dirname, '..', 'scheduled-jobs.json');
const SESSIONS_FILE = path.resolve(__dirname, '..', 'sessions.json');

const DOCKER_IMAGE = 'claudiscord-sandbox';
const CONTAINER_MEMORY = '512m';
const CONTAINER_CPUS = 1;

const CLAUDE_TIMEOUT_MS = 300_000;
const DISCORD_MAX_MSG_LENGTH = 2000;
const TYPING_INTERVAL_MS = 8000;

const ALLOWED_TOOLS = 'Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task';
const DISALLOWED_TOOLS = 'CronCreate CronDelete CronList Skill(loop)';

const SANDBOX_JOBS_PATH = '/home/claude/.claudiscord/scheduled-jobs.json';

function getSchedulingPrompt(jobsPath) {
	return `MANDATORY RULE — Scheduling: scheduled tasks (recurring or one-shot) that execute prompts or display messages to the user MUST use the following Discord scheduling system:

The file ${jobsPath} contains a JSON array of objects. A scheduler (node-cron) runs continuously and automatically executes jobs at the defined times. You only need to write to this file — the system handles the rest. Do not use other methods (crontab, at, setTimeout, setInterval, /loop, sleep, direct node-cron, systemd timer) as they are not connected to the Discord bot and will not persist.

Fields: id (unique string), prompt (the prompt that will be executed by Claude), cron (standard cron expression, timezone Europe/Paris), enabled (bool), notify (bool), notifyPattern (optional string), remaining (number of remaining executions), created (ISO date), lastRun (null or ISO date, do not modify), description.

Remaining counter: controls the number of remaining executions. 0 = infinite (runs forever). >0 = decremented after each execution; job is automatically removed when it reaches 0. Set to 1 for a one-shot job. Set to 0 for a regular recurring job.

Notifications: if notify=true, the job output is sent via Discord DM to the user. If notifyPattern is set, it is interpreted as a regular expression (regex) and the notification is only sent if the output matches this pattern. IMPORTANT: if you want a conditional notification (only send if a keyword appears, or only if a keyword is absent), you MUST specify notifyPattern — without it, notify=true ALWAYS sends the notification. Examples: "PROBLEM" (notify if the word appears), "^(?!.*OK).*$" (notify if OK is absent). The dotall flag (s) is enabled by default (. matches newlines).

To view the list of scheduled jobs, simply read this file — it always contains the complete and up-to-date state of all jobs.

Minimal example:
[{"id":"weather","prompt":"Give me the weather in Lyon","cron":"0 8 * * *","enabled":true,"notify":true,"remaining":0,"created":"2026-01-01T00:00:00Z","lastRun":null,"description":"Daily weather"}]`;
}

function getJobSystemPrompt(jobId) {
	const today = new Date().toISOString().slice(0, 10);
	return `This is a scheduled task for a Discord bot. Job: "${jobId}". Today's date: ${today}.

--- Response format ---
${getDiscordFormattingPrompt()}`;
}

function getDiscordFormattingPrompt() {
	return `Keep responses concise and suited for Discord (max ~1800 characters). Use Discord markdown (not HTML). FORBIDDEN: tables in any form — no ASCII tables, no markdown tables (|---|), no space-aligned columns. Tables are UNREADABLE on Discord (proportional font, mobile). Use instead: bullet lists, bold text for labels, or code blocks for aligned data.`;
}

function getSystemPrompt({ botName, userName } = {}) {
	const today = new Date().toISOString().slice(0, 10);
	const identity = botName ? `Your name is ${botName}. ` : '';
	const interlocutor = userName ? `You are talking to ${userName}. ` : '';
	return `${identity}You are the system administrator assistant. ${interlocutor}The user is talking to you via Discord DM. Today's date is: ${today}.
You have access to system tools to administer the server.

--- Critical rules ---
NEVER restart the claudiscord service (systemctl restart claudiscord, systemctl stop claudiscord, etc.) unless the user EXPLICITLY asks for it. Reason: you are running inside this service — restarting it would cut the connection and your response would never be delivered. The user has the /restart command to do it themselves.

--- Scheduling ---
${getSchedulingPrompt(JOBS_FILE)}

--- Response format ---
${getDiscordFormattingPrompt()}`;
}

function getSandboxSystemPrompt({ botName, userName } = {}) {
	const today = new Date().toISOString().slice(0, 10);
	const identity = botName ? `Your name is ${botName}. ` : '';
	const interlocutor = userName ? `You are talking to ${userName}. ` : '';
	return `${identity}You are a Claude assistant in an isolated Docker sandbox environment. ${interlocutor}The user is talking to you via Discord DM. Today's date is: ${today}.

--- Environment ---
You have access to development tools (Bash, files, web).
Your workspace is /home/claude. This is the only persistent directory (data survives restarts). Everything else (/, /tmp, etc.) is ephemeral and will be lost on container rebuild.

--- Scheduling ---
${getSchedulingPrompt(SANDBOX_JOBS_PATH)}

--- Response format ---
${getDiscordFormattingPrompt()}`;
}

module.exports = {
	AUTHORIZED_USER_ID,
	DISCORD_TOKEN,
	CLAUDE_BIN,
	DATA_DIR,
	JOBS_FILE,
	SESSIONS_FILE,
	SANDBOX_JOBS_PATH,
	CLAUDE_TIMEOUT_MS,
	DISCORD_MAX_MSG_LENGTH,
	TYPING_INTERVAL_MS,
	DOCKER_IMAGE,
	CONTAINER_MEMORY,
	CONTAINER_CPUS,
	ALLOWED_TOOLS,
	DISALLOWED_TOOLS,
	getSystemPrompt,
	getSandboxSystemPrompt,
	getJobSystemPrompt,
};
