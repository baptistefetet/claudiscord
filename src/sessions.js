const fs = require('fs');
const crypto = require('crypto');
const { SESSIONS_FILE, VALID_MODELS, CHANNEL_DEFAULT_MODEL } = require('./config');
const log = require('./logger');

/**
 * sessions.json shape:
 * {
 *   "channels": {
 *     "<channelId>": {
 *       "mode": "admin"|"sandbox",
 *       "model": "opus"|"sonnet",
 *       "sessionId": "<uuid>",
 *       "sessionStarted": boolean,
 *       "lastName": "..."
 *     }
 *   }
 * }
 *
 * A channelId is valid for both DM channels and guild text channels.
 * Default mode for an unknown channel is "admin", default model is "sonnet".
 *
 * sessionId is allocated up-front by ensureSession() so we always know it
 * before spawning claude (lets a message that times out remain resumable).
 * sessionStarted distinguishes the first invocation (`--session-id <uuid>`,
 * which creates the session) from subsequent invocations (`--resume <uuid>`,
 * required because reusing --session-id on an existing UUID errors out with
 * "Session ID X is already in use").
 */

/** @type {Map<string, {mode?: string, model?: string, sessionId?: string, sessionStarted?: boolean, lastName?: string}>} */
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
					model: VALID_MODELS.includes(entry.model) ? entry.model : CHANNEL_DEFAULT_MODEL,
					sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
					sessionStarted: entry.sessionStarted === true,
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

function getModel(channelId) {
	const entry = channels.get(channelId);
	const model = entry?.model;
	return VALID_MODELS.includes(model) ? model : CHANNEL_DEFAULT_MODEL;
}

function setModel(channelId, model) {
	if (!VALID_MODELS.includes(model)) throw new Error(`Invalid model: ${model}`);
	const entry = ensureChannel(channelId);
	entry.model = model;
	persist();
	log.info(`Channel ${channelId} model set to: ${model}`);
}

function ensureSession(channelId) {
	const entry = ensureChannel(channelId);
	if (typeof entry.sessionId !== 'string' || !entry.sessionId) {
		entry.sessionId = crypto.randomUUID();
		entry.sessionStarted = false;
		persist();
		log.info(`Channel ${channelId} new session allocated: ${entry.sessionId}`);
	}
	return { sessionId: entry.sessionId, sessionStarted: entry.sessionStarted === true };
}

function markSessionStarted(channelId) {
	const entry = channels.get(channelId);
	if (!entry || entry.sessionStarted === true) return;
	entry.sessionStarted = true;
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
	entry.sessionStarted = false;
	persist();
}

module.exports = { load, getMode, setMode, getModel, setModel, ensureSession, markSessionStarted, setLastName, clearChannel };
