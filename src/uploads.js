const fs = require('fs');
const path = require('path');
const { ADMIN_FILES_DIR, SANDBOX_HOST_FILES_DIR } = require('./config');
const { writeSandboxUpload, DOCKER_AVAILABLE } = require('./container');
const log = require('./logger');

// Build a filesystem-safe basename and make it unique within the current batch.
// Across batches we intentionally overwrite by name (see CLAUDE.md "File uploads").
function uniqueName(rawName, used) {
	const base = (path.basename(rawName || 'file').replace(/[\x00-\x1f]/g, '').trim()) || 'file';
	if (!used.has(base)) { used.add(base); return base; }
	const ext = path.extname(base);
	const stem = base.slice(0, base.length - ext.length);
	let i = 2;
	let candidate;
	do { candidate = `${stem}-${i}${ext}`; i++; } while (used.has(candidate));
	used.add(candidate);
	return candidate;
}

// Download each Discord attachment and persist it into the channel mode's
// .claudiscord/files dir. Returns the list of saved names (for the Discord echo).
// Throws on the first failed download — the caller surfaces it to the channel.
async function saveUploads(attachments, mode) {
	const useSandbox = mode === 'sandbox' && DOCKER_AVAILABLE && Boolean(SANDBOX_HOST_FILES_DIR);
	const dir = useSandbox ? SANDBOX_HOST_FILES_DIR : ADMIN_FILES_DIR;
	if (!useSandbox) fs.mkdirSync(dir, { recursive: true });

	const used = new Set();
	const names = [];
	for (const att of attachments) {
		const res = await fetch(att.url);
		if (!res.ok) throw new Error(`download failed for ${att.name || 'file'} (${res.status})`);
		const buf = Buffer.from(await res.arrayBuffer());
		const name = uniqueName(att.name, used);
		if (useSandbox) writeSandboxUpload(name, buf);
		else fs.writeFileSync(path.join(dir, name), buf);
		names.push(name);
	}
	log.info(`Saved ${names.length} upload(s) to ${dir}: ${names.join(', ')}`);
	return names;
}

module.exports = { saveUploads };
