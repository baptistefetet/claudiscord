const { spawn, execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const { ChannelType } = require('discord.js');
const execFileAsync = promisify(execFile);
const { UPGRADE_TIMEOUT_MS, SHELL_TIMEOUT_MS, DISCORD_MAX_MSG_LENGTH, CONTAINER_NAME } = require('./config');
const sessions = require('./sessions');
const { writeCredentials, hasCredentials, ensureContainer, DOCKER_AVAILABLE } = require('./container');
const log = require('./logger');

const KILL_GRACE_MS = 5000;
// Worst case: "```\n" (4) + output + "\n... (truncated)\n```" (21) = 25 overhead
const SHELL_MAX_OUTPUT = DISCORD_MAX_MSG_LENGTH - 25;

const LOGIN_INSTRUCTIONS = `**Sandbox authentication**

You need to authenticate on your own machine and send your credentials:

**1.** Install Claude Code: \`curl -fsSL https://claude.ai/install.sh | bash\`
**2.** Run: \`claude auth login\` and authorize access in your browser
**3.** Copy your credentials:

> **Linux**: \`cat ~/.claude/.credentials.json\`
> **Mac**: credentials are stored in the Keychain. Run:
> \`security find-generic-password -s "claude-credentials" -w\`
> **Windows**: \`type %USERPROFILE%\\.claude\\.credentials.json\`

**4.** Send here: \`/login {"claudeAiOauth":...}\`

The message will be automatically deleted after registration.`;

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
			: { cmd: 'bash', args: ['-c', command], opts: { cwd: '/root', stdio: ['pipe', 'pipe', 'pipe'], detached: true } };

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
 * Handle special commands. Returns true if the message was a command.
 * The caller has already confirmed the message comes from the authorized user.
 */
async function handleCommand(message) {
	const content = message.content.trim();
	const channel = message.channel;
	const channelId = channel.id;
	const mode = sessions.getMode(channelId);

	// Shell: !<command> — runs in host (admin mode) or container (sandbox mode)
	if (content.startsWith('!')) {
		const command = content.slice(1).trim();
		if (!command) return false;

		let output;
		if (mode === 'admin') {
			output = await executeShell(command);
		} else {
			if (!DOCKER_AVAILABLE) {
				await channel.send('Docker is not installed — shell requires either admin mode or a working sandbox.');
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
		let help = `**Available commands** (current mode: **${mode}**)

\`/help\` — Show this help
\`/clear\` — Reset session for this channel (new conversation)
\`/status\` — Show current mode and authentication status
\`/admin\` — Switch this channel to admin mode (host)
\`/sandbox\` — Switch this channel to sandbox mode (container)
\`!<command>\` — Execute a shell command (host if admin, container if sandbox)`;
		if (mode === 'sandbox') {
			help += `
\`/upgrade\` — Update sandbox container (apt + Claude Code)
\`/login\` — Sandbox authentication instructions
\`/login <json>\` — Save your Claude Code credentials`;
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
			await channel.send('Docker is not installed on this host — only admin mode is available.');
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

	if (content === '/status') {
		const authed = DOCKER_AVAILABLE && hasCredentials() ? 'yes' : 'no';
		const dockerNote = DOCKER_AVAILABLE ? '' : '\nDocker not installed — sandbox unavailable.';
		await channel.send(`Channel mode: **${mode}**\nAuthenticated (sandbox): **${authed}**${dockerNote}`);
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
			let version = '';
			try {
				version = (await execFileAsync('docker', ['exec', CONTAINER_NAME, 'claude', '--version'], { encoding: 'utf8', timeout: 10000 })).stdout.trim();
			} catch {}
			await channel.send(`Container updated.${version ? `\nVersion: \`${version}\`` : ''}`);
		} catch (err) {
			log.error('Upgrade error:', err.message);
			await channel.send(`Upgrade error: ${err.message.slice(0, 300)}`);
		}
		return true;
	}

	if (content.startsWith('/login')) {
		if (mode !== 'sandbox') {
			await channel.send('`/login` is only used in sandbox mode.');
			return true;
		}
		const arg = content.slice('/login'.length).trim();

		if (!arg) {
			await channel.send(LOGIN_INSTRUCTIONS);
			return true;
		}

		// Credentials must only ever be sent in a DM: in a guild channel the bot
		// might not be able to delete the message, leaving the OAuth JSON visible
		// to anyone with read access.
		if (channel.type !== ChannelType.DM) {
			await message.delete().catch(() => {});
			await channel.send('Send `/login <json>` only in DM — pasting credentials in a guild channel is unsafe.');
			return true;
		}

		const tryDelete = () => message.delete().catch(() => {});

		try {
			const parsed = JSON.parse(arg);
			if (!parsed.claudeAiOauth || !parsed.claudeAiOauth.accessToken) {
				await channel.send('Invalid format. JSON must contain `claudeAiOauth.accessToken`.');
				tryDelete();
				return true;
			}

			writeCredentials(arg);
			await channel.send('Credentials saved. You can now use the sandbox.');
			tryDelete();
		} catch (err) {
			if (err instanceof SyntaxError) {
				await channel.send('Invalid JSON. Send the exact content of `~/.claude/.credentials.json`.');
			} else {
				log.error('Login error:', err.message);
				await channel.send(`Error: ${err.message}`);
			}
			tryDelete();
		}
		return true;
	}

	return false;
}

module.exports = { handleCommand };
