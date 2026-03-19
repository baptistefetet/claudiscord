const { execFileSync, execFile } = require('child_process');
const { AUTHORIZED_USER_ID } = require('./config');
const sessions = require('./sessions');
const { writeCredentials, hasCredentials, ensureContainer, containerName } = require('./container');
const log = require('./logger');

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
 * Handle special commands. Returns true if the message was a command.
 */
async function handleCommand(message) {
	const content = message.content.trim();
	const userId = message.author.id;

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
\`/status\` — Show current mode and authentication status`;
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
			execFileSync('docker', [
				'exec', '-u', 'root', name, 'bash', '-c',
				'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" 2>&1 | tail -10',
			], { encoding: 'utf8', timeout: 300000 });
			// Claude Code upgrade
			await message.channel.send('Updating Claude Code...');
			const output = execFileSync('docker', [
				'exec', name, 'bash', '-c',
				'curl -fsSL https://claude.ai/install.sh | bash 2>&1 | tail -5',
			], { encoding: 'utf8', timeout: 300000 });
			// Copy upgraded binary to /usr/local/bin so it takes priority in PATH
			execFileSync('docker', [
				'exec', '-u', 'root', name, 'bash', '-c',
				'cp /home/claude/.local/share/claude/versions/$(ls -t /home/claude/.local/share/claude/versions/ | head -1) /usr/local/bin/claude && chmod 755 /usr/local/bin/claude',
			], { encoding: 'utf8', timeout: 10000 });
			// Get new version
			let version = '';
			try {
				version = execFileSync('docker', ['exec', name, 'claude', '--version'], { encoding: 'utf8', timeout: 10000 }).trim();
			} catch {}
			await message.channel.send(`Container updated.${version ? `\nClaude Code: \`${version}\`` : ''}`);
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
