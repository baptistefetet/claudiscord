const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { compileFunction } = require('vm');
const queue = require('../src/queue');

const filename = require.resolve('../src/voice');
const source = readFileSync(filename, 'utf8') + `
return {
	handleLiveEvent, leaveVoice, setActive: session => { active = session; },
	MERGED_NOTE, RESENT_NOTE, OUTDATED_NOTE, NO_ACTION, OVERLAP_NOTE,
	DELEGATION_GRACE_MS, DELEGATION_MAX_HOLD_MS, MAX_SPOKEN_RESULT_CHARS,
};`;

/** A fresh voice.js on stubbed services, with one active session and its call. */
function setup(t, { fifo = false } = {}) {
	// A realistic clock: the code compares timestamps against 0 for "never".
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
	const runs = []; // executePrompt calls, settled by the test
	const chat = [];
	const appended = [];
	const state = { busy: false };
	const stubs = {
		'./config': { VOICE_IDLE_TIMEOUT_MS: 3_600_000 },
		'./logger': { info() {}, warn() {}, error() {} },
		'./sessions': { getAgent: () => 'codex', getMode: () => 'admin' },
		'./executor': {
			executePrompt: (agent, mode, take, options) => {
				const start = () => new Promise((resolve, reject) => {
					runs.push({ prompt: fifo ? take() : null, take, options, resolve, reject });
				});
				return fifo ? queue.runQueued(options.channelId, start) : start();
			},
		},
		'./queue': fifo ? queue : { isBusy: () => state.busy },
		'./prompts': { getSystemPrompt: () => 'system', getLiveInstructions: () => '' },
		'./live': {},
		'./scheduler': { reloadJobs() {} },
		'./discord': {
			getClient: () => ({ channels: { cache: { get: () => ({}) } } }),
			sendChunked: async (channel, text) => { chat.push(text); },
			startProgressReporter: () => ({ update() {}, clear() {} }),
		},
	};
	const imports = Object.assign(id => stubs[id] || require(id), { resolve: require.resolve });
	const voice = compileFunction(source, ['require', 'module'], { filename })(imports, { exports: {} });

	const call = {
		isOpen: () => true,
		close() {},
		appendContext: (id, channel, text) => appended.push({ id, channel, text }),
	};
	const session = {
		channelId: 'voice-channel',
		call,
		connection: { destroy() {} },
		outputActivity: { close() {} },
		batch: null,
		delegated: new Set(),
		latest: null,
		recoveredTexts: new Set(),
		unhandled: new Set(),
		userTurn: null,
		userTurns: 0,
		transcript: [],
		pending: 0,
		idleTimer: null,
	};
	voice.setActive(session);
	t.after(() => voice.setActive(null));

	const emit = event => voice.handleLiveEvent(session, call, event);
	return {
		...voice, session, runs, chat, appended, state,
		tick: ms => t.mock.timers.tick(ms),
		// Let the promise chains of a settled run finish.
		flush: () => new Promise(setImmediate),
		userStarts: () => emit({ type: 'turn.created', turn: { role: 'user' } }),
		userSays: transcript => emit({ type: 'turn.done', turn: { role: 'user', transcript } }),
		assistantSays: transcript => emit({ type: 'turn.done', turn: { role: 'assistant', transcript } }),
		delegate: (id, text) => emit({ type: 'delegation.created', item: { id, content: [{ type: 'input_text', text }] } }),
		notes: id => appended.filter(entry => entry.id === id).map(entry => entry.text),
	};
}

/** One spoken request, delegated mid-turn, then dispatched. */
function request(v, id, text) {
	v.userStarts();
	v.delegate(id, text);
	v.userSays(text);
	v.tick(v.DELEGATION_GRACE_MS);
	return v.runs.at(-1);
}

test('a delegation is held until the grace delay after the end of the user turn', t => {
	const v = setup(t);
	v.userStarts();
	v.delegate('d1', 'add a movie');
	v.tick(v.DELEGATION_MAX_HOLD_MS / 2);
	assert.equal(v.runs.length, 0);
	v.userSays('add a movie please');
	v.tick(v.DELEGATION_GRACE_MS - 1);
	assert.equal(v.runs.length, 0);
	v.tick(1);
	assert.equal(v.runs.length, 1);
	assert.deepEqual(v.chat, ['🎙️ add a movie']);
	assert.deepEqual(v.appended, []);
	assert.equal(v.session.pending, 1);
});

test('a user turn that never ends is dispatched at the maximum hold', t => {
	const v = setup(t);
	v.userStarts();
	v.delegate('d1', 'add a movie');
	v.tick(v.DELEGATION_MAX_HOLD_MS - 2000);
	v.delegate('d2', 'add a movie tonight');
	v.tick(1999);
	assert.equal(v.runs.length, 0);
	v.tick(1);
	assert.equal(v.runs.length, 1);
	assert.deepEqual(v.chat, ['🎙️ add a movie tonight']);
});

test('each delegation of a held batch restarts the grace delay', t => {
	const v = setup(t);
	v.delegate('d1', 'add a movie');
	v.tick(v.DELEGATION_GRACE_MS - 1);
	v.delegate('d2', 'add a movie tonight');
	v.tick(v.DELEGATION_GRACE_MS - 1);
	assert.equal(v.runs.length, 0);
	v.tick(1);
	assert.equal(v.runs.length, 1);
});

test('fragments merge into one prompt: extension, prefix, split word, unrelated', t => {
	const v = setup(t);
	v.userStarts();
	v.delegate('d1', 'add a mo');
	v.delegate('d2', 'add a movie'); // extension: replaces
	v.delegate('d3', 'add a'); // prefix: ignored
	v.delegate('d4', 'and a show'); // unrelated: appended
	v.delegate('d5', 'add a movie and a show now'); // extension of the joined text
	v.userSays('add a movie and a show now');
	v.tick(v.DELEGATION_GRACE_MS);
	assert.equal(v.runs.length, 1);
	assert.match(v.runs[0].take(), /<input>add a movie and a show now<\/input>/);
	assert.deepEqual(v.notes('d1'), []);
	for (const id of ['d2', 'd3', 'd4', 'd5']) assert.deepEqual(v.notes(id), [v.MERGED_NOTE]);
	assert.equal(v.session.pending, 1);
});

test('a complete re-send repairs a word split across two fragments', t => {
	const v = setup(t);
	v.userStarts();
	v.delegate('d1', 'add a mo');
	v.delegate('d2', 'vie tonight');
	v.delegate('d3', 'add a movie tonight');
	v.userSays('add a movie tonight');
	v.tick(v.DELEGATION_GRACE_MS);
	assert.deepEqual(v.chat, ['🎙️ add a movie tonight']);
});

test('a word-for-word re-send is dropped until the next user turn', t => {
	const v = setup(t);
	const run = request(v, 'd1', 'add a movie');
	run.take();
	v.delegate('d2', 'add  a movie'); // whitespace aside
	assert.deepEqual(v.notes('d2'), [v.RESENT_NOTE]);
	assert.equal(v.session.batch, null);
	assert.equal(v.session.pending, 1);

	v.userStarts();
	v.delegate('d3', 'add a movie');
	assert.deepEqual(v.notes('d3'), []);
	assert.equal(v.session.pending, 2);
});

test('a queued batch is merged into until it reaches the head of the queue', t => {
	const v = setup(t);
	const run = request(v, 'd1', 'add a movie');
	v.userStarts();
	v.delegate('d2', 'in french');
	v.delegate('d3', 'add a movie in french'); // same text once joined: no new echo
	v.userSays('in french');
	v.tick(v.DELEGATION_MAX_HOLD_MS);
	assert.equal(v.runs.length, 1);
	assert.deepEqual(v.notes('d2'), [v.MERGED_NOTE]);
	assert.deepEqual(v.chat, ['🎙️ add a movie', '🎙️ in french']);
	assert.match(run.take(), /<input>add a movie in french<\/input>/);

	// Taken: the next delegation opens a batch of its own.
	v.userStarts();
	v.delegate('d4', 'and a show');
	v.userSays('and a show');
	v.tick(v.DELEGATION_GRACE_MS);
	assert.equal(v.runs.length, 2);
	assert.deepEqual(v.notes('d4'), []);
	assert.equal(v.session.pending, 2);
});

test('the prompt carries the turns spoken since the previous batch, escaped', t => {
	const v = setup(t);
	v.assistantSays('Hello');
	v.userStarts();
	v.delegate('d1', 'is 1 < 2 & 3');
	v.userSays('is 1 < 2 & 3 ?');
	v.userSays('[breath'); // noise turn
	v.tick(v.DELEGATION_GRACE_MS);
	assert.equal(v.runs[0].take(), '<realtime_delegation>\n'
		+ '  <input>is 1 &lt; 2 &amp; 3</input>\n'
		+ '  <transcript_delta>assistant: Hello\nuser: is 1 &lt; 2 &amp; 3 ?</transcript_delta>\n'
		+ '</realtime_delegation>');
	assert.deepEqual(v.session.transcript, []);
	assert.equal(v.runs[0].options.channelId, 'voice-channel');
	assert.equal(v.runs[0].options.tier, 'high');
});

test('a sentence of another user turn is merged on its own line', t => {
	const v = setup(t);
	v.state.busy = true;
	const run = request(v, 'd1', 'add a movie');
	v.userStarts();
	v.delegate('d2', 'what is the');
	v.delegate('d3', 'weather'); // same turn: a fragment
	v.userSays('what is the weather');
	v.userStarts();
	v.delegate('d4', 'never mind');
	assert.match(run.take(), /<input>add a movie\nwhat is the weather\nnever mind<\/input>/);
});

test('a batch opened while another is pending is flagged as overlapping', t => {
	const v = setup(t);
	const first = request(v, 'd1', 'add a movie');
	first.take();
	const second = request(v, 'd2', 'no, a show');
	assert.ok(second.take().startsWith(`${v.OVERLAP_NOTE}\n\n<realtime_delegation>`));
	assert.ok(first.take().startsWith('<realtime_delegation>'));
});

test('a batch queued behind a running task says so to the call', t => {
	const v = setup(t);
	v.state.busy = true;
	request(v, 'd1', 'add a movie');
	assert.equal(v.notes('d1').length, 1);
	assert.match(v.notes('d1')[0], /^Queued behind another task/);
});

test('the result is spoken on the first delegation and posted to the chat', async t => {
	const v = setup(t);
	v.userStarts();
	v.delegate('d1', 'add a');
	v.delegate('d2', 'add a movie');
	v.userSays('add a movie');
	v.tick(v.DELEGATION_GRACE_MS);
	v.runs[0].take();
	v.appended.length = 0;
	v.runs[0].resolve({ result: 'Done.', files: [] });
	await v.flush();
	assert.deepEqual(v.appended, [{ id: 'd1', channel: 'speakable', text: 'Done.' }]);
	assert.deepEqual(v.chat, ['🎙️ add a movie', 'Done.']);
	assert.equal(v.session.pending, 0);
});

test('a long result is cut for the call, not for the chat', async t => {
	const v = setup(t);
	const run = request(v, 'd1', 'add a movie');
	run.take();
	const result = 'x'.repeat(v.MAX_SPOKEN_RESULT_CHARS + 1);
	run.resolve({ result, files: [] });
	await v.flush();
	assert.deepEqual(v.notes('d1'), [`${'x'.repeat(v.MAX_SPOKEN_RESULT_CHARS)}… (the rest is in the chat)`]);
	assert.equal(v.chat.at(-1), result);
});

test('an empty reply and a files-only reply still say something', async t => {
	const v = setup(t);
	const first = request(v, 'd1', 'add a movie');
	first.take();
	first.resolve({ result: '', files: [] });
	await v.flush();
	assert.deepEqual(v.notes('d1'), ['Empty reply.']);

	const second = request(v, 'd2', 'send the file');
	second.take();
	second.resolve({ result: '', files: ['/tmp/a.txt'] });
	await v.flush();
	assert.deepEqual(v.notes('d2'), ['Files sent in the chat.']);
});

test('a result arriving while a later batch is pending is flagged as outdated', async t => {
	const v = setup(t);
	const first = request(v, 'd1', 'add a movie');
	first.take();
	request(v, 'd2', 'no, a show');
	v.appended.length = 0;
	first.resolve({ result: 'Movie added.', files: [] });
	await v.flush();
	assert.deepEqual(v.notes('d1'), [v.OUTDATED_NOTE, 'Movie added.']);
});

const tomorrow = 'Et dis-moi aussi pour demain';
for (const handoff of ['missing', 'native', 'while queued', 'after start', 'after result']) {
	test(`the Lyon follow-up runs exactly once with a hand-off ${handoff}`, async t => {
		const v = setup(t, { fifo: true });
		request(v, 'today', "Tu peux me dire s'il va faire beau à Lyon cet après-midi");
		await v.flush();
		v.userStarts();
		if (handoff === 'native') v.delegate('tomorrow', tomorrow);
		v.userSays(tomorrow);
		v.assistantSays("Noté, j'ajoute demain aussi.");
		v.tick(v.DELEGATION_GRACE_MS);
		if (handoff === 'while queued') v.delegate('late', tomorrow);
		assert.equal(v.runs.length, 1);
		v.runs[0].resolve({ result: 'Sunny today.', files: [] });
		await v.flush();
		assert.equal(v.runs.length, 2);
		assert.ok(v.runs[1].prompt.includes(`<input>${tomorrow}</input>`));
		assert.ok(v.runs[1].prompt.includes(`user: ${tomorrow}`));
		if (handoff === 'after start') v.delegate('late', 'Check tomorrow in Lyon too');
		v.runs[1].resolve({ result: 'Rain tomorrow.', files: [] });
		await v.flush();
		if (handoff === 'after result') v.delegate('late', tomorrow);
		v.tick(v.DELEGATION_MAX_HOLD_MS);
		await v.flush();
		assert.equal(v.runs.length, 2);
		assert.deepEqual(v.appended.filter(e => e.channel === 'speakable').map(e => e.text), ['Sunny today.', 'Rain tomorrow.']);
		assert.ok(v.notes(handoff === 'native' ? 'tomorrow' : null).includes('Rain tomorrow.'));
		assert.equal(v.chat.filter(text => text === 'Rain tomorrow.').length, 1);
		assert.equal(v.session.pending, 0);
	});
}

test('an overlapping turn is recovered even if the task finishes mid-sentence', async t => {
	const v = setup(t);
	const first = request(v, 'd1', 'Check Batflix');
	first.take();
	v.userStarts();
	first.resolve({ result: 'Batflix is up.', files: [] });
	await v.flush();
	v.userSays('Check Badly too');
	v.tick(v.DELEGATION_GRACE_MS);
	assert.match(v.runs[1].take(), /<input>Check Badly too<\/input>/);
});

test('recovered and explicit follow-ups waiting together are delivered in order', async t => {
	const v = setup(t, { fifo: true });
	request(v, 'today', 'Weather today?');
	await v.flush();
	v.userStarts();
	v.userSays('And tomorrow?');
	v.tick(v.DELEGATION_GRACE_MS); // recovery now waits in the real FIFO
	v.userStarts();
	v.userSays('In Lyon please');
	v.userStarts();
	v.delegate('weekend', 'And this weekend?');
	v.userSays('And this weekend?');
	v.runs[0].resolve({ result: 'Sunny.', files: [] });
	await v.flush();
	assert.equal(v.runs.length, 2);
	assert.ok(v.runs[1].prompt.includes('<input>And tomorrow?\nIn Lyon please\nAnd this weekend?</input>'));
	v.runs[1].resolve({ result: 'Rain both days.', files: [] });
	await v.flush();
	assert.deepEqual(v.notes('weekend'), ['Rain both days.']);
	assert.equal(v.session.pending, 0);
});

test('small talk can finish silently and idle turns and noise start no work', async t => {
	const v = setup(t);
	v.userStarts();
	v.userSays('Hello');
	const first = request(v, 'd1', 'Check Boardy');
	first.take();
	v.userStarts();
	v.userSays('[breath]');
	v.userStarts();
	v.userSays('Thanks');
	v.tick(v.DELEGATION_GRACE_MS);
	assert.equal(v.runs.length, 2);
	const recovered = v.runs[1];
	assert.ok(recovered.take().includes(v.NO_ACTION));
	first.resolve({ result: 'Boardy is up.', files: [] });
	await v.flush();
	const previous = v.appended.slice();
	recovered.options.onProgress({ summary: v.NO_ACTION });
	recovered.resolve({ result: v.NO_ACTION, files: [] });
	await v.flush();
	assert.deepEqual(v.appended, previous);
	assert.deepEqual(v.chat, ['🎙️ Check Boardy', 'Boardy is up.']);
	assert.equal(v.session.pending, 0);
});

test('a delayed replay during another turn respects a deliberate repeat', async t => {
	const v = setup(t);
	const first = request(v, 'today', 'Weather in Lyon?');
	first.take();
	v.userStarts();
	v.userSays(tomorrow);
	v.tick(v.DELEGATION_GRACE_MS);
	v.runs[1].take();
	first.resolve({ result: 'Sunny.', files: [] });
	v.runs[1].resolve({ result: 'Rain.', files: [] });
	await v.flush();
	v.userStarts();
	v.delegate('stale', tomorrow + '?');
	v.delegate('fragment', 'Et dis-moi aussi pour dem');
	v.userSays('Thanks');
	v.tick(v.DELEGATION_GRACE_MS);
	assert.equal(v.runs.length, 2);
	assert.deepEqual(v.notes('stale'), [v.RESENT_NOTE]);
	assert.deepEqual(v.notes('fragment'), [v.RESENT_NOTE]);
	v.userStarts();
	v.delegate('repeat', tomorrow);
	v.userSays(tomorrow);
	v.tick(v.DELEGATION_GRACE_MS);
	assert.equal(v.runs.length, 3);
	assert.ok(v.runs[2].take().includes(`<input>${tomorrow}</input>`));
});

test('the turn that delegated the batch is not reported as undelivered', async t => {
	const v = setup(t);
	v.userStarts();
	v.delegate('d1', 'add a movie');
	v.tick(v.DELEGATION_MAX_HOLD_MS); // dispatched while the user still speaks
	v.runs[0].take();
	v.userSays('add a movie and take your time');
	v.runs[0].resolve({ result: 'Movie added.', files: [] });
	await v.flush();
	assert.deepEqual(v.notes('d1'), ['Movie added.']);
	assert.equal(v.session.latest, null);
	assert.equal(v.runs.length, 1);
});

test('a result without anything said meanwhile carries no note', async t => {
	const v = setup(t);
	const run = request(v, 'd1', 'add a movie');
	run.take();
	v.assistantSays('On it.');
	run.resolve({ result: 'Movie added.', files: [] });
	await v.flush();
	assert.deepEqual(v.notes('d1'), ['Movie added.']);
});

test('a failed task is spoken and posted, a stopped one only spoken', async t => {
	const v = setup(t);
	const first = request(v, 'd1', 'add a movie');
	first.take();
	first.reject(new Error('boom'));
	await v.flush();
	assert.deepEqual(v.notes('d1'), ['The task failed: boom']);
	assert.equal(v.chat.at(-1), 'Voice task failed: boom');
	assert.equal(v.session.pending, 0);

	const second = request(v, 'd2', 'add a show');
	second.take();
	const posted = v.chat.length;
	second.reject(Object.assign(new Error('stopped'), { code: 'CANCELLED' }));
	await v.flush();
	assert.deepEqual(v.notes('d2'), ['The task was stopped by the user.']);
	assert.equal(v.chat.length, posted);
	assert.equal(v.session.pending, 0);
});

test('progress reaches the call as silent context, rate limited', t => {
	const v = setup(t);
	const run = request(v, 'd1', 'add a movie');
	run.take();
	run.options.onProgress({ summary: 'Searching' });
	run.options.onProgress({ summary: 'Still searching' });
	v.tick(5000);
	run.options.onProgress({ summary: 'Downloading' });
	run.options.onProgress({});
	assert.deepEqual(v.appended, [
		{ id: 'd1', channel: 'commentary', text: 'In progress: Searching' },
		{ id: 'd1', channel: 'commentary', text: 'In progress: Downloading' },
	]);
});

test('leaving the channel dispatches the held batch at once', t => {
	const v = setup(t);
	v.userStarts();
	v.delegate('d1', 'add a movie');
	assert.equal(v.leaveVoice(), true);
	assert.equal(v.runs.length, 1);
	assert.match(v.runs[0].take(), /<input>add a movie<\/input>/);
});

test('an empty delegation is ignored', t => {
	const v = setup(t);
	v.delegate('d1', '   ');
	v.delegate(undefined, 'add a movie');
	v.tick(v.DELEGATION_MAX_HOLD_MS);
	assert.equal(v.runs.length, 0);
	assert.equal(v.session.pending, 0);
});
