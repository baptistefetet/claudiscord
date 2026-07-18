const { executeClaude, hostClaudeEnv } = require('./claude');
const { executeCodex, hostCodexEnv } = require('./codex');
const {
	sandboxClaudeEnv,
	sandboxCodexEnv,
} = require('./container');
const { runQueued, executionLocks } = require('./queue');
const sessions = require('./sessions');

/**
 * Execute a prompt with the selected agent and environment. Executions are FIFO
 * within a Discord channel; different channel keys may run concurrently.
 *
 * Channel session state is read inside the queue, just before spawn. The agent
 * returns its generated UUID, which is persisted before the next queued prompt
 * can run. Scheduled jobs pass no channelId and get a fresh session every run.
 */
function executePrompt(agent, mode, prompt, options = {}) {
	const { channelId, queueKey = channelId, ...rest } = options;
	return runQueued(queueKey, async () => {
		if (
			channelId
			&& (sessions.getAgent(channelId) !== agent || sessions.getMode(channelId) !== mode)
		) {
			throw Object.assign(new Error('CHANNEL_CONTEXT_CHANGED'), {
				code: 'CHANNEL_CONTEXT_CHANGED',
			});
		}

		const sessionId = channelId
			? sessions.getSession(channelId).sessionId
			: (rest.sessionId || null);
		const contextRevision = channelId ? sessions.getContextRevision(channelId) : null;
		const opts = { ...rest, sessionId };
		const sessionContextIsCurrent = () => (
			!channelId
			|| (
				sessions.getAgent(channelId) === agent
				&& sessions.getMode(channelId) === mode
				&& sessions.getContextRevision(channelId) === contextRevision
			)
		);

		try {
			let result;
			if (agent === 'codex') {
				const env = mode === 'sandbox' ? sandboxCodexEnv()
					: mode === 'admin' ? hostCodexEnv
					: null;
				if (!env) throw new Error(`Unknown execution mode: ${mode}`);
				result = await executeCodex(prompt, opts, env);
			} else if (agent === 'claude') {
				const env = mode === 'sandbox' ? sandboxClaudeEnv()
					: mode === 'admin' ? hostClaudeEnv
					: null;
				if (!env) throw new Error(`Unknown execution mode: ${mode}`);
				result = await executeClaude(prompt, opts, env);
			} else {
				throw new Error(`Unknown agent: ${agent}`);
			}

			if (channelId && result.sessionId && sessionContextIsCurrent()) {
				sessions.setSessionId(channelId, result.sessionId);
			}
			return result;
		} catch (err) {
			if (channelId && err.sessionId && sessionContextIsCurrent()) {
				sessions.setSessionId(channelId, err.sessionId);
			}
			throw err;
		}
	}, { locks: executionLocks(mode) });
}

module.exports = { executePrompt };
