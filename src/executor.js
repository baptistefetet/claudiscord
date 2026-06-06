const { executeClaudeCommand } = require('./claude');
const { executeCodexCommand } = require('./codex');
const { executeInContainer } = require('./container');
const { runQueued } = require('./queue');
const sessions = require('./sessions');

/**
 * Execute a prompt with the selected agent and environment. All executions
 * pass through the global queue, so only one agent process runs at a time
 * across every channel and scheduled job.
 *
 * Channel session state is read inside the queue, just before spawn. The agent
 * returns its generated UUID, which is persisted before the next queued prompt
 * can run. Scheduled jobs pass no channelId and get a fresh session every run.
 */
function executePrompt(agent, mode, prompt, options = {}) {
	const { channelId, ...rest } = options;
	// Refuse sandbox executions while another channel holds a sandbox remote:
	// a timeout here triggers `killClaudeInContainer`, which
	// pkills every non-init PID in the container and would take the live
	// remote daemon with it. The channel hosting the remote is already gated
	// inside `handleCommand`, so this only blocks *other* sandbox traffic.
	if (mode === 'sandbox' && sessions.hasActiveSandboxRemote()) {
		throw Object.assign(new Error('SANDBOX_REMOTE_ACTIVE'), { code: 'SANDBOX_REMOTE_ACTIVE' });
	}
	return runQueued(async () => {
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
		const opts = { ...rest, sessionId };
		const sessionContextIsCurrent = () => (
			!channelId
			|| (sessions.getAgent(channelId) === agent && sessions.getMode(channelId) === mode)
		);

		try {
			let result;
			if (agent === 'codex') {
				if (mode !== 'admin') {
					throw Object.assign(new Error('CODEX_ADMIN_ONLY'), {
						code: 'CODEX_ADMIN_ONLY',
					});
				}
				result = await executeCodexCommand(prompt, opts);
			} else if (agent === 'claude') {
				if (mode === 'admin') result = await executeClaudeCommand(prompt, opts);
				else if (mode === 'sandbox') result = await executeInContainer(prompt, opts);
				else throw new Error(`Unknown execution mode: ${mode}`);
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
