const { Client, Events, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const { DISCORD_TOKEN, DISCORD_MAX_MSG_LENGTH, TYPING_INTERVAL_MS } = require('./config');
const log = require('./logger');

function resolveChannelName(channel) {
	if (channel.type === ChannelType.DM) {
		return channel.recipient?.username || channel.recipient?.globalName || '<dm>';
	}
	return channel.name || '<unnamed>';
}

let client = null;

function createClient() {
	client = new Client({
		partials: [Partials.Channel, Partials.Message],
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.MessageContent,
			// Voice assistant: join/leave voice channels and receive audio.
			GatewayIntentBits.GuildVoiceStates,
		],
	});

	client.on(Events.Error, err => log.error('Discord error:', err));

	return client;
}

function getClient() {
	return client;
}

async function login() {
	await client.login(DISCORD_TOKEN);
	log.info(`Discord client connected as ${client.user.tag}`);
}

function splitMessage(text, maxLength = DISCORD_MAX_MSG_LENGTH) {
	if (text.length <= maxLength) return [text];
	const chunks = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}
		let splitIdx = remaining.lastIndexOf('\n', maxLength);
		if (splitIdx < maxLength * 0.5) {
			splitIdx = remaining.lastIndexOf(' ', maxLength);
		}
		if (splitIdx < maxLength * 0.3) {
			splitIdx = maxLength;
		}
		chunks.push(remaining.slice(0, splitIdx));
		remaining = remaining.slice(splitIdx).trimStart();
	}
	return chunks;
}

/**
 * Send `text` to a channel object, transparently splitting it to stay under
 * Discord's per-message limit (1900 leaves a margin below the 2000 hard cap).
 * Centralizes chunking so callers never deal with message-size limits themselves.
 */
async function sendChunked(channel, text) {
	for (const chunk of splitMessage(text, 1900)) {
		await channel.send(chunk);
	}
}

/**
 * Same as sendChunked, but resolves the channel by id first (used where only an
 * id is known, e.g. scheduled-job notifications).
 */
async function sendToChannel(channelId, message) {
	const channel = await client.channels.fetch(channelId);
	await sendChunked(channel, message);
}

function startTypingIndicator(channel) {
	const emitTyping = () => channel.sendTyping().catch(() => {});
	emitTyping();
	const interval = setInterval(emitTyping, TYPING_INTERVAL_MS);
	return () => clearInterval(interval);
}

module.exports = { createClient, getClient, login, sendChunked, sendToChannel, startTypingIndicator, resolveChannelName };
