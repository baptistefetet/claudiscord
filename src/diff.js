const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const {
	DIFF_PATH_TIMEOUT_MS, DIFF_MAX_BYTES, CONTAINER_NAME,
} = require('./config');
const { resolveChannelName } = require('./discord');
const { ensureContainer } = require('./container');
const gist = require('./gist');
const sessions = require('./sessions');
const log = require('./logger');

/**
 * `/diff`: a channel's repository, summarized in one Discord line with the patch
 * itself delivered whole as a secret gist, however large it is. GITHUB_TOKEN is
 * not optional here — without it the command has nowhere to publish.
 *
 * The repository is per channel (`depotPath` in the sessions file) and asked for
 * the first time the command runs, the way `/login` asks for its code — so no
 * path is hardcoded anywhere and each channel points at its own project.
 *
 * Both environments are supported: the path is read where the channel runs, on
 * the host or inside the container. It is therefore dropped when the channel
 * changes mode, since it names a filesystem that changed too.
 */

/**
 * Run git in the channel's environment and return its stdout.
 * `core.quotePath=false` keeps non-ASCII paths verbatim instead of C-quoted, so
 * a filename with an accent stays usable both as a label and as an argument on
 * the way back in.
 */
async function git(mode, repo, args) {
	const gitArgs = ['-C', repo, '-c', 'core.quotePath=false', ...args];
	const [cmd, argv] = mode === 'sandbox'
		? ['docker', ['exec', CONTAINER_NAME, 'git', ...gitArgs]]
		: ['git', gitArgs];
	const { stdout } = await execFileAsync(cmd, argv, { maxBuffer: 32 * 1024 * 1024 });
	return stdout;
}

/**
 * The repository root containing `dir`, or null when there is none. Resolving to
 * the root means a path given anywhere inside the project still works, and the
 * stored value is always the same for a given repository.
 */
async function resolveRepoRoot(mode, dir) {
	if (!dir.startsWith('/')) return { error: 'not an absolute path' };
	try {
		const root = (await git(mode, dir, ['rev-parse', '--show-toplevel'])).trim();
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
 * Per-file counters, from `git diff --numstat -z`.
 *
 * `-z` prints paths verbatim, so a rename is told apart from a plain path by the
 * empty third field git leaves before the two paths it then emits — the reason
 * the format exists at all. Tabs are located rather than split on, since with
 * `-z` a path may hold one.
 */
function parseNumstat(out) {
	const parts = out.split('\0');
	const stats = [];
	for (let i = 0; i < parts.length; i++) {
		if (!parts[i]) continue;
		const t1 = parts[i].indexOf('\t');
		const t2 = parts[i].indexOf('\t', t1 + 1);
		if (t1 < 0 || t2 < 0) continue;
		// A binary file has "-" for both counts, which reads as 0.
		const additions = Number(parts[i].slice(0, t1)) || 0;
		const deletions = Number(parts[i].slice(t1 + 1, t2)) || 0;
		const inline = parts[i].slice(t2 + 1);
		// Rename: the preimage and postimage follow as their own records.
		const filePath = inline || parts[i += 2];
		stats.push({ path: filePath, additions, deletions });
	}
	return stats;
}

/**
 * Append while the report stays deliverable. Past the ceiling the patch is cut
 * with a notice rather than dropped: a truncated diff still answers most of the
 * question, and an undeliverable one answers none of it.
 */
function appendCapped(raw, patch) {
	if (raw.length > DIFF_MAX_BYTES) return raw;
	const next = raw + patch;
	return next.length > DIFF_MAX_BYTES
		? `${next.slice(0, DIFF_MAX_BYTES)}\n… diff truncated at ${DIFF_MAX_BYTES} bytes\n`
		: next;
}

/** A repository's uncommitted work, or null when it is clean. */
async function collectRepoDiff(mode, root) {
	// -z keeps paths verbatim; a rename puts its source on a line of its own,
	// which is fine for a block only shown when there is no patch at all. -uall
	// pins `status.showUntrackedFiles`, which set to `no` would report a tree of
	// new files as clean.
	const status = (await git(mode, root, ['status', '--porcelain', '-z', '-uall'])).split('\0').filter(Boolean).join('\n');
	if (!status) return null;
	const branch = (await git(mode, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
	// `diff HEAD` covers the index and the working tree in one pass, but no form
	// of `git diff` knows about untracked files — without the second half, a file
	// the agent just created would be missing from the report entirely.
	let raw = appendCapped('', await git(mode, root, ['diff', 'HEAD', '--no-color']));
	const files = parseNumstat(await git(mode, root, ['diff', 'HEAD', '--numstat', '-z']));
	// -z: a filename may contain a newline, and splitting on one would hand git
	// two paths that do not exist.
	const untracked = (await git(mode, root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
	for (const file of untracked) {
		let patch = '';
		try {
			patch = await git(mode, root, ['diff', '--no-index', '--no-color', '--', '/dev/null', file]);
		} catch (err) {
			// Exit 1 is how `diff --no-index` reports "these differ" — the expected
			// outcome here, and the only place a non-zero exit is not a failure.
			// Its stdout only counts when there is some: `docker exec` also exits 1
			// when the container is gone, and taking that for a diff would drop the
			// file from the report without a word.
			if (err.code === 1 && err.stdout) patch = err.stdout;
			else log.warn(`/diff: ${root}/${file}: ${err.message}`);
		}
		raw = appendCapped(raw, patch);
		// An untracked file is all additions, so its hunk lines are the count — no
		// second git call needed. Counted from the first hunk on, because a source
		// line reading `++i` becomes `+++i` in the patch and excluding every `+++`
		// would drop it. A binary file has no hunk and reads as zero.
		const hunk = patch.indexOf('\n@@');
		const body = hunk < 0 ? '' : patch.slice(hunk);
		files.push({ path: file, additions: body.split('\n').filter(l => l.startsWith('+')).length, deletions: 0 });
	}
	return {
		branch,
		files,
		raw,
		// Kept because `git status` saw something the diff may not describe: an
		// unmerged path yields no diff section, and dropping it here would show the
		// project as clean.
		status,
		additions: files.reduce((n, f) => n + f.additions, 0),
		deletions: files.reduce((n, f) => n + f.deletions, 0),
	};
}

/**
 * The one line that goes in the channel: which repository, which branch, how
 * much moved. Everything else is in the patch it is posted with.
 */
function buildHeader(root, repo) {
	const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
	// Names reach Discord unfiltered otherwise, and a deep path or a long branch
	// would push the line over the message limit. Cut from the left, where the
	// repository name is not.
	const short = (s, max) => (s.length > max ? `…${s.slice(-(max - 1))}` : s);
	return `📊 **${short(path.basename(root), 80)}** \`${short(repo.branch, 80)}\` — ${plural(repo.files.length, 'file')}, \`+${repo.additions} -${repo.deletions}\``;
}

/** Safe on every filesystem and in a gist, and still recognizable as the channel. */
function safeName(name) {
	return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'diff';
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
 * The environment to read the repository in, or null once the reason it cannot
 * be read has been sent. A sandbox channel runs git inside the container, which
 * nothing has necessarily started yet.
 */
async function modeFor(channel) {
	const mode = sessions.getMode(channel.id);
	if (mode !== 'sandbox') return mode;
	try {
		ensureContainer();
		return mode;
	} catch (err) {
		await channel.send(`Sandbox unavailable: ${err.message}`);
		return null;
	}
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

	const mode = await modeFor(channel);
	if (!mode) return true;
	const { root, error } = await resolveRepoRoot(mode, trimmed);
	if (!root) {
		// The question is reopened: a typo should cost one retry, not the command.
		askForPath(channel, `\`${trimmed.slice(0, 200)}\`: ${error}.`);
		return true;
	}
	// Validation took a round trip, and `/admin` or `/sandbox` may have landed
	// during it: storing the path now would resurrect the one the mode switch
	// just dropped, pointing at the filesystem the channel has left.
	if (sessions.getMode(channel.id) !== mode) {
		await channel.send('Channel changed environment — `/diff` cancelled.');
		return true;
	}
	sessions.setDepotPath(channel.id, root);
	await channel.send(`Repository set to \`${root}\`.`);
	await reportSafely(channel, mode, root);
	return true;
}

async function reportSafely(channel, mode, root) {
	let repo;
	try {
		repo = await collectRepoDiff(mode, root);
	} catch (err) {
		log.warn(`/diff: ${root}: ${err.message}`);
		await channel.send(`Could not read \`${root}\`: ${err.message.slice(0, 300)}`);
		return;
	}
	if (!repo) {
		await channel.send(`No uncommitted changes in \`${root}\`.`);
		return;
	}

	const header = buildHeader(root, repo);
	// `git status` saw something no patch describes — an unmerged path, say.
	// There is nothing to publish, and an empty gist file would be deleted by
	// GitHub on arrival.
	if (!repo.raw.trim()) {
		await channel.send(`${header}\n\`\`\`\n${repo.status.slice(0, 1500)}\n\`\`\``);
		return;
	}
	try {
		const { gistId, url } = await gist.upload({
			gistId: sessions.getDiffGistId(channel.id),
			filename: `${safeName(resolveChannelName(channel))}.diff`,
			description: `claudiscord /diff — ${path.basename(root)} ${repo.branch} — ${new Date().toISOString()}`,
			content: repo.raw,
		});
		sessions.setDiffGistId(channel.id, gistId);
		await channel.send(`${header}\n${url}`);
	} catch (err) {
		log.warn(`/diff: gist upload failed for ${root}: ${err.message}`);
		await channel.send(`${header}\nGist upload failed: ${err.message.slice(0, 300)}`);
	}
}

async function handleDiff({ channel, channelId }) {
	// Refused before the repository question: without a gist there is nowhere to
	// put the patch, and asking for a path first would waste the exchange.
	if (!gist.isGistAvailable()) {
		await channel.send('`/diff` requires `GITHUB_TOKEN` (scope `gist`) in `.env`.');
		return true;
	}
	const root = sessions.getDepotPath(channelId);
	if (!root) {
		await askForPath(channel);
		return true;
	}
	const mode = await modeFor(channel);
	if (mode) await reportSafely(channel, mode, root);
	return true;
}

module.exports = { handleDiff, finishPendingDepotPath, cancelPendingDepotPath };
