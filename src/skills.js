const fs = require('fs');
const path = require('path');
const { ADMIN_USER_HOME, SANDBOX_HOST_HOME } = require('./config');
const log = require('./logger');

// Both CLIs discover user skills the same way: one directory per skill, holding a
// SKILL.md. A single path per agent covers both the user scope and the project
// scope, since the cwd of every run IS the home directory.
const SKILLS_DIR = { claude: ['.claude', 'skills'], codex: ['.codex', 'skills'] };

// Read from the host: the sandbox home is a bind-mount of /home/claude, so
// listing needs no container (same shortcut as the sandbox jobs database).
function homeFor(mode) {
	return mode === 'sandbox' ? SANDBOX_HOST_HOME : ADMIN_USER_HOME;
}

/**
 * Sorted skill names available to `agent` in `mode`, [] when there are none and
 * null when the environment has no home (sandbox not configured).
 *
 * Scope is the user's own skills directory. Not listed: plugin-provided skills,
 * Codex's system skills (hidden `.system/` subdirectory, shipped with the CLI),
 * and Claude's bundled ones — which are disabled for claudiscord runs anyway
 * (`disableBundledSkills`, see claude.js).
 */
function listSkills(agent, mode) {
	const home = homeFor(mode);
	if (!home) return null;
	const dir = path.join(home, ...SKILLS_DIR[agent]);
	let entries;
	try {
		entries = fs.readdirSync(dir);
	} catch (err) {
		if (err.code !== 'ENOENT') log.warn(`listSkills(${agent}, ${mode}):`, err.message);
		return [];
	}
	// SKILL.md is the only test: it implies a directory, follows symlinked skills
	// and drops the junk files (.DS_Store…) that sit next to them.
	return entries
		.filter(name => fs.existsSync(path.join(dir, name, 'SKILL.md')))
		.sort();
}

module.exports = { listSkills };
