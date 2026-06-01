const fs = require('fs');
const path = require('path');
const config = require('./config');
const { ALLOWED_TOOLS, EFFORT_BY_MODEL, ADMIN_USER_HOME, STATE_DIR } = config;
const { getSystemPrompt } = require('./prompts');
const log = require('./logger');
const sessions = require('./sessions');
const { ensureImage, DOCKER_AVAILABLE } = require('./container');
const { executeForMode } = require('./executor');
const { isBusy } = require('./queue');
const { createClient, login, splitMessage, startTypingIndicator, resolveChannelName } = require('./discord');
const { handleCommand } = require('./commands');
const { reconcileRemotes } = require('./remote');
const { transcribeVoiceMessage } = require('./stt');
const scheduler = require('./scheduler');
const { Events, ChannelType, MessageFlags } = require('discord.js');

process.on('unhandledRejection', err => {
	log.error('Unhandled rejection:', err);
});
process.on('uncaughtException', err => {
	log.error('Uncaught exception:', err);
});

const client = createClient();

// Channels currently waiting for their turn in the global queue — used to
// avoid flooding a channel with multiple "⏳ waiting…" notices.
const waitingNotice = new Set();

client.on(Events.MessageCreate, async message => {
	if (message.author.bot) return;

	const channel = message.channel;
	const isDM = channel.type === ChannelType.DM;
	const isGuildText = channel.type === ChannelType.GuildText;
	if (!isDM && !isGuildText) return;

	const content = message.content.trim();
	const isVoice = message.flags?.has(MessageFlags.IsVoiceMessage) || false;
	if (!content && !isVoice) return;

	// Strict authorization: silently ignore every other user.
	if (message.author.id !== config.AUTHORIZED_USER_ID) return;

	// If the channel is in remote mode (or transitioning), a voice message is
	// just as invalid as a text prompt. Drop it BEFORE paying for Groq STT and
	// before echoing `🎙️ <transcript>` — `handleCommand` would reject it
	// anyway, but the gate there only runs after transcription.
	if (isVoice && !content && sessions.getRemoteId(channel.id)) {
		await channel.send(`\u{1F6F0}️ This channel is in remote mode — voice messages are ignored. Send \`/remote\` to return to Discord mode.`).catch(() => {});
		return;
	}

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
			await message.channel.send(`Transcription failed: ${err.message?.slice(0, 200) || 'unknown'}`).catch(() => {});
			return;
		}
	}

	// Commands first (they manage their own responses).
	if (await handleCommand(message)) return;

	const channelId = channel.id;
	const channelName = resolveChannelName(channel);
	sessions.setLastName(channelId, channelName);

	const mode = sessions.getMode(channelId);
	const model = sessions.getModel(channelId);
	const botName = client.user.displayName || client.user.username;
	const userName = message.author.displayName || message.author.username;
	const channelTopic = !isDM ? (channel.topic || null) : null;

	// sessionId & sessionStarted are resolved inside executor.executeForMode,
	// **inside the global queue**, to avoid a race where two consecutive
	// messages on a fresh channel both capture sessionStarted=false.
	const promptOptions = {
		channelId,
		systemPrompt: getSystemPrompt({
			botName,
			userName,
			mode,
			channelId,
			channelName,
			channelTopic,
			isDM,
			channelModel: model,
		}),
		allowedTools: ALLOWED_TOOLS,
		model,
		effort: EFFORT_BY_MODEL[model],
		outputFormat: 'stream-json',
	};

	// Surface the wait once per channel if another prompt is already running.
	if (isBusy() && !waitingNotice.has(channelId)) {
		waitingNotice.add(channelId);
		channel.send('\u23F3 Waiting for previous prompt...').catch(() => {});
	}

	let stopTyping = null;
	try {
		stopTyping = startTypingIndicator(channel);
		const result = await executeForMode(mode, prompt, promptOptions);

		stopTyping();
		stopTyping = null;

		const responseText = result.result || 'Empty response from Claude Code.';
		// result.timedOut: Claude hit the timeout (e.g. a background task held the
		// process open past end_turn) but had already produced an answer we
		// recovered. Flag it so the user knows the run was cut short.
		const prefix = result.timedOut
			? '⏱️ Timeout reached, but here is the answer Claude already produced:\n\n'
			: '';
		const chunks = splitMessage(prefix + responseText);
		for (const chunk of chunks) {
			await channel.send(chunk);
		}
	} catch (err) {
		if (stopTyping) stopTyping();

		log.error('Message handling error:', err.message || err);

		let errMsg;
		if (err.code === 124) {
			errMsg = 'Claude Code took too long, timeout!';
		} else if (err.code === 'SANDBOX_REMOTE_ACTIVE') {
			errMsg = '\u{1F6F0}️ A sandbox `/remote` session is active on another channel — sandbox prompts are paused until it stops.';
		} else if (err.message === 'NOT_AUTHENTICATED') {
			errMsg = 'You are not authenticated in the sandbox. Send `/login` for instructions.';
		} else if (err.message === 'Docker is not installed on this host') {
			errMsg = 'Docker is not installed — switch this channel to admin mode with `/admin`.';
		} else {
			errMsg = `Claude Code error: ${err.message?.slice(0, 300) || 'unknown'}\n(if this keeps happening, send \`/clear\` to reset the session)`;
		}
		await channel.send(errMsg).catch(e => log.error('Failed to send error message:', e));
	} finally {
		waitingNotice.delete(channelId);
		// Claude may have edited a jobs file even if the prompt errored — reload
		// so the scheduler picks it up immediately rather than on the next prompt.
		scheduler.reloadJobs();
	}
});

client.on(Events.ClientReady, async () => {
	log.info(`Connected as ${client.user.tag}`);
	try { await purgeInvalidChannels(); } catch (err) { log.warn('purgeInvalidChannels failed:', err.message); }
	scheduler.start();
});

// Remove sessions.json entries whose Discord channel no longer exists (channel
// deleted, bot kicked from guild, etc.). Strict on the error code: only
// `Unknown Channel` (10003) triggers removal — transient errors (network,
// rate limit, permissions) are skipped so a flaky boot doesn't nuke valid
// entries. Runs after login (needs the gateway) and after reconcileRemotes
// (which would otherwise lose its handle on stale remote agents). Scheduled
// jobs attached to a purged channel are intentionally left alone — the user
// manages job lifecycle by hand.
async function purgeInvalidChannels() {
	const ids = sessions.listChannelIds();
	if (ids.length === 0) return;
	const removed = [];
	for (const id of ids) {
		try {
			await client.channels.fetch(id);
		} catch (err) {
			if (err.code === 10003) {
				sessions.removeChannel(id);
				removed.push(id);
			} else {
				log.warn(`purgeInvalidChannels: skip ${id} (${err.message})`);
			}
		}
	}
	if (removed.length) log.info(`purgeInvalidChannels: removed ${removed.length} stale channel(s): ${removed.join(', ')}`);
}

function shutdown(signal) {
	log.info(`Received ${signal}, shutting down...`);
	scheduler.stop();
	client.destroy();
	process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
	fs.mkdirSync(path.join(ADMIN_USER_HOME, STATE_DIR), { recursive: true });
	sessions.load();
	if (DOCKER_AVAILABLE) {
		try { ensureImage(); } catch (err) { log.warn('ensureImage failed:', err.message); }
	} else {
		log.warn('Starting without Docker — sandbox mode disabled');
	}
	// Settle any remote sessions persisted from a previous run before going live.
	try { await reconcileRemotes(); } catch (err) { log.warn('reconcileRemotes failed:', err.message); }
	await login();
}

start().catch(err => {
	log.error('Failed to start:', err);
	process.exit(1);
});
