/**
 * Pure-JS PCM conversions for the voice assistant. Both resamples are exact
 * integer ratios, so no ffmpeg is needed anywhere in the audio pipeline:
 *
 *   - OpenAI TTS output (`pcm` response format: s16le 24 kHz mono) → mixer
 *     input (s16le 48 kHz stereo): 2× linear interpolation + channel dup.
 *   - Captured voice (s16le 48 kHz stereo) → Whisper upload (16 kHz mono WAV):
 *     stereo average + 3:1 decimation. Averaging the 3 frames doubles as a
 *     crude anti-aliasing low-pass — speech energy above 8 kHz is negligible
 *     and Whisper is robust to it.
 */

const WHISPER_RATE = 16000;

/** s16le 24 kHz mono → s16le 48 kHz stereo (2× linear interpolation). */
function ttsToMixer(pcm) {
	const n = Math.floor(pcm.length / 2);
	const out = Buffer.alloc(n * 8); // 2× samples × 2 channels × 2 bytes
	for (let i = 0; i < n; i++) {
		const s = pcm.readInt16LE(i * 2);
		const mid = i + 1 < n ? (s + pcm.readInt16LE((i + 1) * 2)) >> 1 : s;
		const o = i * 8;
		out.writeInt16LE(s, o);
		out.writeInt16LE(s, o + 2);
		out.writeInt16LE(mid, o + 4);
		out.writeInt16LE(mid, o + 6);
	}
	return out;
}

/** s16le 48 kHz stereo → 16 kHz mono WAV buffer (Whisper upload). */
function captureToWav(pcm) {
	const frames = Math.floor(pcm.length / 4);
	const n = Math.floor(frames / 3);
	const data = Buffer.alloc(n * 2);
	for (let i = 0; i < n; i++) {
		let acc = 0;
		for (let f = i * 3; f < i * 3 + 3; f++) {
			acc += pcm.readInt16LE(f * 4) + pcm.readInt16LE(f * 4 + 2);
		}
		data.writeInt16LE(Math.round(acc / 6), i * 2);
	}
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16);               // fmt chunk size
	header.writeUInt16LE(1, 20);                // audio format: PCM
	header.writeUInt16LE(1, 22);                // channels: mono
	header.writeUInt32LE(WHISPER_RATE, 24);
	header.writeUInt32LE(WHISPER_RATE * 2, 28); // byte rate
	header.writeUInt16LE(2, 32);                // block align
	header.writeUInt16LE(16, 34);               // bits per sample
	header.write('data', 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

module.exports = { ttsToMixer, captureToWav };
