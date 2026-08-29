const { executeClaude, hostClaudeEnv } = require('./claude');
const { executeCodex, hostCodexEnv } = require('./codex');
const {
	sandboxClaudeEnv,
	sandboxCodexEnv,
} = require('./container');
const { runQueued } = require('./queue');
const sessions = require('./sessions');
const { AGENT_MODELS, JOB_TIMEOUT_MS } = require('./config');

/**
 * Execute a prompt with the selected agent and environment. Executions are FIFO
 * within a Discord channel; different channel keys may run concurrently.
 *
 * Channel session state is read inside the queue, just before spawn. The agent
 * returns its generated UUID, which is persisted before the next queued prompt
 * can run. A caller passing no channelId supplies its own sessionId instead and
 * never touches the channel's — that is how isolated jobs stay isolated.
 *
 * `requireSession` refuses to start when the channel has no live session, for a
 * caller that must join an EXISTING conversation rather than open one.
 *
 * `tier` ('high' for interactive prompts, 'medium' for scheduled jobs) is turned
 * into a concrete model id here and nowhere else, so no caller names a model.
 */
function executePrompt(agent, mode, prompt, options = {}) {
	const {
		channelId,
		queueKey = channelId,
		tier = 'high',
		requireSession = false,
		runLabel,
		...rest
	} = options;
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

		// Checked here rather than by the caller: the FIFO wait can last as long as
		// the prompt ahead, and every context transition (/new, mode or agent
		// switch, /remote) nulls the session id. A check made before enqueuing
		// would let a reset during that wait through, and the run would silently
		// open a fresh session — whose id is then written back to the channel.
		if (requireSession && !sessionId) {
			throw Object.assign(new Error('SESSION_REQUIRED'), { code: 'SESSION_REQUIRED' });
		}

		const models = AGENT_MODELS[agent];
		if (!models) throw new Error(`Unknown agent: ${agent}`);
		const model = models[tier];
		if (!model) throw new Error(`Unknown model tier: ${tier}`);
		// Keyed on queueKey, not channelId: an isolated job withholds channelId but
		// still occupies a channel's FIFO, so `/stop` typed there must reach it —
		// it is exactly what is blocking that channel.
		const opts = {
			...rest,
			sessionId,
			model,
			cancelKey: queueKey || null,
			// Only scheduled runs get a deadline; an interactive one has an
			// operator and `/stop`.
			timeoutMs: tier === 'medium' ? JOB_TIMEOUT_MS : 0,
			// How `/stop` names this run. Only a caller nobody is watching needs to
			// say; an interactive prompt takes spawn.js's default.
			...(runLabel ? { runLabel } : {}),
		};
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
