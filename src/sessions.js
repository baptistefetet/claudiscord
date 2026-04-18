const fs = require('fs');
const { SESSIONS_FILE } = require('./config');
const log = require('./logger');

/**
 * sessions.json shape:
 * {
 *   "channels": {
 *     "<channelId>": { "mode": "admin"|"sandbox", "sessionId": "...", "lastName": "..." }
 *   }
 * }
 *
 * A channelId is valid for both DM channels and guild text channels.
 * Default mode for an unknown channel is "admin".
 */

/** @type {Map<string, {mode?: string, sessionId?: string, lastName?: string}>} */
const channels = new Map();

function load() {
	try {
		const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
		const data = JSON.parse(raw);
		if (data && data.channels && typeof data.channels === 'object') {
			for (const [id, entry] of Object.entries(data.channels)) {
				if (!entry || typeof entry !== 'object') continue;
				channels.set(id, {
					mode: entry.mode === 'sandbox' ? 'sandbox' : 'admin',
					sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
					lastName: typeof entry.lastName === 'string' ? entry.lastName : null,
				});
			}
		}
		log.info(`Loaded ${channels.size} channel session(s)`);
	} catch (err) {
		if (err.code !== 'ENOENT') log.warn('Failed to load sessions:', err.message);
	}
}

function persist() {
	const obj = { channels: Object.fromEntries(channels) };
	const tmp = SESSIONS_FILE + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
	fs.renameSync(tmp, SESSIONS_FILE);
}

function ensureChannel(channelId) {
	if (!channels.has(channelId)) channels.set(channelId, {});
	return channels.get(channelId);
}

function getMode(channelId) {
	const entry = channels.get(channelId);
	return entry?.mode || 'admin';
}

function setMode(channelId, mode) {
	if (mode !== 'admin' && mode !== 'sandbox') throw new Error(`Invalid mode: ${mode}`);
	const entry = ensureChannel(channelId);
	entry.mode = mode;
	persist();
	log.info(`Channel ${channelId} mode set to: ${mode}`);
}

function getSessionId(channelId) {
	return channels.get(channelId)?.sessionId || null;
}

function setSessionId(channelId, sessionId) {
	const entry = ensureChannel(channelId);
	entry.sessionId = sessionId;
	persist();
}

function setLastName(channelId, name) {
	const entry = ensureChannel(channelId);
	if (entry.lastName === name) return;
	entry.lastName = name;
	persist();
}

function clearChannel(channelId) {
	const entry = channels.get(channelId);
	if (!entry) return;
	entry.sessionId = null;
	persist();
}

module.exports = { load, getMode, setMode, getSessionId, setSessionId, setLastName, clearChannel };
