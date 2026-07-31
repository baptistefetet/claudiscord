const { executeClaude, hostClaudeEnv } = require('./claude');
const { executeCodex, hostCodexEnv } = require('./codex');
const {
	sandboxClaudeEnv,
	sandboxCodexEnv,
} = require('./container');
const { runQueued } = require('./queue');
const sessions = require('./sessions');
const { AGENT_MODELS } = require('./config');

/**
 * Execute a prompt with the selected agent and environment. Executions are FIFO
 * within a Discord channel; different channel keys may run concurrently.
 *
 * Channel session state is read inside the queue, just before spawn. The agent
 * returns its generated UUID, which is persisted before the next queued prompt
 * can run. Scheduled jobs pass no channelId and get a fresh session every run.
 *
 * `tier` ('high' for interactive prompts, 'medium' for scheduled jobs) is turned
 * into a concrete model id here and nowhere else, so no caller names a model.
 */
function executePrompt(agent, mode, prompt, options = {}) {
	const { channelId, queueKey = channelId, tier = 'high', ...rest } = options;
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
		const models = AGENT_MODELS[agent];
		if (!models) throw new Error(`Unknown agent: ${agent}`);
		const model = models[tier];
		if (!model) throw new Error(`Unknown model tier: ${tier}`);
		const opts = { ...rest, sessionId, model };
		const sessionContextIsCurrent = () => (
			!channelId
			|| (
				sessions.getAgent(channelId) === agent
				&& sessions.getMode(channelId) === mode
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
	});
}

module.exports = { executePrompt };
