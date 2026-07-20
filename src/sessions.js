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
 *       "autojoin": true|false,
 *       "lastName": "..."
 *     }
 *   }
 * }
 *
 * A channelId covers DM, guild text and voice channels alike.
 *
 * sessionId is allocated by the agent and emitted in its JSON output; the
 * executor persists it after the first spawn, including on error.
 *
 * autojoin: per-voice-channel policy, see src/voice.js.
 *
 * remoteId, when non-null, means the channel is driven from the Claude mobile app
 * (`claude --bg --remote-control`) and only accepts remoteAllowed commands
 * (src/commands.js). Entering remote mode wipes sessionId — `claude --bg` manages
 * its own UUID and we don't reconcile back.
 */

/** @type {Map<string, {mode?: string, agent?: string, model?: string, sessionId?: string, remoteId?: string|null, autojoin?: boolean, lastName?: string}>} */
const channels = new Map();

// In-memory only. Gates the one-time thread-starter injection against the race
// where concurrent first-turn messages all see a null sessionId.
const starterClaimed = new Set();

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
				if (remoteId) agent = 'claude';
				// Legacy: a false bit means that UUID may never have been created.
				if (entry.sessionStarted === false) sessionId = null;
				// Rebuilt field by field, not spread: a new persisted field must be
				// added here too or it is silently dropped on the next boot.
				channels.set(id, {
					mode,
					agent,
					model: VALID_MODELS.includes(entry.model) ? entry.model : CHANNEL_DEFAULT_MODEL,
					sessionId,
					remoteId,
					autojoin: entry.autojoin === true,
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

/**
 * Snapshot a parent channel's mode/agent/model onto a thread. Idempotent, so the
 * inheritance is a one-off at first contact, not a live link.
 */
function ensureFromParent(channelId, parentId) {
	if (channels.has(channelId)) return;
	const parent = parentId ? channels.get(parentId) : null;
	channels.set(channelId, {
		mode: parent?.mode === 'sandbox' ? 'sandbox' : 'admin',
		agent: VALID_AGENTS.includes(parent?.agent) ? parent.agent : CHANNEL_DEFAULT_AGENT,
		model: VALID_MODELS.includes(parent?.model) ? parent.model : CHANNEL_DEFAULT_MODEL,
		sessionId: null,
		remoteId: null,
		// Threads are never voice channels; kept for a uniform entry shape.
		autojoin: false,
		lastName: null,
	});
	persist();
	log.info(`Thread ${channelId} inherited config from parent ${parentId || '<none>'}`);
}

/**
 * Claim the one-time thread-starter injection. Returns true exactly once per
 * process. Synchronous, so it can gate the injection before any `await`.
 */
function claimStarter(channelId) {
	if (starterClaimed.has(channelId)) return false;
	starterClaimed.add(channelId);
	return true;
}

function getMode(channelId) {
	const entry = channels.get(channelId);
	return entry?.mode || 'admin';
}

function setMode(channelId, mode) {
	if (mode !== 'admin' && mode !== 'sandbox') throw new Error(`Invalid mode: ${mode}`);
	const entry = ensureChannel(channelId);
	if (entry.mode === mode) return;
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

function getAutojoin(channelId) {
	return channels.get(channelId)?.autojoin === true;
}

function setAutojoin(channelId, on) {
	const entry = ensureChannel(channelId);
	const next = on === true;
	if (entry.autojoin === next) return;
	entry.autojoin = next;
	persist();
	log.info(`Channel ${channelId} autojoin set to: ${next}`);
}

function listAutojoinChannelIds() {
	const out = [];
	for (const [channelId, entry] of channels.entries()) {
		if (entry.autojoin === true) out.push(channelId);
	}
	return out;
}

/** Non-allocating read of the channel's active agent session. */
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
	starterClaimed.delete(channelId);
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
	starterClaimed.delete(channelId);
	persist();
}

function listChannelIds() {
	return Array.from(channels.keys());
}

function removeChannel(channelId) {
	if (!channels.delete(channelId)) return false;
	starterClaimed.delete(channelId);
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
	if (next) entry.sessionId = null; // `claude --bg` manages its own UUID
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
 * Gates sandbox `!shell`: its timeout path pkills by command pattern inside the
 * container, which can match and kill a live remote daemon.
 */
function hasActiveSandboxRemote() {
	for (const entry of channels.values()) {
		if (entry.mode === 'sandbox' && typeof entry.remoteId === 'string' && entry.remoteId) return true;
	}
	return false;
}

module.exports = {
	load,
	ensureFromParent,
	claimStarter,
	getMode,
	setMode,
	getAgent,
	setAgent,
	getModel,
	setModel,
	getAutojoin,
	setAutojoin,
	listAutojoinChannelIds,
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
