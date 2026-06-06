const fs = require('fs');
const crypto = require('crypto');
const { ADMIN_SESSIONS_FILE, VALID_MODELS, CHANNEL_DEFAULT_MODEL } = require('./config');
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
 *       "remoteId": null | "<agentId>",
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
 *
 * remoteId, when non-null, means the session is currently driven from the
 * Claude mobile app via `claude --bg --remote-control`. While set, the channel
 * only accepts `/remote`, `/status`, `/help`; every other message returns an
 * invalidation hint. Entering remote mode wipes `sessionId`/`sessionStarted`:
 * `claude --bg` manages its own session UUID and we don't try to reconcile
 * back, so the next Discord message after `/remote` stop starts fresh.
 */

/** @type {Map<string, {mode?: string, model?: string, sessionId?: string, sessionStarted?: boolean, remoteId?: string|null, lastName?: string}>} */
const channels = new Map();

function load() {
	try {
		const raw = fs.readFileSync(ADMIN_SESSIONS_FILE, 'utf8');
		const data = JSON.parse(raw);
		if (data && data.channels && typeof data.channels === 'object') {
			for (const [id, entry] of Object.entries(data.channels)) {
				if (!entry || typeof entry !== 'object') continue;
				channels.set(id, {
					mode: entry.mode === 'sandbox' ? 'sandbox' : 'admin',
					model: VALID_MODELS.includes(entry.model) ? entry.model : CHANNEL_DEFAULT_MODEL,
					sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
					sessionStarted: entry.sessionStarted === true,
					remoteId: typeof entry.remoteId === 'string' ? entry.remoteId : null,
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
	const tmp = ADMIN_SESSIONS_FILE + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
	fs.renameSync(tmp, ADMIN_SESSIONS_FILE);
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

/**
 * Non-allocating read of the channel's session state. Used by `/remote` start
 * to hand the existing UUID to `claude --bg --resume` before `setRemoteId`
 * wipes it.
 */
function getSession(channelId) {
	const entry = channels.get(channelId);
	return {
		sessionId: typeof entry?.sessionId === 'string' ? entry.sessionId : null,
		sessionStarted: entry?.sessionStarted === true,
	};
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

function listChannelIds() {
	return Array.from(channels.keys());
}

function removeChannel(channelId) {
	if (!channels.delete(channelId)) return false;
	persist();
	return true;
}

function getRemoteId(channelId) {
	const entry = channels.get(channelId);
	return entry?.remoteId || null;
}

function setRemoteId(channelId, remoteId) {
	const entry = ensureChannel(channelId);
	const next = typeof remoteId === 'string' && remoteId ? remoteId : null;
	if (entry.remoteId === next) return;
	entry.remoteId = next;
	if (next) {
		// Entering remote mode: forget the Discord session — `claude --bg`
		// will manage its own UUID, and the next Discord message after stop
		// allocates a fresh one.
		entry.sessionId = null;
		entry.sessionStarted = false;
	}
	persist();
	log.info(`Channel ${channelId} remoteId set to: ${next}`);
}

function listRemoteChannels() {
	const out = [];
	for (const [channelId, entry] of channels.entries()) {
		if (typeof entry.remoteId === 'string' && entry.remoteId) {
			out.push({ channelId, mode: entry.mode || 'admin', remoteId: entry.remoteId });
		}
	}
	return out;
}

/**
 * True when any channel currently has a sandbox-mode remote. Used to refuse
 * other sandbox claude executions (prompts, !shell, scheduled jobs) — those
 * would route through `killClaudeInContainer` on timeout, which
 * pkills every non-essential PID in the container and would take the live
 * remote daemon with it.
 */
function hasActiveSandboxRemote() {
	for (const entry of channels.values()) {
		if (entry.mode === 'sandbox' && typeof entry.remoteId === 'string' && entry.remoteId) return true;
	}
	return false;
}

module.exports = { load, getMode, setMode, getModel, setModel, ensureSession, markSessionStarted, getSession, setLastName, clearChannel, listChannelIds, removeChannel, getRemoteId, setRemoteId, listRemoteChannels, hasActiveSandboxRemote };
