const { spawn } = require('child_process');
const { ChannelType } = require('discord.js');
const {
	joinVoiceChannel,
	entersState,
	createAudioPlayer,
	createAudioResource,
	VoiceConnectionStatus,
	AudioPlayerStatus,
	NoSubscriberBehavior,
	EndBehaviorType,
	StreamType,
} = require('@discordjs/voice');
const prism = require('prism-media');
const config = require('./config');
const log = require('./logger');
const sessions = require('./sessions');
const { executePrompt } = require('./executor');
const { isBusy } = require('./queue');
const { getSystemPrompt } = require('./prompts');
const { transcribeAudio } = require('./stt');
const { synthesizeSpeech } = require('./tts');
const { getClient, sendChunked, resolveChannelName } = require('./discord');
const { VoiceMixer, SAMPLE_RATE, CHANNELS } = require('./mixer');

/**
 * Voice assistant: talk to the bot in a guild voice channel. The voice layer is
 * only an I/O adapter around the unchanged core — one utterance = one
 * executePrompt('claude', mode, text) through the existing global FIFO queue,
 * with the session keyed by the voice channel's own channelId (shared with its
 * text-in-voice chat, so /admin, /sandbox, /status typed there apply).
 *
 * v1 is half-duplex (walkie-talkie): input is ignored while a turn is being
 * transcribed, thought about, or spoken. The bot never hears its own output
 * (Discord delivers per-user streams).
 *
 * State machine:
 *   LISTENING → (user speaks, silence ends the stream) CAPTURING →
 *   TRANSCRIBING (Groq Whisper) → [gate: length/hallucinations] →
 *   THINKING (claude -p via the global FIFO, ambient bed up) →
 *   SPEAKING (OpenAI TTS → ffmpeg → mixer) → LISTENING
 */

const FFMPEG_TIMEOUT_MS = 30_000;
// PCM captured shorter than this is a click/cough, not an utterance.
const MIN_TURN_MS = 300;
const PCM_BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * 2) / 1000;

// Whisper hallucinates canned phrases on silence/noise (French model artifacts).
const HALLUCINATION_PATTERNS = [
	/sous-titr/i,
	/amara\.org/i,
	/merci d'avoir regardé/i,
	/abonnez-vous/i,
	/^[\s.!?…-]*$/,
];

// Spoken canned phrases. French on purpose: single-user bot, matches the
// whisper STT_LANGUAGE default. TTS clips for these are cached after first use.
const PHRASES = {
	joined: (mode) => `Mode vocal activé, canal en mode ${mode === 'sandbox' ? 'sandbox' : 'admin'}.`,
	busy: 'Un instant, je termine une autre tâche.',
	error: 'Désolé, une erreur est survenue pendant le traitement.',
	timeout: 'Désolé, la réponse a pris trop de temps et a été interrompue.',
};

// Single active voice session (single-user bot, one process, one connection).
let active = null;
const phraseCache = new Map(); // canned phrase text -> decoded PCM Buffer

function isVoiceModeAvailable() {
	return Boolean(config.OPENAI_API_KEY && config.GROQ_API_KEY);
}

function isSupportedVoiceChannel(channel) {
	return channel?.type === ChannelType.GuildVoice;
}

function getActiveVoiceChannelId() {
	return active ? active.channelId : null;
}

/** Run ffmpeg with stdin/stdout pipes, binary-safe. Returns stdout as a Buffer. */
function runFfmpeg(args, input) {
	return new Promise((resolve, reject) => {
		const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
		const out = [];
		let stderr = '';
		const timer = setTimeout(() => {
			try { child.kill('SIGKILL'); } catch (_) {}
			reject(new Error('ffmpeg timeout'));
		}, FFMPEG_TIMEOUT_MS);
		child.stdout.on('data', c => out.push(c));
		child.stderr.on('data', c => { stderr += c; });
		child.stdin.on('error', () => {});
		child.on('error', (err) => { clearTimeout(timer); reject(err); });
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 200)}`));
			resolve(Buffer.concat(out));
		});
		child.stdin.end(input);
	});
}

// Captured 48 kHz stereo PCM → 16 kHz mono WAV for Whisper.
function pcmToWav(pcm) {
	return runFfmpeg([
		'-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-i', 'pipe:0',
		'-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1',
	], pcm);
}

// TTS mp3 → 48 kHz stereo PCM for the mixer.
function mp3ToPcm(mp3) {
	return runFfmpeg([
		'-i', 'pipe:0',
		'-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), 'pipe:1',
	], mp3);
}

function isHallucination(text) {
	return text.length < 2 || HALLUCINATION_PATTERNS.some(re => re.test(text));
}

/** TTS + decode + play through the session mixer; resolves when played out. */
async function speak(session, text, { cache = false } = {}) {
	let pcm = cache ? phraseCache.get(text) : null;
	if (!pcm) {
		const mp3 = await synthesizeSpeech(text, {
			apiKey: config.OPENAI_API_KEY,
			model: config.TTS_MODEL,
			voice: config.TTS_VOICE,
		});
		pcm = await mp3ToPcm(mp3);
		if (cache) phraseCache.set(text, pcm);
	}
	await session.mixer.playSpeech(pcm);
}

async function postToChat(session, text) {
	// Re-resolve the channel from the client cache: the session outlives any
	// interaction-scoped channel proxy the /voice command may have been given.
	try {
		const channel = getClient().channels.cache.get(session.channelId);
		if (channel) await sendChunked(channel, text);
	} catch (err) {
		log.warn('voice chat post failed:', err.message);
	}
}

function resetIdleTimer(session) {
	clearTimeout(session.idleTimer);
	session.idleTimer = setTimeout(() => {
		if (active !== session) return;
		log.info('voice: leaving after inactivity');
		postToChat(session, '🔇 Voice assistant left after inactivity.');
		leaveVoice();
	}, config.VOICE_IDLE_TIMEOUT_MS);
}

function buildVoiceSystemPrompt(session) {
	return getSystemPrompt({
		botName: session.botName,
		userName: session.userName,
		mode: sessions.getMode(session.channelId),
		channelId: session.channelId,
		channelName: session.channelName,
		isDM: false,
		channelAgent: 'claude',
		channelModel: sessions.getModel(session.channelId),
		voice: true,
	});
}

/** Capture one utterance: subscribe until silence, decode opus → PCM. */
function captureTurn(session, userId) {
	return new Promise((resolve) => {
		const opusStream = session.connection.receiver.subscribe(userId, {
			end: { behavior: EndBehaviorType.AfterSilence, duration: config.VOICE_SILENCE_MS },
		});
		const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });
		const chunks = [];
		decoder.on('data', c => chunks.push(c));
		const finish = () => resolve(Buffer.concat(chunks));
		decoder.on('end', finish);
		decoder.on('error', (err) => { log.warn('voice decode error:', err.message); finish(); });
		opusStream.on('error', (err) => { log.warn('voice receive error:', err.message); });
		opusStream.pipe(decoder);
	});
}

async function handleTurn(session, pcm) {
	const { channelId } = session;
	if (pcm.length < MIN_TURN_MS * PCM_BYTES_PER_MS) return;

	// Voice turns must respect the same gates as text prompts (handleCommand is
	// bypassed here): no execution while the channel is driven from the mobile app.
	if (sessions.getRemoteId(channelId)) {
		await postToChat(session, '\u{1F6F0}️ This channel is in remote mode — voice turns are ignored. Send `/remote` to return to Discord mode.');
		return;
	}

	const wav = await pcmToWav(pcm);
	const text = (await transcribeAudio(wav, {
		apiKey: config.GROQ_API_KEY,
		model: config.STT_MODEL,
		language: config.STT_LANGUAGE,
	})).trim();
	if (isHallucination(text)) {
		log.info(`voice: dropped transcript "${text.slice(0, 60)}"`);
		return;
	}
	await postToChat(session, `🎙️ ${text}`);

	// Voice equivalent of the text "⏳ waiting" hint.
	if (isBusy()) {
		session.state = 'speaking';
		await speak(session, PHRASES.busy, { cache: true }).catch(err => log.warn('voice busy notice failed:', err.message));
	}

	session.state = 'thinking';
	session.mixer.setThinking(true);
	let reply;
	try {
		const mode = sessions.getMode(channelId);
		const result = await executePrompt('claude', mode, text, {
			channelId,
			systemPrompt: buildVoiceSystemPrompt(session),
			model: sessions.getModel(channelId),
		});
		reply = result.result || 'Réponse vide.';
	} finally {
		session.mixer.setThinking(false);
	}

	await postToChat(session, reply);
	session.state = 'speaking';
	await speak(session, reply);
}

function onSpeakingStart(session, userId) {
	if (userId !== config.AUTHORIZED_USER_ID) return;
	if (session.state !== 'listening') return; // half-duplex: one turn at a time
	session.state = 'capturing';
	// Suspend the inactivity timer for the whole turn — a long THINKING phase
	// must not be cut mid-flight. Re-armed in the finally below.
	clearTimeout(session.idleTimer);

	captureTurn(session, userId)
		.then(async (pcm) => {
			try {
				await handleTurn(session, pcm);
			} catch (err) {
				log.error('voice turn error:', err.message || err);
				const spoken = err.code === 124 ? PHRASES.timeout : PHRASES.error;
				await postToChat(session, `Voice turn failed: ${err.message?.slice(0, 300) || 'unknown'}`);
				await speak(session, spoken, { cache: true }).catch(() => {});
			} finally {
				if (active === session) {
					session.state = 'listening';
					resetIdleTimer(session);
				}
			}
		});
}

/**
 * Join `channel` (a GuildVoice channel) and start the assistant. Caller has
 * already validated availability, channel type and agent. Announces the
 * channel mode out loud once ready.
 */
async function joinVoice(channel) {
	if (active) throw new Error('Voice assistant already active');
	const client = getClient();

	const connection = joinVoiceChannel({
		channelId: channel.id,
		guildId: channel.guild.id,
		adapterCreator: channel.guild.voiceAdapterCreator,
		selfDeaf: false,
		selfMute: false,
	});

	const session = {
		channelId: channel.id,
		channelName: resolveChannelName(channel),
		connection,
		mixer: null,
		player: null,
		state: 'listening',
		idleTimer: null,
		botName: client.user.displayName || client.user.username,
		userName: 'user',
	};

	try {
		await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
	} catch (err) {
		connection.destroy();
		throw new Error(`could not join the voice channel (permissions?): ${err.message}`);
	}

	try {
		const user = await client.users.fetch(config.AUTHORIZED_USER_ID);
		session.userName = user.displayName || user.username;
	} catch (_) {}

	// Permanent mixer resource: one audio source for the whole session.
	session.mixer = new VoiceMixer();
	session.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
	session.player.on('error', err => log.error('voice player error:', err.message));
	// The mixer never ends by itself — Idle here means the pipeline broke.
	session.player.on(AudioPlayerStatus.Idle, () => {
		if (active !== session) return;
		log.warn('voice player went idle, rebuilding mixer resource');
		const old = session.mixer;
		session.mixer = new VoiceMixer();
		old.destroy();
		session.player.play(createAudioResource(session.mixer, { inputType: StreamType.Raw }));
	});
	connection.subscribe(session.player);
	session.player.play(createAudioResource(session.mixer, { inputType: StreamType.Raw }));

	connection.receiver.speaking.on('start', userId => onSpeakingStart(session, userId));

	// Standard reconnect pattern: a Disconnected that neither resumes nor
	// reconnects within 5 s is a real disconnect (kick, channel deleted).
	connection.on(VoiceConnectionStatus.Disconnected, async () => {
		if (active !== session) return;
		try {
			await Promise.race([
				entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
				entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
			]);
		} catch (_) {
			log.info('voice: disconnected, cleaning up');
			postToChat(session, '🔇 Voice assistant disconnected.');
			leaveVoice();
		}
	});
	connection.on('error', err => log.error('voice connection error:', err.message));

	active = session;
	resetIdleTimer(session);

	const mode = sessions.getMode(channel.id);
	speak(session, PHRASES.joined(mode), { cache: true })
		.catch(err => log.warn('voice join announcement failed:', err.message));
	return session;
}

/** Tear down the active session, if any. Safe to call twice. */
function leaveVoice() {
	const session = active;
	if (!session) return false;
	active = null;
	clearTimeout(session.idleTimer);
	session.mixer.stopSpeech();
	try { session.player.stop(true); } catch (_) {}
	try { session.connection.destroy(); } catch (_) {}
	session.mixer.destroy();
	log.info(`voice: left channel ${session.channelId}`);
	return true;
}

module.exports = {
	isVoiceModeAvailable,
	isSupportedVoiceChannel,
	getActiveVoiceChannelId,
	joinVoice,
	leaveVoice,
};
