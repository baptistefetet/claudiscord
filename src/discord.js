const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const { BATBOT_DISCORD_TOKEN, DISCORD_MAX_MSG_LENGTH, TYPING_INTERVAL_MS } = require('./config');
const log = require('./logger');

let client = null;

function createClient() {
	client = new Client({
		partials: [Partials.Channel, Partials.Message],
		intents: [GatewayIntentBits.DirectMessages],
	});

	client.on(Events.Error, err => log.error('Discord error:', err));

	return client;
}

function getClient() {
	return client;
}

async function login() {
	await client.login(BATBOT_DISCORD_TOKEN);
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

async function sendDM(userId, message) {
	const user = await client.users.fetch(userId);
	const dm = await user.createDM();
	const chunks = splitMessage(message, 1900);
	for (const chunk of chunks) {
		await dm.send(chunk);
	}
}

function startTypingIndicator(channel) {
	const emitTyping = () => channel.sendTyping().catch(() => {});
	emitTyping();
	const interval = setInterval(emitTyping, TYPING_INTERVAL_MS);
	return () => clearInterval(interval);
}

module.exports = { createClient, getClient, login, splitMessage, sendDM, startTypingIndicator };
