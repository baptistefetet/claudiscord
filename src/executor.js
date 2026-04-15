const { executeClaudeCommandQueued } = require('./claude');
const { executeInContainerQueued } = require('./container');

/**
 * Execute Claude on host or in a user's container.
 * `userId == null` routes to the host queue, otherwise to the user's container queue.
 */
function executeForUser(userId, prompt, options = {}) {
	if (userId == null) {
		return executeClaudeCommandQueued(prompt, options);
	}
	return executeInContainerQueued(userId, prompt, options);
}

module.exports = { executeForUser };
