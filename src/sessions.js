const fs = require('fs');
const path = require('path');
const { SESSIONS_FILE } = require('./config');
const log = require('./logger');

/** @type {Map<string, string>} userId -> sessionId */
const sessions = new Map();

let adminMode = false;

function load() {
	try {
		const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
		const data = JSON.parse(raw);

		// New format: { adminMode, sessions: { userId: sessionId } }
		if (data.sessions && typeof data.sessions === 'object') {
			adminMode = !!data.adminMode;
			for (const [k, v] of Object.entries(data.sessions)) {
				if (typeof v === 'string') sessions.set(k, v);
			}
		} else {
			// Legacy format: { userId: sessionId } (flat)
			for (const [k, v] of Object.entries(data)) {
				if (typeof v === 'string') sessions.set(k, v);
			}
		}
		log.info(`Loaded ${sessions.size} session(s), mode: ${adminMode ? 'admin' : 'sandbox'}`);
	} catch (err) {
		if (err.code !== 'ENOENT') log.warn('Failed to load sessions:', err.message);
	}
}

function persist() {
	const obj = {
		adminMode,
		sessions: Object.fromEntries(sessions),
	};
	const tmp = SESSIONS_FILE + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
	fs.renameSync(tmp, SESSIONS_FILE);
}

function getSessionId(userId) {
	return sessions.get(userId) || null;
}

function setSessionId(userId, sessionId) {
	sessions.set(userId, sessionId);
	persist();
}

function clearSession(userId) {
	sessions.delete(userId);
	persist();
}

function isAdminMode() {
	return adminMode;
}

function setAdminMode(value) {
	adminMode = !!value;
	persist();
	log.info(`Mode set to: ${adminMode ? 'admin' : 'sandbox'}`);
	return adminMode;
}

module.exports = { load, getSessionId, setSessionId, clearSession, isAdminMode, setAdminMode };
