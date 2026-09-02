const { Client, Events, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const { DISCORD_TOKEN, DISCORD_MAX_MSG_LENGTH, TYPING_INTERVAL_MS, PROGRESS_EDIT_MS, PROGRESS_MAX } = require('./config');
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

/**
 * Assemble an agent's `{ icon, summary, detail? }` into one display line, short
 * enough to stay readable. Truncating by code point rather than by index keeps
 * a surrogate pair whole, and the ellipsis counts toward the budget.
 */
function formatProgress({ icon, summary, detail }) {
	const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
	const tail = clean(detail);
	// Truncated as a whole: a narration carries everything in `summary`, a tool
	// call splits it across both, and either can be the long part.
	const chars = [...`${clean(summary)}${tail ? ` — ${tail}` : ''}`];
	const shown = chars.length > PROGRESS_MAX
		? `${chars.slice(0, PROGRESS_MAX - 1).join('')}…`
		: chars.join('');
	return `${icon} ${shown}`;
}

// Nothing retries a failed deletion, so at least name the message left behind
// rather than losing it silently.
function deleteMessage(message) {
	message.delete().catch(err => log.warn(`Progress message ${message.id} not deleted: ${err.message}`));
}

/**
 * Live activity line for a running prompt: one message, edited in place, gone
 * once the answer is ready. Returns `{ update, clear }`.
 *
 * Edits are throttled and fire-and-forget — a dropped or rate-limited progress
 * line must never disturb the run it is describing. `update(null)` is a no-op,
 * so a caller can pass an event's outcome straight through.
 */
function startProgressReporter(channel) {
	let message = null;      // the Discord message, once created
	let pending = null;      // latest line not yet shown
	let sending = false;     // a send/edit is in flight
	let done = false;
	let timer = null;

	const flush = () => {
		timer = null;
		if (done || sending || pending === null) return;
		const text = pending;
		pending = null;
		sending = true;
		// A send that lands after clear() must not leave its message behind: the
		// clear could not delete what did not exist yet.
		const op = message
			? message.edit(text)
			: channel.send(text).then(m => {
				message = m;
				if (done) { deleteMessage(message); message = null; return; }
				// Posting clears the channel's typing indicator, and the next
				// heartbeat is up to TYPING_INTERVAL_MS away. Editing does not, so
				// only this first send needs it back.
				channel.sendTyping().catch(() => {});
			});
		op.catch(() => {}).finally(() => {
			sending = false;
			// A line that arrived during the round trip still deserves to show.
			if (pending !== null && !timer && !done) timer = setTimeout(flush, PROGRESS_EDIT_MS);
		});
	};

	return {
		update(activity) {
			if (!activity || done) return;
			pending = formatProgress(activity);
			if (!timer && !sending) timer = setTimeout(flush, PROGRESS_EDIT_MS);
		},
		clear() {
			done = true;
			clearTimeout(timer);
			if (message) deleteMessage(message);
			message = null;
		},
	};
}

function startTypingIndicator(channel) {
	const emitTyping = () => channel.sendTyping().catch(() => {});
	emitTyping();
	const interval = setInterval(emitTyping, TYPING_INTERVAL_MS);
	return () => clearInterval(interval);
}

module.exports = { createClient, getClient, login, sendChunked, sendToChannel, startTypingIndicator, startProgressReporter, resolveChannelName };
