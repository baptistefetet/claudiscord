const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const {
	CLAUDE_BIN,
	PROMPT_TIMEOUT_MS,
	ADMIN_USER_HOME,
	SANDBOX_HOST_HOME,
	CONTAINER_NAME,
	SANDBOX_USER_HOME,
} = require('./config');
const { ensureContainer } = require('./container');
const { spawnWithTimeout } = require('./spawn');
const log = require('./logger');

// Claude-only; Codex governs its tools via --yolo. `claude -p` already drops the
// interactive tools, so DISALLOWED_TOOLS only lists what would conflict with
// claudiscord. Bundled skills are excluded via disableBundledSkills below (so new
// ones are covered automatically); plugin and .claude/skills/ ones are unaffected.
const ALLOWED_TOOLS = 'Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task';

// Native scheduling + remote session control — claudiscord owns the job and
// session lifecycle itself.
const ORCHESTRATION_TOOLS = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger'];
// Features with no place in a headless Discord relay: agent messaging, push
// notifications, git worktree switching, Jupyter notebook editing.
const UNSUPPORTED_TOOLS = ['SendMessage', 'PushNotification', 'EnterWorktree', 'ExitWorktree', 'NotebookEdit'];

const DISALLOWED_TOOLS = [
	...ORCHESTRATION_TOOLS,
	...UNSUPPORTED_TOOLS,
].join(' ');

// Passed via --settings (not ~/.claude/settings.json, which is shared with the
// admin's own interactive sessions): scopes bundled-skill exclusion to claudiscord's
// own `claude -p` invocations only.
const CLAUDE_SETTINGS = JSON.stringify({ disableBundledSkills: true });

// OAuth account usage (5h window + weekly), same endpoint Claude Code's /usage hits.
const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// systemd's inherited PATH usually omits ~/.local/bin, where `claude` itself
// lives. Without this, Bash tool calls like `claude --version` fail with
// "command not found" inside the agent.
const CLAUDE_BIN_DIR = path.dirname(CLAUDE_BIN);
const ADMIN_ENV = {
	...process.env,
	PATH: `${CLAUDE_BIN_DIR}:${process.env.PATH || ''}`,
};
const CLAUDE_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const CLAUDE_LOGIN_URL_TIMEOUT_MS = 15 * 1000;
const CLAUDE_LOGIN_URL_RE = /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+/;

function loginTargetLabel(mode) {
	return mode === 'sandbox' ? 'sandbox' : 'host';
}

function extractClaudeLoginUrl(output) {
	const match = output.match(CLAUDE_LOGIN_URL_RE);
	return match ? match[0] : null;
}

function buildClaudeLoginFlow(mode, child) {
	const target = loginTargetLabel(mode);
	const label = `Claude ${target}`;
	return {
		agent: 'claude',
		mode,
		label,
		child,
		timeoutMs: CLAUDE_LOGIN_TIMEOUT_MS,
		urlTimeoutMs: CLAUDE_LOGIN_URL_TIMEOUT_MS,
		awaitsDiscordInput: true,
		extractUrl: extractClaudeLoginUrl,
		formatUrlMessage: (url) => [
			`Claude login started for **${target}**.`,
			'Open this link on your iPhone:',
			`<${url}>`,
			'After signing in, Claude will show a code. Send only that code here.',
			'This login expires in 10 minutes. Use `/login cancel` to abort.',
		].join('\n'),
		pendingHint: 'Open the link above, then send only the code from Claude.',
		inputHint: 'Send only the code from Claude, or `/login cancel`.',
		inputReceivedMessage: 'Code received. Finishing Claude login...',
		cancelMessage: `${label} login cancelled.`,
		noUrlMessage: `${label} login did not produce a login URL. Check the service logs and try again.`,
		successMessage: `${label} login completed.`,
		cleanup: mode === 'sandbox'
			? () => {
				execFileSync('docker', [
					'exec',
					CONTAINER_NAME,
					'sh',
					'-c',
					'pkill -f "[c]laude auth login --claudeai" || true',
				], { stdio: 'ignore', timeout: 5000 });
			}
			: null,
		formatFailureMessage: ({ killed, urlSent, inputSubmitted }) => {
			if (killed) return `${label} login expired or was cancelled. Run \`/login\` to start again.`;
			const hint = urlSent && !inputSubmitted
				? 'No code was submitted.'
				: 'Claude rejected the submitted code or the login flow failed.';
			return `${hint} Run \`/login\` to try again.`;
		},
	};
}

function startClaudeLogin(mode) {
	let child;
	if (mode === 'sandbox') {
		ensureContainer();
		child = spawn('docker', [
			'exec',
			'-i',
			'-w', SANDBOX_USER_HOME,
			CONTAINER_NAME,
			'claude',
			'auth',
			'login',
			'--claudeai',
		], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	} else if (mode === 'admin') {
		child = spawn(CLAUDE_BIN, ['auth', 'login', '--claudeai'], {
			cwd: ADMIN_USER_HOME,
			env: ADMIN_ENV,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	} else {
		throw new Error(`Unknown execution mode: ${mode}`);
	}
	return buildClaudeLoginFlow(mode, child);
}

/**
 * Build Claude CLI arguments from options.
 * Extra args (e.g. --dangerously-skip-permissions) can be prepended via extraArgs.
 *
 * Session attach strategy:
 *   - sessionId  -> `--resume <uuid>`.
 *   - !sessionId -> no flag; Claude allocates an ID and emits it in JSON output.
 */
function buildClaudeArgs(prompt, options = {}) {
	const {
		sessionId = null,
		systemPrompt = null,
		model = null,
		extraArgs = [],
	} = options;

	const args = ['-p', ...extraArgs];

	if (sessionId) {
		args.push('--resume', sessionId);
	}
	if (systemPrompt) {
		args.push('--system-prompt', systemPrompt);
	}

	args.push('--output-format', 'stream-json', '--verbose');
	args.push('--allowedTools', ALLOWED_TOOLS);
	args.push('--disallowedTools', DISALLOWED_TOOLS);
	args.push('--settings', CLAUDE_SETTINGS);
	if (model) args.push('--model', model);
	args.push('--effort', model === 'sonnet' ? 'medium' : 'xhigh');
	args.push('--', prompt);

	return args;
}

// Split a stream-json stdout into its per-line JSON events. This is the single
// JSON.parse pass; every extractor below operates on the resulting array.
function parseStreamJsonEvents(stdout) {
	const events = [];
	for (const line of (stdout || '').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			// Keep only objects: a bare JSON primitive (e.g. `null`) parses
			// without throwing but would break the extractors' property access.
			const event = JSON.parse(trimmed);
			if (event && typeof event === 'object') events.push(event);
		} catch (_) {}
	}
	return events;
}

// First session_id seen in the event stream, or null.
function sessionIdFromEvents(events) {
	for (const e of events) {
		if (typeof e.session_id === 'string' && e.session_id) return e.session_id;
	}
	return null;
}

// Last `result` event in the stream, or null.
function lastResultEvent(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].type === 'result') return events[i];
	}
	return null;
}

// On a failed run the text lives near the START of the result event's JSON, so a
// naive stdout.slice(-500) returns the metadata tail instead. Null when nothing
// usable is found — the caller falls back to stderr/exit code.
function errorTextFromResultEvent(resultEvent) {
	if (!resultEvent) return null;
	return (typeof resultEvent.result === 'string' && resultEvent.result.trim())
		? resultEvent.result.trim()
		: (resultEvent.subtype || null);
}

/**
 * Collect the user-visible final answer from the event stream.
 *
 * The `result` event only carries the final text block, so a naive read
 * loses intermediate text when the conversation interleaves text with
 * tool_use. But collecting *every* assistant text block goes too far the
 * other way: it pulls in the preamble Claude often narrates before tool
 * calls ("I'll check the logs…", "Let me look at this…"), frequently in
 * English even when the final answer is in the user's language, which
 * looks like leaked thinking on the Discord side.
 *
 * Heuristic: only text blocks emitted *after* the last tool boundary (the
 * last `tool_result` or `tool_use`) are part of the final answer. Anything
 * before is interstitial narration and is dropped. If no tool activity
 * exists in the stream (no tools were used), we collect everything — the
 * only assistant text IS the answer.
 *
 * Edge case: if the last assistant turn ends on `tool_use` (no closing
 * text), there is no text after the last tool boundary and this returns ''.
 * The caller falls back to `resultEvent.result`.
 */
function finalTextFromEvents(events) {
	// Walk back to the last tool boundary — the last event carrying a
	// tool_result (user) OR a tool_use (assistant). The final answer is the
	// assistant text after it. Considering tool_use too (not only tool_result)
	// prevents an interstitial "let me run X" immediately before a tool_use
	// from being mistaken for the final answer.
	let startIdx = 0;
	for (let i = events.length - 1; i >= 0; i--) {
		const content = events[i].message?.content;
		if (!Array.isArray(content)) continue;
		const hasToolActivity = content.some(
			b => b && (b.type === 'tool_result' || b.type === 'tool_use'),
		);
		if (hasToolActivity) { startIdx = i + 1; break; }
	}

	const texts = [];
	for (let i = startIdx; i < events.length; i++) {
		const e = events[i];
		if (e.type !== 'assistant') continue;
		const content = e.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block.type === 'text' && block.text) texts.push(block.text);
		}
	}
	return texts.join('\n\n');
}

/**
 * Turn a finished spawn result ({ stdout, stderr, code }) into the parsed
 * { result, sessionId }, or throw a tagged error. Parses the stream-json
 * stdout once and derives session id, final text and error text from it.
 */
function finalizeClaudeResult(result, label) {
	const events = parseStreamJsonEvents(result.stdout);
	const sessionId = sessionIdFromEvents(events);
	const resultEvent = lastResultEvent(events);

	if (result.code !== 0) {
		const errMsg = errorTextFromResultEvent(resultEvent)
			|| result.stderr?.slice(-500)
			|| `exit code ${result.code}`;
		throw Object.assign(new Error(errMsg), { code: result.code, sessionId });
	}

	if (!resultEvent) {
		log.warn(`${label}: no result event in stream-json output`);
		return { result: result.stdout.slice(-500), sessionId };
	}
	return {
		result: finalTextFromEvents(events) || resultEvent.result || '',
		// A 0-turn result (e.g. an unrecognized slash command) still returns a
		// session_id but writes no conversation to disk, so a later --resume fails
		// with "No conversation found". Don't surface it for persistence.
		sessionId: resultEvent.num_turns === 0 ? null : sessionId,
	};
}

/**
 * Execute Claude in the given environment. The `env` descriptor abstracts where
 * and how the process runs, so host and sandbox share this one executor:
 *   - label:     log / diagnostic label
 *   - extraArgs: extra CLI flags (e.g. --dangerously-skip-permissions in sandbox)
 *   - spawn:     (args, { timeoutMs }) => Promise<{ stdout, stderr, code }>
 * On spawn rejection the partial session id is attached; otherwise the
 * stream-json output is parsed once and finalized (or thrown).
 */
async function executeClaude(prompt, options = {}, env) {
	const {
		sessionId = null,
		systemPrompt = null,
		model = null,
		timeoutMs = PROMPT_TIMEOUT_MS,
	} = options;

	if (!systemPrompt) {
		throw new Error('executeClaude requires systemPrompt');
	}

	const args = buildClaudeArgs(prompt, {
		sessionId, systemPrompt, model,
		extraArgs: env.extraArgs,
	});

	const attach = sessionId ? `resume ${sessionId}` : 'new session';
	log.info(`${env.label}: ${attach}, prompt length: ${prompt.length}`);

	let result;
	try {
		result = await env.spawn(args, { timeoutMs });
	} catch (err) {
		err.sessionId = sessionIdFromEvents(parseStreamJsonEvents(err.stdout));
		throw err;
	}
	return finalizeClaudeResult(result, env.label);
}

// Host environment: run the `claude` binary directly under the admin home.
const hostClaudeEnv = {
	label: 'Claude',
	extraArgs: [],
	spawn: (args, { timeoutMs }) => spawnWithTimeout(
		CLAUDE_BIN, args,
		{ timeoutMs, cwd: ADMIN_USER_HOME, env: ADMIN_ENV, label: 'Claude' },
	),
};

function claudeCredentialsPath(mode) {
	if (mode === 'sandbox') {
		return SANDBOX_HOST_HOME
			? path.join(SANDBOX_HOST_HOME, '.claude', '.credentials.json')
			: null;
	}
	return path.join(ADMIN_USER_HOME, '.claude', '.credentials.json');
}

/**
 * Read OAuth account usage from Anthropic (5h window + weekly) using the
 * credentials for the selected execution environment.
 */
async function getClaudeUsage(mode = 'admin') {
	const credentialsPath = claudeCredentialsPath(mode);
	if (!credentialsPath) return { available: false, reason: 'no-oauth' };

	let token;
	try {
		const raw = await fs.promises.readFile(credentialsPath, 'utf8');
		token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
	} catch {
		return { available: false, reason: 'no-oauth' };
	}
	if (!token) return { available: false, reason: 'no-oauth' };

	let res;
	try {
		res = await fetch(OAUTH_USAGE_URL, {
			headers: {
				Authorization: `Bearer ${token}`,
				'anthropic-beta': 'oauth-2025-04-20',
			},
			signal: AbortSignal.timeout(10000),
		});
	} catch (err) {
		log.warn(`getClaudeUsage(${mode}) fetch error:`, err.message);
		return { available: false, reason: 'error' };
	}

	if (res.status === 401) return { available: false, reason: 'expired' };
	if (!res.ok) {
		log.warn(`getClaudeUsage(${mode}) HTTP ${res.status}`);
		return { available: false, reason: 'error' };
	}

	const data = await res.json().catch(() => null);
	if (!data?.five_hour || !data?.seven_day) {
		return { available: false, reason: 'error' };
	}
	return {
		available: true,
		fiveHour: data.five_hour.utilization,
		weekly: data.seven_day.utilization,
		fiveHourResetAt: data.five_hour.resets_at || null,
		weeklyResetAt: data.seven_day.resets_at || null,
	};
}

module.exports = {
	ADMIN_ENV,
	executeClaude,
	hostClaudeEnv,
	getClaudeUsage,
	startClaudeLogin,
};
