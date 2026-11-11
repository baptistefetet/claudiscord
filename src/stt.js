const log = require('./logger');

const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// Groq caps `prompt` at 224 tokens and documents no truncation. Tokens are not
// countable here: 2 characters per token is a deliberately low estimate.
const PROMPT_MAX_CHARS = 448;

/** Cut a comma-separated list of terms on a term boundary. */
function fitTerms(terms, max = PROMPT_MAX_CHARS) {
	if (terms.length <= max) return terms;
	return terms.slice(0, Math.max(0, terms.lastIndexOf(',', max)));
}

/**
 * Transcribe a Discord voice message (the mic button's attachment) via Groq Whisper.
 * `lexicon`: comma-separated terms whose spelling the model should know.
 */
async function transcribeVoiceMessage(attachment, { apiKey, model, language, lexicon }) {
	if (!apiKey) throw new Error('GROQ_API_KEY missing');

	const audioRes = await fetch(attachment.url);
	if (!audioRes.ok) {
		throw new Error(`Failed to download audio (${audioRes.status})`);
	}
	const buf = await audioRes.arrayBuffer();

	const form = new FormData();
	form.append('file', new Blob([buf], { type: attachment.contentType || 'audio/ogg' }), attachment.name || 'voice-message.ogg');
	form.append('model', model);
	if (language) form.append('language', language);
	if (lexicon) form.append('prompt', fitTerms(lexicon));
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

module.exports = { transcribeVoiceMessage };
