const fs = require('fs');
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
const SANDBOX_HOME = process.env.SANDBOX_HOME || null;

// Optional: enables Groq Whisper transcription of Discord voice messages.
// If unset, voice messages are silently ignored (legacy behaviour).
const GROQ_API_KEY = process.env.GROQ_API_KEY || null;
const STT_MODEL = process.env.STT_MODEL || 'whisper-large-v3';
const STT_LANGUAGE = process.env.STT_LANGUAGE || 'fr';

// --- Paths ---
const ADMIN_HOME = os.homedir();
const CONTAINER_HOME = '/home/claude';
const STATE_DIR = '.claudiscord';
const JOBS_FILENAME = 'jobs.json';
const ADMIN_SESSIONS_FILENAME = 'sessions.json';

fs.mkdirSync(path.join(ADMIN_HOME, STATE_DIR), { recursive: true });

const ADMIN_JOBS_FILE = path.join(ADMIN_HOME, STATE_DIR, JOBS_FILENAME);
const SANDBOX_JOBS_FILE = SANDBOX_HOME ? path.join(SANDBOX_HOME, STATE_DIR, JOBS_FILENAME) : null;
const ADMIN_SESSIONS_FILE = path.join(ADMIN_HOME, STATE_DIR, ADMIN_SESSIONS_FILENAME);
const SANDBOX_JOBS_PATH = path.posix.join(CONTAINER_HOME, STATE_DIR, JOBS_FILENAME);
const JOBS_RELATIVE = path.join(STATE_DIR, JOBS_FILENAME);

const CONTAINER_NAME = 'claudiscord-sandbox';
const DOCKER_IMAGE = 'claudiscord-sandbox';
const CONTAINER_MEMORY = '512m';
const CONTAINER_CPUS = 1;

const CLAUDE_TIMEOUT_MS = 1_200_000; // 20 min — laisse la place aux gros prompts de dev
const SHELL_TIMEOUT_MS = 300_000;
const DOCKER_CMD_TIMEOUT = 30_000;
const UPGRADE_TIMEOUT_MS = 300_000;
const DISCORD_MAX_MSG_LENGTH = 2000;
const TYPING_INTERVAL_MS = 8000;

const ALLOWED_TOOLS = 'Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task';
const DISALLOWED_TOOLS = 'CronCreate CronDelete CronList Monitor AskUserQuestion RemoteTrigger EnterPlanMode ExitPlanMode EnterWorktree ExitWorktree NotebookEdit ScheduleWakeup PushNotification Skill(loop) Skill(keybindings-help) Skill(schedule) Skill(claude-api) Skill(update-config) Skill(fewer-permission-prompts)';

const VALID_MODELS = ['opus', 'sonnet'];
const CHANNEL_DEFAULT_MODEL = 'sonnet';
const EFFORT_BY_MODEL = { opus: 'xhigh', sonnet: 'high' };

module.exports = {
	AUTHORIZED_USER_ID,
	DISCORD_TOKEN,
	CLAUDE_BIN,
	SANDBOX_HOME,
	GROQ_API_KEY,
	STT_MODEL,
	STT_LANGUAGE,
	ADMIN_HOME,
	CONTAINER_HOME,
	CONTAINER_NAME,
	JOBS_RELATIVE,
	ADMIN_JOBS_FILE,
	SANDBOX_JOBS_FILE,
	ADMIN_SESSIONS_FILE,
	SANDBOX_JOBS_PATH,
	CLAUDE_TIMEOUT_MS,
	SHELL_TIMEOUT_MS,
	DISCORD_MAX_MSG_LENGTH,
	TYPING_INTERVAL_MS,
	DOCKER_IMAGE,
	CONTAINER_MEMORY,
	CONTAINER_CPUS,
	ALLOWED_TOOLS,
	DISALLOWED_TOOLS,
	VALID_MODELS,
	CHANNEL_DEFAULT_MODEL,
	EFFORT_BY_MODEL,
	DOCKER_CMD_TIMEOUT,
	UPGRADE_TIMEOUT_MS,
};
