const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { CONTAINER_NAME, DOCKER_CMD_TIMEOUT, ATTACH_MAX_BYTES } = require('./config');
const log = require('./logger');

// One line per file in an agent's answer (convention stated in prompts.js),
// newline included so that removing it leaves no blank line.
const ATTACH_LINE = /^[ \t]*\[\[attach:[ \t]*(.+?)[ \t]*\]\][ \t]*(?:\n|$)/gm;
const NOT_A_FILE = 'not found or not a regular file';
const TOO_LARGE = `over the ${ATTACH_MAX_BYTES / 1024 / 1024} MB attached per answer`;

/**
 * Read a file where the agent runs. A sandbox path is read inside the container
 * as its user, so a symlink there can only reach what the container sees, never
 * a host file. `test -f` refuses directories and devices; `head` reads one byte
 * past `limit` to tell an oversized file.
 */
async function readFile(mode, filePath, limit) {
	if (!path.isAbsolute(filePath)) throw new Error('not an absolute path');
	let data;
	if (mode === 'sandbox') {
		data = await new Promise((resolve, reject) => execFile(
			'docker',
			['exec', CONTAINER_NAME, 'sh', '-c', 'test -f "$1" && exec head -c "$2" -- "$1"', 'sh', filePath, String(limit + 1)],
			{ encoding: 'buffer', maxBuffer: limit + 1, timeout: DOCKER_CMD_TIMEOUT },
			// A failed `test` exits 1 silently; docker itself also exits 1, with a message.
			(err, stdout, stderr) => (err
				? reject(new Error(err.code === 1 && !stderr.length ? NOT_A_FILE : String(stderr).trim() || err.message))
				: resolve(stdout)),
		));
	} else {
		const stat = await fs.promises.stat(filePath).catch(() => null);
		if (!stat?.isFile()) throw new Error(NOT_A_FILE);
		if (stat.size > limit) throw new Error(TOO_LARGE);
		data = await fs.promises.readFile(filePath);
	}
	if (data.length > limit) throw new Error(TOO_LARGE);
	return data;
}

/**
 * Take the `[[attach: /path]]` lines out of an agent's answer and read their
 * files. A file that cannot be read leaves a notice in the text instead, so the
 * user learns it was meant to come. The size limit spans all the files, so
 * repeated lines cannot pile up buffers.
 */
async function takeAttachments(text, mode) {
	const files = [];
	const notices = [];   // per line, in match order
	let budget = ATTACH_MAX_BYTES;
	for (const [, filePath] of text.matchAll(ATTACH_LINE)) {
		try {
			const data = await readFile(mode, filePath, budget);
			budget -= data.length;
			files.push({ name: path.basename(filePath), data });
			notices.push('');
		} catch (err) {
			log.warn(`Attachment ${filePath} (${mode}): ${err.message}`);
			notices.push(`📎 \`${filePath}\` not attached: ${err.message.slice(0, 200)}\n`);
		}
	}
	if (!notices.length) return { text, files };
	let i = 0;
	return { text: text.replace(ATTACH_LINE, () => notices[i++]).trim(), files };
}

module.exports = { takeAttachments };
