const { spawn, execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const {
	UPGRADE_TIMEOUT_MS,
	SHELL_TIMEOUT_MS,
	DISCORD_MAX_MSG_LENGTH,
	CONTAINER_NAME,
	ADMIN_USER_HOME,
} = require('./config');
const sessions = require('./sessions');
const {
	ensureContainer,
	DOCKER_AVAILABLE,
	isCodexAvailableInContainer,
} = require('./container');
const { CODEX_AVAILABLE, getCodexUsage, startCodexLogin } = require('./codex');
const { getClaudeUsage, startClaudeLogin } = require('./claude');
const { runQueued, isBusy } = require('./queue');
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
const { loadAllJobs } = require('./jobs-store');
const scheduler = require('./scheduler');
const log = require('./logger');

const KILL_GRACE_MS = 5000;
// Worst case: "```\n" (4) + output + "\n... (truncated)\n```" (21) = 25 overhead
const SHELL_MAX_OUTPUT = DISCORD_MAX_MSG_LENGTH - 25;

// Per-channel lock held for the whole duration of a `/remote` toggle (queue
// wait + spawn + state persistence). Closes two races:
//   1. While `/remote start` is queued, `remoteId` is not yet set on the
//      session — without this lock, a concurrent plain message or
//      `/new`/`/admin` would pass the remote gate and step on the session.
//   2. Two back-to-back `/remote` calls could both pick the start branch
//      before the first finished, spawning two agents and orphaning one.
const remoteOpInFlight = new Set();
let pendingLogin = null;

function startAgentLogin(agent, mode) {
	if (agent === 'codex') return startCodexLogin(mode);
	return startClaudeLogin(mode);
}

function killLogin(login) {
	if (!login || login.closed) return;
	login.killed = true;
	try { login.child.kill('SIGTERM'); } catch (_) {}
	try {
		if (login.flow.cleanup) login.flow.cleanup();
	} catch (err) {
		log.warn(`${login.flow.label} login cleanup failed: ${err.message}`);
	}
	setTimeout(() => {
		if (!login.closed) {
			try { login.child.kill('SIGKILL'); } catch (_) {}
			try {
				if (login.flow.cleanup) login.flow.cleanup();
			} catch (err) {
				log.warn(`${login.flow.label} login cleanup failed: ${err.message}`);
			}
		}
	}, KILL_GRACE_MS);
}

function clearLogin(login) {
	if (!login || pendingLogin !== login) return;
	clearTimeout(login.timeout);
	clearTimeout(login.urlTimeout);
	if (login.releaseQueue) {
		login.releaseQueue();
		login.releaseQueue = null;
	}
	pendingLogin = null;
}

function resolveLoginStart(login) {
	if (!login || login.startResolved) return;
	login.startResolved = true;
	if (login.resolveStart) login.resolveStart();
}

function loginOutput(login) {
	return `${login.stdout}\n${login.stderr}`;
}

function maybeSendLoginUrl(login, channel) {
	if (login.urlSent) return;
	const output = loginOutput(login);
	const url = login.flow.extractUrl(output);
	if (!url) return;
	login.urlSent = true;
	clearTimeout(login.urlTimeout);
	channel.send(login.flow.formatUrlMessage(url, output))
		.catch(err => log.error(`${login.flow.label} login URL send error:`, err.message))
		.finally(() => resolveLoginStart(login));
}

async function finishPendingLogin(channel, content) {
	const login = pendingLogin;
	if (!login || login.channelId !== channel.id) return false;

	const trimmed = content.trim();
	if (trimmed === '/login') {
		await channel.send(`${login.flow.label} login is already pending here. ${login.flow.pendingHint}`);
		return true;
	}
	if (trimmed === '/login cancel' || trimmed === '/cancel') {
		killLogin(login);
		clearLogin(login);
		await channel.send(login.flow.cancelMessage);
		resolveLoginStart(login);
		return true;
	}
	if (!login.flow.awaitsDiscordInput) {
		await channel.send(`${login.flow.label} login is pending. ${login.flow.pendingHint}`);
		return true;
	}
	if (trimmed.startsWith('/')) {
		await channel.send(`${login.flow.label} login is pending. ${login.flow.inputHint}`);
		return true;
	}

	login.inputSubmitted = true;
	try {
		login.child.stdin.write(`${trimmed}\n`);
		if (login.flow.inputReceivedMessage) {
			await channel.send(login.flow.inputReceivedMessage);
		}
	} catch (err) {
		clearLogin(login);
		await channel.send(`${login.flow.label} login failed before the input could be sent: ${err.message}`);
		resolveLoginStart(login);
	}
	return true;
}

/**
 * Execute a shell command asynchronously and return output for Discord.
 * Uses spawn to avoid blocking the event loop (which would kill the Discord
 * WebSocket heartbeat on long-running commands). Implements SIGTERM→SIGKILL
 * with process group kill (host) or container cleanup (sandbox).
 */
function executeShell(command, { inContainer } = {}) {
	return new Promise((resolve) => {
		const spawnArgs = inContainer
			? { cmd: 'docker', args: ['exec', CONTAINER_NAME, 'bash', '-c', command], opts: { stdio: ['pipe', 'pipe', 'pipe'] } }
			: { cmd: 'bash', args: ['-c', command], opts: { cwd: ADMIN_USER_HOME, stdio: ['pipe', 'pipe', 'pipe'], detached: true } };

		const child = spawn(spawnArgs.cmd, spawnArgs.args, spawnArgs.opts);
		child.stdin.end();

		let stdout = '';
		let stderr = '';
		let killed = false;

		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });

		const timer = setTimeout(() => {
			killed = true;
			log.warn(`Shell timeout after ${SHELL_TIMEOUT_MS / 1000}s, sending SIGTERM`);
			if (inContainer) {
				child.kill('SIGTERM');
			} else {
				try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {}
			}
			setTimeout(() => {
				if (inContainer) {
					try { child.kill('SIGKILL'); } catch (_) {}
					try {
						execFileSync('docker', ['exec', CONTAINER_NAME, 'pkill', '-9', '-f', command.slice(0, 80)], { timeout: 5000 });
					} catch (_) {}
				} else {
					try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
				}
			}, KILL_GRACE_MS);
		}, SHELL_TIMEOUT_MS);

		child.on('close', (code) => {
			clearTimeout(timer);
			if (killed) {
				resolve(`(timeout after ${SHELL_TIMEOUT_MS / 1000}s)`);
				return;
			}
			const output = (stdout + stderr).trim();
			if (code === 0) {
				resolve(output || '(no output)');
			} else {
				resolve(output || `(exit code ${code})`);
			}
		});

		child.on('error', (err) => {
			clearTimeout(timer);
			resolve(`(error: ${err.message})`);
		});
	});
}

/**
 * Multi-line rendering of a scheduled job for the /jobs command.
 * Header line with id, then one piece of information per line.
 */
function formatJobBlock(job) {
	const status = job.enabled === false ? '⏸ disabled' : '✅ enabled';
	const agent = job.agent === 'codex' ? 'codex' : `claude/${job.model || 'sonnet'}`;
	const runs = (typeof job.remaining === 'number' && job.remaining > 0) ? `${job.remaining} left` : 'infinite';
	const channel = job.channelName || job.channelId;
	const last = job.lastRun ? `${String(job.lastRun).replace('T', ' ').slice(0, 16)} UTC` : 'never';
	const lines = [
		`**\`${job.id}\`**`,
		`▫️ Status: ${status}`,
		`⏰ Schedule: \`${job.cron}\``,
		`🤖 Agent: ${agent}`,
		`💬 Channel: ${channel}`,
		`🔁 Runs: ${runs}`,
		`🕘 Last run: ${last}`,
	];
	if (job.notify) {
		lines.push(`🔔 Notify: ${job.notifyPattern ? `\`${job.notifyPattern}\`` : 'always'}`);
	}
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
		await channel.send('`/remote` is only available with the **claude** agent. Use `/opus` or `/sonnet` first.');
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
			if (isBusy()) await channel.send('⏳ Waiting for previous prompt...');
			let stoppedCleanly = false;
			try {
				stoppedCleanly = await runQueued(() => stopRemote({ mode, remoteId: existing }));
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
		if (isBusy()) await channel.send('⏳ Waiting for previous prompt...');
		try {
			const agentId = await runQueued(async () => {
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
		return `📊 **${label} usage**\n`
			+ `▫️ 5h window: **${Math.round(usage.fiveHour)}%**${fmtReset(usage.fiveHourResetAt)}\n`
			+ `▫️ Weekly: **${Math.round(usage.weekly)}%**${fmtReset(usage.weeklyResetAt)}`;
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
 * /login — start the selected agent's browser login flow in the selected
 * environment. Only one login can be pending because it holds the global queue.
 */
async function handleLogin({ channel, channelId, mode, agent }) {
	if (pendingLogin) {
		const sameChannel = pendingLogin.channelId === channelId;
		await channel.send(sameChannel
			? `${pendingLogin.flow.label} login is already pending here. ${pendingLogin.flow.pendingHint}`
			: `${pendingLogin.flow.label} login is already pending in another channel. Finish or let it expire before starting a new one.`);
		return true;
	}
	if (isBusy()) {
		await channel.send('⏳ A prompt is currently running. Retry `/login` when the queue is idle.');
		return true;
	}

	let flow;
	try {
		flow = startAgentLogin(agent, mode);
	} catch (err) {
		if (err.code === 'CODEX_NOT_AVAILABLE') {
			await channel.send(`Codex is not installed or not available in **${mode}** mode.`);
			return true;
		}
		const label = agent === 'codex' ? 'Codex' : 'Claude';
		await channel.send(`${label} login failed to start: ${err.message}`);
		return true;
	}

	const login = {
		flow,
		child: flow.child,
		channelId,
		stdout: '',
		stderr: '',
		urlSent: false,
		inputSubmitted: false,
		killed: false,
		closed: false,
		timeout: null,
		urlTimeout: null,
		releaseQueue: null,
		startResolved: false,
		resolveStart: null,
	};
	const queueHold = new Promise((resolve) => { login.releaseQueue = resolve; });
	const startPromise = new Promise((resolve) => { login.resolveStart = resolve; });
	pendingLogin = login;
	runQueued(() => queueHold)
		.catch(err => log.warn(`${flow.label} login queue hold failed: ${err.message}`));

	login.child.stdin.on('error', () => {});
	login.child.stdout.on('data', (chunk) => {
		login.stdout += chunk;
		maybeSendLoginUrl(login, channel);
	});
	login.child.stderr.on('data', (chunk) => {
		login.stderr += chunk;
		maybeSendLoginUrl(login, channel);
	});
	login.child.on('error', (err) => {
		clearLogin(login);
		channel.send(`${flow.label} login failed to start: ${err.message}`)
			.catch(() => {})
			.finally(() => resolveLoginStart(login));
	});
	login.child.on('close', (code) => {
		login.closed = true;
		if (pendingLogin !== login) return;
		clearLogin(login);
		if (code === 0) {
			channel.send(flow.successMessage).catch(() => {})
				.finally(() => resolveLoginStart(login));
			return;
		}
		channel.send(flow.formatFailureMessage({
			killed: login.killed,
			urlSent: login.urlSent,
			inputSubmitted: login.inputSubmitted,
			code,
			output: loginOutput(login),
		}))
			.catch(() => {})
			.finally(() => resolveLoginStart(login));
	});

	login.urlTimeout = setTimeout(() => {
		if (login.urlSent || pendingLogin !== login) return;
		killLogin(login);
		clearLogin(login);
		channel.send(flow.noUrlMessage)
			.catch(() => {})
			.finally(() => resolveLoginStart(login));
	}, flow.urlTimeoutMs);
	login.timeout = setTimeout(() => {
		if (pendingLogin !== login) return;
		killLogin(login);
		clearLogin(login);
		channel.send(flow.formatFailureMessage({
			killed: true,
			urlSent: login.urlSent,
			inputSubmitted: login.inputSubmitted,
			output: loginOutput(login),
		})).catch(() => {});
	}, flow.timeoutMs);

	await startPromise;
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
 * /upgrade — sandbox only. Update container packages + Claude Code + Codex.
 * Routed through the global queue so it never overwrites a binary mid-prompt.
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
	// Overwriting /usr/local/bin/claude while another prompt is running
	// inside the container would crash that prompt. Go through the global
	// queue so we wait for any in-flight prompt (and warn the user).
	if (isBusy()) {
		await channel.send('⏳ A prompt is currently running, upgrade will start after.');
	}
	await runQueued(async () => {
		try {
			ensureContainer();
			await execFileAsync('docker', [
				'exec', '-u', 'root', CONTAINER_NAME, 'bash', '-c',
				'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" 2>&1 | tail -10',
			], { encoding: 'utf8', timeout: UPGRADE_TIMEOUT_MS });
			await execFileAsync('docker', [
				'exec', CONTAINER_NAME, 'bash', '-c',
				'curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh',
			], { encoding: 'utf8', timeout: UPGRADE_TIMEOUT_MS });
			await execFileAsync('docker', [
				'exec', CONTAINER_NAME, 'bash', '-c',
				'bash /tmp/claude-install.sh 2>&1 | tail -5 ; rm -f /tmp/claude-install.sh',
			], { encoding: 'utf8', timeout: UPGRADE_TIMEOUT_MS });
			await execFileAsync('docker', [
				'exec', '-u', 'root', CONTAINER_NAME, 'bash', '-c',
				'cp /home/claude/.local/share/claude/versions/$(ls -t /home/claude/.local/share/claude/versions/ | head -1) /usr/local/bin/claude && chmod 755 /usr/local/bin/claude',
			], { encoding: 'utf8', timeout: 10000 });
			await execFileAsync('docker', [
				'exec', '-u', 'root', CONTAINER_NAME,
				'npm', 'install', '-g', '--prefix', '/usr/local',
				'@openai/codex@latest', '--no-fund', '--no-audit',
			], { encoding: 'utf8', timeout: UPGRADE_TIMEOUT_MS });
			// Keep only the version number (e.g. "2.1.195 (Claude Code)" -> "2.1.195").
			const parseVersion = (out) => (out.match(/\d+(?:\.\d+)+/) || [''])[0];
			let claudeVersion = '';
			let codexVersion = '';
			try {
				claudeVersion = parseVersion((await execFileAsync('docker', ['exec', CONTAINER_NAME, 'claude', '--version'], { encoding: 'utf8', timeout: 10000 })).stdout);
			} catch {}
			try {
				codexVersion = parseVersion((await execFileAsync('docker', ['exec', CONTAINER_NAME, 'codex', '--version'], { encoding: 'utf8', timeout: 10000 })).stdout);
			} catch {}
			const versions = [
				claudeVersion ? `Claude: \`${claudeVersion}\`` : null,
				codexVersion ? `Codex: \`${codexVersion}\`` : null,
			].filter(Boolean);
			await channel.send(`Container updated.${versions.length ? `\n${versions.join('\n')}` : ''}`);
		} catch (err) {
			log.error('Upgrade error:', err.message);
			await channel.send(`Upgrade error: ${err.message.slice(0, 300)}`);
		}
	}).catch(err => log.error('Queued upgrade error:', err.message));
	return true;
}

// Codex availability for the channel's mode: the host startup probe in admin, a
// live container probe in sandbox (which already returns false without Docker).
function isCodexAvailable(mode) {
	return mode === 'admin' ? CODEX_AVAILABLE : isCodexAvailableInContainer();
}

async function handleNew({ channel, channelId }) {
	sessions.clearChannel(channelId);
	await channel.send('Session reset for this channel.');
	return true;
}

async function handleAdmin({ channel, channelId, mode }) {
	if (mode === 'admin') {
		await channel.send('This channel is already in **admin** mode.');
		return true;
	}
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
	sessions.setMode(channelId, 'sandbox');
	sessions.clearChannel(channelId);
	await channel.send('Channel switched to **sandbox** mode. Session reset.');
	return true;
}

async function handleStatus({ channel, channelId, mode, agent, model, remoteId }) {
	const dockerNote = DOCKER_AVAILABLE ? '' : '\nSandbox unavailable on this host.';
	const remoteLine = remoteId ? `\nRemote: \`${remoteId}\`` : '';
	const modelLine = agent === 'claude' ? `\nModel: **${model}**` : '';
	const codexLine = isCodexAvailable(mode) ? '' : `\nCodex unavailable in **${mode}** mode.`;
	const voiceLine = getActiveVoiceChannelId() === channelId ? '\nVoice assistant: **active**' : '';
	// Only shown when on: meaningless (and always false) outside a voice channel.
	const autojoinLine = sessions.getAutojoin(channelId) ? '\nAutojoin: **on**' : '';
	await channel.send(`Channel mode: **${mode}**\nAgent: **${agent}**${modelLine}${voiceLine}${autojoinLine}${remoteLine}${dockerNote}${codexLine}`);
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
		// Explicit kick: hold autojoin off until the user leaves this channel,
		// otherwise the bot would just walk back in on the next voice event.
		leaveVoice({ suppressAutojoin: true });
		await channel.send(`🔇 Voice assistant left.${sessions.getAutojoin(channelId) ? ' Autojoin stays **on** — I rejoin next time you connect here.' : ''}`);
		return true;
	}
	if (activeId) {
		await channel.send(`Voice assistant is already active in <#${activeId}>. Send \`/voice\` there to stop it first.`);
		return true;
	}
	try {
		// The slash path hands us an interaction-scoped channel proxy; give
		// voice.js the real channel so the session never outlives the token.
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
 * /autojoin — toggle this voice channel's autojoin policy (persisted per channel).
 * Deliberately orthogonal to `/voice`, which drives the live session: turning the
 * policy off leaves a connected bot alone, turning it on connects right away if
 * the user is already sitting in the channel (rather than making them reconnect).
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
	// Turning the policy on is an explicit re-arm: drop any suppression left by a
	// `/voice` kick earlier in this same stay, which would otherwise silently
	// swallow the immediate join below.
	clearAutojoinSuppression(channelId);
	// The slash path hands us an interaction-scoped channel proxy; voice.js needs
	// the real channel (same reason as handleVoice). No-op unless the user is
	// already in the channel and nothing else is active.
	const realChannel = getClient().channels.cache.get(channelId) || channel;
	await maybeAutojoin(realChannel);
	return true;
}

// Voice turns run the channel's agent, so switching agents mid-voice-session
// would break the shared sessionId (Claude UUIDs vs Codex thread ids) and trip
// the executor's context guard. Model switches (opus/sonnet) stay allowed.
const VOICE_AGENT_LOCK = 'Agent switch is locked while the voice assistant is active here — send `/voice` to stop it first.';

// Shared by /opus and /sonnet — the target model is the command name sans slash.
async function handleModel({ channel, channelId, content, agent, model }) {
	const target = content.slice(1);
	if (agent === 'claude' && model === target) {
		await channel.send(`This channel is already using **${target}**.`);
		return true;
	}
	if (agent !== 'claude' && getActiveVoiceChannelId() === channelId) {
		await channel.send(VOICE_AGENT_LOCK);
		return true;
	}
	sessions.setModel(channelId, target);
	if (agent !== 'claude') {
		sessions.setAgent(channelId, 'claude');
		await channel.send(`Channel switched to **claude ${target}**. Session reset.`);
	} else {
		await channel.send(`Channel switched to **${target}**.`);
	}
	return true;
}

async function handleCodex({ channel, channelId, mode, agent }) {
	if (!isCodexAvailable(mode)) {
		await channel.send(`Codex is not installed or not available in **${mode}** mode.`);
		return true;
	}
	if (agent === 'codex') {
		await channel.send('This channel is already using **codex**.');
		return true;
	}
	if (getActiveVoiceChannelId() === channelId) {
		await channel.send(VOICE_AGENT_LOCK);
		return true;
	}
	sessions.setAgent(channelId, 'codex');
	await channel.send('Channel switched to **codex**. Session reset.');
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
 *                    model, remoteId }) => Promise<boolean>.
 */
const COMMANDS = [
	{ name: '/new', help: 'Reset session for this channel (new conversation)', handler: handleNew },
	{ name: '/status', help: 'Show current mode, agent and runtime status', remoteAllowed: true, handler: handleStatus },
	{ name: '/usage', help: 'Show Claude and Codex usage for the current mode', remoteAllowed: true, handler: handleUsage },
	{ name: '/login', help: 'Refresh current agent login via a Discord-friendly link', remoteAllowed: true, handler: handleLogin },
	{ name: '/jobs', help: 'List all scheduled jobs (admin + sandbox)', remoteAllowed: true, handler: handleJobs },
	{ name: '/admin', help: 'Switch this channel to admin mode (host)', handler: handleAdmin },
	{ name: '/sandbox', help: 'Switch this channel to sandbox mode (container)', handler: handleSandbox },
	{ name: '/opus', help: 'Use Claude Opus for this channel', handler: handleModel },
	{ name: '/sonnet', help: 'Use Claude Sonnet for this channel', handler: handleModel },
	{ name: '/codex', help: 'Use Codex for this channel', handler: handleCodex },
	{ name: '/remote', help: 'Toggle this channel between Discord mode and remote mode (Claude mobile app)', remoteAllowed: true, handler: handleRemote },
	{ name: '/voice', help: 'Toggle the voice assistant in this voice channel (join/leave)', handler: handleVoice },
	{ name: '/autojoin', help: 'Toggle autojoin for this voice channel (join on my own when you connect)', handler: handleAutojoin },
	{ name: '!<command>', help: 'Execute a shell command (host if admin, container if sandbox)', helpOnly: true },
	{ name: '/upgrade', help: 'Update sandbox container (apt + Claude Code + Codex)', modes: ['sandbox'], modeError: '`/upgrade` is only available in sandbox mode.', handler: handleUpgrade },
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
	const model = sessions.getModel(channelId);

	if (await finishPendingLogin(channel, content)) return true;

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

		let output;
		if (mode === 'admin') {
			output = await executeShell(command);
		} else {
			if (!DOCKER_AVAILABLE) {
				await channel.send('Sandbox is not available — shell requires either admin mode or a working sandbox.');
				return true;
			}
			// A live sandbox remote shares the container with us. `executeShell`
			// times out via `pkill -9 -f <prefix>` which can scoop up the remote
			// daemon. Refuse rather than risk killing the user's mobile session.
			if (sessions.hasActiveSandboxRemote()) {
				await channel.send('\u{1F6F0}️ A sandbox `/remote` session is active — sandbox `!shell` is paused to avoid killing it. Stop the remote first.');
				return true;
			}
			ensureContainer();
			output = await executeShell(command, { inContainer: true });
		}

		let truncated = false;
		if (output.length > SHELL_MAX_OUTPUT) {
			output = output.slice(0, SHELL_MAX_OUTPUT);
			truncated = true;
		}

		const response = '```\n' + output + (truncated ? '\n... (truncated)' : '') + '\n```';
		try {
			await channel.send(response);
		} catch (err) {
			log.error('Shell send error:', err.message);
			await channel.send('Output too large or failed to send.').catch(() => {});
		}
		return true;
	}

	// Registry dispatch (single source of truth, shared with the slash path via
	// runCommand). An unknown command → runCommand returns false → the message is
	// handled as a normal prompt.
	return runCommand({ channel, channelId, name: content, mode, agent, model, remoteId, message });
}

/**
 * Remote-mode gate, transport-neutral. Returns a hint string to show the user
 * when the channel is driven by the Claude mobile app (or mid-toggle) and `key`
 * is not allowed in that state, else null. `key` is the raw content for the text
 * path or the command name for the slash path (both matched against REMOTE_ALLOWED).
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
 * Registry dispatch, transport-neutral: mode-gate + lookup + handler call. The
 * only messaging primitive it touches is `channel.send`, so any transport can
 * drive it. Returns true if a command handled the input, false if `name` is not a
 * registered command (text path: fall through to a normal prompt).
 */
async function runCommand({ channel, channelId, name, mode, agent, model, remoteId, message }) {
	const cmd = COMMANDS.find(c => !c.helpOnly && c.name === name);
	if (!cmd) return false;
	if (cmd.modes && !cmd.modes.includes(mode)) {
		await channel.send(cmd.modeError);
		return true;
	}
	return cmd.handler({ message, channel, channelId, content: name, mode, agent, model, remoteId });
}

/**
 * Slash-command entry point, transport-neutral. The Discord adapter (index.js)
 * owns the interaction plumbing (3s ack + non-ephemeral response routing) and calls
 * this with the resolved channel and command name. Mirrors handleCommand's gating
 * but keyed on the command name; output goes to the channel via `channel.send`,
 * exactly like the text path. `name` includes the leading slash (e.g. `/jobs`).
 */
async function dispatchSlashCommand({ channel, channelId, name }) {
	const mode = sessions.getMode(channelId);
	const agent = sessions.getAgent(channelId);
	const model = sessions.getModel(channelId);
	const remoteId = sessions.getRemoteId(channelId);

	const hint = remoteGateHint(channelId, name);
	if (hint) {
		await channel.send(hint);
		return;
	}
	const handled = await runCommand({ channel, channelId, name, mode, agent, model, remoteId, message: null });
	if (!handled) await channel.send('Unknown command.');
}

/**
 * Neutral command metadata for transports that register native commands (e.g.
 * Discord slash commands). Excludes `helpOnly` entries (the `!shell` prefix) and
 * any non-slash name. The transport maps { name, help } to its own shape; `name`
 * keeps the leading slash so it stays the registry's canonical identifier.
 */
function getRegisteredCommands() {
	return COMMANDS
		.filter(c => !c.helpOnly && c.name.startsWith('/'))
		.map(c => ({ name: c.name, help: c.help }));
}

module.exports = { handleCommand, dispatchSlashCommand, getRegisteredCommands };
