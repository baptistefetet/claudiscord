const { AUTHORIZED_USER_ID } = require('./config');
const sessions = require('./sessions');
const mode = require('./mode');
const { runLoginFlow } = require('./container');
const log = require('./logger');

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
		await message.channel.send(`Mode actuel : **${current}**`);
		return true;
	}

	if (content === '/login') {
		await message.channel.send('Lancement du flow OAuth...');
		try {
			const { url, process: loginProcess } = await runLoginFlow(userId);
			await message.channel.send(`Ouvre ce lien pour connecter ton compte Claude :\n${url}`);

			// Wait for the process to finish
			await new Promise((resolve) => {
				loginProcess.on('close', resolve);
				// 5 min timeout already handled in runLoginFlow
			});
			await message.channel.send('Authentification terminee.');
		} catch (err) {
			log.error('Login flow error:', err.message);
			await message.channel.send(`Erreur login : ${err.message}`);
		}
		return true;
	}

	return false;
}

module.exports = { handleCommand };
