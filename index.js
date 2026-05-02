const config = require('./src/config');
const { ALLOWED_TOOLS, DM_MODEL, DM_EFFORT } = config;
const { getSystemPrompt } = require('./src/prompts');
const log = require('./src/logger');
const sessions = require('./src/sessions');
const { ensureImage, DOCKER_AVAILABLE } = require('./src/container');
const { executeForMode } = require('./src/executor');
const { isBusy } = require('./src/queue');
const { createClient, login, splitMessage, startTypingIndicator } = require('./src/discord');
const { handleCommand } = require('./src/commands');
const { transcribeVoiceMessage } = require('./src/stt');
const scheduler = require('./src/scheduler');
const { Events, ChannelType, MessageFlags } = require('discord.js');

process.on('unhandledRejection', err => {
	log.error('Unhandled rejection:', err);
});
process.on('uncaughtException', err => {
	log.error('Uncaught exception:', err);
});

const client = createClient();

// Protect the bootstrap (first DM -> AUTHORIZED_USER_ID) against a race
// between two messages arriving while the first registration is in flight.
let bootstrapPending = false;

// Channels currently waiting for their turn in the global queue — used to
// avoid flooding a channel with multiple "⏳ en attente…" notices.
const waitingNotice = new Set();

function resolveChannelName(channel) {
	if (channel.type === ChannelType.DM) {
		return channel.recipient?.username || channel.recipient?.globalName || '<dm>';
	}
	return channel.name || '<unnamed>';
}

client.on(Events.MessageCreate, async message => {
	if (message.author.bot) return;

	const channel = message.channel;
	const isDM = channel.type === ChannelType.DM;
	const isGuildText = channel.type === ChannelType.GuildText;
	if (!isDM && !isGuildText) return;

	const content = message.content.trim();
	const isVoice = message.flags?.has(MessageFlags.IsVoiceMessage) || false;
	if (!content && !isVoice) return;

	const userId = message.author.id;

	// Bootstrap: the very first DM registers its author as the authorized user.
	// Only DMs can bootstrap — unsolicited guild messages must never escalate.
	if (!config.getAuthorizedUserId()) {
		if (!isDM) return;
		if (bootstrapPending) return;
		bootstrapPending = true;
		try {
			config.writeEnvValue('AUTHORIZED_USER_ID', userId);
			log.info(`Authorized user registered via first-DM bootstrap: ${userId}`);
		} catch (err) {
			bootstrapPending = false;
			log.error('Bootstrap failed:', err.message);
			return;
		}
		bootstrapPending = false;
	}

	// Strict authorization: silently ignore every other user.
	if (!config.isAuthorized(userId)) return;

	// Voice message → transcription via Groq Whisper. Text wins if both present.
	let prompt = content;
	if (!prompt && isVoice) {
		if (!config.GROQ_API_KEY) {
			log.warn('Voice message received but GROQ_API_KEY not set, ignoring');
			return;
		}
		const audio = message.attachments.find(a => a.contentType?.startsWith('audio/'));
		if (!audio) return;
		try {
			prompt = (await transcribeVoiceMessage(audio, {
				apiKey: config.GROQ_API_KEY,
				model: config.STT_MODEL,
				language: config.STT_LANGUAGE,
			})).trim();
			if (!prompt) return;
			await message.channel.send(`🎙️ ${prompt}`).catch(() => {});
		} catch (err) {
			log.error('STT failed:', err.message);
			await message.channel.send(`Transcription échouée : ${err.message?.slice(0, 200) || 'unknown'}`).catch(() => {});
			return;
		}
	}

	// Commands first (they manage their own responses).
	if (await handleCommand(message)) return;

	const channelId = channel.id;
	const channelName = resolveChannelName(channel);
	sessions.setLastName(channelId, channelName);

	const mode = sessions.getMode(channelId);
	const sessionId = sessions.getSessionId(channelId);
	const botName = client.user.displayName || client.user.username;
	const userName = message.author.displayName || message.author.username;
	const channelTopic = !isDM ? (channel.topic || null) : null;

	const promptOptions = {
		sessionId,
		systemPrompt: getSystemPrompt({
			botName,
			userName,
			mode,
			channelId,
			channelName,
			channelTopic,
			isDM,
		}),
		allowedTools: ALLOWED_TOOLS,
		model: DM_MODEL,
		effort: DM_EFFORT,
		outputFormat: 'stream-json',
	};

	// Surface the wait once per channel if another prompt is already running.
	if (isBusy() && !waitingNotice.has(channelId)) {
		waitingNotice.add(channelId);
		channel.send('\u23F3 En attente du prompt précédent...').catch(() => {});
	}

	let stopTyping = null;
	try {
		stopTyping = startTypingIndicator(channel);
		const result = await executeForMode(mode, prompt, promptOptions);

		stopTyping();
		stopTyping = null;

		if (result.sessionId) {
			sessions.setSessionId(channelId, result.sessionId);
		}

		const responseText = result.result || 'Empty response from Claude Code.';
		const chunks = splitMessage(responseText);
		for (const chunk of chunks) {
			await channel.send(chunk);
		}
	} catch (err) {
		if (stopTyping) stopTyping();

		log.error('Message handling error:', err.message || err);

		let errMsg;
		if (err.code === 124) {
			errMsg = 'Claude Code took too long, timeout!';
		} else if (err.message === 'NOT_AUTHENTICATED') {
			errMsg = 'You are not authenticated in the sandbox. Send `/login` for instructions.';
		} else if (err.message === 'Docker is not installed on this host') {
			errMsg = 'Docker is not installed — switch this channel to admin mode with `/admin`.';
		} else {
			errMsg = `Claude Code error: ${err.message?.slice(0, 300) || 'unknown'}`;
		}
		await channel.send(errMsg).catch(e => log.error('Failed to send error message:', e));
	} finally {
		waitingNotice.delete(channelId);
		// Claude may have edited a jobs file even if the prompt errored — reload
		// so the scheduler picks it up immediately rather than on the next prompt.
		scheduler.reloadJobs();
	}
});

client.on(Events.ClientReady, () => {
	log.info(`Connected as ${client.user.tag}`);
	scheduler.start();
});

function shutdown(signal) {
	log.info(`Received ${signal}, shutting down...`);
	scheduler.stop();
	client.destroy();
	process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
	sessions.load();
	if (DOCKER_AVAILABLE) {
		try { ensureImage(); } catch (err) { log.warn('ensureImage failed:', err.message); }
	} else {
		log.warn('Starting without Docker — sandbox mode disabled');
	}
	await login();
}

start().catch(err => {
	log.error('Failed to start:', err);
	process.exit(1);
});
