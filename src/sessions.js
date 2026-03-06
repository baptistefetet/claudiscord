const fs = require('fs');
const path = require('path');
const { SESSIONS_FILE } = require('./config');
const log = require('./logger');

/** @type {Map<string, string>} userId -> sessionId */
const sessions = new Map();

function load() {
	try {
		const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
		const obj = JSON.parse(raw);
		for (const [k, v] of Object.entries(obj)) {
			if (typeof v === 'string') sessions.set(k, v);
		}
		log.info(`Loaded ${sessions.size} session(s) from ${SESSIONS_FILE}`);
	} catch (err) {
		if (err.code !== 'ENOENT') log.warn('Failed to load sessions:', err.message);
	}
}

function persist() {
	const obj = Object.fromEntries(sessions);
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

module.exports = { load, getSessionId, setSessionId, clearSession };
