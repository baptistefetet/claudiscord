const log = require('./logger');

const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * Transcribe an in-memory audio buffer via Groq Whisper. Shared core for
 * Discord voice messages (downloaded attachment) and voice-channel turns
 * (PCM captured live, converted to WAV by src/voice.js).
 */
async function transcribeAudio(buf, { apiKey, model, language, filename = 'audio.wav', contentType = 'audio/wav' }) {
	if (!apiKey) throw new Error('GROQ_API_KEY missing');

	const blob = new Blob([buf], { type: contentType });

	const form = new FormData();
	form.append('file', blob, filename);
	form.append('model', model);
	if (language) form.append('language', language);
	form.append('response_format', 'text');

	const t0 = Date.now();
	const res = await fetch(GROQ_TRANSCRIPTIONS_URL, {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Groq ${res.status}: ${body.slice(0, 200) || res.statusText}`);
	}

	const text = (await res.text()).trim();
	log.info(`STT ok: ${buf.byteLength}B audio -> ${text.length} chars (${Date.now() - t0}ms)`);
	return text;
}

async function transcribeVoiceMessage(attachment, { apiKey, model, language }) {
	const audioRes = await fetch(attachment.url);
	if (!audioRes.ok) {
		throw new Error(`Failed to download audio (${audioRes.status})`);
	}
	const buf = await audioRes.arrayBuffer();
	return transcribeAudio(buf, {
		apiKey,
		model,
		language,
		filename: attachment.name || 'voice-message.ogg',
		contentType: attachment.contentType || 'audio/ogg',
	});
}

module.exports = { transcribeAudio, transcribeVoiceMessage };
