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
// Default to ~/.local/bin/codex — where chatgpt.com/codex/install.sh drops the
// binary. An absolute path rather than a PATH lookup because the service runs
// under systemd, whose PATH does not include ~/.local/bin.
const CODEX_BIN = process.env.CODEX_BIN || path.join(os.homedir(), '.local/bin/codex');
// Optional: only required when sandbox mode is used. If unset, sandbox
// is reported as unavailable just like when Docker is missing.
const SANDBOX_HOST_HOME = process.env.SANDBOX_HOME || null;

// Optional: enables Groq Whisper transcription of Discord voice messages.
// If unset, voice messages are silently ignored (legacy behaviour).
const GROQ_API_KEY = process.env.GROQ_API_KEY || null;
const STT_MODEL = process.env.STT_MODEL || 'whisper-large-v3';
const STT_LANGUAGE = process.env.STT_LANGUAGE || 'fr';

// Optional: enables the voice assistant (/voice) — OpenAI TTS for spoken
// replies. Voice mode also needs GROQ_API_KEY for transcription.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const TTS_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.TTS_VOICE || 'ash';
// Speech rate multiplier, clamped to the endpoint's accepted range (0.25–4).
const TTS_SPEED = Math.min(4, Math.max(0.25, parseFloat(process.env.TTS_SPEED) || 1));

// Required by `/diff`, which publishes the patch as a secret gist and refuses
// to run without it. Needs the `gist` scope.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;

// --- Paths ---
const ADMIN_USER_HOME = os.homedir();
const SANDBOX_USER_HOME = '/home/claude';
const STATE_DIR = '.claudiscord';
const JOBS_FILENAME = 'jobs.db';
const ADMIN_SESSIONS_FILENAME = 'sessions.json';

const ADMIN_JOBS_FILE = path.join(ADMIN_USER_HOME, STATE_DIR, JOBS_FILENAME);
const SANDBOX_HOST_JOBS_FILE = SANDBOX_HOST_HOME ? path.join(SANDBOX_HOST_HOME, STATE_DIR, JOBS_FILENAME) : null;
const ADMIN_SESSIONS_FILE = path.join(ADMIN_USER_HOME, STATE_DIR, ADMIN_SESSIONS_FILENAME);
const SANDBOX_JOBS_FILE = path.posix.join(SANDBOX_USER_HOME, STATE_DIR, JOBS_FILENAME);

// Uploaded files dropped by the user (see src/uploads.js). Sibling of jobs.db.
const ADMIN_FILES_DIR = path.join(ADMIN_USER_HOME, STATE_DIR, 'files');
const SANDBOX_HOST_FILES_DIR = SANDBOX_HOST_HOME ? path.join(SANDBOX_HOST_HOME, STATE_DIR, 'files') : null;
const SANDBOX_FILES_DIR = path.posix.join(SANDBOX_USER_HOME, STATE_DIR, 'files'); // path seen inside the container (system prompt)
const SANDBOX_CODEX_HOME = path.posix.join(SANDBOX_USER_HOME, '.codex'); // CODEX_HOME inside the container

const CONTAINER_NAME = 'claudiscord-sandbox';
const DOCKER_IMAGE = 'claudiscord-sandbox';
const CONTAINER_CPUS = 1;

const SHELL_TIMEOUT_MS = 300_000;
const KILL_GRACE_MS = 5000; // SIGTERM→SIGKILL grace for killed child processes
const DOCKER_CMD_TIMEOUT = 30_000;
const UPGRADE_TIMEOUT_MS = 600_000; // Sandbox apt upgrade
// Scheduled runs only. An interactive prompt has an operator watching it and
// `/stop` to end it; a job fires with nobody there, and a stuck one holds its
// channel's queue and blocks maintenance until someone notices.
const JOB_TIMEOUT_MS = 3_600_000;
// How long `/stop` waits for the process to actually exit before answering.
// Comfortably past KILL_GRACE_MS, since SIGKILL settles it by then.
const STOP_REPORT_TIMEOUT_MS = 15_000;
const DISCORD_MAX_MSG_LENGTH = 2000;
const TYPING_INTERVAL_MS = 8000;
// Minimum delay between two edits of the progress message. Discord rate-limits
// edits per channel, and a line that changes faster than this is unreadable.
const PROGRESS_EDIT_MS = 2000;
// Longest activity line shown. Well under the message limit, and a tool input is
// rarely informative past that.
const PROGRESS_MAX = 160;

// How long `/diff` waits for the repository path it asked for, before dropping
// the question rather than swallowing the channel's next ordinary message.
const DIFF_PATH_TIMEOUT_MS = 300_000;
// Hard ceiling on the collected patch. A safety net against a working tree
// nobody meant to diff, not a budget: it truncates with a notice rather than
// pushing a gist no browser will render.
const DIFF_MAX_BYTES = 5 * 1024 * 1024;
// A gist upload sits between the user and their diff, so it gives up and says so
// rather than leaving the command hanging on a dead network.
const GIST_TIMEOUT_MS = 15_000;

// Voice assistant tuning: silence that ends an utterance, and inactivity
// before the bot leaves the voice channel on its own.
const VOICE_SILENCE_MS = 900;
const VOICE_IDLE_TIMEOUT_MS = 900_000; // 15 min

const VALID_AGENTS = ['claude', 'codex'];
const CHANNEL_DEFAULT_AGENT = 'claude';

// Two model tiers per agent. Interactive prompts (text + voice) use `high`,
// scheduled jobs use `medium`. src/executor.js is the only resolver — no caller
// ever names a concrete model id.
const AGENT_MODELS = {
	claude: { high: 'opus', medium: 'sonnet' },
	codex: { high: 'gpt-6-astra', medium: 'gpt-5.6-terra' },
};

// Single reasoning effort for every agent and every model above. Claude takes it
// via --effort, Codex via -c model_reasoning_effort (which overrides config.toml,
// so this stays the single source).
const REASONING_EFFORT = 'xhigh';

module.exports = {
	AUTHORIZED_USER_ID,
	DISCORD_TOKEN,
	CLAUDE_BIN,
	CODEX_BIN,
	SANDBOX_HOST_HOME,
	GROQ_API_KEY,
	STT_MODEL,
	STT_LANGUAGE,
	OPENAI_API_KEY,
	TTS_MODEL,
	TTS_VOICE,
	TTS_SPEED,
	GITHUB_TOKEN,
	VOICE_SILENCE_MS,
	VOICE_IDLE_TIMEOUT_MS,
	ADMIN_USER_HOME,
	SANDBOX_USER_HOME,
	CONTAINER_NAME,
	ADMIN_JOBS_FILE,
	SANDBOX_HOST_JOBS_FILE,
	ADMIN_SESSIONS_FILE,
	SANDBOX_JOBS_FILE,
	ADMIN_FILES_DIR,
	SANDBOX_HOST_FILES_DIR,
	SANDBOX_FILES_DIR,
	SANDBOX_CODEX_HOME,
	STATE_DIR,
	JOBS_FILENAME,
	SHELL_TIMEOUT_MS,
	KILL_GRACE_MS,
	DISCORD_MAX_MSG_LENGTH,
	TYPING_INTERVAL_MS,
	PROGRESS_EDIT_MS,
	PROGRESS_MAX,
	DIFF_PATH_TIMEOUT_MS,
	DIFF_MAX_BYTES,
	GIST_TIMEOUT_MS,
	DOCKER_IMAGE,
	CONTAINER_CPUS,
	VALID_AGENTS,
	CHANNEL_DEFAULT_AGENT,
	AGENT_MODELS,
	REASONING_EFFORT,
	DOCKER_CMD_TIMEOUT,
	UPGRADE_TIMEOUT_MS,
	JOB_TIMEOUT_MS,
	STOP_REPORT_TIMEOUT_MS,
};
