const { AUTHORIZED_USER_ID, ALLOWED_TOOLS, DM_MODEL, DM_EFFORT } = require('./src/config');
const { getSystemPrompt, getSandboxSystemPrompt } = require('./src/prompts');
const log = require('./src/logger');
const sessions = require('./src/sessions');
const { ensureImage } = require('./src/container');
const { executeForUser } = require('./src/executor');
const { mergeUserJobs } = require('./src/jobs-store');
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

// Create Discord client
const client = createClient();

client.on(Events.MessageCreate, async message => {
	if (message.author.bot) return;

	const isDM = message.channel.type === 1 || message.channel.type === 'DM';
	if (!isDM) return;

	const content = message.content.trim();
	if (!content) return;

	// Check for commands
	if (await handleCommand(message)) return;

	let stopTyping = null;
	try {
		stopTyping = startTypingIndicator(message.channel);

		const userId = message.author.id;
		const sessionId = sessions.getSessionId(userId);
		const botName = client.user.displayName;
		const userName = message.author.displayName;
		const isAdminDm = userId === AUTHORIZED_USER_ID && sessions.isAdminMode();
		const dmOptions = {
			sessionId,
			systemPrompt: isAdminDm
				? getSystemPrompt({ botName, userName })
				: getSandboxSystemPrompt({ botName, userName }),
			allowedTools: ALLOWED_TOOLS,
			model: DM_MODEL,
			effort: DM_EFFORT,
			outputFormat: 'stream-json',
		};
		const targetUserId = isAdminDm ? null : userId;
		const result = await executeForUser(targetUserId, content, dmOptions);
		if (targetUserId != null) {
			try {
				mergeUserJobs(targetUserId);
			} catch (err) {
				log.warn(`Failed to merge jobs for user ${targetUserId}:`, err.message);
			}
		}

		stopTyping();
		stopTyping = null;

		if (result.sessionId) {
			sessions.setSessionId(userId, result.sessionId);
		}

		const responseText = result.result || 'Empty response from Claude Code.';
		const chunks = splitMessage(responseText);
		for (const chunk of chunks) {
			await message.channel.send(chunk);
		}
	} catch (err) {
		if (stopTyping) stopTyping();

		log.error('Message handling error:', err.message || err);

		let errMsg;
		if (err.code === 124) {
			errMsg = 'Claude Code took too long, timeout!';
		} else if (err.message === 'NOT_AUTHENTICATED') {
			errMsg = 'You are not authenticated in the sandbox. Send `/login` for instructions.';
		} else {
			errMsg = `Claude Code error: ${err.message?.slice(0, 300) || 'unknown'}`;
		}
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

// Async startup
async function start() {
	sessions.load();
	ensureImage();
	await login();
}

start().catch(err => {
	log.error('Failed to start:', err);
	process.exit(1);
});
