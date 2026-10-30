const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { compileFunction } = require('vm');
// Load internals without initializing application configuration or services.
const filename = require.resolve('../src/live');
const imports = Object.assign(id => id.startsWith('./') ? {} : require(id), { resolve: require.resolve });
const { toNtp, fromNtp } = compileFunction(
	readFileSync(filename, 'utf8') + '\nreturn { toNtp, fromNtp };', ['require', 'module'], { filename },
)(imports, { exports: {} });

test('NTP uses a binary 32-bit fraction and round-trips milliseconds', () => {
	assert.equal(toNtp(0), 0x83aa7e8000000000n);
	assert.equal(toNtp(750), 0x83aa7e80c0000000n);
	assert.equal(toNtp(1250), 0x83aa7e8140000000n);
	for (const ms of [0, 125, 999, 1000, 1793397600123.5]) {
		assert.ok(Math.abs(fromNtp(toNtp(ms)) - ms) < 0.001);
	}
	assert.ok(Math.abs(Number(toNtp(1020) - toNtp(1000)) / 2 ** 32 - 0.02) < 1e-9);
});

test('werift uses the corrected clock in sender reports and absolute send time', async () => {
	const { RTCPeerConnection, RtpPacket, RtpHeader, RtcpSenderInfo, useOPUS, ntpTime, serializeAbsSendTime } = require('werift');
	const beforeClock = Date.now();
	const current = fromNtp(ntpTime());
	assert.ok(current >= beforeClock - 1 && current <= Date.now() + 1);
	assert.equal(serializeAbsSendTime(toNtp(750)).readUIntBE(0, 3) & 0x3ffff, 0x30000);
	const pc = new RTCPeerConnection({ codecs: { audio: [useOPUS({ payloadType: 111 })], video: [] } });
	try {
		const sender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
		sender.codec = useOPUS({ payloadType: 111 });
		sender.dtlsTransport.state = 'connected';
		sender.dtlsTransport.sendRtp = async () => 3;
		sender.runRtcp = () => {};
		const beforeSend = Date.now();
		await sender.sendRtp(new RtpPacket(new RtpHeader({ timestamp: 960, sequenceNumber: 1 }), Buffer.from('f8fffe', 'hex')));
		const sentAt = fromNtp(sender.ntpTimestamp);
		assert.ok(sentAt >= beforeSend - 1 && sentAt <= Date.now() + 1);
		assert.equal(sender.rtpTimestamp, 960);
		const wire = new RtcpSenderInfo({ ntpTimestamp: toNtp(750), rtpTimestamp: 960, packetCount: 1, octetCount: 3 }).serialize();
		assert.equal(wire.readUInt32BE(0), 2208988800);
		assert.equal(wire.readUInt32BE(4), 0xc0000000);
	} finally { await pc.close(); }
});
