const { executeClaude, hostClaudeEnv } = require('./claude');
const { executeCodex, hostCodexEnv } = require('./codex');
const {
	sandboxClaudeEnv,
	sandboxCodexEnv,
	reconcileAgentCredentials,
	syncAgentCredentialsAfterSuccess,
	dropSandboxAgentCredentials,
} = require('./container');
const { runQueued } = require('./queue');
const sessions = require('./sessions');

function isClaudeAuthError(err) {
	const msg = String(err?.message || '').toLowerCase();
	return msg.includes('not logged in')
		|| msg.includes('please run /login')
		|| msg.includes('invalid authentication credentials')
		|| msg.includes('failed to authenticate')
		|| msg.includes('authentication_failed');
}

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
	// a timeout here triggers `killAgentProcessesInContainer`, which
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

		// Prepare shared credentials before the run. Claude only seeds host ->
		// sandbox here; sandbox -> host is allowed only after a successful sandbox
		// run, so a failed auth file cannot be propagated.
		reconcileAgentCredentials(agent);

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
			syncAgentCredentialsAfterSuccess(agent, mode);
			return result;
		} catch (err) {
			if (agent === 'claude' && mode === 'sandbox' && isClaudeAuthError(err)) {
				dropSandboxAgentCredentials('claude');
			}
			if (channelId && err.sessionId && sessionContextIsCurrent()) {
				sessions.setSessionId(channelId, err.sessionId);
			}
			throw err;
		}
	});
}

module.exports = { executePrompt };
