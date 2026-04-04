const { spawn, execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { AUTHORIZED_USER_ID, UPGRADE_TIMEOUT_MS, SHELL_TIMEOUT_MS, DISCORD_MAX_MSG_LENGTH } = require('./config');
const sessions = require('./sessions');
const { writeCredentials, hasCredentials, ensureContainer, containerName } = require('./container');
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
function executeShell(command, { inContainer, containerNameStr } = {}) {
	return new Promise((resolve) => {
		const spawnArgs = inContainer
			? { cmd: 'docker', args: ['exec', containerNameStr, 'bash', '-c', command], opts: { stdio: ['pipe', 'pipe', 'pipe'] } }
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
					// Kill orphaned processes in container
					try {
						execFileSync('docker', ['exec', containerNameStr, 'pkill', '-9', '-f', command.slice(0, 80)], { timeout: 5000 });
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
 */
async function handleCommand(message) {
	const content = message.content.trim();
	const userId = message.author.id;

	// Shell command: !<command> (authorized user only)
	if (content.startsWith('!') && userId === AUTHORIZED_USER_ID) {
		const command = content.slice(1).trim();
		if (!command) return false;

		const isAdmin = sessions.isAdminMode();
		let output;

		if (isAdmin) {
			output = await executeShell(command);
		} else {
			// Sandbox mode: run in user's container
			ensureContainer(userId);
			const name = containerName(userId);
			output = await executeShell(command, { inContainer: true, containerNameStr: name });
		}

		// Truncate and wrap in code block
		let truncated = false;
		if (output.length > SHELL_MAX_OUTPUT) {
			output = output.slice(0, SHELL_MAX_OUTPUT);
			truncated = true;
		}

		const response = '```\n' + output + (truncated ? '\n... (truncated)' : '') + '\n```';
		try {
			await message.channel.send(response);
		} catch (err) {
			log.error('Shell send error:', err.message);
			await message.channel.send('Output too large or failed to send.').catch(() => {});
		}
		return true;
	}

	if (content === '/help') {
		const isAdmin = userId === AUTHORIZED_USER_ID;
		const inAdmin = sessions.isAdminMode();
		let help = `**Available commands**

\`/help\` — Show this help
\`/clear\` — Reset session (new conversation)`;
		if (!inAdmin) {
			help += `
\`/upgrade\` — Update sandbox container (apt + Claude Code)
\`/login\` — Sandbox authentication instructions
\`/login <json>\` — Save your credentials`;
		}
		if (isAdmin) {
			help += `
\`/admin\` — Switch to admin mode (host)
\`/sandbox\` — Switch to sandbox mode (container)
\`/status\` — Show current mode and authentication status
\`!<command>\` — Execute a shell command (${inAdmin ? 'host' : 'container'})`;
			if (inAdmin) {
				help += `
\`/restart\` — Restart the claudiscord service`;
			}
		}
		await message.channel.send(help);
		return true;
	}

	if (content === '/upgrade' && !sessions.isAdminMode()) {
		try {
			ensureContainer(userId);
			const name = containerName(userId);
			// APT upgrade (as root in container)
			await message.channel.send('Updating container packages...');
			await execFileAsync('docker', [
				'exec', '-u', 'root', name, 'bash', '-c',
				'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" 2>&1 | tail -10',
			], { encoding: 'utf8', timeout: UPGRADE_TIMEOUT_MS });
			// Claude Code upgrade — use async exec to avoid blocking the event loop
			// (execFileSync blocks heartbeats; >41s block kills the Discord WebSocket)
			await message.channel.send('Updating Claude Code...');
			await execFileAsync('docker', [
				'exec', name, 'bash', '-c',
				'curl -fsSL https://claude.ai/install.sh -o /tmp/claude-install.sh',
			], { encoding: 'utf8', timeout: UPGRADE_TIMEOUT_MS });
			await execFileAsync('docker', [
				'exec', name, 'bash', '-c',
				'bash /tmp/claude-install.sh 2>&1 | tail -5 ; rm -f /tmp/claude-install.sh',
			], { encoding: 'utf8', timeout: UPGRADE_TIMEOUT_MS });
			// Copy upgraded binary to /usr/local/bin so it takes priority in PATH
			await execFileAsync('docker', [
				'exec', '-u', 'root', name, 'bash', '-c',
				'cp /home/claude/.local/share/claude/versions/$(ls -t /home/claude/.local/share/claude/versions/ | head -1) /usr/local/bin/claude && chmod 755 /usr/local/bin/claude',
			], { encoding: 'utf8', timeout: 10000 });
			// Get new version
			let version = '';
			try {
				version = (await execFileAsync('docker', ['exec', name, 'claude', '--version'], { encoding: 'utf8', timeout: 10000 })).stdout.trim();
			} catch {}
			await message.channel.send(`Container updated.${version ? `\nVersion: \`${version}\`` : ''}`);
		} catch (err) {
			log.error('Upgrade error:', err.message);
			await message.channel.send(`Upgrade error: ${err.message.slice(0, 300)}`);
		}
		return true;
	}

	if (content === '/clear') {
		sessions.clearSession(userId);
		await message.channel.send('Session reset.');
		return true;
	}

	if (content === '/admin' && userId === AUTHORIZED_USER_ID) {
		if (sessions.isAdminMode()) {
			await message.channel.send('Already in **admin** mode.');
			return true;
		}
		sessions.setAdminMode(true);
		sessions.clearSession(userId);
		await message.channel.send('Switched to **admin** mode. Session reset.');
		return true;
	}

	if (content === '/sandbox' && userId === AUTHORIZED_USER_ID) {
		if (!sessions.isAdminMode()) {
			await message.channel.send('Already in **sandbox** mode.');
			return true;
		}
		sessions.setAdminMode(false);
		sessions.clearSession(userId);
		await message.channel.send('Switched to **sandbox** mode. Session reset.');
		return true;
	}

	if (content === '/restart' && userId === AUTHORIZED_USER_ID && sessions.isAdminMode()) {
		await message.channel.send('Restarting claudiscord service...');
		// Use execFile (async) so the message is sent before the process dies
		execFile('systemctl', ['restart', 'claudiscord'], (err) => {
			if (err) log.error('Restart error:', err.message);
		});
		return true;
	}

	if (content === '/status' && userId === AUTHORIZED_USER_ID) {
		const current = sessions.isAdminMode() ? 'admin (host)' : 'sandbox (container)';
		const authed = hasCredentials(userId) ? 'yes' : 'no';
		await message.channel.send(`Current mode: **${current}**\nAuthenticated (sandbox): **${authed}**`);
		return true;
	}

	if (content.startsWith('/login') && !sessions.isAdminMode()) {
		const arg = content.slice('/login'.length).trim();

		if (!arg) {
			await message.channel.send(LOGIN_INSTRUCTIONS);
			return true;
		}

		// Validate credentials JSON
		try {
			const parsed = JSON.parse(arg);
			if (!parsed.claudeAiOauth || !parsed.claudeAiOauth.accessToken) {
				await message.channel.send('Invalid format. JSON must contain `claudeAiOauth.accessToken`.');
				return true;
			}

			writeCredentials(userId, arg);
			await message.channel.send('Credentials saved. You can now use the sandbox.');

			// Delete the message containing credentials for security
			try { await message.delete(); } catch {}
		} catch (err) {
			if (err instanceof SyntaxError) {
				await message.channel.send('Invalid JSON. Send the exact content of `~/.claude/.credentials.json`.');
			} else {
				log.error('Login error:', err.message);
				await message.channel.send(`Error: ${err.message}`);
			}
		}
		return true;
	}

	return false;
}

module.exports = { handleCommand };
