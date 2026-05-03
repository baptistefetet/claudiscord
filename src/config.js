const os = require('os');
const path = require('path');
const ENV_PATH = path.resolve(__dirname, '..', '.env');
require('dotenv').config({ path: ENV_PATH });

const REQUIRED_ENV = ['DISCORD_TOKEN', 'AUTHORIZED_USER_ID'];
for (const key of REQUIRED_ENV) {
	if (!process.env[key]) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
}

const AUTHORIZED_USER_ID = process.env.AUTHORIZED_USER_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
// Default to ~/.local/bin/claude — where claude.ai/install.sh drops the
// binary for the user running the service. Override via .env if you have
// it elsewhere.
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), '.local/bin/claude');
// Optional: only required when sandbox mode is used. If unset, sandbox
// is reported as unavailable just like when Docker is missing.
const SANDBOX_HOME_DIR = process.env.SANDBOX_HOME_DIR || null;

// Optional: enables Groq Whisper transcription of Discord voice messages.
// If unset, voice messages are silently ignored (legacy behaviour).
const GROQ_API_KEY = process.env.GROQ_API_KEY || null;
const STT_MODEL = process.env.STT_MODEL || 'whisper-large-v3';
const STT_LANGUAGE = process.env.STT_LANGUAGE || 'fr';

// --- Paths ---
const ADMIN_HOME = os.homedir();
const CONTAINER_HOME = '/home/claude';
const JOBS_FILENAME = 'scheduled-jobs.json';
const JOBS_RELATIVE = path.join('.claudiscord', JOBS_FILENAME);

const ADMIN_JOBS_FILE = path.resolve(__dirname, '..', JOBS_FILENAME);
const SANDBOX_JOBS_FILE = SANDBOX_HOME_DIR ? path.join(SANDBOX_HOME_DIR, JOBS_RELATIVE) : null;
const SESSIONS_FILE = path.resolve(__dirname, '..', 'sessions.json');
const CONTAINER_JOBS_FILE = path.posix.join(CONTAINER_HOME, JOBS_RELATIVE);

const CONTAINER_NAME = 'claudiscord-sandbox';
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
const DISALLOWED_TOOLS = 'CronCreate CronDelete CronList Monitor AskUserQuestion RemoteTrigger EnterPlanMode ExitPlanMode EnterWorktree ExitWorktree NotebookEdit ScheduleWakeup PushNotification Skill(loop) Skill(keybindings-help) Skill(schedule) Skill(claude-api) Skill(update-config) Skill(fewer-permission-prompts)';

const DM_MODEL = 'opus';
const DM_EFFORT = 'xhigh';
const JOB_MODEL = 'sonnet';
const JOB_EFFORT = 'high';

module.exports = {
	AUTHORIZED_USER_ID,
	DISCORD_TOKEN,
	CLAUDE_BIN,
	SANDBOX_HOME_DIR,
	GROQ_API_KEY,
	STT_MODEL,
	STT_LANGUAGE,
	ADMIN_HOME,
	CONTAINER_HOME,
	CONTAINER_NAME,
	JOBS_RELATIVE,
	ADMIN_JOBS_FILE,
	SANDBOX_JOBS_FILE,
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
