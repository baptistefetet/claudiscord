require('dotenv').config();
const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const MESSAGES_DIR = process.env.MESSAGES_DIR || path.resolve(__dirname, 'messages');
const AUTHORIZED_USER_ID = process.env.AUTHORIZED_USER_ID;
const CLAUDE_TIMEOUT_MS = 300_000;
const DISCORD_MAX_MSG_LENGTH = 2000;
const MAX_DM_FILE_SIZE_BYTES = 1024 * 1024;
const EMPTY_DM_FILE = { sessionId: null, messages: [] };

/*--------------------------------------------------------------
  Discord client
--------------------------------------------------------------*/
const client = new Client({
	partials: [Partials.Channel, Partials.Message],
	intents: [
		GatewayIntentBits.DirectMessages
	]
});

process.on('unhandledRejection', err => {
	console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', err => {
	console.error('Uncaught exception:', err);
});

/*--------------------------------------------------------------
  Helpers
--------------------------------------------------------------*/
function getDmMessagesFilePath(userId) {
	return path.join(MESSAGES_DIR, `${userId}.json`);
}

async function ensureMessagesDirExists() {
	await fs.mkdir(MESSAGES_DIR, { recursive: true });
}

async function loadDmMessages(filePath) {
	try {
		const raw = await fs.readFile(filePath, 'utf8');
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return { sessionId: null, messages: parsed };
		if (parsed && Array.isArray(parsed.messages)) return parsed;
		return { ...EMPTY_DM_FILE };
	} catch (err) {
		if (err.code === 'ENOENT') return { ...EMPTY_DM_FILE };
		console.error(`Failed to load DM messages from ${filePath}:`, err);
		return { ...EMPTY_DM_FILE };
	}
}

async function getFileSize(filePath) {
	try {
		const stats = await fs.stat(filePath);
		return stats.size;
	} catch (err) {
		if (err.code === 'ENOENT') return 0;
		throw err;
	}
}

function removeOldestExchange(messages) {
	if (messages.length > 0) messages.shift();
	if (messages.length > 0) messages.shift();
}

async function persistDmMessage(userId, role, content, timestamp) {
	await ensureMessagesDirExists();
	const filePath = getDmMessagesFilePath(userId);
	const data = await loadDmMessages(filePath);
	const fileSize = await getFileSize(filePath);

	if (fileSize > MAX_DM_FILE_SIZE_BYTES) {
		removeOldestExchange(data.messages);
	}

	data.messages.push({ role, content, timestamp });
	await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function waitForClaudeResponse(userId) {
	const filePath = getDmMessagesFilePath(userId);
	return new Promise((resolve, reject) => {
		let resolved = false;

		const cleanup = () => {
			resolved = true;
			clearTimeout(timer);
			if (watcher) watcher.close();
		};

		const timer = setTimeout(() => {
			if (resolved) return;
			cleanup();
			reject(new Error('timeout'));
		}, CLAUDE_TIMEOUT_MS);

		const checkForResponse = async () => {
			if (resolved) return;
			try {
				const data = await loadDmMessages(filePath);
				const msgs = data.messages;
				if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
					cleanup();
					resolve(msgs[msgs.length - 1].content);
				}
			} catch (_) { /* ignore read errors, retry on next event */ }
		};

		const watcher = fsSync.watch(filePath, () => checkForResponse());
		watcher.on('error', () => {});
	});
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

function startTypingIndicator(channel, intervalMs = 8000) {
	const emitTyping = () => channel.sendTyping().catch(() => {});
	emitTyping();
	const interval = setInterval(emitTyping, intervalMs);
	return () => clearInterval(interval);
}

/*--------------------------------------------------------------
  Discord message handler
--------------------------------------------------------------*/
client.on(Events.MessageCreate, async message => {
	if (message.author.bot) return;

	const isDM = message.channel.type === 1 || message.channel.type === 'DM';
	if (!isDM) return;

	const content = message.content.trim();
	if (!content) return;

	// /clear command (authorized user only)
	if (content === '/clear' && message.author.id === AUTHORIZED_USER_ID) {
		const filePath = getDmMessagesFilePath(message.author.id);
		await fs.writeFile(filePath, JSON.stringify({ sessionId: null, messages: [] }, null, 2), 'utf8');
		await message.channel.send('Conversation réinitialisée.');
		return;
	}

	let stopTypingIndicator = null;
	try {
		stopTypingIndicator = startTypingIndicator(message.channel);
		await persistDmMessage(
			message.author.id,
			'user',
			message.content,
			new Date(message.createdTimestamp).toISOString()
		);

		const response = await waitForClaudeResponse(message.author.id);
		stopTypingIndicator?.();
		stopTypingIndicator = null;

		const chunks = splitMessage(response);
		for (const chunk of chunks) {
			await message.channel.send(chunk);
		}
	} catch (err) {
		stopTypingIndicator?.();
		stopTypingIndicator = null;
		const errMsg = err.message?.includes('timeout')
			? 'Claude Code a pris trop de temps, timeout !'
			: `Erreur Claude Code : ${err.message}`;
		await message.channel.send(errMsg);
		await persistDmMessage(message.author.id, 'assistant', errMsg, new Date().toISOString());
	}
});

client.on(Events.ClientReady, () => {
	console.log(`BatBot connected as ${client.user.tag}`);
});

client.on(Events.Error, error => {
	console.error('Discord error:', error);
});

/*--------------------------------------------------------------
  Start up
--------------------------------------------------------------*/
async function main() {
	try {
		await fs.mkdir(MESSAGES_DIR, { recursive: true });
		await client.login(process.env.BATBOT_DISCORD_TOKEN);
	} catch (error) {
		console.error('Error during BatBot startup:', error);
		process.exit(1);
	}
}

main();
