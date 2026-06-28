const fs = require('fs');
const path = require('path');
const { CLAUDE_BIN, PROMPT_TIMEOUT_MS, ADMIN_USER_HOME } = require('./config');
const { spawnWithTimeout } = require('./spawn');
const log = require('./logger');

// Tool permissions for the Claude agent (host and sandbox). Fixed by design:
// claudiscord strips every tool that could interfere with its own operation
// (local schedulers, plan mode, notebook edits, harness-config skills, …).
// Claude-only — Codex governs its tools via --yolo and ignores these.
const ALLOWED_TOOLS = 'Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task';
const DISALLOWED_TOOLS = 'CronCreate CronDelete CronList Monitor AskUserQuestion RemoteTrigger EnterPlanMode ExitPlanMode EnterWorktree ExitWorktree NotebookEdit ScheduleWakeup PushNotification Skill(loop) Skill(keybindings-help) Skill(schedule) Skill(claude-api) Skill(update-config) Skill(fewer-permission-prompts)';

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
		effort = null,
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
	if (model) args.push('--model', model);
	if (effort) args.push('--effort', effort);
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

// Human-readable error text from a result event: its `result` field, falling
// back to `subtype`. On a failed run (e.g. usage limit, credit balance) this
// text lives near the START of the result event's JSON, so a naive
// stdout.slice(-500) returns the metadata tail (usage stats) instead. Returns
// null when nothing usable is found — the caller falls back to stderr/exit code.
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
		effort = null,
		timeoutMs = PROMPT_TIMEOUT_MS,
	} = options;

	if (!systemPrompt) {
		throw new Error('executeClaude requires systemPrompt');
	}

	const args = buildClaudeArgs(prompt, {
		sessionId, systemPrompt, model, effort,
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

/**
 * Read the OAuth account usage from Anthropic (5h window + weekly).
 * Token comes from the host credentials file — usage is account-wide, so it is
 * identical whether the channel is admin or sandbox. Never throws: returns a
 * tagged result the caller renders into a friendly Discord message.
 */
async function getClaudeUsage() {
	let token;
	try {
		const raw = await fs.promises.readFile(
			path.join(ADMIN_USER_HOME, '.claude', '.credentials.json'),
			'utf8',
		);
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
		log.warn('getClaudeUsage fetch error:', err.message);
		return { available: false, reason: 'error' };
	}

	if (res.status === 401) return { available: false, reason: 'expired' };
	if (!res.ok) {
		log.warn(`getClaudeUsage HTTP ${res.status}`);
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
};
