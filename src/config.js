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
const DISALLOWED_TOOLS = 'CronCreate CronDelete CronList Skill(loop)';

const SANDBOX_JOBS_PATH = '/home/claude/.claudiscord/scheduled-jobs.json';

function getSchedulingPrompt(jobsPath) {
	return `REGLE OBLIGATOIRE — Planification : les taches planifiees (recurrentes ou non) a base d'execution de prompt ou d'affichage de message a l'utilisateur DOIVENT passer par le systeme de scheduling Discord suivant :

Le fichier ${jobsPath} contient un tableau JSON d'objets. Un scheduler (node-cron) tourne en permanence et execute automatiquement les jobs aux horaires definis. Tu n'as qu'a ecrire dans ce fichier — le systeme s'occupe du reste. N'utilise pas d'autres methodes (crontab, at, setTimeout, setInterval, /loop, sleep, node-cron direct, systemd timer) car elles ne sont pas connectees au bot Discord et ne persisteront pas.

Champs : id (string unique), prompt (le prompt qui sera execute par Claude), cron (expression cron standard, timezone Europe/Paris), enabled (bool), notify (bool), notifyPattern (string optionnel), remaining (nombre d'executions restantes), created (ISO date), lastRun (null ou ISO date, ne pas modifier), description.

Compteur remaining : controle le nombre d'executions restantes du job. 0 = infini (le job tourne indefiniment). >0 = le scheduler decremente apres chaque execution ; quand il atteint 0, le job est automatiquement supprime. Pour un job one-shot, mettre remaining a 1. Pour un job recurrent classique, mettre 0.

Notifications : si notify=true, l'output du job est envoye par DM Discord a l'utilisateur. Si notifyPattern est defini, il est interprete comme une expression reguliere (regex) et la notification n'est envoyee que si l'output matche ce pattern. IMPORTANT : si tu veux une notification conditionnee par quelque chose (n'envoyer que si un mot-cle apparait, ou seulement si un mot-cle est absent), tu DOIS specifier notifyPattern — sans lui, notify=true envoie TOUJOURS la notification. Exemples : "PROBLEME" (notifie si le mot apparait), "^(?!.*OK).*$" (notifie si OK est absent). Le flag dotall (s) est actif par defaut (le . matche les newlines).

Pour consulter la liste des jobs planifies, il suffit de lire ce fichier — il contient toujours l'etat complet et a jour de tous les jobs.

Exemple minimal :
[{"id":"meteo","prompt":"Donne la meteo de Lyon","cron":"0 8 * * *","enabled":true,"notify":true,"remaining":0,"created":"2026-01-01T00:00:00Z","lastRun":null,"description":"Meteo quotidienne"}]`;
}

function getJobSystemPrompt(jobId) {
	const today = new Date().toISOString().slice(0, 10);
	return `Ceci est une tache planifiee pour un bot Discord. Job : "${jobId}". Date du jour : ${today}.

--- Format de reponse ---
${getDiscordFormattingPrompt()}`;
}

function getDiscordFormattingPrompt() {
	return `Fais des reponses concises adaptees a Discord (max ~1800 caracteres). Utilise le markdown Discord (pas HTML). INTERDIT : les tableaux sous toute forme — pas de tableaux ASCII, pas de tableaux markdown (|---|), pas de colonnes alignees avec des espaces. Les tableaux sont ILLISIBLES sur Discord (police proportionnelle, mobile). Utilise a la place : listes a puces, texte gras pour les labels, ou blocs de code pour les donnees alignees.`;
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
	DISALLOWED_TOOLS,
	getSystemPrompt,
	getSandboxSystemPrompt,
	getJobSystemPrompt,
};
