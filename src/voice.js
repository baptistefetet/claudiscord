const { ChannelType } = require('discord.js');
const { PassThrough } = require('stream');
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
const config = require('./config');
const log = require('./logger');
const sessions = require('./sessions');
const { executePrompt } = require('./executor');
const { isBusy } = require('./queue');
const { getSystemPrompt, getLiveInstructions } = require('./prompts');
const { openLiveCall, hasHostCodexLogin } = require('./live');
const scheduler = require('./scheduler');
const { getClient, sendChunked, resolveChannelName, startProgressReporter } = require('./discord');

/**
 * Voice assistant: a GPT-Live call (src/live.js) holds the spoken conversation,
 * full duplex, and delegates every real task here. A delegation is one
 * executePrompt through the channel FIFO, session keyed by the voice channel's own
 * id (shared with its text-in-voice chat). Its result goes to the chat and back to
 * the call, which says the gist of it.
 */

// Trailing silent output chunks (200 ms each) that end a spoken burst.
const END_OF_SPEECH_CHUNKS = 2;
// Discord player tolerance for late output chunks before it gives up (20 ms frames).
const MAX_MISSED_FRAMES = 50;
// Silent progress context is for "where are you at?" questions, not a live feed.
const PROGRESS_MIN_INTERVAL_MS = 5000;
// Past this, the call is told the rest is in the chat instead of receiving it.
const MAX_SPOKEN_RESULT_CHARS = 2000;
// The call words a follow-up without the previous result; the backend has it.
const OVERLAP_NOTE = '[Requested by voice before the result of the previous task was known: '
	+ 'it may correct or refine it. Take that result into account; do not repeat it.]';

let active = null;
// `active` cannot serialize joins on its own: it is assigned only at the end of
// connectAndStart, after up to 15 s of entersState. Guards that window.
let joining = null;

function isVoiceModeAvailable() {
	return hasHostCodexLogin();
}

function isSupportedVoiceChannel(channel) {
	return channel?.type === ChannelType.GuildVoice;
}

function getActiveVoiceChannelId() {
	return active ? active.channelId : null;
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

/** Re-armed on each user turn; suspended while delegated work is pending. */
function resetIdleTimer(session) {
	clearTimeout(session.idleTimer);
	if (session.pending > 0) return;
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
		voice: true,
	});
}

/* ------------------------------------------------------------------ output */

/**
 * GPT-Live output (s16le 24 kHz mono) → Discord raw playback (s16le 48 kHz
 * stereo): 2× linear interpolation + channel duplication. Exact integer ratio,
 * so no resampler dependency.
 */
function liveToDiscord(pcm) {
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

/** True when the chunk holds sound: GPT-Live streams exact digital silence between turns. */
function hasSignal(pcm) {
	for (let i = 0; i + 1 < pcm.length; i += 2) {
		if (Math.abs(pcm.readInt16LE(i)) > 64) return true;
	}
	return false;
}

/**
 * One audio resource per spoken burst: the call streams silence between turns,
 * which is dropped, so the player goes idle and the speaking ring turns off.
 */
function playOutput(session, pcm) {
	const speech = hasSignal(pcm);
	if (!session.output) {
		if (!speech) return;
		const stream = new PassThrough();
		const resource = createAudioResource(stream, { inputType: StreamType.Raw });
		session.output = { stream, resource, silentChunks: 0 };
		session.player.play(resource);
	}
	const output = session.output;
	output.stream.write(liveToDiscord(pcm));
	output.silentChunks = speech ? 0 : output.silentChunks + 1;
	if (output.silentChunks >= END_OF_SPEECH_CHUNKS) {
		output.stream.end(); // plays out what is buffered, then the player goes idle
		session.output = null;
	}
}

/** Barge-in: drop the whole playback path, including a burst still playing out. */
function stopOutput(session) {
	session.output?.stream.destroy();
	session.output = null;
	session.player?.stop(true);
}

/* -------------------------------------------------------------- delegation */

function handleDelegation(session, call, event) {
	const id = event.item?.id;
	const text = (event.item?.content || [])
		.filter(part => part.type === 'input_text')
		.map(part => part.text)
		.join('')
		.trim();
	if (!id || !text) return;
	const { channelId } = session;
	postToChat(session, `🎙️ ${text}`);
	if (isBusy(channelId)) {
		call.appendContext(id, 'commentary', 'Queued behind another task running on this channel; starts when it ends.');
	}

	// Same live activity line as text channels, without the typing indicator.
	const channel = getClient().channels.cache.get(channelId);
	const chatProgress = channel ? startProgressReporter(channel, { typing: false }) : null;
	let lastProgress = 0;
	const onProgress = (progress) => {
		chatProgress?.update(progress);
		if (!progress?.summary || Date.now() - lastProgress < PROGRESS_MIN_INTERVAL_MS) return;
		lastProgress = Date.now();
		call.appendContext(id, 'commentary', `In progress: ${progress.summary.slice(0, 300)}`);
	};
	// A closed call ignores the append; the chat still gets the result.
	const speakResult = (result) => {
		const spoken = result.length > MAX_SPOKEN_RESULT_CHARS
			? `${result.slice(0, MAX_SPOKEN_RESULT_CHARS)}… (the rest is in the chat)`
			: result;
		call.appendContext(id, 'speakable', spoken);
	};

	const prompt = session.pending > 0 ? `${OVERLAP_NOTE}\n\n${text}` : text;
	session.pending++;
	clearTimeout(session.idleTimer);
	executePrompt(sessions.getAgent(channelId), sessions.getMode(channelId), prompt, {
		channelId,
		systemPrompt: buildVoiceSystemPrompt(session),
		tier: 'high',
		onProgress,
	})
		.then(async (result) => {
			const reply = result.result || 'Empty reply.';
			chatProgress?.clear();
			await postToChat(session, reply);
			speakResult(reply);
		})
		.catch(async (err) => {
			// `/stop` answers in the chat for itself.
			if (err.code === 'CANCELLED') {
				speakResult('The task was stopped by the user.');
				return;
			}
			log.error('voice delegation error:', err.message || err);
			const message = err.message?.slice(0, 300) || 'unknown';
			await postToChat(session, `Voice task failed: ${message}`);
			speakResult(`The task failed: ${message}`);
		})
		.finally(() => {
			chatProgress?.clear();
			session.pending--;
			if (active === session) resetIdleTimer(session);
			try {
				scheduler.reloadJobs(); // the agent may have edited a jobs file; mirrors index.js
			} catch (err) {
				log.error('voice: jobs reload failed:', err.message);
			}
		});
}

/* -------------------------------------------------------------------- call */

function handleLiveEvent(session, call, event) {
	if (active !== session || session.call !== call) return;
	switch (event.type) {
		case 'session.output_audio.delta':
			playOutput(session, Buffer.from(event.delta, 'base64'));
			break;
		case 'turn.done':
			log.info(`voice ${event.turn?.role}: ${event.turn?.transcript?.trim()}`);
			break;
		case 'turn.created':
			if (event.turn?.role !== 'user') break;
			stopOutput(session);
			resetIdleTimer(session);
			break;
		case 'delegation.created':
			handleDelegation(session, call, event);
			break;
		case 'error':
			log.warn('GPT-Live error:', JSON.stringify(event.error || event).slice(0, 300));
			break;
	}
}

async function openCall(session) {
	let call = null;
	call = await openLiveCall({
		instructions: getLiveInstructions({
			botName: session.botName,
			userName: session.userName,
			mode: sessions.getMode(session.channelId),
		}),
		onEvent: event => call && handleLiveEvent(session, call, event),
		onClose: (reason) => {
			if (active !== session || session.call !== call) return;
			log.info(`voice: GPT-Live call ended (${reason}), leaving`);
			postToChat(session, `🔇 Voice assistant left: the voice call ended (${reason}).`);
			leaveVoice();
		},
	});
	return call;
}

/**
 * `/new` and mode switches reset the channel's agent session: the call's own
 * conversation memory is reset with it. Delegations already queued keep running
 * and report to the chat only.
 */
async function restartVoiceCall(channelId) {
	const session = active;
	if (!session || session.channelId !== channelId) return;
	// Two resets in a row: only the latest one installs its call.
	const generation = ++session.callGeneration;
	const isCurrent = () => active === session && session.callGeneration === generation;
	session.call.close();
	stopOutput(session);
	try {
		const call = await openCall(session);
		if (isCurrent()) session.call = call;
		else call.close();
	} catch (err) {
		if (!isCurrent()) return;
		log.error('voice call restart failed:', err.message);
		await postToChat(session, `🔇 Voice assistant left: ${err.message.slice(0, 300)}`);
		leaveVoice();
	}
}

/* ------------------------------------------------------------------- input */

/** Forward the authorized user's Opus packets to the call as they are. */
function onSpeakingStart(session, userId) {
	if (userId !== config.AUTHORIZED_USER_ID || session.input) return;
	const stream = session.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
	session.input = stream;
	stream.on('data', packet => session.call.pushOpus(packet));
	stream.on('error', err => log.warn('voice receive error:', err.message));
	stream.on('close', () => { if (session.input === stream) session.input = null; });
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
		call: null,
		callGeneration: 0,
		player: null,
		output: null,
		input: null,
		pending: 0,
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

	try {
		session.call = await openCall(session);
	} catch (err) {
		connection.destroy();
		throw err;
	}
	// The Disconnected handler below is not installed yet during call setup.
	if (connection.state.status !== VoiceConnectionStatus.Ready) {
		session.call.close();
		connection.destroy();
		throw new Error('lost the voice channel connection while opening the voice call');
	}

	session.player = createAudioPlayer({
		behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: MAX_MISSED_FRAMES },
	});
	session.player.on('error', err => log.error('voice player error:', err.message));
	// A burst that played out, or was dropped for missing too many frames.
	session.player.on(AudioPlayerStatus.Idle, (oldState) => {
		if (session.output?.resource === oldState.resource) session.output = null;
	});
	connection.subscribe(session.player);

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

	// Implicit /new: the call starts with no memory, so the agent session starts fresh too.
	// Skipped while a task still runs there, like /new.
	if (!isBusy(session.channelId)) sessions.clearChannel(session.channelId);

	active = session;
	resetIdleTimer(session);
	return session;
}

/**
 * Tear down the active session, if any. Safe to call twice. Delegations still
 * queued or running keep going and report to the chat.
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
	session.call.close();
	session.input?.destroy();
	session.output?.stream.destroy();
	try { session.player.stop(true); } catch (_) {}
	try { session.connection.destroy(); } catch (_) {}
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
	restartVoiceCall,
	maybeAutojoin,
	clearAutojoinSuppression,
	handleVoiceStateUpdate,
	scanAutojoinOnBoot,
};
