const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { DIFF_MAX_MESSAGES, DIFF_MAX_FILE_CHARS, DIFF_PATH_TIMEOUT_MS } = require('./config');
const { formatDiffPages } = require('./discord');
const sessions = require('./sessions');
const log = require('./logger');

/**
 * `/diff`: a channel's repository, reported as plain Discord messages.
 *
 * The repository is per channel (`depotPath` in the sessions file) and asked for
 * the first time the command runs, the way `/login` asks for its code — so no
 * path is hardcoded anywhere and each channel points at its own project.
 */

/**
 * Run git and return its stdout. `core.quotePath=false` keeps non-ASCII paths
 * verbatim instead of C-quoted, so a filename with an accent stays usable both
 * as a label and as an argument on the way back in.
 */
async function git(repo, args) {
	try {
		const { stdout } = await execFileAsync(
			'git', ['-C', repo, '-c', 'core.quotePath=false', ...args],
			{ maxBuffer: 32 * 1024 * 1024 },
		);
		return stdout;
	} catch (err) {
		// Exit 1 is how `diff --no-index` reports "these differ", the normal
		// outcome here. Nothing else may pass: a maxBuffer overflow also leaves
		// partial stdout behind, and accepting it would report a truncated diff
		// as if it were the whole change.
		if (err.code === 1) return err.stdout || '';
		throw err;
	}
}

/**
 * The repository root containing `dir`, or null when there is none. Resolving to
 * the root means a path given anywhere inside the project still works, and the
 * stored value is always the same for a given repository.
 */
async function resolveRepoRoot(dir) {
	if (!dir.startsWith('/')) return { error: 'not an absolute path' };
	try {
		const root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
		return root ? { root } : { error: 'not a git repository' };
	} catch (err) {
		// Git refuses over ownership or permissions with the same exit code as
		// "not a repository", and the difference is exactly what the user needs
		// to fix it — so its own words are passed on rather than paraphrased.
		const reason = (err.stderr || err.message).trim().split('\n')[0].replace(/^fatal: /, '');
		log.warn(`/diff: ${dir}: ${reason}`);
		return { error: reason };
	}
}

/**
 * Cut a combined diff into one entry per file.
 *
 * The `index`/`---`/`+++` preamble is dropped because the title already names
 * the file, but only until the first `@@`: past that point a removed line whose
 * content starts with `--` is itself a `--- ` line, and matching on the prefix
 * alone would silently delete it from the report.
 */
function splitDiffByFile(raw) {
	const files = [];
	let current = null;

	// Git still C-quotes a path holding a quote, a tab or a newline, even with
	// core.quotePath=false — which only stops the octal escaping of non-ASCII.
	// The remaining escapes are the ones JSON uses.
	const unquote = (s) => {
		if (!s.startsWith('"')) return s;
		try { return JSON.parse(s); } catch { return s; }
	};
	// Git appends a tab after an unquoted name containing a space, to keep the
	// header unambiguous; it is not part of the path.
	const namedBy = side => (
		side && side !== '/dev/null' ? unquote(side).replace(/\t.*$/, '').replace(/^[ab]\//, '') : ''
	);
	// `diff --git a/<p> b/<p>` cannot be parsed by looking for ` b/`: a path may
	// contain that very substring. Both halves are the same path, so the middle
	// is the split. Only a chmod and an empty new file need this — everything
	// else carries a `---`/`+++` pair or a `rename to`.
	const fromHeader = (rest) => {
		const half = (rest.length - 1) / 2;
		if (!Number.isInteger(half) || rest[half] !== ' ') return '';
		const left = namedBy(rest.slice(0, half));
		return left && left === namedBy(rest.slice(half + 1)) ? left : '';
	};
	const resolve = (file) => {
		file.path = namedBy(file.plus) || file.renamed || namedBy(file.minus) || file.path;
	};

	for (const line of raw.split('\n')) {
		if (line.startsWith('diff --git ')) {
			current = {
				path: fromHeader(line.slice(11)) || '?',
				status: '', header: true, plus: '', minus: '', renamed: '',
				lines: [], additions: 0, deletions: 0,
			};
			files.push(current);
			continue;
		}
		if (!current) continue;
		if (current.header) {
			if (line.startsWith('@@')) { current.header = false; resolve(current); }
			else {
				if (line.startsWith('new file mode')) current.status = 'new';
				else if (line.startsWith('deleted file mode')) current.status = 'deleted';
				else if (line.startsWith('rename to ')) { current.status = 'renamed'; current.renamed = line.slice(10); }
				else if (line.startsWith('old mode ')) current.status = current.status || 'mode';
				else if (line.startsWith('--- ')) current.minus = line.slice(4);
				else if (line.startsWith('+++ ')) current.plus = line.slice(4);
				// A binary file has no hunk at all; this line is the whole diff.
				else if (line.startsWith('Binary files')) { current.lines.push(line); current.header = false; resolve(current); }
				continue;
			}
		}
		if (line.startsWith('+')) current.additions++;
		else if (line.startsWith('-')) current.deletions++;
		current.lines.push(line);
	}
	// A rename or a chmod never reaches a hunk, so it never got named above.
	for (const file of files) if (file.header) resolve(file);
	return files;
}

/** A repository's uncommitted work, or null when it is clean. */
async function collectRepoDiff(root) {
	const status = (await git(root, ['status', '--porcelain'])).trim();
	if (!status) return null;
	const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
	// `diff HEAD` covers the index and the working tree in one pass, but no form
	// of `git diff` knows about untracked files — without the second half, a file
	// the agent just created would be missing from the report entirely.
	// -U1 rather than git's three lines of context: on a file with long lines,
	// three lines around each change fill a Discord message with text nobody
	// asked about, and the budget is spent before the changes are.
	let raw = await git(root, ['diff', 'HEAD', '--no-color', '-U1']);
	// -z: a filename may contain a newline, and splitting on one would hand git
	// two paths that do not exist.
	const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
	for (const file of untracked) {
		try {
			raw += await git(root, ['diff', '--no-index', '--no-color', '-U1', '--', '/dev/null', file]);
		} catch (err) {
			log.warn(`/diff: ${root}/${file}: ${err.message}`);
		}
	}
	const files = splitDiffByFile(raw);
	return {
		branch,
		files,
		// Kept because `git status` saw something the diff may not describe: an
		// empty new file yields no diff section, and dropping it here would show
		// the project as clean.
		status,
		additions: files.reduce((n, f) => n + f.additions, 0),
		deletions: files.reduce((n, f) => n + f.deletions, 0),
	};
}

function capFileDiff(text) {
	if (text.length <= DIFF_MAX_FILE_CHARS) return text;
	const cut = text.lastIndexOf('\n', DIFF_MAX_FILE_CHARS);
	return `${text.slice(0, cut > 0 ? cut : DIFF_MAX_FILE_CHARS)}\n… file diff truncated`;
}

/**
 * The whole report, as messages ready to send in order. Assembled before
 * anything is sent so the ceiling covers the report entirely — summary and
 * closing notice included — instead of only its body.
 */
function buildDiffMessages(root, repo) {
	const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
	// Names reach Discord unfiltered otherwise, and a deep path or a long branch
	// would push a header over the message limit — which drops it and stops the
	// whole report. Paths are cut from the left, where the filename is not.
	const short = (s, max) => (s.length > max ? `…${s.slice(-(max - 1))}` : s);
	const messages = [
		`📊 **${short(path.basename(root), 80)}** \`${short(repo.branch, 80)}\` — ${plural(repo.files.length, 'file')}, \`+${repo.additions} -${repo.deletions}\``,
	];
	if (!repo.files.length) {
		messages.push(`\`\`\`\n${repo.status.slice(0, 1500)}\n\`\`\``);
		return messages;
	}

	// A file is all or nothing: its first page out of eight tells you a file
	// changed, which the summary already did, and costs a message to say it.
	// Skipped rather than stopped at the first one that does not fit, so a big
	// file does not hide the small ones behind it. One message is held back for
	// the notice, which names what was left out — a count alone would not tell
	// you whether the part you cared about is missing.
	let left = DIFF_MAX_MESSAGES - 2;
	const skipped = [];
	for (const file of repo.files) {
		const status = file.status ? ` *(${file.status})*` : '';
		const title = `**${short(file.path, 150)}**${status} \`+${file.additions} -${file.deletions}\``;
		// A rename or a chmod carries no hunk; the title alone says it all, and an
		// empty code block under it would only add noise.
		const body = file.lines.join('\n').replace(/\n+$/, '');
		const pages = body ? formatDiffPages(title, capFileDiff(body)) : [title];
		if (pages.length > left) {
			skipped.push(`${short(file.path, 60)} (${plural(pages.length, 'message')})`);
			continue;
		}
		messages.push(...pages);
		left -= pages.length;
	}
	if (skipped.length) {
		messages.push(`… not shown, ${DIFF_MAX_MESSAGES}-message budget reached: ${skipped.join(', ')}`);
	}
	return messages;
}

// Channels waiting for their repository path, with the timer that gives up on
// them. Without the timeout a forgotten prompt would swallow the next ordinary
// message of that channel forever.
const pendingPath = new Map();

function clearPending(channelId) {
	clearTimeout(pendingPath.get(channelId));
	pendingPath.delete(channelId);
}

function askForPath(channel, reason = 'No repository is set for this channel.') {
	clearPending(channel.id);
	pendingPath.set(channel.id, setTimeout(() => pendingPath.delete(channel.id), DIFF_PATH_TIMEOUT_MS));
	return channel.send(`${reason} Send its absolute path (any directory inside it works), or \`/cancel\`.`);
}

/** Dropped when the channel is driven elsewhere, so it cannot eat a later message. */
function cancelPendingDepotPath(channelId) {
	clearPending(channelId);
}

/**
 * Consume a message that answers the pending path question. Returns true when it
 * was consumed. `isCommand` lets a slash command typed instead of a path run
 * normally — a path also starts with `/`, so the two cannot be told apart by
 * shape alone.
 */
async function finishPendingDepotPath(channel, content, isCommand) {
	if (!pendingPath.has(channel.id)) return false;
	const trimmed = content.trim();

	// Claimed before the first await, so two messages racing to answer cannot
	// both get through, and a slow validation cannot clear a question asked
	// after it.
	clearPending(channel.id);

	if (trimmed === '/cancel') {
		await channel.send('Cancelled — no repository set.');
		return true;
	}
	if (isCommand(trimmed)) return false;
	// The channel may have left admin mode since the question was asked, and the
	// answer would then set up a host repository the command itself refuses.
	if (sessions.getMode(channel.id) !== 'admin') {
		await channel.send('Channel is no longer in admin mode — `/diff` cancelled.');
		return true;
	}

	const { root, error } = await resolveRepoRoot(trimmed);
	if (!root) {
		// The question is reopened: a typo should cost one retry, not the command.
		askForPath(channel, `\`${trimmed.slice(0, 200)}\`: ${error}.`);
		return true;
	}
	sessions.setDepotPath(channel.id, root);
	await channel.send(`Repository set to \`${root}\`.`);
	await reportSafely(channel, root);
	return true;
}

async function reportSafely(channel, root) {
	try {
		const repo = await collectRepoDiff(root);
		if (!repo) {
			await channel.send(`No uncommitted changes in \`${root}\`.`);
			return;
		}
		for (const message of buildDiffMessages(root, repo)) {
			await channel.send(message);
		}
	} catch (err) {
		log.warn(`/diff: ${root}: ${err.message}`);
		await channel.send(`Could not read \`${root}\`: ${err.message.slice(0, 300)}`);
	}
}

/**
 * `/diff` — the channel repository's uncommitted work, as plain paginated
 * messages. No external service and no interactive viewer: Discord's own
 * scrollback is the navigation, which costs nothing to maintain and works the
 * same on mobile.
 */
async function handleDiff({ channel, channelId }) {
	const root = sessions.getDepotPath(channelId);
	if (!root) {
		await askForPath(channel);
		return true;
	}
	await reportSafely(channel, root);
	return true;
}

module.exports = { handleDiff, finishPendingDepotPath, cancelPendingDepotPath };
