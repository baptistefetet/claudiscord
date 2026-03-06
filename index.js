const { AUTHORIZED_USER_ID, getSystemPrompt, PROFILES } = require('./src/config');
const log = require('./src/logger');
const sessions = require('./src/sessions');
const { executeDM } = require('./src/claude');
const { createClient, login, splitMessage, startTypingIndicator } = require('./src/discord');
const { handleCommand } = require('./src/commands');
const scheduler = require('./src/scheduler');
const { Events } = require('discord.js');

process.on('unhandledRejection', err => {
	log.error('Unhandled rejection:', err);
});
process.on('uncaughtException', err => {
	log.error('Uncaught exception:', err);
});

// Load sessions from disk
sessions.load();

// Create Discord client
const client = createClient();

client.on(Events.MessageCreate, async message => {
	if (message.author.bot) return;

	const isDM = message.channel.type === 1 || message.channel.type === 'DM';
	if (!isDM) return;

	// Phase 1: admin-only
	if (message.author.id !== AUTHORIZED_USER_ID) return;

	const content = message.content.trim();
	if (!content) return;

	// Check for commands
	if (await handleCommand(message)) return;

	let stopTyping = null;
	try {
		stopTyping = startTypingIndicator(message.channel);

		const userId = message.author.id;
		const sessionId = sessions.getSessionId(userId);

		const result = await executeDM(content, {
			sessionId,
			systemPrompt: getSystemPrompt(),
			allowedTools: PROFILES.admin,
			outputFormat: 'json',
		});

		stopTyping();
		stopTyping = null;

		if (result.sessionId) {
			sessions.setSessionId(userId, result.sessionId);
		}

		const responseText = result.result || 'Reponse vide de Claude Code.';
		const chunks = splitMessage(responseText);
		for (const chunk of chunks) {
			await message.channel.send(chunk);
		}
	} catch (err) {
		if (stopTyping) stopTyping();

		const errMsg = err.code === 124
			? 'Claude Code a pris trop de temps, timeout !'
			: `Erreur Claude Code : ${err.message?.slice(0, 300) || 'unknown'}`;
		await message.channel.send(errMsg).catch(e => log.error('Failed to send error message:', e));
	}
});

client.on(Events.ClientReady, () => {
	log.info(`Connected as ${client.user.tag}`);

	// Start scheduler after Discord is ready (so sendDM works)
	scheduler.start();
});

// Graceful shutdown
function shutdown(signal) {
	log.info(`Received ${signal}, shutting down...`);
	scheduler.stop();
	client.destroy();
	process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start
login().catch(err => {
	log.error('Failed to start:', err);
	process.exit(1);
});
