const { AUTHORIZED_USER_ID } = require('./config');
const sessions = require('./sessions');
const mode = require('./mode');
const { runLoginFlow, hasPendingLogin, submitLoginCode } = require('./container');
const log = require('./logger');

/**
 * Handle special commands. Returns true if the message was a command.
 */
async function handleCommand(message) {
	const content = message.content.trim();
	const userId = message.author.id;

	// If user has a pending login, route the message as OAuth code
	if (hasPendingLogin(userId)) {
		submitLoginCode(userId, content);
		await message.channel.send('Code recu, verification en cours...');
		return true;
	}

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
			const { urlPromise, completionPromise } = runLoginFlow(userId);
			const url = await urlPromise;
			await message.channel.send(`Ouvre ce lien pour connecter ton compte Claude :\n${url}\n\nPuis colle le code ici.`);

			// Wait for completion in background
			completionPromise.then(() => {
				message.channel.send('Authentification reussie !').catch(() => {});
			}).catch((err) => {
				log.error('Login completion error:', err.message);
				message.channel.send(`Echec de l'authentification : ${err.message}`).catch(() => {});
			});
		} catch (err) {
			log.error('Login flow error:', err.message);
			await message.channel.send(`Erreur login : ${err.message}`);
		}
		return true;
	}

	return false;
}

module.exports = { handleCommand };
