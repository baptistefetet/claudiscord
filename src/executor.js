const { executeClaudeCommand } = require('./claude');
const { executeInContainer } = require('./container');
const { runQueued } = require('./queue');
const sessions = require('./sessions');

/**
 * Execute a Claude prompt on the host (admin) or in the single sandbox container.
 * All executions pass through the global queue — only one Claude runs at a time
 * across every channel, command, and scheduled job.
 *
 * When `channelId` is provided, the session state (UUID + sessionStarted) is
 * read **inside** the queue, just before spawn — that's critical, otherwise two
 * back-to-back messages on a fresh channel could both capture `sessionStarted:
 * false` and both try `--session-id`, the second one erroring with "already in
 * use". Successful (or timeout-aborted) spawns flip `sessionStarted` so the
 * next call uses `--resume`. Scheduled jobs pass no channelId — they get a
 * fresh session every run (options.sessionId stays null).
 */
function executeForMode(mode, prompt, options = {}) {
	const { channelId, ...rest } = options;
	return runQueued(async () => {
		let opts = rest;
		if (channelId) {
			const { sessionId, sessionStarted } = sessions.ensureSession(channelId);
			opts = { ...rest, sessionId, sessionStarted };
		}
		try {
			let result;
			if (mode === 'admin') result = await executeClaudeCommand(prompt, opts);
			else if (mode === 'sandbox') result = await executeInContainer(prompt, opts);
			else throw new Error(`Unknown execution mode: ${mode}`);
			if (channelId) sessions.markSessionStarted(channelId);
			return result;
		} catch (err) {
			// Timeout: claude ran for the full window, the session JSONL is on
			// disk — the next message must use --resume.
			if (channelId && err.code === 124) sessions.markSessionStarted(channelId);
			throw err;
		}
	});
}

module.exports = { executeForMode };
