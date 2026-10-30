const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { compileFunction } = require('vm');
// Load internals without initializing application configuration or services.
const filename = require.resolve('../src/voice');
const imports = Object.assign(id => id.startsWith('./') ? {} : require(id), { resolve: require.resolve });
const { RtpOutput, OpusActivity, SILENCE_FRAME, opusDurationMs } = compileFunction(
	readFileSync(filename, 'utf8') + '\nreturn { RtpOutput, OpusActivity, SILENCE_FRAME, opusDurationMs };', ['require', 'module'], { filename },
)(imports, { exports: {} });

const packet = (sequence, payload = Buffer.from([0xf8, sequence & 255]), silent = false) => ({
	header: { sequenceNumber: sequence, timestamp: (sequence * 960) >>> 0, ssrc: 1 }, payload, silent,
});
function streamFor(t, sequence = 10) {
	const first = packet(sequence);
	const stream = new RtpOutput(first);
	t.after(() => stream.destroy());
	stream.receive(first);
	for (let i = 0; i < 20; i++) assert.deepEqual(stream.read(), SILENCE_FRAME);
	return stream;
}

test('Opus TOC durations include multi-frame packets', () => {
	assert.equal(opusDurationMs(SILENCE_FRAME), 20);
	assert.equal(opusDurationMs(Buffer.from([0x08])), 20);
	assert.equal(opusDurationMs(Buffer.from([0x61])), 20);
	assert.equal(opusDurationMs(Buffer.from([0x82])), 5);
	assert.equal(opusDurationMs(Buffer.from([0x83, 8])), 20);
	assert.equal(opusDurationMs(Buffer.from([0x18])), 60);
	assert.equal(opusDurationMs(Buffer.alloc(0)), 0);
	assert.equal(opusDurationMs(Buffer.from([0x83])), 0);
});

test('plays packets across sequence wrap without hidden stream prefetch', t => {
	const stream = streamFor(t, 65534);
	stream.receive(packet(65535));
	stream.receive(packet(0));
	stream.receive(packet(1));
	for (const sequence of [65534, 65535, 0, 1]) assert.deepEqual(stream.read(), packet(sequence).payload);
	assert.equal(stream.missing, 0);
	assert.equal(stream.readableLength, 0);
});

test('fills a proven loss once', t => {
	const stream = streamFor(t);
	stream.receive(packet(12));
	assert.deepEqual(stream.read(), packet(10).payload);
	assert.deepEqual(stream.read(), SILENCE_FRAME);
	assert.deepEqual(stream.read(), packet(12).payload);
	assert.equal(stream.missing, 1);
	assert.equal(stream.lost, 1);
});

test('an empty queue preserves late speech instead of treating clock drift as packet loss', t => {
	const stream = streamFor(t);
	stream.read();
	for (let i = 0; i < 3; i++) assert.deepEqual(stream.read(), SILENCE_FRAME);
	stream.receive(packet(11));
	assert.deepEqual(stream.read(), packet(11).payload);
	assert.equal(stream.missing, 3);
	assert.equal(stream.lost, 0);
});

test('bounds sparse sequence jumps and rebuilds the initial buffer', t => {
	const stream = streamFor(t);
	stream.receive(packet(60));
	assert.equal(stream.packets.size, 1);
	for (let i = 0; i < 20; i++) assert.deepEqual(stream.read(), SILENCE_FRAME);
	assert.deepEqual(stream.read(), packet(60).payload);
});

test('ends on source silence, but preserves speech already buffered after a pause', t => {
	for (const resume of [false, true]) {
		const stream = streamFor(t);
		for (let sequence = 11; sequence <= 30; sequence++) stream.receive(packet(sequence, Buffer.from('d8fffe', 'hex'), true));
		if (resume) stream.receive(packet(31));
		for (let i = 0; i < 40 && stream.silentFrames < 20; i++) assert.ok(stream.read());
		assert.equal(stream.finished, !resume);
		if (resume) assert.deepEqual(stream.read(), packet(31).payload);
		else assert.equal(stream.endReason, 'silence');
	}
});

test('transport timeout drains queued speech before ending', t => {
	const stream = streamFor(t);
	stream.lastAt -= 1001;
	assert.deepEqual(stream.read(), packet(10).payload);
	assert.equal(stream.read(), null);
	assert.equal(stream.endReason, 'timeout');
});

test('destroy releases queued packets', t => {
	const stream = streamFor(t);
	stream.destroy();
	assert.equal(stream.packets.size, 0);
});

test('short quiet frames do not add a pause or alter speech', t => {
	const stream = streamFor(t);
	const frames = [packet(11, SILENCE_FRAME, true), packet(12, SILENCE_FRAME, true), packet(13)];
	for (const frame of frames) stream.receive(frame);
	assert.deepEqual(stream.read(), packet(10).payload);
	for (const frame of frames) assert.deepEqual(stream.read(), frame.payload);
	assert.equal(stream.pauseAdded, 0);
	assert.equal(stream.missing, 0);
});

test('quiet refill is capped per source pause and preserves sequence wrap', t => {
	const stream = streamFor(t, 65534);
	for (const sequence of [65535, 0, 1, 2]) stream.receive(packet(sequence, SILENCE_FRAME, true));
	stream.read(); // speech
	stream.read(); stream.read(); // 40 ms of source silence
	for (let i = 0; i < 10; i++) {
		assert.deepEqual(stream.read(), SILENCE_FRAME);
		assert.equal(stream.nextSequence, 1);
		assert.equal(stream.silentFrames, 2);
	}
	assert.equal(stream.pauseAdded, 10);
	stream.read(); stream.read();
	assert.equal(stream.nextSequence, 3);
	assert.equal(stream.silentFrames, 4);
	assert.equal(stream.pauseAdded, 10);
	assert.equal(stream.missing, 0);
	stream.receive(packet(3));
	assert.deepEqual(stream.read(), packet(3).payload);
	assert.equal(stream.pauseFill, 0);
});

test('quiet refill stops when the reserve is full and does not hide an empty queue', t => {
	const stream = streamFor(t);
	for (let sequence = 11; sequence <= 13; sequence++) stream.receive(packet(sequence, SILENCE_FRAME, true));
	stream.read(); stream.read(); stream.read();
	stream.read(); // one inserted quiet frame
	assert.equal(stream.pauseAdded, 1);
	for (let sequence = 14; sequence <= 32; sequence++) stream.receive(packet(sequence));
	stream.read();
	assert.equal(stream.nextSequence, 14);
	assert.equal(stream.pauseAdded, 1);
	for (let i = 0; i < 19; i++) stream.read();
	stream.read();
	assert.equal(stream.missing, 1);
	assert.equal(stream.pauseAdded, 1);
});

test('long speech with regular pauses tolerates a 5 percent arrival slowdown', t => {
	const { performance } = require('perf_hooks');
	let now = 0;
	t.mock.method(performance, 'now', () => now);
	const stream = new RtpOutput(packet(0));
	t.after(() => stream.destroy());
	let sequence = 0;
	for (now = 0; now < 30000 && !stream.finished; now += 20) {
		while (sequence < 1230 && sequence * 21 <= now) {
			const silent = sequence >= 1200 || sequence % 100 >= 90;
			stream.receive(packet(sequence, silent ? SILENCE_FRAME : undefined, silent));
			assert.ok(stream.packets.size <= 50);
			sequence++;
		}
		stream.read();
	}
	assert.equal(stream.endReason, 'silence');
	assert.equal(stream.missing, 0);
	assert.ok(stream.pauseAdded > 0 && stream.pauseAdded <= 13 * 10);
});

function encodedFrames() {
	const { OpusEncoder } = require('@discordjs/opus');
	const encoder = new OpusEncoder(48000, 1);
	encoder.setBitrate(28000);
	encoder.applyEncoderCTL(4006, 0); // OPUS_SET_VBR: fixed-size packets, including silence
	return Array.from({ length: 60 }, (_, sequence) => {
		const pcm = Buffer.alloc(1920);
		if (sequence < 10) {
			for (let i = 0; i < 960; i++) pcm.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 440 * i / 48000)), i * 2);
		}
		return packet(sequence, encoder.encode(pcm));
	});
}

test('detects encoded silence after speech and preserves original Opus bytes', t => {
	const frames = encodedFrames();
	const decoded = [];
	const activity = new OpusActivity(p => decoded.push(p), error => { throw error; });
	t.after(() => activity.close());
	for (const frame of frames) activity.receive(frame);
	assert.equal(decoded.length, frames.length);
	assert.ok(decoded.slice(0, 10).some(frame => !frame.silent));
	assert.ok(decoded.slice(-20).every(frame => frame.silent && frame.payload.length > 3));
	for (let i = 0; i < frames.length; i++) assert.equal(decoded[i].payload, frames[i].payload);
	const stream = new RtpOutput(decoded[0]);
	t.after(() => stream.destroy());
	for (let i = 0; i < 40; i++) stream.receive(decoded[i]);
	for (let i = 0; i < 80 && !stream.finished; i++) stream.read();
	assert.equal(stream.endReason, 'silence');
});

test('activity decoding handles reordering, wrap, duplicates and a confirmed loss', async t => {
	const frames = encodedFrames();
	for (let i = 0; i < frames.length; i++) frames[i].header.sequenceNumber = (65534 + i) & 0xffff;
	const actual = [];
	const activity = new OpusActivity(p => actual.push(p.header.sequenceNumber), error => { throw error; });
	t.after(() => activity.close());
	for (const index of [0, 2, 2]) activity.receive(frames[index]);
	assert.deepEqual(activity.latest, { ssrc: 1, sequence: 0 });
	assert.deepEqual(actual, [65534]);
	for (const index of [1, 1, 4]) activity.receive(frames[index]);
	assert.deepEqual(actual, [65534, 65535, 0]);
	assert.deepEqual(activity.latest, { ssrc: 1, sequence: 2 });
	await new Promise(resolve => setTimeout(resolve, 90));
	assert.deepEqual(actual, [65534, 65535, 0, 2]);
	activity.receive(frames[3]);
	assert.deepEqual(actual, [65534, 65535, 0, 2]);
});

test('closing activity cancels pending delivery and resets decoder state for a new call', async t => {
	const frames = encodedFrames();
	const actual = [];
	const activity = new OpusActivity(p => actual.push(p.header.sequenceNumber), error => { throw error; });
	t.after(() => activity.close());
	activity.receive(frames[0]);
	activity.receive(frames[2]);
	activity.close();
	assert.equal(activity.latest, null);
	await new Promise(resolve => setTimeout(resolve, 90));
	assert.deepEqual(actual, [0]);
	activity.receive(frames[0]);
	assert.deepEqual(actual, [0, 0]);
});
