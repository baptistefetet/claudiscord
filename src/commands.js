const { spawn, execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const {
	UPGRADE_TIMEOUT_MS,
	SHELL_TIMEOUT_MS,
	DISCORD_MAX_MSG_LENGTH,
	CONTAINER_NAME,
	ADMIN_USER_HOME,
	CODEX_REASONING_EFFORT,
} = require('./config');
const sessions = require('./sessions');
const {
	ensureContainer,
	DOCKER_AVAILABLE,
	isCodexAvailableInContainer,
} = require('./container');
const { CODEX_AVAILABLE } = require('./codex');
const { runQueued, isBusy } = require('./queue');
const { startRemote, stopRemote } = require('./remote');
const { resolveChannelName, splitMessage } = require('./discord');
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
//      `/clear`/`/admin` would pass the remote gate and step on the session.
//   2. Two back-to-back `/remote` calls could both pick the start branch
//      before the first finished, spawning two agents and orphaning one.
const remoteOpInFlight = new Set();

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

	// Remote mode gating: while a channel is driven by the Claude mobile app,
	// only /remote (toggle off), /status and /help are accepted. Everything
	// else — plain messages, !shell, other slash commands — is invalidated so
	// we never spawn a parallel `claude -p` against the live remote session.
	// We also block during a transition (`remoteOpInFlight`) so a message
	// arriving while `/remote start` is still queued can't slip through.
	const remoteId = sessions.getRemoteId(channelId);
	const remoteTransitioning = remoteOpInFlight.has(channelId);
	if ((remoteId || remoteTransitioning) && content !== '/remote' && content !== '/status' && content !== '/help' && content !== '/jobs') {
		const hint = !remoteId && remoteTransitioning
			? '⏳ A `/remote` toggle is in progress for this channel.'
			: `\u{1F6F0}️ This channel is in remote mode (agent \`${remoteId}\`). Send \`/remote\` to return to Discord mode.`;
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

	if (content === '/help') {
		const modelLabel = agent === 'claude' ? `, model: **${model}**` : '';
		let help = `**Available commands** (current mode: **${mode}**, agent: **${agent}**${modelLabel})

\`/help\` — Show this help
\`/clear\` — Reset session for this channel (new conversation)
\`/status\` — Show current mode, agent and runtime status
\`/jobs\` — List all scheduled jobs (admin + sandbox)
\`/admin\` — Switch this channel to admin mode (host)
\`/sandbox\` — Switch this channel to sandbox mode (container)
\`/opus\` — Use Claude Opus for this channel
\`/sonnet\` — Use Claude Sonnet for this channel
\`/codex\` — Use Codex for this channel
\`/remote\` — Toggle this channel between Discord mode and remote mode (Claude mobile app)
\`!<command>\` — Execute a shell command (host if admin, container if sandbox)`;
		if (mode === 'sandbox') {
			help += `
\`/upgrade\` — Update sandbox container (apt + Claude Code + Codex)`;
		}
		if (mode === 'admin') {
			help += `
\`/restart\` — Restart the claudiscord service`;
		}
		await channel.send(help);
		return true;
	}

	if (content === '/clear') {
		sessions.clearChannel(channelId);
		await channel.send('Session reset for this channel.');
		return true;
	}

	if (content === '/admin') {
		if (mode === 'admin') {
			await channel.send('This channel is already in **admin** mode.');
			return true;
		}
		sessions.setMode(channelId, 'admin');
		sessions.clearChannel(channelId);
		await channel.send('Channel switched to **admin** mode. Session reset.');
		return true;
	}

	if (content === '/sandbox') {
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

	if (content === '/remote') {
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

	if (content === '/status') {
		const dockerNote = DOCKER_AVAILABLE ? '' : '\nSandbox unavailable on this host.';
		const remoteLine = remoteId ? `\nRemote: \`${remoteId}\`` : '';
		const modelLine = agent === 'claude' ? `\nModel: **${model}**` : '';
		const reasoningLine = agent === 'codex' ? `\nReasoning: **${CODEX_REASONING_EFFORT}**` : '';
		const codexAvailable = mode === 'admin'
			? CODEX_AVAILABLE
			: isCodexAvailableInContainer();
		const codexLine = codexAvailable ? '' : `\nCodex unavailable in **${mode}** mode.`;
		await channel.send(`Channel mode: **${mode}**\nAgent: **${agent}**${modelLine}${reasoningLine}${remoteLine}${dockerNote}${codexLine}`);
		return true;
	}

	if (content === '/jobs') {
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
		for (const chunk of splitMessage(out, 1900)) {
			await channel.send(chunk);
		}
		return true;
	}

	if (content === '/opus' || content === '/sonnet') {
		const target = content.slice(1);
		if (agent === 'claude' && model === target) {
			await channel.send(`This channel is already using **${target}**.`);
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

	if (content === '/codex') {
		const codexAvailable = mode === 'admin'
			? CODEX_AVAILABLE
			: (DOCKER_AVAILABLE && isCodexAvailableInContainer());
		if (!codexAvailable) {
			await channel.send(`Codex is not installed or not available in **${mode}** mode.`);
			return true;
		}
		if (agent === 'codex') {
			await channel.send('This channel is already using **codex**.');
			return true;
		}
		sessions.setAgent(channelId, 'codex');
		await channel.send(`Channel switched to **codex** with **${CODEX_REASONING_EFFORT}** reasoning. Session reset.`);
		return true;
	}

	if (content === '/restart') {
		if (mode !== 'admin') {
			await channel.send('`/restart` is only available in admin mode.');
			return true;
		}
		await channel.send('Restarting claudiscord service...');
		execFile('systemctl', ['restart', 'claudiscord'], (err) => {
			if (err) log.error('Restart error:', err.message);
		});
		return true;
	}

	if (content === '/upgrade') {
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
			await channel.send('\u23F3 A prompt is currently running, upgrade will start after.');
		}
		await runQueued(async () => {
			try {
				ensureContainer();
				await channel.send('Updating container packages...');
				await execFileAsync('docker', [
					'exec', '-u', 'root', CONTAINER_NAME, 'bash', '-c',
					'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" 2>&1 | tail -10',
				], { encoding: 'utf8', timeout: UPGRADE_TIMEOUT_MS });
				await channel.send('Updating Claude Code...');
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
				await channel.send('Updating Codex...');
				await execFileAsync('docker', [
					'exec', '-u', 'root', CONTAINER_NAME,
					'npm', 'install', '-g', '--prefix', '/usr/local',
					'@openai/codex@latest', '--no-fund', '--no-audit',
				], { encoding: 'utf8', timeout: UPGRADE_TIMEOUT_MS });
				let claudeVersion = '';
				let codexVersion = '';
				try {
					claudeVersion = (await execFileAsync('docker', ['exec', CONTAINER_NAME, 'claude', '--version'], { encoding: 'utf8', timeout: 10000 })).stdout.trim();
				} catch {}
				try {
					codexVersion = (await execFileAsync('docker', ['exec', CONTAINER_NAME, 'codex', '--version'], { encoding: 'utf8', timeout: 10000 })).stdout.trim();
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

	return false;
}

module.exports = { handleCommand };
