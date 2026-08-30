const fs = require('fs');
const path = require('path');
const config = require('./config');
const { ADMIN_USER_HOME, STATE_DIR, ADMIN_JOBS_FILE, ADMIN_FILES_DIR, SANDBOX_FILES_DIR } = config;
const { ensureDb } = require('./jobs-store');
const { getSystemPrompt } = require('./prompts');
const log = require('./logger');
const sessions = require('./sessions');
const { ensureImage, DOCKER_AVAILABLE } = require('./container');
const { executePrompt } = require('./executor');
const { isBusy } = require('./queue');
const { createClient, login, sendChunked, startTypingIndicator, startProgressReporter, resolveChannelName } = require('./discord');
const { handleCommand, dispatchSlashCommand, getRegisteredCommands } = require('./commands');
const { reconcileRemotes } = require('./remote');
const { transcribeVoiceMessage } = require('./stt');
const { leaveVoice, handleVoiceStateUpdate, scanAutojoinOnBoot } = require('./voice');
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

// One "⏳ waiting…" notice per channel, not one per queued message.
const waitingNotice = new Set();

// Threads whose starter-message fetch is in flight. Siblings await it so they
// cannot overtake the claimant (executePrompt enqueues synchronously).
const starterGate = new Map();

client.on(Events.MessageCreate, async message => {
	if (message.author.bot) return;
	// Creating a thread posts a ThreadCreated system message whose `content` is
	// the thread NAME, which would otherwise be treated as a prompt.
	if (message.system) return;

	const channel = message.channel;
	const isDM = channel.type === ChannelType.DM;
	const isGuildText = channel.type === ChannelType.GuildText;
	const isPublicThread = channel.type === ChannelType.PublicThread;
	// A voice channel's built-in text chat shares the voice channel's ID.
	const isGuildVoice = channel.type === ChannelType.GuildVoice;
	if (!isDM && !isGuildText && !isPublicThread && !isGuildVoice) return;

	const content = message.content.trim();
	const isVoice = message.flags?.has(MessageFlags.IsVoiceMessage) || false;
	if (!content && !isVoice && message.attachments.size === 0) return;

	// Strict authorization: silently ignore every other user.
	if (message.author.id !== config.AUTHORIZED_USER_ID) return;

	// Before commands/uploads, so they see the inherited mode.
	if (isPublicThread) sessions.ensureFromParent(channel.id, channel.parentId);

	// Drop before paying for Groq STT: handleCommand would reject it anyway, but
	// only after transcription.
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

	// Before handleCommand, so uploads work in /remote mode too (they spawn no
	// agent). A voice message's lone attachment is the audio, handled by STT above.
	if (!isVoice && message.attachments.size > 0) {
		const uploadMode = sessions.getMode(channel.id);
		try {
			const saved = await saveUploads([...message.attachments.values()], uploadMode);
			const list = saved.map(n => `\`${n}\``).join(', ');
			await channel.send(`📎 Received ${saved.length} file(s): ${list}`).catch(() => {});
			if (prompt) {
				// Paths as the agent sees them, so it reads the file instead of
				// searching for the name.
				const dir = uploadMode === 'sandbox' ? SANDBOX_FILES_DIR : ADMIN_FILES_DIR;
				const paths = saved.map(n => `${dir}/${n}`).join('\n');
				prompt = `[Files attached to this message:]\n${paths}\n\n[Message:]\n${prompt}`;
			}
		} catch (err) {
			log.error('Upload failed:', err.message);
			await channel.send(`Upload failed: ${err.message?.slice(0, 200) || 'unknown'}`).catch(() => {});
			return;
		}
		if (!prompt) return; // upload-only: the agent is not invoked
	}

	// Commands first (they manage their own responses).
	if (await handleCommand(message)) return;

	const channelId = channel.id;
	// Threads have no topic of their own, so both name and topic fall back to the
	// parent. Normally cached (Guilds intent); fetch as a fallback.
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
	const botName = client.user.displayName || client.user.username;
	const userName = message.author.displayName || message.author.username;
	const channelTopic = isPublicThread
		? (parentChannel?.topic || null)
		: (!isDM ? (channel.topic || null) : null);

	// On a thread's first turn, prepend the message it was forked from — it lives
	// in the parent and reaches the thread only as a dropped system message.
	// claimStarter + starterGate make this race-safe against concurrent first
	// turns, which all see a null sessionId.
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

	// sessionId is resolved inside executePrompt, within the channel queue, so
	// back-to-back messages cannot race the first generated UUID.
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
		}),
		tier: 'high',
	};

	// Surface the wait once per channel if another prompt is already running.
	if (isBusy(channelId) && !waitingNotice.has(channelId)) {
		waitingNotice.add(channelId);
		channel.send('\u23F3 Waiting for previous prompt...').catch(() => {});
	}

	let stopTyping = null;
	const progress = startProgressReporter(channel);
	try {
		stopTyping = startTypingIndicator(channel);
		const result = await executePrompt(agent, mode, prompt, { ...promptOptions, onProgress: progress.update });

		stopTyping();
		stopTyping = null;
		// Before the answer, not in the finally: the progress line has nothing
		// left to report, and clearing it afterwards would leave it standing next
		// to the reply it was describing.
		progress.clear();

		const agentLabel = agent === 'codex' ? 'Codex' : 'Claude Code';
		const responseText = result.result || `Empty response from ${agentLabel}.`;
		await sendChunked(channel, responseText);
	} catch (err) {
		if (stopTyping) stopTyping();

		// A cancel is an operator decision, not a fault.
		if (err.code === 'CANCELLED') log.info('Prompt stopped by the user');
		else log.error('Message handling error:', err.message || err);

		let errMsg;
		if (err.code === 'CODEX_NOT_AVAILABLE') {
			errMsg = `Codex is not installed or no longer available in **${mode}** mode.`;
		} else if (err.code === 'CODEX_NOT_AUTHENTICATED') {
			errMsg = 'Codex authentication failed. Select Codex in this channel and run `/login`.';
		} else if (err.code === 'CANCELLED') {
			// `/stop` answers for itself, once the process is really gone.
			errMsg = null;
		} else if (err.code === 'CHANNEL_CONTEXT_CHANGED') {
			errMsg = 'Channel mode or agent changed while this message was waiting. Send it again.';
		} else if (err.message === 'Docker is not installed on this host') {
			errMsg = 'Docker is not installed — switch this channel to admin mode with `/admin`.';
		} else {
			const agentLabel = agent === 'codex' ? 'Codex' : 'Claude Code';
			errMsg = `${agentLabel} error: ${err.message?.slice(0, 300) || 'unknown'}`;
		}
		if (errMsg) await channel.send(errMsg).catch(e => log.error('Failed to send error message:', e));
	} finally {
		progress.clear();
		if (!isBusy(channelId)) waitingNotice.delete(channelId);
		scheduler.reloadJobs(); // the agent may have edited a jobs file, even on error
	}
});

// Routes a handler's channel.send() calls onto one non-ephemeral interaction
// response: first send → reply, later ones → follow-ups. A 2 s timer defers so
// Discord's 3 s ack window holds, without a "thinking" placeholder on fast
// commands. The 15-min token lifetime bounds a command's runtime.
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

	// Falls back to a plain channel message once the interaction is unusable: the
	// 15-min token can expire while a command waits in an execution queue. The
	// fallback only loses the "used /command" grouping — output is never dropped.
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

// Discord adapter for slash commands: authorization and interaction→response
// translation live here, the neutral dispatch in commands.js.
client.on(Events.InteractionCreate, async interaction => {
	if (!interaction.isChatInputCommand()) return;

	// Interactions must be acked, so reject ephemerally rather than drop silently.
	if (interaction.user.id !== config.AUTHORIZED_USER_ID) {
		await interaction.reply({ content: '⛔ Not authorized.', flags: MessageFlags.Ephemeral }).catch(() => {});
		return;
	}
	if (!interaction.channel) {
		await interaction.reply({ content: 'Channel unavailable.', flags: MessageFlags.Ephemeral }).catch(() => {});
		return;
	}

	// Like the message path, before dispatching.
	if (interaction.channel.isThread?.()) sessions.ensureFromParent(interaction.channelId, interaction.channel.parentId);

	const responder = makeInteractionResponder(interaction);
	// Property reads still resolve against the real channel; only .send is routed.
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

// Autojoin adapter: voice.js owns the policy. discord.js does not await
// handlers, so the rejection must be caught here.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
	handleVoiceStateUpdate(oldState, newState)
		.catch(err => log.error('voiceStateUpdate error:', err.message || err));
});

client.on(Events.ClientReady, async () => {
	log.info(`Connected as ${client.user.tag}`);
	try { await registerSlashCommands(); } catch (err) { log.warn('registerSlashCommands failed:', err.message); }
	try { await purgeInvalidChannels(); } catch (err) { log.warn('purgeInvalidChannels failed:', err.message); }
	// After purgeInvalidChannels: never try to join a channel that just got pruned.
	try { await scanAutojoinOnBoot(); } catch (err) { log.warn('scanAutojoinOnBoot failed:', err.message); }
	scheduler.start();
});

// Bulk-overwrite the global commands from commands.js's neutral metadata.
// Idempotent, so it is safe on every boot. Discord constraints: lowercase names,
// descriptions ≤ 100 chars. First-time propagation can take up to ~1h.
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

// Drop sessions.json entries whose channel no longer exists. Strict on the error
// code: only Unknown Channel (10003) removes, so a flaky boot cannot nuke valid
// entries. Removing an entry takes its non-isolated jobs with it (sessions.js
// observer); its isolated jobs are left alone — the user manages their lifecycle.
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
	try { leaveVoice(); } catch (_) {}
	client.destroy();
	process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
	fs.mkdirSync(path.join(ADMIN_USER_HOME, STATE_DIR), { recursive: true });
	// Also fail-fast when the sqlite3 CLI is missing (spawn ENOENT aborts boot).
	ensureDb(ADMIN_JOBS_FILE);
	sessions.load();
	// After load(), which rebuilds entries in place and must not trigger cleanups.
	sessions.onSessionCleared(scheduler.handleSessionCleared);
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
