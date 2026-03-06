const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const AUTHORIZED_USER_ID = process.env.AUTHORIZED_USER_ID;
const BATBOT_DISCORD_TOKEN = process.env.BATBOT_DISCORD_TOKEN;
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/root/.local/bin/claude';

const JOBS_FILE = path.resolve(__dirname, '..', 'scheduled-jobs.json');
const SESSIONS_FILE = path.resolve(__dirname, '..', 'sessions.json');

const CLAUDE_TIMEOUT_MS = 300_000;
const DISCORD_MAX_MSG_LENGTH = 2000;
const TYPING_INTERVAL_MS = 8000;

const PROFILES = {
	admin: 'Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task',
	online: 'WebSearch WebFetch',
};

function getSystemPrompt() {
	const today = new Date().toISOString().slice(0, 10);
	return `Tu es l'assistant administrateur systeme. L'utilisateur te parle via Discord DM.
Tu as acces aux outils systeme pour administrer le serveur.
Tu peux gerer les jobs planifies (creer, modifier, supprimer, lister, executer) dans ${JOBS_FILE} si l'utilisateur le demande. Champs : id, prompt, cron, profile (admin|online), enabled, notify, created, lastRun, description. Si notify=true, le runner envoie automatiquement l'output du job sur Discord — le job n'a pas besoin d'appeler notify_discord.sh lui-meme. Profil : admin seulement si le prompt necessite un acces systeme (Bash, fichiers, services). Pour tout le reste (recherche web, generation de texte, message simple), utilise online. L'utilisateur peut forcer le profil.
Fais des reponses concises adaptees a Discord (max ~1800 caracteres).
Utilise le markdown Discord (pas HTML). La date du jour est : ${today}.`;
}

module.exports = {
	AUTHORIZED_USER_ID,
	BATBOT_DISCORD_TOKEN,
	CLAUDE_BIN,
	JOBS_FILE,
	SESSIONS_FILE,
	CLAUDE_TIMEOUT_MS,
	DISCORD_MAX_MSG_LENGTH,
	TYPING_INTERVAL_MS,
	PROFILES,
	getSystemPrompt,
};
