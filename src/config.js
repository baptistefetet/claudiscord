const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const REQUIRED_ENV = ['AUTHORIZED_USER_ID', 'DISCORD_TOKEN', 'CLAUDE_BIN', 'SANDBOX_HOMES_DIR'];
for (const key of REQUIRED_ENV) {
	if (!process.env[key]) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
}

const AUTHORIZED_USER_ID = process.env.AUTHORIZED_USER_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLAUDE_BIN = process.env.CLAUDE_BIN;
const SANDBOX_HOMES_DIR = process.env.SANDBOX_HOMES_DIR;

// --- Paths ---
// Single source of truth: the jobs file basename and its path relative to a home.
const CONTAINER_HOME = '/home/claude';
const JOBS_FILENAME = 'scheduled-jobs.json';
const JOBS_RELATIVE = path.join('.claudiscord', JOBS_FILENAME);

const CENTRAL_JOBS_FILE = path.resolve(__dirname, '..', JOBS_FILENAME);
const SESSIONS_FILE = path.resolve(__dirname, '..', 'sessions.json');
const CONTAINER_JOBS_FILE = path.posix.join(CONTAINER_HOME, JOBS_RELATIVE);

const DOCKER_IMAGE = 'claudiscord-sandbox';
const CONTAINER_MEMORY = '512m';
const CONTAINER_CPUS = 1;

const CLAUDE_TIMEOUT_MS = 1_200_000;
const SHELL_TIMEOUT_MS = 300_000;
const DOCKER_CMD_TIMEOUT = 30_000;
const UPGRADE_TIMEOUT_MS = 300_000;
const DISCORD_MAX_MSG_LENGTH = 2000;
const TYPING_INTERVAL_MS = 8000;

const ALLOWED_TOOLS = 'Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task';
const DISALLOWED_TOOLS = 'CronCreate CronDelete CronList Monitor AskUserQuestion RemoteTrigger EnterPlanMode ExitPlanMode EnterWorktree ExitWorktree NotebookEdit ScheduleWakeup PushNotification mcp__claude_ai_Gmail__authenticate mcp__claude_ai_Gmail__complete_authentication mcp__claude_ai_Google_Calendar__authenticate mcp__claude_ai_Google_Calendar__complete_authentication mcp__claude_ai_Google_Drive__authenticate mcp__claude_ai_Google_Drive__complete_authentication Skill(loop) Skill(keybindings-help) Skill(schedule) Skill(claude-api) Skill(update-config) Skill(fewer-permission-prompts)';

const DM_MODEL = 'opus';
const DM_EFFORT = 'xhigh';
const JOB_MODEL = 'sonnet';
const JOB_EFFORT = 'high';

module.exports = {
	AUTHORIZED_USER_ID,
	DISCORD_TOKEN,
	CLAUDE_BIN,
	SANDBOX_HOMES_DIR,
	CONTAINER_HOME,
	JOBS_RELATIVE,
	CENTRAL_JOBS_FILE,
	SESSIONS_FILE,
	CONTAINER_JOBS_FILE,
	CLAUDE_TIMEOUT_MS,
	SHELL_TIMEOUT_MS,
	DISCORD_MAX_MSG_LENGTH,
	TYPING_INTERVAL_MS,
	DOCKER_IMAGE,
	CONTAINER_MEMORY,
	CONTAINER_CPUS,
	ALLOWED_TOOLS,
	DISALLOWED_TOOLS,
	DM_MODEL,
	DM_EFFORT,
	JOB_MODEL,
	JOB_EFFORT,
	DOCKER_CMD_TIMEOUT,
	UPGRADE_TIMEOUT_MS,
};
