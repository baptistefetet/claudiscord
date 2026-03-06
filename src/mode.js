const fs = require('fs');
const path = require('path');
const log = require('./logger');

const MODE_FILE = path.resolve(__dirname, '..', 'admin-mode.json');

let adminMode = false;

function load() {
	try {
		const raw = fs.readFileSync(MODE_FILE, 'utf8');
		const data = JSON.parse(raw);
		adminMode = !!data.adminMode;
		log.info(`Mode loaded: ${adminMode ? 'admin' : 'sandbox'}`);
	} catch (err) {
		if (err.code !== 'ENOENT') log.warn('Failed to load mode:', err.message);
		adminMode = false;
	}
}

function persist() {
	const tmp = MODE_FILE + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify({ adminMode }, null, 2), 'utf8');
	fs.renameSync(tmp, MODE_FILE);
}

function isAdminMode() {
	return adminMode;
}

function toggle() {
	adminMode = !adminMode;
	persist();
	log.info(`Mode toggled to: ${adminMode ? 'admin' : 'sandbox'}`);
	return adminMode;
}

module.exports = { load, isAdminMode, toggle };
