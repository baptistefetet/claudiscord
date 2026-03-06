const { AUTHORIZED_USER_ID } = require('./config');
const sessions = require('./sessions');
const mode = require('./mode');
const { writeCredentials, hasCredentials } = require('./container');
const log = require('./logger');

const LOGIN_INSTRUCTIONS = `**Authentification sandbox**

Le login OAuth ne fonctionne pas dans un container Docker. Tu dois t'authentifier sur ta propre machine puis envoyer tes credentials :

1. Installe Claude Code : \`curl -fsSL https://claude.ai/install.sh | bash\`
2. Lance : \`claude auth login\` et autorise l'acces dans ton navigateur
3. Copie le contenu du fichier credentials :
   - Linux/Mac : \`cat ~/.claude/.credentials.json\`
   - Windows : \`type %USERPROFILE%\\.claude\\.credentials.json\`
4. Envoie ici : \`/login {"claudeAiOauth":...}\``;

/**
 * Handle special commands. Returns true if the message was a command.
 */
async function handleCommand(message) {
	const content = message.content.trim();
	const userId = message.author.id;

	if (content === '/clear') {
		sessions.clearSession(userId);
		await message.channel.send('Conversation reinitialisee.');
		return true;
	}

	if (content === '/admin' && userId === AUTHORIZED_USER_ID) {
		const isAdmin = mode.toggle();
		sessions.clearSession(userId);
		await message.channel.send(`Mode bascule vers **${isAdmin ? 'admin' : 'sandbox'}**. Session reinitialisee.`);
		return true;
	}

	if (content === '/status' && userId === AUTHORIZED_USER_ID) {
		const current = mode.isAdminMode() ? 'admin (hote)' : 'sandbox (container)';
		const authed = hasCredentials(userId) ? 'oui' : 'non';
		await message.channel.send(`Mode actuel : **${current}**\nAuthentifie (sandbox) : **${authed}**`);
		return true;
	}

	if (content.startsWith('/login')) {
		const arg = content.slice('/login'.length).trim();

		if (!arg) {
			await message.channel.send(LOGIN_INSTRUCTIONS);
			return true;
		}

		// Validate credentials JSON
		try {
			const parsed = JSON.parse(arg);
			if (!parsed.claudeAiOauth || !parsed.claudeAiOauth.accessToken) {
				await message.channel.send('Format invalide. Le JSON doit contenir `claudeAiOauth.accessToken`.');
				return true;
			}

			writeCredentials(userId, arg);
			await message.channel.send('Credentials enregistrees. Tu peux maintenant utiliser le sandbox.');

			// Delete the message containing credentials for security
			try { await message.delete(); } catch {}
		} catch (err) {
			if (err instanceof SyntaxError) {
				await message.channel.send('JSON invalide. Envoie le contenu exact de `~/.claude/.credentials.json`.');
			} else {
				log.error('Login error:', err.message);
				await message.channel.send(`Erreur : ${err.message}`);
			}
		}
		return true;
	}

	return false;
}

module.exports = { handleCommand };
