const { AUTHORIZED_USER_ID } = require('./config');
const sessions = require('./sessions');

/**
 * Handle special commands. Returns true if the message was a command.
 */
async function handleCommand(message) {
	const content = message.content.trim();
	const userId = message.author.id;

	if (content === '/clear' && userId === AUTHORIZED_USER_ID) {
		sessions.clearSession(userId);
		await message.channel.send('Conversation reinitialisee.');
		return true;
	}

	// Phase 2: /sandbox

	return false;
}

module.exports = { handleCommand };
