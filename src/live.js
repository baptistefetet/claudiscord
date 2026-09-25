const fs = require('fs');
const { randomUUID, randomInt } = require('crypto');
const { RTCPeerConnection, RtpPacket, RtpHeader, useOPUS } = require('werift');
const WebSocket = require('ws');
const config = require('./config');
const log = require('./logger');

/**
 * GPT-Live call on the ChatGPT subscription (`gpt-live-1-codex`), the route the
 * Codex CLI uses. Undocumented wire, validated empirically:
 *   - call creation: POST {sdp, session} with the host Codex OAuth token → SDP answer,
 *     call id in `Location`. Input audio MUST go over WebRTC (RTP Opus 48 kHz):
 *     the sideband rejects `session.input_audio.append`.
 *   - sideband WebSocket: every event, including the output audio as
 *     `session.output_audio.delta` (PCM16 24 kHz mono, 200 ms chunks, silence included).
 *     No RTP comes back, so the peer is send-only in practice.
 */

const CALL_URL = 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas';
const SIDEBAND_URL = 'wss://api.openai.com/v1/live/';
const MODEL = 'gpt-live-1-codex';
const VOICE = 'cove';
const FRAME_MS = 20;
const FRAME_SAMPLES = 960; // 20 ms at 48 kHz
// Discord's own 20 ms Opus silence packet — sent on every tick the user is silent.
const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
// Input queue bound (200 ms): late packets are dropped, never sent as a burst.
const MAX_QUEUED_FRAMES = 10;
const CONTEXT_APPEND_MAX_BYTES = 500;
const CONNECT_TIMEOUT_MS = 15_000;

const LOGIN_HINT = 'send `/codex` then `/login` in an admin channel';

function hasHostCodexLogin() {
	return fs.existsSync(config.HOST_CODEX_AUTH_FILE);
}

/** Read afresh on every call: the Codex CLI refreshes the token on its own. */
function readAuth() {
	let tokens;
	try {
		tokens = JSON.parse(fs.readFileSync(config.HOST_CODEX_AUTH_FILE, 'utf8')).tokens;
	} catch {
		tokens = null;
	}
	if (!tokens?.access_token || !tokens.account_id) {
		throw new Error(`voice needs the host Codex ChatGPT login — ${LOGIN_HINT}`);
	}
	const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
	if (payload.exp * 1000 < Date.now()) {
		throw new Error(`the host Codex login has expired — ${LOGIN_HINT}`);
	}
	return tokens;
}

/** Split on UTF-8 byte size without cutting a character. */
function chunkUtf8(text, maxBytes) {
	const chunks = [];
	let current = '';
	for (const char of text) {
		if (Buffer.byteLength(current + char) > maxBytes) {
			chunks.push(current);
			current = '';
		}
		current += char;
	}
	if (current) chunks.push(current);
	return chunks;
}

function withTimeout(promise, label) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} timed out`)), CONNECT_TIMEOUT_MS);
		}),
	]).finally(() => clearTimeout(timer));
}

/**
 * Open a call. `onEvent(event)` receives every sideband event, `onClose(reason)`
 * fires once when the call ends on its own (never after `close()`).
 */
async function openLiveCall({ instructions, onEvent, onClose }) {
	const tokens = readAuth();
	const headers = {
		Authorization: `Bearer ${tokens.access_token}`,
		'chatgpt-account-id': tokens.account_id,
		'OpenAI-Alpha': 'quicksilver=v2',
		'session-id': randomUUID(),
		'thread-id': randomUUID(),
		'x-session-id': randomUUID(),
	};

	const pc = new RTCPeerConnection({ codecs: { audio: [useOPUS({ payloadType: 111 })], video: [] } });
	const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
	let ws = null;
	let clock = null;
	let closed = false;
	let established = false;
	let lostDuringSetup = null;

	const close = () => {
		if (closed) return;
		closed = true;
		clearInterval(clock);
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: 'session.close' }));
			setTimeout(() => ws.close(), 1000).unref();
		} else {
			ws?.terminate();
		}
		pc.close().catch(() => {});
	};
	// Failures during setup surface as the thrown error instead.
	const fail = (reason) => {
		if (!established) {
			lostDuringSetup ??= reason;
			return;
		}
		if (closed) return;
		close();
		onClose(reason);
	};

	try {
		const connected = new Promise((resolve, reject) => {
			pc.connectionStateChange.subscribe((state) => {
				if (state === 'connected') resolve();
				else if (['failed', 'disconnected', 'closed'].includes(state)) {
					reject(new Error(`WebRTC ${state}`));
					fail(`WebRTC ${state}`);
				}
			});
		});
		connected.catch(() => {}); // awaited below, after the sideband is up

		await pc.setLocalDescription(await pc.createOffer());
		const res = await fetch(CALL_URL, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				sdp: pc.localDescription.sdp,
				session: { model: MODEL, instructions, audio: { output: { voice: VOICE } }, delegation: { type: 'client' } },
			}),
			signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
		});
		const answer = await res.text();
		if (res.status === 401 || res.status === 403) {
			throw new Error(`GPT-Live refused the host Codex login (${res.status}) — ${LOGIN_HINT}`);
		}
		if (!res.ok) throw new Error(`GPT-Live call creation failed (${res.status}): ${answer.slice(0, 200)}`);
		const callId = (res.headers.get('location') || '').split('/').pop();
		if (!/^rtc_[\w-]+$/.test(callId)) throw new Error('GPT-Live answered without a call id');
		await pc.setRemoteDescription({ type: 'answer', sdp: answer });

		ws = new WebSocket(SIDEBAND_URL + callId, { headers });
		await withTimeout(new Promise((resolve, reject) => {
			ws.once('open', resolve);
			ws.once('error', reject);
			ws.once('unexpected-response', (_req, r) => reject(new Error(`GPT-Live sideband refused (${r.statusCode})`)));
		}), 'GPT-Live sideband');
		ws.on('message', (data, isBinary) => {
			if (isBinary) return;
			let event;
			try { event = JSON.parse(String(data)); } catch { return; }
			if (event.type === 'session.closed') fail(`session closed (${event.reason})`);
			else onEvent(event);
		});
		ws.on('error', err => log.warn('GPT-Live sideband error:', err.message));
		ws.on('close', code => fail(`sideband closed (${code})`));
		await withTimeout(connected, 'WebRTC connection');
		if (lostDuringSetup) throw new Error(`GPT-Live call lost during setup: ${lostDuringSetup}`);
		established = true;
		log.info(`GPT-Live call ${callId} connected`);
	} catch (err) {
		close();
		throw err;
	}

	// 20 ms input clock. Paced on elapsed time: setInterval alone drifts late and
	// would slowly fill the queue.
	const queue = [];
	// Overflow drops the oldest frames, i.e. the start of a burst: logged to tell
	// it apart from clipping upstream (Discord) or downstream (GPT-Live).
	let dropped = 0;
	const start = Date.now();
	let ticks = 0;
	let sequenceNumber = randomInt(0x10000);
	let timestamp = randomInt(0x100000000);
	clock = setInterval(() => {
		const due = Math.floor((Date.now() - start) / FRAME_MS);
		if (due - ticks > MAX_QUEUED_FRAMES) {
			// Event loop stalled: skip the gap instead of catching up.
			timestamp = (timestamp + (due - ticks - 1) * FRAME_SAMPLES) >>> 0;
			ticks = due - 1;
		}
		while (ticks < due) {
			ticks++;
			const payload = queue.shift() || SILENCE_FRAME;
			if (dropped && !queue.length) {
				log.warn(`GPT-Live input: dropped ${dropped} frame(s) on queue overflow`);
				dropped = 0;
			}
			const packet = new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber, timestamp, marker: false }), payload);
			sequenceNumber = (sequenceNumber + 1) & 0xffff;
			timestamp = (timestamp + FRAME_SAMPLES) >>> 0;
			transceiver.sender.sendRtp(packet).catch(() => {});
		}
	}, FRAME_MS / 2);

	return {
		/** One Discord Opus packet (48 kHz stereo, 20 ms). */
		pushOpus(payload) {
			queue.push(payload);
			if (queue.length > MAX_QUEUED_FRAMES) {
				queue.shift();
				dropped++;
			}
		},
		/** `channel`: 'commentary' (silent context) or 'speakable' (said aloud, paraphrased). */
		appendContext(delegationId, channel, text) {
			if (closed || ws.readyState !== WebSocket.OPEN) return;
			for (const chunk of chunkUtf8(text, CONTEXT_APPEND_MAX_BYTES)) {
				ws.send(JSON.stringify({
					type: 'delegation.context.append',
					delegation_item_id: delegationId,
					channel,
					content: [{ type: 'input_text', text: chunk }],
				}));
			}
		},
		close,
	};
}

module.exports = { openLiveCall, hasHostCodexLogin };
