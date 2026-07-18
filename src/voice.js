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
const { ttsToMixer, captureToWav } = require('./pcm');
const scheduler = require('./scheduler');
const { getClient, sendChunked, resolveChannelName } = require('./discord');
const { VoiceMixer, SAMPLE_RATE, CHANNELS } = require('./mixer');

/**
 * Voice assistant: an I/O adapter around the unchanged core. One utterance = one
 * executePrompt through its channel FIFO, session keyed by the voice channel's own
 * id (shared with its text-in-voice chat).
 *
 * Half-duplex: input is ignored unless the state is `listening`.
 *   LISTENING → CAPTURING (until silence) → TRANSCRIBING → THINKING → SPEAKING
 */

// PCM captured shorter than this is a click/cough, not an utterance.
const MIN_TURN_MS = 300;
const PCM_BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * 2) / 1000;

// Whisper hallucinates canned phrases on silence/noise (French model artifacts).
const HALLUCINATION_PATTERNS = [
	/sous-titr/i,
	/amara\.org/i,
	/merci d'avoir regardé/i,
	/abonnez-vous/i,
	// A bare pleasantry alone is a silence artifact, not a real turn.
	/^(?:merci(?: beaucoup| à tous)?|au revoir|à bientôt)[\s.!?…]*$/i,
	/^[\s.!?…-]*$/,
];

// French on purpose: single-user bot, matches the STT_LANGUAGE default.
const PHRASES = {
	busy: 'Un instant, je termine une autre tâche.',
	error: 'Désolé, une erreur est survenue pendant le traitement.',
};

let active = null;
// `active` cannot serialize joins on its own: it is assigned only at the end of
// connectAndStart, after up to 15 s of entersState. Guards that window.
let joining = null;
const phraseCache = new Map();

function isVoiceModeAvailable() {
	return Boolean(config.OPENAI_API_KEY && config.GROQ_API_KEY);
}

function isSupportedVoiceChannel(channel) {
	return channel?.type === ChannelType.GuildVoice;
}

function getActiveVoiceChannelId() {
	return active ? active.channelId : null;
}

function isHallucination(text) {
	return text.length < 2 || HALLUCINATION_PATTERNS.some(re => re.test(text));
}

/**
 * playSpeech resolves once the mixer has GENERATED the last frame, but the opus
 * encoder buffers seconds ahead — pausing then would freeze that tail (truncated
 * replies). resource.playbackDuration advances 20 ms per packet actually sent.
 */
function waitForPlayout(session, generatedMs) {
	if (!generatedMs) return Promise.resolve();
	const deadline = Date.now() + 15_000;
	return new Promise((resolve) => {
		const check = () => {
			if (active !== session || !session.resource
				|| session.resource.playbackDuration >= generatedMs
				|| Date.now() > deadline) return resolve();
			setTimeout(check, 100);
		};
		check();
	});
}

/** TTS + decode + play through the session mixer; resolves when played out. */
async function speak(session, text, { cache = false } = {}) {
	let pcm = cache ? phraseCache.get(text) : null;
	if (!pcm) {
		const raw = await synthesizeSpeech(text, {
			apiKey: config.OPENAI_API_KEY,
			model: config.TTS_MODEL,
			voice: config.TTS_VOICE,
			speed: config.TTS_SPEED,
			format: 'pcm', // s16le 24 kHz mono, upsampled below — no decode step
		});
		pcm = ttsToMixer(raw);
		if (cache) phraseCache.set(text, pcm);
	}
	session.player.unpause();
	const generatedMs = await session.mixer.playSpeech(pcm);
	await waitForPlayout(session, generatedMs);
}

async function postToChat(session, text) {
	// Re-resolve from cache: the session outlives any interaction-scoped proxy.
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
		channelAgent: sessions.getAgent(session.channelId),
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

	// Same gate as the text path; handleCommand is bypassed here.
	if (sessions.getRemoteId(channelId)) {
		await postToChat(session, '\u{1F6F0}️ This channel is in remote mode — voice turns are ignored. Send `/remote` to return to Discord mode.');
		return;
	}

	const wav = captureToWav(pcm);
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
	if (isBusy(channelId)) {
		session.state = 'speaking';
		await speak(session, PHRASES.busy, { cache: true }).catch(err => log.warn('voice busy notice failed:', err.message));
	}

	session.state = 'thinking';
	session.player.unpause(); // make the thinking bed audible
	session.mixer.setThinking(true);
	let reply;
	try {
		const mode = sessions.getMode(channelId);
		const agent = sessions.getAgent(channelId);
		const result = await executePrompt(agent, mode, text, {
			channelId,
			systemPrompt: buildVoiceSystemPrompt(session),
			model: sessions.getModel(channelId),
		});
		reply = result.result || 'Réponse vide.';
	} finally {
		session.mixer.setThinking(false);
		scheduler.reloadJobs(); // the agent may have edited a jobs file; mirrors index.js
	}

	await postToChat(session, reply);
	session.state = 'speaking';
	await speak(session, reply);
}

function onSpeakingStart(session, userId) {
	if (userId !== config.AUTHORIZED_USER_ID) return;
	if (session.state !== 'listening') return; // half-duplex: one turn at a time
	session.state = 'capturing';
	clearTimeout(session.idleTimer); // a long THINKING must not be cut; re-armed below

	captureTurn(session, userId)
		.then(async (pcm) => {
			try {
				await handleTurn(session, pcm);
			} catch (err) {
				log.error('voice turn error:', err.message || err);
				await postToChat(session, `Voice turn failed: ${err.message?.slice(0, 300) || 'unknown'}`);
				await speak(session, PHRASES.error, { cache: true }).catch(() => {});
			} finally {
				if (active === session) {
					session.state = 'listening';
					// The lib's 5 silence frames on pause turn the speaking ring off;
					// its own UDP keepalive keeps the session up.
					session.player.pause();
					resetIdleTimer(session);
				}
			}
		});
}

/**
 * Join `channel` and start the assistant. Caller has already validated
 * availability, channel type and agent. The `joining` guard is held here so it
 * covers every path (/voice, autojoin, boot scan).
 */
async function joinVoice(channel) {
	if (active || joining) throw new Error('Voice assistant already active');
	joining = channel.id;
	try {
		return await connectAndStart(channel);
	} finally {
		joining = null;
	}
}

async function connectAndStart(channel) {
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
		resource: null,
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
		session.resource = createAudioResource(session.mixer, { inputType: StreamType.Raw });
		session.player.play(session.resource);
	});
	connection.subscribe(session.player);
	session.resource = createAudioResource(session.mixer, { inputType: StreamType.Raw });
	session.player.play(session.resource);

	connection.receiver.speaking.on('start', userId => onSpeakingStart(session, userId));

	// A Disconnected that neither resumes nor reconnects within 5 s is a real one.
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

	// Join silently, straight to Paused: the idle bed is silent but a live player
	// keeps transmitting, showing the bot as permanently speaking. pause() no-ops
	// unless already Playing, and play() starts in Buffering — hence entersState.
	entersState(session.player, AudioPlayerStatus.Playing, 5_000)
		.then(() => { if (active === session && session.state === 'listening') session.player.pause(); })
		.catch(err => log.warn('voice: player never reached Playing:', err.message));
	return session;
}

/**
 * Tear down the active session, if any. Safe to call twice.
 *
 * `suppressAutojoin` is passed only by the explicit `/voice` kick — the other
 * callers produce no voiceStateUpdate, so nothing could re-trigger autojoin.
 */
function leaveVoice({ suppressAutojoin = false } = {}) {
	const session = active;
	if (!session) return false;
	if (suppressAutojoin && sessions.getAutojoin(session.channelId)) suppressed.add(session.channelId);
	active = null;
	clearTimeout(session.idleTimer);
	session.mixer.stopSpeech();
	try { session.player.stop(true); } catch (_) {}
	try { session.connection.destroy(); } catch (_) {}
	session.mixer.destroy();
	log.info(`voice: left channel ${session.channelId}`);
	return true;
}

/* ---------------------------------------------------------------- autojoin */

/**
 * Autojoin: connect on our own when the authorized user joins a voice channel
 * whose `autojoin` flag is set. Opt-in per channel — that IS the allowlist.
 *
 * Policy and session are orthogonal: `/autojoin` off leaves a connected bot
 * alone, `/voice` off suppresses the policy for the current stay only.
 * Following a move is leave + join, so the destination brings its own session.
 */

// Kicked out with `/voice` while autojoin was on; cleared when the user leaves
// the channel, so the kick holds for the current stay only.
const suppressed = new Set();

function clearAutojoinSuppression(channelId) {
	suppressed.delete(channelId);
}

function userVoiceChannelId(guild) {
	return guild?.voiceStates?.cache?.get(config.AUTHORIZED_USER_ID)?.channelId || null;
}

function isAutojoinTarget(channel) {
	return isVoiceModeAvailable()
		&& isSupportedVoiceChannel(channel)
		&& sessions.getAutojoin(channel.id)
		&& !suppressed.has(channel.id)
		// Presence check: makes this safe to call from the boot scan and /autojoin.
		&& userVoiceChannelId(channel.guild) === channel.id;
}

/**
 * Join `channel` if policy, live state and presence allow, then converge.
 * `seen` bounds the convergence chain: a channel that always fails to join would
 * otherwise bounce between here and reconcile forever.
 */
async function maybeAutojoin(channel, seen = new Set()) {
	if (active || joining) return;
	if (seen.has(channel.id)) return;
	if (!isAutojoinTarget(channel)) return;
	seen.add(channel.id);

	try {
		const session = await joinVoice(channel);
		log.info(`voice: autojoined ${channel.id}`);
		await postToChat(session, `🎙️ Autojoin — voice assistant joined **${resolveChannelName(channel)}** (mode **${sessions.getMode(channel.id)}**, agent **${sessions.getAgent(channel.id)}**). Send \`/voice\` to stop it.`);
	} catch (err) {
		log.error('voice autojoin failed:', err.message || err);
	}

	await reconcileAutojoin(channel.guild, seen);
}

/**
 * Converge the live session on the user's current channel. Runs after every
 * attempt: the join window is wide, and a move during it was either dropped by
 * the `joining` guard or found no session to tear down. Also recovers a failed
 * join, whose destination event was swallowed the same way.
 */
async function reconcileAutojoin(guild, seen) {
	const nowId = userVoiceChannelId(guild);
	if (getActiveVoiceChannelId() === nowId) return; // converged (both null included)
	if (getActiveVoiceChannelId()) {
		log.info('voice: user moved during a join, backing out');
		leaveVoice();
	}
	if (!nowId) return;
	const next = guild.channels.cache.get(nowId);
	if (next) await maybeAutojoin(next, seen);
}

/**
 * voiceStateUpdate also fires on mute/deafen/stream/camera, and for every member
 * including the bot itself (a follow emits a burst). Both filtered up front.
 */
async function handleVoiceStateUpdate(oldState, newState) {
	if ((newState?.id || oldState?.id) !== config.AUTHORIZED_USER_ID) return;

	const from = oldState?.channelId || null;
	const to = newState?.channelId || null;
	if (from === to) return; // not a channel transition

	if (from) suppressed.delete(from); // leaving re-arms autojoin there

	// Checked before any availability gate: an active session must always be able
	// to shut down.
	if (from && from === getActiveVoiceChannelId()) {
		log.info(`voice: user left ${from}, leaving`);
		leaveVoice();
	}

	if (to) await maybeAutojoin(newState.channel);
}

/**
 * The gateway only delivers voiceStateUpdate on CHANGES, so a user already in an
 * autojoin channel at boot never triggers one. Converge once on ClientReady.
 */
async function scanAutojoinOnBoot() {
	if (!isVoiceModeAvailable()) return;
	const client = getClient();
	for (const channelId of sessions.listAutojoinChannelIds()) {
		const channel = client.channels.cache.get(channelId);
		if (!channel) continue;
		await maybeAutojoin(channel);
		if (active) return; // one voice channel at a time
	}
}

module.exports = {
	isVoiceModeAvailable,
	isSupportedVoiceChannel,
	getActiveVoiceChannelId,
	joinVoice,
	leaveVoice,
	maybeAutojoin,
	clearAutojoinSuppression,
	handleVoiceStateUpdate,
	scanAutojoinOnBoot,
};
