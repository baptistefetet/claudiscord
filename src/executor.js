const { executeClaudeCommand } = require('./claude');
const { executeInContainer } = require('./container');
const { runQueued } = require('./queue');

/**
 * Execute a Claude prompt on the host (admin) or in the single sandbox container.
 * All executions pass through the global queue — only one Claude runs at a time
 * across every channel, command, and scheduled job.
 */
function executeForMode(mode, prompt, options = {}) {
	return runQueued(() => {
		if (mode === 'admin') return executeClaudeCommand(prompt, options);
		if (mode === 'sandbox') return executeInContainer(prompt, options);
		throw new Error(`Unknown execution mode: ${mode}`);
	});
}

module.exports = { executeForMode };
