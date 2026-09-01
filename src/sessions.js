const fs = require('fs');
const {
	ADMIN_SESSIONS_FILE,
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
 *       "sessionId": "<uuid>",
 *       "remoteId": null | "<agentId>",
 *       "autojoin": true|false,
 *       "depotPath": null | "<git repository root>",
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

/** @type {Map<string, {mode?: string, agent?: string, sessionId?: string, remoteId?: string|null, autojoin?: boolean, lastName?: string}>} */
const channels = new Map();

// In-memory only. Gates the one-time thread-starter injection against the race
// where concurrent first-turn messages all see a null sessionId.
const starterClaimed = new Set();

/**
 * Notified whenever a channel loses its agent session. Injected by index.js:
 * reacting to it means touching the jobs store and Discord, neither of which
 * this module may depend on. Fire-and-forget — every caller below is
 * synchronous and must stay so, so the observer owns its errors.
 */
let sessionClearedHandler = null;

function onSessionCleared(handler) {
	sessionClearedHandler = handler;
}

function fireSessionCleared(channelId, reason) {
	if (!sessionClearedHandler) return;
	try {
		sessionClearedHandler(channelId, reason);
	} catch (err) {
		log.error(`sessionCleared handler failed for channel ${channelId}:`, err.message);
	}
}

/**
 * Single choke point for dropping a channel's agent session — /new, a mode or
 * agent switch and the /remote handover all land here. Going through one
 * function is what makes the observer exhaustive: a future command that resets
 * a session cannot forget to notify it. Persists first, so the observer never
 * sees a state that is not on disk yet.
 */
function dropSession(entry, channelId, reason) {
	const had = Boolean(entry.sessionId);
	entry.sessionId = null;
	entry.usage = null;
	starterClaimed.delete(channelId);
	persist();
	if (had) fireSessionCleared(channelId, reason);
}

// A hand-edited or older sessions.json can hold anything; a string costUsd would
// concatenate on the next turn and then throw in toFixed.
function sanitizeUsage(usage) {
	if (!usage || typeof usage !== 'object') return null;
	const num = value => (Number.isFinite(value) && value >= 0 ? value : null);
	const clean = {
		context: num(usage.context),
		window: num(usage.window),
		costUsd: num(usage.costUsd),
	};
	return (clean.context || clean.costUsd) ? clean : null;
}

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
					sessionId,
					remoteId,
					autojoin: entry.autojoin === true,
					lastName: typeof entry.lastName === 'string' ? entry.lastName : null,
					usage: sanitizeUsage(entry.usage),
					depotPath: typeof entry.depotPath === 'string' ? entry.depotPath : null,
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
 * Snapshot a parent channel's mode/agent onto a thread. Idempotent, so the
 * inheritance is a one-off at first contact, not a live link.
 */
function ensureFromParent(channelId, parentId) {
	if (channels.has(channelId)) return;
	const parent = parentId ? channels.get(parentId) : null;
	channels.set(channelId, {
		mode: parent?.mode === 'sandbox' ? 'sandbox' : 'admin',
		agent: VALID_AGENTS.includes(parent?.agent) ? parent.agent : CHANNEL_DEFAULT_AGENT,
		sessionId: null,
		remoteId: null,
		// Threads are never voice channels; kept for a uniform entry shape.
		autojoin: false,
		lastName: null,
		usage: null,
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
	// The repository path names a filesystem the channel just left: the same
	// path in the other environment is another directory, or none.
	entry.depotPath = null;
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
	dropSession(entry, channelId, 'agent switch');
	log.info(`Channel ${channelId} agent set to: ${agent}; session cleared`);
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

/**
 * Record what the turn that just finished reported. `costUsd` accumulates over
 * the conversation — each turn reports only its own — while context and window
 * are a snapshot, the conversation's current size. Persisted so it survives a
 * restart alongside the conversation it describes.
 */
function setUsage(channelId, usage) {
	if (!usage) return;
	const entry = ensureChannel(channelId);
	// Context and window describe the turn that just ran and are replaced, never
	// carried over: keeping a previous window would let one agent's denominator
	// survive into another's token count.
	entry.usage = sanitizeUsage({
		context: usage.context || null,
		window: usage.window || null,
		costUsd: ((entry.usage?.costUsd || 0) + (usage.costUsd || 0)) || null,
	});
	persist();
}

function getUsage(channelId) {
	return channels.get(channelId)?.usage || null;
}

/**
 * The git repository `/diff` reports on for this channel. Channel configuration,
 * not conversation state: `/new` and a mode or agent switch leave it alone. It is
 * only a repository root — the agent still runs from its environment's home.
 */
function getDepotPath(channelId) {
	return channels.get(channelId)?.depotPath || null;
}

function setDepotPath(channelId, depotPath) {
	const entry = ensureChannel(channelId);
	const next = typeof depotPath === 'string' && depotPath ? depotPath : null;
	if (entry.depotPath === next) return;
	entry.depotPath = next;
	persist();
	log.info(`Channel ${channelId} depot path set to: ${next}`);
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
	dropSession(entry, channelId, 'session reset');
}

function listChannelIds() {
	return Array.from(channels.keys());
}

function removeChannel(channelId) {
	if (!channels.delete(channelId)) return false;
	starterClaimed.delete(channelId);
	persist();
	// Unconditional, unlike dropSession: the channel itself is gone, so its
	// non-isolated jobs are undeliverable whether or not a session was live.
	fireSessionCleared(channelId, 'channel removed');
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
	// `claude --bg` manages its own UUID
	if (next) dropSession(entry, channelId, 'remote handover');
	else persist();
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
	onSessionCleared,
	ensureFromParent,
	claimStarter,
	getMode,
	setMode,
	getAgent,
	setAgent,
	getAutojoin,
	setAutojoin,
	listAutojoinChannelIds,
	getSession,
	setSessionId,
	setUsage,
	getUsage,
	getDepotPath,
	setDepotPath,
	setLastName,
	clearChannel,
	listChannelIds,
	removeChannel,
	getRemoteId,
	setRemoteId,
	listRemoteChannels,
	hasActiveSandboxRemote,
};
