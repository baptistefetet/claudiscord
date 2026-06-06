const fs = require('fs');
const {
	ADMIN_SESSIONS_FILE,
	VALID_MODELS,
	CHANNEL_DEFAULT_MODEL,
	VALID_AGENTS,
	CHANNEL_DEFAULT_AGENT,
} = require('./config');
const log = require('./logger');

/**
 * sessions.json shape:
 * {
 *   "channels": {
 *     "<channelId>": {
 *       "mode": "admin"|"sandbox",
 *       "agent": "claude"|"codex",
 *       "model": "opus"|"sonnet",
 *       "sessionId": "<uuid>",
 *       "remoteId": null | "<agentId>",
 *       "lastName": "..."
 *     }
 *   }
 * }
 *
 * A channelId is valid for both DM channels and guild text channels.
 * Default mode for an unknown channel is "admin", default agent is "claude",
 * and default model is "sonnet".
 *
 * The active agent allocates sessionId and emits it in its JSON output. The
 * executor persists it after the first spawn, including on timeout when the
 * ID was emitted before the process was killed.
 *
 * remoteId, when non-null, means the session is currently driven from the
 * Claude mobile app via `claude --bg --remote-control`. While set, the channel
 * only accepts `/remote`, `/status`, `/help`; every other message returns an
 * invalidation hint. Entering remote mode wipes `sessionId`: `claude --bg`
 * manages its own session UUID and we don't try to reconcile back, so the
 * next Discord message after `/remote` stop starts fresh.
 */

/** @type {Map<string, {mode?: string, agent?: string, model?: string, sessionId?: string, remoteId?: string|null, lastName?: string}>} */
const channels = new Map();

function load() {
	try {
		const raw = fs.readFileSync(ADMIN_SESSIONS_FILE, 'utf8');
		const data = JSON.parse(raw);
		if (data && data.channels && typeof data.channels === 'object') {
			for (const [id, entry] of Object.entries(data.channels)) {
				if (!entry || typeof entry !== 'object') continue;
				const mode = entry.mode === 'sandbox' ? 'sandbox' : 'admin';
				const remoteId = typeof entry.remoteId === 'string' ? entry.remoteId : null;
				let agent = VALID_AGENTS.includes(entry.agent) ? entry.agent : CHANNEL_DEFAULT_AGENT;
				let sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : null;
				if (mode === 'sandbox' || remoteId) agent = 'claude';
				// Legacy entries preallocated Claude UUIDs before spawn. A false
				// bit means that UUID may never have been created on disk.
				if (entry.sessionStarted === false) sessionId = null;
				channels.set(id, {
					mode,
					agent,
					model: VALID_MODELS.includes(entry.model) ? entry.model : CHANNEL_DEFAULT_MODEL,
					sessionId,
					remoteId,
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

function getAgent(channelId) {
	const entry = channels.get(channelId);
	const agent = entry?.agent;
	return VALID_AGENTS.includes(agent) ? agent : CHANNEL_DEFAULT_AGENT;
}

function setAgent(channelId, agent) {
	if (!VALID_AGENTS.includes(agent)) throw new Error(`Invalid agent: ${agent}`);
	const entry = ensureChannel(channelId);
	if (entry.agent === agent) return;
	entry.agent = agent;
	entry.sessionId = null;
	persist();
	log.info(`Channel ${channelId} agent set to: ${agent}; session cleared`);
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

/**
 * Non-allocating read of the channel's active agent session.
 */
function getSession(channelId) {
	const entry = channels.get(channelId);
	return {
		sessionId: typeof entry?.sessionId === 'string' ? entry.sessionId : null,
	};
}

function setSessionId(channelId, sessionId) {
	if (typeof sessionId !== 'string' || !sessionId) return;
	const entry = ensureChannel(channelId);
	if (entry.sessionId === sessionId) return;
	entry.sessionId = sessionId;
	persist();
	log.info(`Channel ${channelId} session set to: ${sessionId}`);
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

module.exports = {
	load,
	getMode,
	setMode,
	getAgent,
	setAgent,
	getModel,
	setModel,
	getSession,
	setSessionId,
	setLastName,
	clearChannel,
	listChannelIds,
	removeChannel,
	getRemoteId,
	setRemoteId,
	listRemoteChannels,
	hasActiveSandboxRemote,
};
