const { GITHUB_TOKEN, GIST_TIMEOUT_MS } = require('./config');
const log = require('./logger');

const GISTS_URL = 'https://api.github.com/gists';

/**
 * Secret gists as an output surface for reports too long to read in Discord.
 *
 * "Secret" means unlisted, not private: anyone holding the URL can read it. The
 * caller decides whether its content may leave the machine.
 */

function isGistAvailable() {
	return Boolean(GITHUB_TOKEN);
}

async function api(path, method, body) {
	const res = await fetch(`${GISTS_URL}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${GITHUB_TOKEN}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(GIST_TIMEOUT_MS),
	});
	if (!res.ok) {
		// Collapsed: GitHub answers with pretty-printed JSON, and the message ends
		// up in a Discord line.
		const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim();
		const err = new Error(`GitHub ${res.status}: ${text.slice(0, 200) || res.statusText}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

/**
 * Write `content` to `filename` in `gistId`, creating the gist when there is
 * none, and return the URL of the revision just written.
 *
 * One gist per caller, rewritten in place: the returned URL carries the revision
 * SHA, so an old link keeps showing the content it was posted with while the
 * gist list stays a single entry instead of growing one per report.
 */
async function upload({ gistId, filename, description, content }) {
	const body = { description, files: { [filename]: { content } } };
	let gist;
	if (gistId) {
		try {
			gist = await api(`/${gistId}`, 'PATCH', body);
		} catch (err) {
			// The gist was deleted outside this process; the stored id is stale
			// rather than wrong, and a new one costs one extra request.
			if (err.status !== 404) throw err;
			log.info(`Gist ${gistId} is gone, creating a new one`);
			gistId = null;
		}
	}
	if (!gistId) gist = await api('', 'POST', { ...body, public: false });

	// Renaming the Discord channel renames the file, and GitHub adds the new key
	// rather than replacing the old one — the single-file gist would grow a stale
	// patch per rename. Setting a file to null deletes it.
	const stale = Object.keys(gist.files || {}).filter(f => f !== filename);
	if (stale.length) {
		gist = await api(`/${gist.id}`, 'PATCH', { files: Object.fromEntries(stale.map(f => [f, null])) });
	}

	const version = gist.history?.[0]?.version;
	return {
		gistId: gist.id,
		// Without a revision, the link follows the gist and a message posted today
		// would show next week's diff.
		url: version ? `${gist.html_url}/${version}` : gist.html_url,
	};
}

module.exports = { isGistAvailable, upload };
