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
 * Voice assistant: talk to the bot in a guild voice channel. The voice layer is
 * only an I/O adapter around the unchanged core — one utterance = one
 * executePrompt(agent, mode, text) through the existing global FIFO queue,
 * with the session keyed by the voice channel's own channelId (shared with its
 * text-in-voice chat, so /admin, /sandbox, /status typed there apply). Turns
 * run the channel's own agent/mode/model; agent switches are locked while the
 * assistant is active (commands.js) so the shared sessionId stays coherent.
 *
 * v1 is half-duplex (walkie-talkie): input is ignored while a turn is being
 * transcribed, thought about, or spoken. The bot never hears its own output
 * (Discord delivers per-user streams).
 *
 * State machine:
 *   LISTENING → (user speaks, silence ends the stream) CAPTURING →
 *   TRANSCRIBING (Groq Whisper) → [gate: length/hallucinations] →
 *   THINKING (channel agent via the global FIFO, ambient bed up) →
 *   SPEAKING (OpenAI TTS pcm → JS resample → mixer) → LISTENING
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

// Spoken canned phrases. French on purpose: single-user bot, matches the
// whisper STT_LANGUAGE default. TTS clips for these are cached after first use.
const PHRASES = {
	busy: 'Un instant, je termine une autre tâche.',
	error: 'Désolé, une erreur est survenue pendant le traitement.',
	timeout: 'Désolé, la réponse a pris trop de temps et a été interrompue.',
};

// Single active voice session (single-user bot, one process, one connection).
let active = null;
// Channel id whose join is in flight, or null. `active` alone cannot serialize
// joins: it is only assigned at the very END of joinVoice, after entersState has
// awaited readiness for up to 15 s. Within that window `active` is still null, so
// a concurrent caller (autojoin firing while a manual /voice join is settling)
// would start a second session — and @discordjs/voice reuses the connection for a
// guild, so both would attach their own speaking handler to the same receiver
// (duplicate turns) while the overwritten session leaks past leaveVoice's reach.
let joining = null;
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

function isHallucination(text) {
	return text.length < 2 || HALLUCINATION_PATTERNS.some(re => re.test(text));
}

/**
 * playSpeech resolves when the mixer has GENERATED the last speech frame, but
 * the opus encoder between mixer and player buffers a few seconds ahead —
 * pausing the player at generation time would freeze that buffered tail
 * (truncated replies). Wait until the player has actually sent the frame:
 * resource.playbackDuration advances 20 ms per packet really read.
 */
function waitForPlayout(session, generatedMs) {
	if (!generatedMs) return Promise.resolve();
	const deadline = Date.now() + 15_000; // the tail is only ever buffer-sized
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

	// Voice turns must respect the same gates as text prompts (handleCommand is
	// bypassed here): no execution while the channel is driven from the mobile app.
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
	if (isBusy()) {
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
		// The agent may have edited a jobs file — reload the scheduler right away
		// (mirrors the text path in index.js) so a job scheduled by voice can fire
		// on time instead of waiting for the next text prompt.
		scheduler.reloadJobs();
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
					// Pause the player while idle: after 5 silence frames the lib
					// clears the speaking flag, so the green ring turns off between
					// turns. The lib's own 5 s UDP keepalive keeps the session up.
					session.player.pause();
					resetIdleTimer(session);
				}
			}
		});
}

/**
 * Join `channel` (a GuildVoice channel) and start the assistant. Caller has
 * already validated availability, channel type and agent. Announces the
 * channel mode out loud once ready.
 *
 * The `joining` guard is held here rather than in the callers so it covers EVERY
 * path (/voice, autojoin, boot scan) — see the declaration for why `active` is
 * not enough on its own.
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

	// Join silently: the mode is already announced in the channel's chat, and a
	// spoken greeting on every single connect gets old fast. Removing it also drops
	// the whole class of "the greeting's first word is clipped" problems — autojoin
	// fires the instant the user's own client connects, so it is still finishing its
	// voice handshake while the bot is already Ready.
	//
	// Settle the player straight to Paused instead: the idle bed is silent
	// (BED_IDLE = 0) but a live player keeps transmitting, which shows the bot as
	// permanently speaking. pause() only works from Playing and play() starts in
	// Buffering, so wait for the transition rather than pausing blind. The lib's 5
	// silence frames on pause clear the speaking flag, and its own 5 s UDP keepalive
	// keeps the session up. Skipped if a turn already claimed the player.
	entersState(session.player, AudioPlayerStatus.Playing, 5_000)
		.then(() => { if (active === session && session.state === 'listening') session.player.pause(); })
		.catch(err => log.warn('voice: player never reached Playing:', err.message));
	return session;
}

/**
 * Tear down the active session, if any. Safe to call twice.
 *
 * `suppressAutojoin` is set only by the explicit `/voice` toggle: kicking the
 * bot out of an autojoin channel must not have it walk straight back in. The
 * other callers (idle timeout, disconnect, shutdown) don't need it — autojoin is
 * only ever re-triggered by a voiceStateUpdate, which none of them produce.
 * Nothing to suppress when the policy is already off: recording it there would
 * only linger and block a later `/autojoin` on during the same stay.
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
 * Autojoin: the bot connects on its own when the authorized user joins a voice
 * channel whose `autojoin` flag is set (`/autojoin`, persisted per channel in
 * sessions.json). Opt-in per channel — that IS the allowlist, so the bot never
 * joins a call by surprise and turns every one of the user's sentences into a
 * prompt.
 *
 * Policy vs session are orthogonal:
 *   - `/autojoin` off does NOT disconnect a bot that is already connected.
 *   - `/voice` off does NOT clear the policy — it suppresses it for this stay only.
 *
 * On a move, "following" is leave + join, never a connection move: the session is
 * keyed by the voice channel's own id, so the destination brings its own
 * mode/agent/model/sessionId and re-announces its mode. Moving to a channel
 * without autojoin just leaves — a bot alone in a channel can do nothing anyway
 * (onSpeakingStart only ever reacts to AUTHORIZED_USER_ID).
 */

// Channels the user kicked the bot out of with `/voice` while autojoin was on.
// In-memory only, and cleared as soon as they leave the channel: the kick holds
// for the current stay, then autojoin re-arms on the next connect.
const suppressed = new Set();

/** Explicitly re-arm autojoin for a channel (used when the policy is turned ON). */
function clearAutojoinSuppression(channelId) {
	suppressed.delete(channelId);
}

/** The authorized user's current voice channel in `guild`, straight from the gateway cache. */
function userVoiceChannelId(guild) {
	return guild?.voiceStates?.cache?.get(config.AUTHORIZED_USER_ID)?.channelId || null;
}

function isAutojoinTarget(channel) {
	return isVoiceModeAvailable()
		&& isSupportedVoiceChannel(channel)
		&& sessions.getAutojoin(channel.id)
		&& !suppressed.has(channel.id)
		// The user must actually be in there: this makes the function safe to call
		// from the boot scan and from `/autojoin` on, not just from the event path.
		&& userVoiceChannelId(channel.guild) === channel.id;
}

/**
 * Join `channel` if the autojoin policy, the live state and the user's presence
 * all allow it, then converge on wherever the user actually ended up.
 *
 * `seen` carries the channels already attempted in the current convergence chain
 * and guarantees termination: without it, a channel that keeps failing to join
 * (missing Connect permission, say) would bounce between here and reconcile
 * forever. Each fresh event starts a fresh chain, so a later retry still works.
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
 * Converge the live session on the user's current channel. Called after every
 * autojoin attempt because that attempt is a wide async window (entersState up to
 * 15 s, plus the chat post) during which the user may have left or moved on: their
 * voiceStateUpdate was either dropped by the `joining` guard or found no session
 * to tear down, so nothing else will fix it. Also recovers a failed join, whose
 * destination event was swallowed the same way.
 */
async function reconcileAutojoin(guild, seen) {
	const nowId = userVoiceChannelId(guild);
	if (getActiveVoiceChannelId() === nowId) return; // already converged (both null included)
	if (getActiveVoiceChannelId()) {
		log.info('voice: user moved during a join, backing out');
		leaveVoice();
	}
	if (!nowId) return;
	const next = guild.channels.cache.get(nowId);
	if (next) await maybeAutojoin(next, seen);
}

/**
 * voiceStateUpdate handler. Discord fires this event for far more than channel
 * changes (mute, deafen, streaming, camera, server-mute…), and for every member
 * including the bot itself — whose own join/leave, plus the leave+join burst of a
 * follow, would otherwise re-enter this logic. Both are filtered up front.
 */
async function handleVoiceStateUpdate(oldState, newState) {
	if ((newState?.id || oldState?.id) !== config.AUTHORIZED_USER_ID) return;

	const from = oldState?.channelId || null;
	const to = newState?.channelId || null;
	if (from === to) return; // mute/deafen/stream/camera: not a channel transition

	// Leaving a channel re-arms autojoin there (see `suppressed`).
	if (from) suppressed.delete(from);

	// The user left the channel the bot is sitting in — whether they disconnected
	// or moved elsewhere, the bot leaves. Checked before any availability gate: an
	// active session must always be able to shut down.
	if (from && from === getActiveVoiceChannelId()) {
		log.info(`voice: user left ${from}, leaving`);
		leaveVoice();
	}

	if (to) await maybeAutojoin(newState.channel);
}

/**
 * The gateway only delivers voiceStateUpdate on CHANGES, so a user already
 * sitting in an autojoin channel when the process boots (typical after
 * `/restart`) would never trigger one. Converge once on ClientReady. Scoped to
 * opted-in channels, so it can't produce a surprise join.
 */
async function scanAutojoinOnBoot() {
	if (!isVoiceModeAvailable()) return;
	const client = getClient();
	for (const channelId of sessions.listAutojoinChannelIds()) {
		const channel = client.channels.cache.get(channelId);
		// isAutojoinTarget does the real check (is the user actually in there?).
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
