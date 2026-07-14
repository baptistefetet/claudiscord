const log = require('./logger');

const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
// The endpoint rejects inputs longer than 4096 characters.
const TTS_MAX_INPUT_CHARS = 4000;

/**
 * Synthesize speech with OpenAI's speech endpoint (plain REST, no SDK — same
 * mold as src/stt.js). Returns the audio as a Buffer (mp3), decoded to PCM by
 * the caller (ffmpeg). Long texts are truncated to the endpoint's input limit.
 */
async function synthesizeSpeech(text, { apiKey, model, voice, instructions = null }) {
	if (!apiKey) throw new Error('OPENAI_API_KEY missing');

	let input = text.trim();
	if (input.length > TTS_MAX_INPUT_CHARS) {
		input = input.slice(0, TTS_MAX_INPUT_CHARS);
	}

	const body = { model, voice, input, response_format: 'mp3' };
	if (instructions) body.instructions = instructions;

	const t0 = Date.now();
	const res = await fetch(OPENAI_SPEECH_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const errBody = await res.text().catch(() => '');
		throw new Error(`OpenAI TTS ${res.status}: ${errBody.slice(0, 200) || res.statusText}`);
	}

	const audio = Buffer.from(await res.arrayBuffer());
	log.info(`TTS ok: ${input.length} chars -> ${audio.length}B mp3 (${Date.now() - t0}ms)`);
	return audio;
}

module.exports = { synthesizeSpeech };
