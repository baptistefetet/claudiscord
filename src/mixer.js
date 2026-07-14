const { Readable } = require('stream');

/**
 * Continuous audio mixer for the voice assistant (idea borrowed from Hermes'
 * voice_mixer.py). ONE permanent PCM source (s16le, 48 kHz, stereo) feeds the
 * audio player for the whole voice session, summing two layers per 20 ms frame:
 *
 *   - ambient "thinking" bed — a synthesized detuned-sine pad with a slow
 *     tremolo, faded in while Claude works so the channel never feels dead
 *     during the 5–15 s turn latency. No asset file: pure phase-accumulator
 *     synthesis, seamless by construction.
 *   - speech — decoded TTS PCM played over the bed, which ducks down while
 *     speech is active and swells back after (never stop-and-swap).
 *
 * Always producing frames (silence included) doubles as the UDP keepalive:
 * Discord drops the voice UDP session after ~60 s without packets.
 *
 * Generation is pull-driven: the audio player requests a frame every 20 ms,
 * so there are no timers here.
 */

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SAMPLES = 960; // 20 ms at 48 kHz
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;

// Bed levels relative to full scale (Hermes values), smoothed per frame.
const BED_THINKING = 0.18;
const BED_DUCKED = 0.06;
const BED_IDLE = 0;
const GAIN_SMOOTHING = 0.08; // exponential approach factor per 20 ms frame

// Pad voicing: a low fifth with a slight detune between the two roots.
const BED_FREQS = [110, 110.6, 165];
const TREMOLO_HZ = 0.25;
const TREMOLO_DEPTH = 0.35;

class VoiceMixer extends Readable {
	constructor() {
		super({ highWaterMark: FRAME_BYTES * 2 });
		this.thinking = false;
		this.bedGain = 0;
		this.phases = BED_FREQS.map(() => Math.random() * 2 * Math.PI);
		this.tremoloPhase = 0;
		/** @type {{buf: Buffer, offset: number, resolve: Function}|null} */
		this.speech = null;
		/** @type {{buf: Buffer, resolve: Function}[]} */
		this.speechQueue = [];
		this.destroyedFlag = false;
	}

	_read() {
		this.push(this._nextFrame());
	}

	_destroy(err, cb) {
		this.destroyedFlag = true;
		this.stopSpeech();
		cb(err);
	}

	/**
	 * Queue a decoded speech clip (s16le 48 kHz stereo). Resolves when the clip
	 * has been fully consumed by the stream (i.e. played out, modulo the small
	 * player buffer). Clips play back-to-back in queue order.
	 */
	playSpeech(pcm) {
		return new Promise((resolve) => {
			if (this.destroyedFlag || pcm.length === 0) return resolve();
			this.speechQueue.push({ buf: pcm, resolve });
		});
	}

	/** Drop the current clip and the queue (barge-in rail; also used on leave). */
	stopSpeech() {
		if (this.speech) {
			this.speech.resolve();
			this.speech = null;
		}
		for (const item of this.speechQueue.splice(0)) item.resolve();
	}

	isSpeechActive() {
		return Boolean(this.speech) || this.speechQueue.length > 0;
	}

	setThinking(on) {
		this.thinking = Boolean(on);
	}

	_nextFrame() {
		const out = Buffer.alloc(FRAME_BYTES);

		// Pull up to one frame of speech PCM, chaining queued clips.
		let speechFrame = null;
		if (!this.speech && this.speechQueue.length > 0) {
			const next = this.speechQueue.shift();
			this.speech = { buf: next.buf, offset: 0, resolve: next.resolve };
		}
		if (this.speech) {
			const { buf, offset } = this.speech;
			const end = Math.min(offset + FRAME_BYTES, buf.length);
			speechFrame = buf.subarray(offset, end);
			this.speech.offset = end;
			if (end >= buf.length) {
				this.speech.resolve();
				this.speech = null;
			}
		}

		const speechActive = Boolean(speechFrame) || this.isSpeechActive();
		const target = speechActive ? BED_DUCKED : (this.thinking ? BED_THINKING : BED_IDLE);
		this.bedGain += (target - this.bedGain) * GAIN_SMOOTHING;

		const bedActive = this.bedGain > 0.001;
		if (!bedActive && !speechFrame) return out; // pure silence frame

		const phaseInc = BED_FREQS.map(f => (2 * Math.PI * f) / SAMPLE_RATE);
		const tremoloInc = (2 * Math.PI * TREMOLO_HZ) / SAMPLE_RATE;
		for (let i = 0; i < FRAME_SAMPLES; i++) {
			let bed = 0;
			if (bedActive) {
				for (let v = 0; v < this.phases.length; v++) {
					bed += Math.sin(this.phases[v]);
					this.phases[v] += phaseInc[v];
				}
				const tremolo = 1 - TREMOLO_DEPTH * (0.5 + 0.5 * Math.sin(this.tremoloPhase));
				this.tremoloPhase += tremoloInc;
				bed = (bed / this.phases.length) * tremolo * this.bedGain * 32767;
			}
			for (let c = 0; c < CHANNELS; c++) {
				const idx = (i * CHANNELS + c) * 2;
				let sample = bed;
				if (speechFrame && idx + 1 < speechFrame.length) {
					sample += speechFrame.readInt16LE(idx);
				}
				out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), idx);
			}
		}
		if (!bedActive) {
			// Keep phases bounded while idle so a long session never loses precision.
			this.phases = this.phases.map(p => p % (2 * Math.PI));
			this.tremoloPhase %= 2 * Math.PI;
		}
		return out;
	}
}

module.exports = { VoiceMixer, FRAME_BYTES, SAMPLE_RATE, CHANNELS };
