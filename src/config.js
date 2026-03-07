const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const REQUIRED_ENV = ['AUTHORIZED_USER_ID', 'DISCORD_TOKEN', 'CLAUDE_BIN', 'DATA_DIR'];
for (const key of REQUIRED_ENV) {
	if (!process.env[key]) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
}

const AUTHORIZED_USER_ID = process.env.AUTHORIZED_USER_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLAUDE_BIN = process.env.CLAUDE_BIN;
const DATA_DIR = process.env.DATA_DIR;

const JOBS_FILE = path.resolve(__dirname, '..', 'scheduled-jobs.json');
const SESSIONS_FILE = path.resolve(__dirname, '..', 'sessions.json');

const DOCKER_IMAGE = 'claudiscord-sandbox';
const CONTAINER_MEMORY = '512m';
const CONTAINER_CPUS = 1;

const CLAUDE_TIMEOUT_MS = 300_000;
const DISCORD_MAX_MSG_LENGTH = 2000;
const TYPING_INTERVAL_MS = 8000;

const PROFILES = {
	admin: 'Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task',
	online: 'WebSearch WebFetch',
	sandbox: 'Bash Read Write Edit Glob Grep WebSearch WebFetch Task',
};

function getSystemPrompt({ botName, userName } = {}) {
	const today = new Date().toISOString().slice(0, 10);
	const identity = botName ? `Tu t'appelles ${botName}. ` : '';
	const interlocutor = userName ? `Tu parles a ${userName}. ` : '';
	return `${identity}Tu es l'assistant administrateur systeme. ${interlocutor}L'utilisateur te parle via Discord DM.
Tu as acces aux outils systeme pour administrer le serveur.
Tu peux gerer les jobs planifies (creer, modifier, supprimer, lister, executer) dans ${JOBS_FILE} si l'utilisateur le demande. Champs : id, prompt, cron, profile (admin|online), enabled, notify, notifyPattern (optionnel), created, lastRun, description. Notifications : si notify=true, l'output est envoye par DM. Si notifyPattern est defini (ex: "PROBLEME"), la notification n'est envoyee que si l'output contient cette chaine — utile pour n'alerter qu'en cas de probleme. Le job n'a pas besoin d'envoyer de notification lui-meme. Profil : admin seulement si le prompt necessite un acces systeme (Bash, fichiers, services). Pour tout le reste (recherche web, generation de texte, message simple), utilise online. L'utilisateur peut forcer le profil.
Fais des reponses concises adaptees a Discord (max ~1800 caracteres).
Utilise le markdown Discord (pas HTML). La date du jour est : ${today}.`;
}

function getSandboxSystemPrompt({ botName, userName } = {}) {
	const today = new Date().toISOString().slice(0, 10);
	const identity = botName ? `Tu t'appelles ${botName}. ` : '';
	const interlocutor = userName ? `Tu parles a ${userName}. ` : '';
	return `${identity}Tu es un assistant Claude dans un environnement sandbox Docker isole.
${interlocutor}L'utilisateur te parle via Discord DM.
Tu as acces aux outils de developpement (Bash, fichiers, web).
Fais des reponses concises adaptees a Discord (max ~1800 caracteres).
Utilise le markdown Discord (pas HTML). La date du jour est : ${today}.`;
}

module.exports = {
	AUTHORIZED_USER_ID,
	DISCORD_TOKEN,
	CLAUDE_BIN,
	DATA_DIR,
	JOBS_FILE,
	SESSIONS_FILE,
	CLAUDE_TIMEOUT_MS,
	DISCORD_MAX_MSG_LENGTH,
	TYPING_INTERVAL_MS,
	DOCKER_IMAGE,
	CONTAINER_MEMORY,
	CONTAINER_CPUS,
	PROFILES,
	getSystemPrompt,
	getSandboxSystemPrompt,
};
