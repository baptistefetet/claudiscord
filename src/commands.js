const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const {
	UPGRADE_TIMEOUT_MS,
	STOP_REPORT_TIMEOUT_MS,
	SANDBOX_HOST_HOME,
} = require('./config');
const sessions = require('./sessions');
const {
	ensureContainer,
	DOCKER_AVAILABLE,
	isCodexAvailableInContainer,
	getSandboxVersions,
} = require('./container');
const { CODEX_AVAILABLE, getCodexUsage, getCodexVersion } = require('./codex');
const { getClaudeUsage, getClaudeVersion } = require('./claude');
const { handleLogin, finishPendingLogin } = require('./login');
const { handleShell } = require('./shell');
const { runMaintenance, isBusy, stopRun } = require('./queue');
const { startRemote, stopRemote } = require('./remote');
const {
	isVoiceModeAvailable,
	isSupportedVoiceChannel,
	getActiveVoiceChannelId,
	joinVoice,
	leaveVoice,
	maybeAutojoin,
	clearAutojoinSuppression,
} = require('./voice');
const { getClient, resolveChannelName, sendChunked } = require('./discord');
const { handleDiff, finishPendingDepotPath, cancelPendingDepotPath } = require('./diff');
const { listSkills } = require('./skills');
const { loadAllJobs } = require('./jobs-store');
const scheduler = require('./scheduler');
const log = require('./logger');

const UPDATE_SANDBOX_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'update-sandbox.sh');

// Per-channel lock for a whole `/remote` toggle. `remoteId` is not set until the
// spawn completes, so without it a concurrent message would pass the remote gate,
// and two back-to-back toggles would both take the start branch.
const remoteOpInFlight = new Set();

/**
 * Multi-line rendering of a scheduled job for the /jobs command.
 * Header line with id, then one piece of information per line.
 */
function formatJobBlock(job) {
	// Derived, not stored: a job runs on whatever agent its channel is set to now.
	const agent = sessions.getAgent(job.channelId);
	const runs = (typeof job.remaining === 'number' && job.remaining > 0) ? `${job.remaining} left` : 'infinite';
	const channel = job.channelName || job.channelId;
	const last = job.lastRun ? `${String(job.lastRun).replace('T', ' ').slice(0, 16)} UTC` : 'never';
	const lines = [
		`**\`${job.id}\`**`,
		`⏰ Schedule: \`${job.cron}\``,
		`🤖 Agent: ${agent} (channel's current)`,
		`💬 Channel: ${channel}`,
		`🔁 Runs: ${runs}`,
		`🕘 Last run: ${last}`,
	];
	// Shown only for the exception, so the common case stays compact.
	if (!job.isolated) lines.push('🧵 Session: channel conversation');
	if (job.description) {
		let d = String(job.description).replace(/\s+/g, ' ').trim();
		if (d.length > 150) d = d.slice(0, 149) + '…';
		lines.push(`📝 ${d}`);
	}
	return lines.join('\n');
}

/**
 * /remote — toggle the channel between Discord mode and Claude-mobile remote mode.
 * Claude-only. Holds a per-channel lock for the whole toggle (see remoteOpInFlight).
 */
async function handleRemote({ channel, channelId, mode, agent, remoteId }) {
	if (agent !== 'claude') {
		await channel.send('`/remote` is only available with the **claude** agent. Use `/claude` first.');
		return true;
	}
	// Hold the per-channel lock for the entire toggle. The gating above
	// honours it, so the channel stays inert until the transition settles.
	if (remoteOpInFlight.has(channelId)) {
		await channel.send('⏳ A `/remote` toggle is already in progress for this channel.');
		return true;
	}
	remoteOpInFlight.add(channelId);
	try {
		const existing = remoteId;
		if (existing) {
			if (isBusy()) {
				await channel.send('⏳ An execution or maintenance operation is running. Retry `/remote` when the bot is idle.');
				return true;
			}
			let stoppedCleanly = false;
			try {
				stoppedCleanly = await runMaintenance(
					() => stopRemote({ mode, remoteId: existing }),
				);
			} catch (err) {
				log.error('remote stop error:', err.message);
			}
			sessions.setRemoteId(channelId, null);
			// Claude may have edited a jobs file during the mobile session — and
			// we did NOT go through executor.js, so reload jobs here.
			scheduler.reloadJobs();
			const suffix = stoppedCleanly ? '' : ' (stop reported an error, state cleared)';
			await channel.send(`Back to Discord mode. The next message starts a fresh conversation${suffix}.`);
			return true;
		}

		if (mode === 'sandbox' && !DOCKER_AVAILABLE) {
			await channel.send('Sandbox is not available — `/remote` requires either admin mode or a working sandbox.');
			return true;
		}

		const channelName = resolveChannelName(channel);
		if (isBusy()) {
			await channel.send('⏳ An execution or maintenance operation is running. Retry `/remote` when the bot is idle.');
			return true;
		}
		try {
			const agentId = await runMaintenance(async () => {
				if (mode === 'sandbox') ensureContainer();
				// Hand the existing Discord session to `claude --bg --resume`
				// so the mobile user starts with the channel's history. Read
				// BEFORE setRemoteId, which wipes the sessionId.
				const { sessionId } = sessions.getSession(channelId);
				const id = await startRemote({ mode, sessionId, channelName });
				sessions.setRemoteId(channelId, id);
				return id;
			});
			await channel.send(`\u{1F6F0}️ Remote control enabled for **${channelName}** (agent \`${agentId}\`). Open the Claude mobile app to continue. Send \`/remote\` again to return to Discord mode.`);
		} catch (err) {
			log.error('remote start error:', err.message);
			await channel.send(`Remote start failed: ${err.message.slice(0, 300)}`);
		}
		return true;
	} finally {
		remoteOpInFlight.delete(channelId);
	}
}

/**
 * /usage — Claude and Codex account usage for the current mode.
 */
async function handleUsage({ channel, mode }) {
	const [claudeUsage, codexUsage] = await Promise.all([
		getClaudeUsage(mode),
		getCodexUsage(mode),
	]);
	const modeLabel = mode === 'sandbox' ? 'sandbox' : 'host';
	// Relative reset hint: "resets in 1h47" or "resets in 4d 6h" for the weekly window.
	const fmtReset = (iso) => {
		if (!iso) return '';
		const ms = new Date(iso).getTime() - Date.now();
		if (!Number.isFinite(ms) || ms <= 0) return '';
		const totalMin = Math.floor(ms / 60000);
		const d = Math.floor(totalMin / 1440);
		const h = Math.floor((totalMin % 1440) / 60);
		const m = totalMin % 60;
		const span = d ? `${d}d ${h}h` : `${h}h${String(m).padStart(2, '0')}`;
		return ` (resets in ${span})`;
	};
	const formatUsage = (label, usage, reasons) => {
		if (!usage.available) {
			return `📊 **${label} usage**\n▫️ ${reasons[usage.reason] || reasons.error}`;
		}
		const lines = [`📊 **${label} usage**`];
		if (Number.isFinite(usage.fiveHour)) {
			lines.push(`▫️ 5h window: **${Math.round(usage.fiveHour)}%**${fmtReset(usage.fiveHourResetAt)}`);
		}
		if (Number.isFinite(usage.weekly)) {
			lines.push(`▫️ Weekly: **${Math.round(usage.weekly)}%**${fmtReset(usage.weeklyResetAt)}`);
		}
		return lines.join('\n');
	};
	const claudeReasons = {
		'no-oauth': 'Not available (no OAuth credentials in this environment).',
		expired: `Authentication expired.`,
		error: 'Unavailable right now.',
	};
	const codexReasons = {
		'no-cli': 'The Codex CLI is not installed in this environment.',
		'no-subscription': 'Not available (API-key auth, no subscription window).',
		expired: `Authentication expired.`,
		error: 'Unavailable right now.',
	};
	await channel.send([
		formatUsage(`Claude (${modeLabel})`, claudeUsage, claudeReasons),
		formatUsage(`Codex (${modeLabel})`, codexUsage, codexReasons),
	].join('\n\n'));
	return true;
}

/**
 * /stop — terminate the agent process running in this channel.
 *
 * Deliberately outside the queue and outside `runMaintenance`: both refuse to
 * act while an execution is pending, which is the only state where `/stop` has
 * anything to do.
 *
 * One message, sent once the process is actually gone rather than when the
 * signal goes out — the callers whose run was cancelled stay quiet about it so
 * this is the only reply. The killed run rejects as CANCELLED, so the channel
 * session survives and the next message resumes the conversation.
 */
async function handleStop({ channel, channelId }) {
	const run = stopRun(channelId);
	if (!run) {
		await channel.send('Nothing is running in this channel.');
		return true;
	}
	// SIGKILL lands at KILL_GRACE_MS, so this only expires if the process is
	// unkillable (uninterruptible sleep, a wedged Docker daemon). Saying so beats
	// claiming a stop that did not happen.
	const gaveUp = Symbol('gaveUp');
	const timer = new Promise(resolve => setTimeout(() => resolve(gaveUp), STOP_REPORT_TIMEOUT_MS));
	const outcome = await Promise.race([run.settled, timer]);
	await channel.send(outcome === gaveUp
		? `⏹️ Signalled ${run.label}, but it has not exited yet. Check the service logs.`
		: `⏹️ Stopped ${run.label} — ${run.note}.`);
	return true;
}

/**
 * /version — Claude and Codex CLI versions. One line per agent: the sandbox
 * bind-mounts the host binaries, so both environments run the same build. The
 * sandbox is still probed, and reported only when it disagrees — that
 * disagreement is the symptom of every way the mounts can break.
 */
async function handleVersion({ channel }) {
	const [claude, codex] = await Promise.all([getClaudeVersion(), getCodexVersion()]);
	const fmt = (version) => (version ? `\`${version}\`` : '_unavailable_');
	const lines = [`▫️ Claude: ${fmt(claude)}`, `▫️ Codex: ${fmt(codex)}`];

	if (DOCKER_AVAILABLE) {
		const sandbox = await getSandboxVersions();
		if (sandbox.error) {
			lines.push(`⚠️ Sandbox unreachable: ${sandbox.error}`);
		} else {
			if (sandbox.claude !== claude) lines.push(`⚠️ Sandbox Claude: ${fmt(sandbox.claude)}`);
			if (sandbox.codex !== codex) lines.push(`⚠️ Sandbox Codex: ${fmt(sandbox.codex)}`);
		}
	}

	await channel.send(lines.join('\n'));
	return true;
}

/**
 * /skills — skill names of both agents in both environments, whatever the
 * channel's mode is.
 */
async function handleSkills({ channel }) {
	const line = (label, names) => {
		if (names === null) return `▫️ ${label}: _unavailable_`;
		if (names.length === 0) return `▫️ ${label}: _none_`;
		return `▫️ ${label} (${names.length}): ${names.map(n => `\`${n}\``).join(', ')}`;
	};
	await sendChunked(channel, [
		'🖥️ **Admin**',
		line('Claude', listSkills('claude', 'admin')),
		line('Codex', listSkills('codex', 'admin')),
		'',
		'📦 **Sandbox**',
		...(SANDBOX_HOST_HOME
			? [line('Claude', listSkills('claude', 'sandbox')), line('Codex', listSkills('codex', 'sandbox'))]
			: ['▫️ Sandbox home is not configured.']),
	].join('\n'));
	return true;
}

/**
 * /jobs — list all scheduled jobs (admin first, then sandbox).
 */
async function handleJobs({ channel }) {
	const all = loadAllJobs();
	const admin = all.filter(j => j.mode === 'admin');
	const sandbox = all.filter(j => j.mode === 'sandbox');
	if (admin.length === 0 && sandbox.length === 0) {
		await channel.send('No scheduled jobs.');
		return true;
	}
	const section = (title, jobs) =>
		`${title} (${jobs.length})\n${jobs.length ? jobs.map(formatJobBlock).join('\n\n') : '_none_'}`;
	const out = [
		section('🖥️ **Admin jobs**', admin),
		section('📦 **Sandbox jobs**', sandbox),
	].join('\n\n');
	await sendChunked(channel, out);
	return true;
}

/**
 * /upgrade — sandbox only. Update the container's apt packages (the agents
 * themselves are bind-mounted from the host, see container.js).
 * Runs as global maintenance so apt never swaps a library mid-prompt.
 */
async function handleUpgrade({ channel, mode }) {
	if (mode !== 'sandbox') {
		await channel.send('`/upgrade` is only available in sandbox mode.');
		return true;
	}
	if (!DOCKER_AVAILABLE) {
		await channel.send('Docker is not installed — cannot upgrade.');
		return true;
	}
	if (sessions.hasActiveSandboxRemote()) {
		await channel.send('🛰️ A sandbox `/remote` session is active — stop it before upgrading the container.');
		return true;
	}
	if (isBusy()) {
		await channel.send('⏳ An execution or maintenance operation is running. Retry `/upgrade` when the bot is idle.');
		return true;
	}
	await runMaintenance(async () => {
		try {
			ensureContainer();
			await execFileAsync(UPDATE_SANDBOX_SCRIPT, [], {
				encoding: 'utf8',
				timeout: UPGRADE_TIMEOUT_MS,
			});
			await channel.send('Container updated.');
		} catch (err) {
			log.error('Upgrade error:', err.message);
			await channel.send(`Upgrade error: ${err.message.slice(0, 300)}`);
		}
	}).catch(err => log.error('Upgrade maintenance error:', err.message));
	return true;
}

// Codex availability for the channel's mode: the host startup probe in admin, a
// live container probe in sandbox (which already returns false without Docker).
function isCodexAvailable(mode) {
	return mode === 'admin' ? CODEX_AVAILABLE : isCodexAvailableInContainer();
}

// Context-mutating commands (mode/agent switch, session reset) are refused while
// an execution is in flight on this channel: queuing prompts is useful, silently
// mutating the context a running prompt or job depends on is not. Remote mode is
// gated upstream by remoteGateHint.
async function rejectIfChannelBusy(channel, channelId) {
	if (!isBusy(channelId)) return false;
	await channel.send('⏳ A prompt or job is running on this channel — retry when it is done.');
	return true;
}

async function handleNew({ channel, channelId }) {
	if (await rejectIfChannelBusy(channel, channelId)) return true;
	sessions.clearChannel(channelId);
	await channel.send('Session reset for this channel.');
	return true;
}

async function handleAdmin({ channel, channelId, mode }) {
	if (mode === 'admin') {
		await channel.send('This channel is already in **admin** mode.');
		return true;
	}
	if (await rejectIfChannelBusy(channel, channelId)) return true;
	sessions.setMode(channelId, 'admin');
	sessions.clearChannel(channelId);
	await channel.send('Channel switched to **admin** mode. Session reset.');
	return true;
}

async function handleSandbox({ channel, channelId, mode }) {
	if (!DOCKER_AVAILABLE) {
		await channel.send('Sandbox is not available on this host — only admin mode is available.');
		return true;
	}
	if (mode === 'sandbox') {
		await channel.send('This channel is already in **sandbox** mode.');
		return true;
	}
	if (await rejectIfChannelBusy(channel, channelId)) return true;
	sessions.setMode(channelId, 'sandbox');
	sessions.clearChannel(channelId);
	await channel.send('Channel switched to **sandbox** mode. Session reset.');
	return true;
}

/**
 * How big the conversation has grown and what it has cost, from what the last
 * turn reported. Empty before the first turn, and after `/new` — there is no
 * conversation to measure.
 */
function conversationLine(channelId) {
	const usage = sessions.getUsage(channelId);
	if (!usage) return '';
	// Rounding to thousands turns a first short turn into "0k"; below that,
	// show the count.
	const tokens = n => (n < 1000 ? `${n}` : `${Math.round(n / 1000)}k`);
	const parts = [];
	if (usage.context) {
		parts.push(usage.window
			? `${tokens(usage.context)} / ${tokens(usage.window)} tokens (${Math.round((usage.context / usage.window) * 100)}%)`
			: `${tokens(usage.context)} tokens`);
	}
	// Two decimals read as $0.00 for a cheap conversation, which looks free.
	if (usage.costUsd) parts.push(`$${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(2)}`);
	return parts.length ? `\nConversation: ${parts.join(' · ')}` : '';
}

async function handleStatus({ channel, channelId, mode, agent, remoteId }) {
	const dockerNote = DOCKER_AVAILABLE ? '' : '\nSandbox unavailable on this host.';
	const remoteLine = remoteId ? `\nRemote: \`${remoteId}\`` : '';
	const codexLine = isCodexAvailable(mode) ? '' : `\nCodex unavailable in **${mode}** mode.`;
	const voiceLine = getActiveVoiceChannelId() === channelId ? '\nVoice assistant: **active**' : '';
	const autojoinLine = sessions.getAutojoin(channelId) ? '\nAutojoin: **on**' : '';
	const depotPath = sessions.getDepotPath(channelId);
	const depotLine = depotPath ? `\nRepository: \`${depotPath}\`` : '';
	await channel.send(`Channel mode: **${mode}**\nAgent: **${agent}**${conversationLine(channelId)}${depotLine}${voiceLine}${autojoinLine}${remoteLine}${dockerNote}${codexLine}`);
	return true;
}

/**
 * /voice — toggle the voice assistant in a guild voice channel (typed in its
 * text-in-voice chat). Requires OPENAI_API_KEY (TTS) and GROQ_API_KEY (STT).
 */
async function handleVoice({ channel, channelId, agent }) {
	if (!isVoiceModeAvailable()) {
		await channel.send('Voice mode requires `OPENAI_API_KEY` and `GROQ_API_KEY` in `.env`.');
		return true;
	}
	if (!isSupportedVoiceChannel(channel)) {
		await channel.send('`/voice` only works in a voice channel’s text chat — it joins/leaves that voice channel.');
		return true;
	}
	const activeId = getActiveVoiceChannelId();
	if (activeId === channelId) {
		// Explicit kick, so hold autojoin off until the user leaves the channel.
		leaveVoice({ suppressAutojoin: true });
		await channel.send(`🔇 Voice assistant left.${sessions.getAutojoin(channelId) ? ' Autojoin stays **on** — I rejoin next time you connect here.' : ''}`);
		return true;
	}
	if (activeId) {
		await channel.send(`Voice assistant is already active in <#${activeId}>. Send \`/voice\` there to stop it first.`);
		return true;
	}
	try {
		// The real channel, not the slash path's interaction-scoped proxy: the
		// session must never outlive the token.
		const realChannel = getClient().channels.cache.get(channelId) || channel;
		await joinVoice(realChannel);
		await channel.send(`🎙️ Voice assistant joined **${resolveChannelName(channel)}** (mode **${sessions.getMode(channelId)}**, agent **${agent}**). Speak, then pause — I answer out loud. Send \`/voice\` again to stop.`);
	} catch (err) {
		log.error('voice join error:', err.message);
		await channel.send(`Voice join failed: ${err.message?.slice(0, 300) || 'unknown'}`);
	}
	return true;
}

/**
 * /autojoin — toggle this voice channel's autojoin policy. Orthogonal to
 * `/voice`: off leaves a connected bot alone, on connects right away if the user
 * is already there.
 */
async function handleAutojoin({ channel, channelId }) {
	if (!isVoiceModeAvailable()) {
		await channel.send('Voice mode requires `OPENAI_API_KEY` and `GROQ_API_KEY` in `.env`.');
		return true;
	}
	if (!isSupportedVoiceChannel(channel)) {
		await channel.send('`/autojoin` only works in a voice channel’s text chat — it controls whether I join that voice channel on my own.');
		return true;
	}

	const next = !sessions.getAutojoin(channelId);
	sessions.setAutojoin(channelId, next);
	const name = resolveChannelName(channel);

	if (!next) {
		const stillIn = getActiveVoiceChannelId() === channelId ? ' I stay connected for now — send `/voice` to disconnect me.' : '';
		await channel.send(`🚪 Autojoin **off** for **${name}**.${stillIn}`);
		return true;
	}

	await channel.send(`🚪 Autojoin **on** for **${name}** — I join on my own when you connect here.`);
	clearAutojoinSuppression(channelId); // an explicit enable is an explicit re-arm
	// Real channel, not the proxy (as in handleVoice). No-op unless the user is
	// already there.
	const realChannel = getClient().channels.cache.get(channelId) || channel;
	await maybeAutojoin(realChannel);
	return true;
}

// Switching agents mid-session would break the shared sessionId (Claude UUIDs vs
// Codex thread ids).
const VOICE_AGENT_LOCK = 'Agent switch is locked while the voice assistant is active here — send `/voice` to stop it first.';

// Shared by /claude and /codex — the target agent is the command name sans slash.
// Availability is checked before "already using": claiming the channel runs an
// agent that has since disappeared would be the more misleading answer.
async function handleAgent({ channel, channelId, content, mode, agent }) {
	const target = content.slice(1);
	if (target === 'codex' && !isCodexAvailable(mode)) {
		await channel.send(`Codex is not installed or not available in **${mode}** mode.`);
		return true;
	}
	if (agent === target) {
		await channel.send(`This channel is already using **${target}**.`);
		return true;
	}
	if (getActiveVoiceChannelId() === channelId) {
		await channel.send(VOICE_AGENT_LOCK);
		return true;
	}
	if (await rejectIfChannelBusy(channel, channelId)) return true;
	sessions.setAgent(channelId, target);
	await channel.send(`Channel switched to **${target}**. Session reset.`);
	return true;
}

async function handleRestart({ channel }) {
	await channel.send('Restarting claudiscord service...');
	const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
	const cmd = isRoot ? 'systemctl' : 'sudo';
	const args = isRoot ? ['restart', 'claudiscord'] : ['-n', 'systemctl', 'restart', 'claudiscord'];

	execFile(cmd, args, (err) => {
		if (err) {
			log.error('Restart error:', err.message);
			channel.send(`Restart failed: ${err.message}`).catch(() => {});
		}
	});
	return true;
}

/**
 * Single source of truth for slash commands. Fields:
 *   - modes:         allowed channel modes (omit = all). Typing it in another
 *                    mode replies `modeError` instead of falling through.
 *   - remoteAllowed: accepted while the channel is in /remote mode.
 *   - helpOnly:      excluded from slash registration and registry dispatch
 *                    (e.g. the `!` shell, matched by prefix before the registry).
 *   - handler:       ({ message, channel, channelId, content, mode, agent,
 *                    remoteId }) => Promise<boolean>.
 */
const COMMANDS = [
	{ name: '/new', help: 'Reset session for this channel (new conversation)', handler: handleNew },
	{ name: '/stop', help: 'Stop the prompt currently running in this channel', handler: handleStop },
	{ name: '/status', help: 'Show mode, agent, conversation size and cost, runtime status', remoteAllowed: true, handler: handleStatus },
	{ name: '/usage', help: 'Show Claude and Codex usage for the current mode', remoteAllowed: true, handler: handleUsage },
	{ name: '/version', help: 'Show the Claude and Codex CLI versions', remoteAllowed: true, handler: handleVersion },
	{ name: '/skills', help: 'List each agent\'s skills (admin + sandbox)', remoteAllowed: true, handler: handleSkills },
	{ name: '/login', help: 'Refresh current agent login via a Discord-friendly link', remoteAllowed: true, handler: handleLogin },
	{ name: '/jobs', help: 'List all scheduled jobs (admin + sandbox)', remoteAllowed: true, handler: handleJobs },
	{ name: '/diff', help: 'Show the uncommitted changes of this channel\'s repository', remoteAllowed: true, modes: ['admin'], modeError: '`/diff` is only available in admin mode: it reads a repository on the host.', handler: handleDiff },
	{ name: '/admin', help: 'Switch this channel to admin mode (host)', handler: handleAdmin },
	{ name: '/sandbox', help: 'Switch this channel to sandbox mode (container)', handler: handleSandbox },
	{ name: '/claude', help: 'Use Claude for this channel', handler: handleAgent },
	{ name: '/codex', help: 'Use Codex for this channel', handler: handleAgent },
	{ name: '/remote', help: 'Toggle this channel between Discord mode and remote mode (Claude mobile app)', remoteAllowed: true, handler: handleRemote },
	{ name: '/voice', help: 'Toggle the voice assistant in this voice channel (join/leave)', handler: handleVoice },
	{ name: '/autojoin', help: 'Toggle autojoin for this voice channel (join on my own when you connect)', handler: handleAutojoin },
	{ name: '!<command>', help: 'Execute a shell command (host if admin, container if sandbox)', helpOnly: true },
	{ name: '/upgrade', help: 'Update sandbox container packages (Claude and Codex follow the host install)', modes: ['sandbox'], modeError: '`/upgrade` is only available in sandbox mode.', handler: handleUpgrade },
	{ name: '/restart', help: 'Restart the claudiscord service', modes: ['admin'], modeError: '`/restart` is only available in admin mode.', handler: handleRestart },
];

// Commands accepted while a channel is driven by the Claude mobile app.
const REMOTE_ALLOWED = new Set(COMMANDS.filter(c => c.remoteAllowed).map(c => c.name));

/**
 * Handle special commands. Returns true if the message was a command.
 * The caller has already confirmed the message comes from the authorized user.
 */
async function handleCommand(message) {
	const content = message.content.trim();
	const channel = message.channel;
	const channelId = channel.id;
	const mode = sessions.getMode(channelId);
	const agent = sessions.getAgent(channelId);

	if (await finishPendingLogin(channel, content)) return true;
	// Before the remote gate: answering a question the bot asked is not a command,
	// and `isCommand` is what tells a repository path from a slash command, since
	// both start with a slash.
	if (await finishPendingDepotPath(channel, content, isCommand)) return true;

	// Remote-mode gating (shared with the slash path via remoteGateHint): while the
	// channel is driven by the Claude mobile app, only REMOTE_ALLOWED commands are
	// accepted. Applies to everything — plain messages, !shell, other slash commands
	// — so we never spawn a parallel `claude -p` against the live remote session.
	// Keyed on the full content here; the slash path keys on the command name.
	const remoteId = sessions.getRemoteId(channelId);
	const hint = remoteGateHint(channelId, content);
	if (hint) {
		await channel.send(hint);
		return true;
	}

	// Shell: !<command> — runs in host (admin mode) or container (sandbox mode)
	if (content.startsWith('!')) {
		const command = content.slice(1).trim();
		if (!command) return false;
		return handleShell(channel, mode, command);
	}

	// Registry dispatch (single source of truth, shared with the slash path via
	// runCommand). An unknown command → runCommand returns false → the message is
	// handled as a normal prompt.
	return runCommand({ channel, channelId, name: content, mode, agent, remoteId, message });
}

/** Whether `name` is a dispatchable command, `!shell` included. */
function isCommand(name) {
	return name.startsWith('!') || COMMANDS.some(c => !c.helpOnly && c.name === name);
}

/**
 * Remote-mode gate. Returns a hint to show the user when the channel is driven by
 * the Claude mobile app and `key` is not allowed there, else null. `key` is the
 * raw content (text path) or the command name (slash path).
 */
function remoteGateHint(channelId, key) {
	const remoteId = sessions.getRemoteId(channelId);
	const transitioning = remoteOpInFlight.has(channelId);
	if ((remoteId || transitioning) && !REMOTE_ALLOWED.has(key)) {
		return !remoteId && transitioning
			? '⏳ A `/remote` toggle is in progress for this channel.'
			: `\u{1F6F0}️ This channel is in remote mode (agent \`${remoteId}\`). Send \`/remote\` to return to Discord mode.`;
	}
	return null;
}

/**
 * Registry dispatch: mode-gate + lookup + handler call. Touches only
 * `channel.send`, so any transport can drive it. False when `name` is not a
 * registered command (text path: fall through to a normal prompt).
 */
async function runCommand({ channel, channelId, name, mode, agent, remoteId, message }) {
	const cmd = COMMANDS.find(c => !c.helpOnly && c.name === name);
	if (!cmd) return false;
	if (cmd.modes && !cmd.modes.includes(mode)) {
		await channel.send(cmd.modeError);
		return true;
	}
	return cmd.handler({ message, channel, channelId, content: name, mode, agent, remoteId });
}

/**
 * Slash-command entry point. The adapter (index.js) owns the interaction plumbing
 * and calls this with the resolved channel and command name (leading slash
 * included). Same gating as handleCommand, but keyed on the name.
 */
async function dispatchSlashCommand({ channel, channelId, name }) {
	// A native command never passes through handleCommand, so a `/diff` question
	// left open would still be waiting and would swallow the next plain message.
	if (name !== '/diff') cancelPendingDepotPath(channelId);
	const mode = sessions.getMode(channelId);
	const agent = sessions.getAgent(channelId);
	const remoteId = sessions.getRemoteId(channelId);

	const hint = remoteGateHint(channelId, name);
	if (hint) {
		await channel.send(hint);
		return;
	}
	const handled = await runCommand({ channel, channelId, name, mode, agent, remoteId, message: null });
	if (!handled) await channel.send('Unknown command.');
}

/**
 * Neutral metadata for transports that register native commands. Excludes
 * `helpOnly` entries. `name` keeps its leading slash — the registry's canonical
 * identifier.
 */
function getRegisteredCommands() {
	return COMMANDS
		.filter(c => !c.helpOnly && c.name.startsWith('/'))
		.map(c => ({ name: c.name, help: c.help }));
}

module.exports = { handleCommand, dispatchSlashCommand, getRegisteredCommands };
