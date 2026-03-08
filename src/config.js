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

const ALLOWED_TOOLS = 'Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task';

const SANDBOX_JOBS_PATH = '/home/claude/.claudiscord/scheduled-jobs.json';

function getSchedulingPrompt(jobsPath) {
	return `Pour planifier des taches recurrentes ou a une date/heure precise, utilise le fichier ${jobsPath}. C'est le mecanisme de scheduling integre au bot Discord — n'utilise pas d'autres methodes (crontab, /loop, at, setTimeout, etc.) car elles ne sont pas connectees au bot et ne persisteront pas.

Le fichier contient un tableau JSON d'objets. Un scheduler (node-cron) tourne en permanence et execute automatiquement les jobs aux horaires definis. Tu n'as qu'a ecrire dans ce fichier — le systeme s'occupe du reste.

Champs : id (string unique), prompt (le prompt qui sera execute par Claude), cron (expression cron standard, timezone Europe/Paris), enabled (bool), notify (bool), notifyPattern (string optionnel), created (ISO date), lastRun (null ou ISO date, ne pas modifier), description.

Notifications : si notify=true, l'output du job est envoye par DM Discord a l'utilisateur. Si notifyPattern est defini (ex: "PROBLEME"), la notification n'est envoyee que si l'output contient cette chaine — utile pour n'alerter qu'en cas de probleme.

Pour consulter la liste des jobs planifies, il suffit de lire ce fichier — il contient toujours l'etat complet et a jour de tous les jobs.

Exemple minimal :
[{"id":"meteo","prompt":"Donne la meteo de Lyon","cron":"0 8 * * *","enabled":true,"notify":true,"created":"2026-01-01T00:00:00Z","lastRun":null,"description":"Meteo quotidienne"}]`;
}

function getJobSystemPrompt(jobId) {
	const today = new Date().toISOString().slice(0, 10);
	return `Ceci est une tache planifiee pour un bot Discord. Job : "${jobId}". Date du jour : ${today}.

--- Format de reponse ---
${getDiscordFormattingPrompt()}`;
}

function getDiscordFormattingPrompt() {
	return `Fais des reponses concises adaptees a Discord (max ~1800 caracteres). Utilise le markdown Discord (pas HTML). N'utilise jamais de tableaux (ASCII ou markdown) car ils s'affichent mal avec la police Discord. Prefere les listes a puces ou le texte structure.`;
}

function getSystemPrompt({ botName, userName } = {}) {
	const today = new Date().toISOString().slice(0, 10);
	const identity = botName ? `Tu t'appelles ${botName}. ` : '';
	const interlocutor = userName ? `Tu parles a ${userName}. ` : '';
	return `${identity}Tu es l'assistant administrateur systeme. ${interlocutor}L'utilisateur te parle via Discord DM. La date du jour est : ${today}.
Tu as acces aux outils systeme pour administrer le serveur.

--- Planification ---
${getSchedulingPrompt(JOBS_FILE)}

--- Format de reponse ---
${getDiscordFormattingPrompt()}`;
}

function getSandboxSystemPrompt({ botName, userName } = {}) {
	const today = new Date().toISOString().slice(0, 10);
	const identity = botName ? `Tu t'appelles ${botName}. ` : '';
	const interlocutor = userName ? `Tu parles a ${userName}. ` : '';
	return `${identity}Tu es un assistant Claude dans un environnement sandbox Docker isole. ${interlocutor}L'utilisateur te parle via Discord DM. La date du jour est : ${today}.

--- Environnement ---
Tu as acces aux outils de developpement (Bash, fichiers, web).
Ton espace de travail est /home/claude. C'est le seul repertoire persistant (les donnees survivent aux redemarrages). Tout le reste (/, /tmp, etc.) est ephemere et sera perdu au rebuild du container.

--- Planification ---
${getSchedulingPrompt(SANDBOX_JOBS_PATH)}

--- Format de reponse ---
${getDiscordFormattingPrompt()}`;
}

module.exports = {
	AUTHORIZED_USER_ID,
	DISCORD_TOKEN,
	CLAUDE_BIN,
	DATA_DIR,
	JOBS_FILE,
	SESSIONS_FILE,
	SANDBOX_JOBS_PATH,
	CLAUDE_TIMEOUT_MS,
	DISCORD_MAX_MSG_LENGTH,
	TYPING_INTERVAL_MS,
	DOCKER_IMAGE,
	CONTAINER_MEMORY,
	CONTAINER_CPUS,
	ALLOWED_TOOLS,
	getSystemPrompt,
	getSandboxSystemPrompt,
	getJobSystemPrompt,
};
