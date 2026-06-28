const fs = require('fs');
const path = require('path');
const config = require('./config');
const { EFFORT_BY_MODEL, ADMIN_USER_HOME, STATE_DIR } = config;
const { getSystemPrompt } = require('./prompts');
const log = require('./logger');
const sessions = require('./sessions');
const { ensureImage, DOCKER_AVAILABLE } = require('./container');
const { executePrompt } = require('./executor');
const { isBusy } = require('./queue');
const { createClient, login, sendChunked, startTypingIndicator, resolveChannelName } = require('./discord');
const { handleCommand, dispatchSlashCommand, getRegisteredCommands } = require('./commands');
const { reconcileRemotes } = require('./remote');
const { transcribeVoiceMessage } = require('./stt');
const { saveUploads } = require('./uploads');
const scheduler = require('./scheduler');
const { Events, ChannelType, MessageFlags, ApplicationCommandType } = require('discord.js');

process.on('unhandledRejection', err => {
	log.error('Unhandled rejection:', err);
});
process.on('uncaughtException', err => {
	log.error('Uncaught exception:', err);
});

const client = createClient();

// Channels currently waiting for their turn in the global queue — used to
// avoid flooding a channel with multiple "⏳ waiting…" notices.
const waitingNotice = new Set();

// Threads whose first-turn starter-message fetch is in flight. Concurrent
// messages await this promise so they cannot overtake the claimant when
// enqueuing (executePrompt enqueues synchronously at call time).
const starterGate = new Map();

client.on(Events.MessageCreate, async message => {
	if (message.author.bot) return;
	// Skip system messages. Creating a thread posts a `ThreadCreated` system
	// message in the parent whose `content` is the thread NAME (not empty), so
	// it would otherwise be treated as a prompt. Also covers the thread-starter
	// crosspost and other notices. Real prompts are Default/Reply (not system).
	if (message.system) return;

	const channel = message.channel;
	const isDM = channel.type === ChannelType.DM;
	const isGuildText = channel.type === ChannelType.GuildText;
	const isPublicThread = channel.type === ChannelType.PublicThread;
	if (!isDM && !isGuildText && !isPublicThread) return;

	const content = message.content.trim();
	const isVoice = message.flags?.has(MessageFlags.IsVoiceMessage) || false;
	if (!content && !isVoice && message.attachments.size === 0) return;

	// Strict authorization: silently ignore every other user.
	if (message.author.id !== config.AUTHORIZED_USER_ID) return;

	// First contact in a public thread snapshots the parent channel's
	// mode/agent/model (not a live link); the thread keeps its own fresh session.
	// Done before commands/uploads so they already see the inherited mode.
	if (isPublicThread) sessions.ensureFromParent(channel.id, channel.parentId);

	// If the channel is in remote mode (or transitioning), a voice message is
	// just as invalid as a text prompt. Drop it BEFORE paying for Groq STT and
	// before echoing `🎙️ <transcript>` — `handleCommand` would reject it
	// anyway, but the gate there only runs after transcription.
	if (isVoice && !content && sessions.getRemoteId(channel.id)) {
		await channel.send(`\u{1F6F0}️ This channel is in remote mode — voice messages are ignored. Send \`/remote\` to return to Discord mode.`).catch(() => {});
		return;
	}

	// Voice message → transcription via Groq Whisper. Text wins if both present.
	let prompt = content;
	if (!prompt && isVoice) {
		if (!config.GROQ_API_KEY) {
			log.warn('Voice message received but GROQ_API_KEY not set, ignoring');
			return;
		}
		const audio = message.attachments.find(a => a.contentType?.startsWith('audio/'));
		if (!audio) return;
		try {
			prompt = (await transcribeVoiceMessage(audio, {
				apiKey: config.GROQ_API_KEY,
				model: config.STT_MODEL,
				language: config.STT_LANGUAGE,
			})).trim();
			if (!prompt) return;
			await message.channel.send(`🎙️ ${prompt}`).catch(() => {});
		} catch (err) {
			log.error('STT failed:', err.message);
			await message.channel.send(`Transcription failed: ${err.message?.slice(0, 200) || 'unknown'}`).catch(() => {});
			return;
		}
	}

	// File/photo upload (not a voice message, whose lone attachment is the audio
	// handled by STT above). We persist the files and echo their names. When the
	// message also carries text, the files are saved first — same echo as an
	// upload-only message — and then the text is processed as a normal prompt so
	// the agent can reference them. With no text, the upload does NOT invoke the
	// agent: we just persist the files for a later message. Placed before
	// handleCommand so uploads work even in /remote mode (they don't spawn the
	// agent; the files become available to the mobile session too).
	if (!isVoice && message.attachments.size > 0) {
		try {
			const saved = await saveUploads([...message.attachments.values()], sessions.getMode(channel.id));
			const list = saved.map(n => `\`${n}\``).join(', ');
			await channel.send(`📎 Received ${saved.length} file(s): ${list}`).catch(() => {});
		} catch (err) {
			log.error('Upload failed:', err.message);
			await channel.send(`Upload failed: ${err.message?.slice(0, 200) || 'unknown'}`).catch(() => {});
			return;
		}
		// Upload-only: done, the agent is not invoked. With text, fall through and
		// process the message as a normal prompt.
		if (!prompt) return;
	}

	// Commands first (they manage their own responses).
	if (await handleCommand(message)) return;

	const channelId = channel.id;
	// In a public thread, show both the parent channel name and the thread name
	// in the system prompt; the topic falls back to the parent's (threads have none).
	// The parent is normally cached (Guilds intent), but fetch it by parentId as a
	// fallback so an uncached parent doesn't degrade the name/topic to <unknown>.
	let parentChannel = null;
	if (isPublicThread) {
		parentChannel = channel.parent;
		if (!parentChannel && channel.parentId) {
			try { parentChannel = await client.channels.fetch(channel.parentId); }
			catch (err) { log.warn(`Failed to fetch thread parent ${channel.parentId}: ${err.message}`); }
		}
	}
	const threadName = isPublicThread ? resolveChannelName(channel) : null;
	const channelName = isPublicThread
		? (parentChannel ? resolveChannelName(parentChannel) : '<unknown>')
		: resolveChannelName(channel);
	sessions.setLastName(channelId, threadName || channelName);

	const mode = sessions.getMode(channelId);
	const agent = sessions.getAgent(channelId);
	const model = sessions.getModel(channelId);
	const botName = client.user.displayName || client.user.username;
	const userName = message.author.displayName || message.author.username;
	const channelTopic = isPublicThread
		? (parentChannel?.topic || null)
		: (!isDM ? (channel.topic || null) : null);

	// On a thread's very first turn, if it was created FROM an existing message,
	// prepend that anchor message as quoted context — otherwise the message the
	// thread forks from is invisible (it lives in the parent and shows up in the
	// thread only as a dropped system message). First turn only (sessionId still
	// null), so it enters the conversation history and persists across --resume.
	//
	// Two guards make this race-safe against rapid concurrent first-turn messages
	// (sessionId stays null until the first run completes):
	//   - sessions.claimStarter() — synchronous atomic per-channel claim, so the
	//     anchor is injected at most once.
	//   - starterGate — while the claimant awaits fetchStarterMessage(), siblings
	//     await the same promise instead of racing ahead, so they cannot enqueue
	//     before it (executePrompt enqueues synchronously at call time).
	if (isPublicThread) {
		const pendingStarter = starterGate.get(channelId);
		if (pendingStarter) {
			await pendingStarter;
		} else if (!sessions.getSession(channelId).sessionId && sessions.claimStarter(channelId)) {
			let releaseStarter;
			starterGate.set(channelId, new Promise(r => { releaseStarter = r; }));
			try {
				const starter = await channel.fetchStarterMessage();
				const starterText = starter?.content?.trim();
				if (starterText) {
					const starterAuthor = starter.author?.id === client.user.id
						? botName
						: (starter.author?.displayName || starter.author?.username || 'someone');
					prompt = `[This thread was created from the following message by ${starterAuthor}:]\n${starterText}\n\n[Message:]\n${prompt}`;
				}
			} catch (err) {
				// Standalone thread (no anchor) or deleted anchor → Unknown Message (10008): ignore.
				if (err.code !== 10008) log.warn(`fetchStarterMessage failed for thread ${channelId}: ${err.message}`);
			} finally {
				starterGate.delete(channelId);
				releaseStarter();
			}
		}
	}

	// sessionId is resolved inside executor.executePrompt, inside the global
	// queue, so back-to-back messages cannot race before the first generated
	// UUID has been persisted.
	const promptOptions = {
		channelId,
		systemPrompt: getSystemPrompt({
			botName,
			userName,
			mode,
			channelId,
			channelName,
			threadName,
			channelTopic,
			isDM,
			channelAgent: agent,
			channelModel: model,
		}),
		model,
		effort: EFFORT_BY_MODEL[model],
	};

	// Surface the wait once per channel if another prompt is already running.
	if (isBusy() && !waitingNotice.has(channelId)) {
		waitingNotice.add(channelId);
		channel.send('\u23F3 Waiting for previous prompt...').catch(() => {});
	}

	let stopTyping = null;
	try {
		stopTyping = startTypingIndicator(channel);
		const result = await executePrompt(agent, mode, prompt, promptOptions);

		stopTyping();
		stopTyping = null;

		const agentLabel = agent === 'codex' ? 'Codex' : 'Claude Code';
		const responseText = result.result || `Empty response from ${agentLabel}.`;
		await sendChunked(channel, responseText);
	} catch (err) {
		if (stopTyping) stopTyping();

		log.error('Message handling error:', err.message || err);

		let errMsg;
		if (err.code === 124) {
			errMsg = `${agent === 'codex' ? 'Codex' : 'Claude Code'} took too long, timeout!`;
		} else if (err.code === 'SANDBOX_REMOTE_ACTIVE') {
			errMsg = '\u{1F6F0}️ A sandbox `/remote` session is active on another channel — sandbox prompts are paused until it stops.';
		} else if (err.code === 'CODEX_NOT_AVAILABLE') {
			errMsg = `Codex is not installed or no longer available in **${mode}** mode.`;
		} else if (err.code === 'CODEX_NOT_AUTHENTICATED') {
			errMsg = 'Codex authentication failed. Run `codex login` on the host.';
		} else if (err.code === 'CHANNEL_CONTEXT_CHANGED') {
			errMsg = 'Channel mode or agent changed while this message was waiting. Send it again.';
		} else if (err.message === 'Docker is not installed on this host') {
			errMsg = 'Docker is not installed — switch this channel to admin mode with `/admin`.';
		} else {
			const agentLabel = agent === 'codex' ? 'Codex' : 'Claude Code';
			errMsg = `${agentLabel} error: ${err.message?.slice(0, 300) || 'unknown'}`;
		}
		await channel.send(errMsg).catch(e => log.error('Failed to send error message:', e));
	} finally {
		waitingNotice.delete(channelId);
		// Claude may have edited a jobs file even if the prompt errored — reload
		// so the scheduler picks it up immediately rather than on the next prompt.
		scheduler.reloadJobs();
	}
});

// Routes a command handler's `channel.send(...)` calls onto a SINGLE non-ephemeral
// interaction response: the first send becomes the reply (Discord renders the
// persistent "user used /command" marker above it), later sends become follow-ups.
// A 2s safety net defers — only the few slow commands reach it — so the 3s ack
// window is respected while fast commands reply directly, with no "thinking"
// placeholder. The 15-min token lifetime bounds how long a command may run.
function makeInteractionResponder(interaction) {
	const realChannel = interaction.channel;
	let acked = false;        // an initial response (reply or defer) was sent
	let deferred = false;
	let firstFilled = false;  // the deferred placeholder has received its content
	let deferPromise = null;
	let broken = false;       // interaction unusable → fall back to the real channel

	const deferTimer = setTimeout(() => {
		if (acked || broken) return;
		acked = true; deferred = true;
		deferPromise = interaction.deferReply().then(() => {}, () => { broken = true; });
	}, 2000);

	// Post `text` through the interaction, falling back to a plain channel message if
	// the interaction can no longer be used: the 15-min token may expire while a
	// command sits in the global queue (a long agent prompt can hold it ~20 min), and
	// any reply/edit/follow-up may fail. The fallback only loses the "used /command"
	// grouping — output is never dropped.
	const send = async (text) => {
		if (broken) { await realChannel.send(text); return; }
		try {
			if (!acked) {
				acked = true;
				clearTimeout(deferTimer);
				await interaction.reply({ content: text });
				firstFilled = true;
				return;
			}
			if (deferPromise) await deferPromise;   // let an in-flight defer settle first
			if (broken) { await realChannel.send(text); return; }
			if (deferred && !firstFilled) {
				firstFilled = true;
				await interaction.editReply({ content: text });
				return;
			}
			await interaction.followUp({ content: text });
		} catch (err) {
			broken = true;
			await realChannel.send(text).catch(() => {});
		}
	};

	const finish = async () => {
		clearTimeout(deferTimer);
		if (deferPromise) await deferPromise;
		if (broken || firstFilled) return;
		if (!acked) {                  // handler sent nothing, fast → ack so it doesn't error
			acked = true;
			await interaction.reply({ content: '✅' }).catch(() => {});
		} else if (deferred) {         // deferred but nothing sent → clear the placeholder
			await interaction.editReply({ content: '✅' }).catch(() => {});
		}
	};

	return { send, finish };
}

// Slash-command interactions (Discord Application Commands). This listener is the
// Discord adapter: all Discord-specific plumbing lives here — authorization and the
// interaction→response translation. Handler output is routed into the interaction's
// own non-ephemeral response (via a channel Proxy whose `.send` maps to the
// responder), so the channel shows Discord's persistent "user used /command" marker
// + the result in one block, with no "thinking" on fast commands. The neutral
// gate+dispatch lives in commands.js (dispatchSlashCommand), shared with the text
// path, so commands.js stays free of any discord.js dependency.
client.on(Events.InteractionCreate, async interaction => {
	if (!interaction.isChatInputCommand()) return;

	// Same strict authorization as the message path. Interactions must be acked, so
	// reply ephemerally (errors stay private) instead of silently dropping.
	if (interaction.user.id !== config.AUTHORIZED_USER_ID) {
		await interaction.reply({ content: '⛔ Not authorized.', flags: MessageFlags.Ephemeral }).catch(() => {});
		return;
	}
	if (!interaction.channel) {
		await interaction.reply({ content: 'Channel unavailable.', flags: MessageFlags.Ephemeral }).catch(() => {});
		return;
	}

	// Inherit the parent channel's mode/agent/model on first contact in a thread,
	// exactly like the message path does before dispatching commands.
	if (interaction.channel.isThread?.()) sessions.ensureFromParent(interaction.channelId, interaction.channel.parentId);

	const responder = makeInteractionResponder(interaction);
	// Proxy the real channel so resolveChannelName() (and any other property) still
	// resolves against it, but `.send` routes to the interaction response.
	const channel = new Proxy(interaction.channel, {
		get(target, prop) {
			if (prop === 'send') return responder.send;
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});

	try {
		await dispatchSlashCommand({ channel, channelId: interaction.channelId, name: `/${interaction.commandName}` });
	} catch (err) {
		log.error('InteractionCreate error:', err.message || err);
		await responder.send(`Command error: ${err.message?.slice(0, 200) || 'unknown'}`).catch(() => {});
	} finally {
		await responder.finish().catch(() => {});
	}
});

client.on(Events.ClientReady, async () => {
	log.info(`Connected as ${client.user.tag}`);
	try { await registerSlashCommands(); } catch (err) { log.warn('registerSlashCommands failed:', err.message); }
	try { await purgeInvalidChannels(); } catch (err) { log.warn('purgeInvalidChannels failed:', err.message); }
	scheduler.start();
});

// Map the neutral command metadata (commands.js) to Discord's Application Command
// shape and bulk-overwrite the global commands. The Discord-specific shape lives
// here, not in commands.js. Idempotent: Discord only mutates what actually changed,
// so this is safe on every boot. Names are lowercased (Discord constraint);
// descriptions clamped to 100 chars; dmPermission keeps them usable in DMs. Global
// scope covers guild channels + DMs; first-time propagation can take up to ~1h.
async function registerSlashCommands() {
	const data = getRegisteredCommands().map(c => ({
		name: c.name.slice(1).toLowerCase(),
		description: c.help.length > 100 ? `${c.help.slice(0, 99)}…` : c.help,
		type: ApplicationCommandType.ChatInput,
		dmPermission: true,
	}));
	await client.application.commands.set(data);
	log.info(`Registered ${data.length} global slash command(s)`);
}

// Remove sessions.json entries whose Discord channel no longer exists (channel
// deleted, bot kicked from guild, etc.). Strict on the error code: only
// `Unknown Channel` (10003) triggers removal — transient errors (network,
// rate limit, permissions) are skipped so a flaky boot doesn't nuke valid
// entries. Runs after login (needs the gateway) and after reconcileRemotes
// (which would otherwise lose its handle on stale remote agents). Scheduled
// jobs attached to a purged channel are intentionally left alone — the user
// manages job lifecycle by hand.
async function purgeInvalidChannels() {
	const ids = sessions.listChannelIds();
	if (ids.length === 0) return;
	const removed = [];
	for (const id of ids) {
		try {
			await client.channels.fetch(id);
		} catch (err) {
			if (err.code === 10003) {
				sessions.removeChannel(id);
				removed.push(id);
			} else {
				log.warn(`purgeInvalidChannels: skip ${id} (${err.message})`);
			}
		}
	}
	if (removed.length) log.info(`purgeInvalidChannels: removed ${removed.length} stale channel(s): ${removed.join(', ')}`);
}

function shutdown(signal) {
	log.info(`Received ${signal}, shutting down...`);
	scheduler.stop();
	client.destroy();
	process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
	fs.mkdirSync(path.join(ADMIN_USER_HOME, STATE_DIR), { recursive: true });
	sessions.load();
	if (DOCKER_AVAILABLE) {
		try { ensureImage(); } catch (err) { log.warn('ensureImage failed:', err.message); }
	} else {
		log.warn('Starting without Docker — sandbox mode disabled');
	}
	// Settle any remote sessions persisted from a previous run before going live.
	try { await reconcileRemotes(); } catch (err) { log.warn('reconcileRemotes failed:', err.message); }
	await login();
}

start().catch(err => {
	log.error('Failed to start:', err);
	process.exit(1);
});
