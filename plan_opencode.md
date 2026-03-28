# Plan d'intégration OpenCode dans Claudiscord

## Objectif

Permettre l'exécution de tâches de développement en arrière-plan via OpenCode (utilisant l'abonnement GitHub Copilot), sans bloquer la conversation principale avec Claude, et sans consommer l'abonnement Anthropic.

## Contexte

- **Claude CLI** (`claude -p`) : mode one-shot, bloquant, utilise l'abonnement Anthropic
- **OpenCode** (`opencode serve`) : serveur HTTP REST, sessions persistantes, supporte GitHub Copilot comme provider (modèles Claude inclus dans l'abonnement Copilot)
- **Claudiscord** : process Node.js unique, queues par user, communication Discord DM

## Architecture cible

```
User DM (admin mode uniquement, cwd: /root)
  ├─ message normal      → claude -p (inchangé)
  ├─ /opencode <prompt>  → OpenCode HTTP API (bypass total de Claude)
  └─ Claude délègue      → écriture dans background-tasks.json → OpenCode HTTP API

OpenCode daemon
  ← opencode serve (port 4096, localhost uniquement)
  ← provider: GitHub Copilot (via GITHUB_TOKEN)
  ← modèle: celui configuré dans OpenCode par l'utilisateur
  ← cwd: /root (même environnement que Claude en mode admin)
```

## Composants

### 1. Service OpenCode (systemd)

**Fichier** : `/etc/systemd/system/opencode.service`

OpenCode tourne en tant que `root` (même contexte que Claude en mode admin) dans `/root`.

```ini
[Unit]
Description=OpenCode Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root
ExecStart=/chemin/vers/opencode serve --port 4096 --hostname 127.0.0.1
Environment=GITHUB_TOKEN=<token>
Environment=OPENCODE_SERVER_PASSWORD=<password>
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- Tourne en `root` pour accéder au système comme Claude en mode admin
- `WorkingDirectory=/root` : charge le même `CLAUDE.md` principal que Claude
- Écoute uniquement sur localhost (pas d'exposition externe)
- Auth HTTP Basic pour sécuriser l'API
- Le modèle utilisé est celui configuré dans la config OpenCode (pas géré par claudiscord)

### 2. Module `src/opencode.js`

Nouveau module responsable de toute la communication avec OpenCode.

```
Responsabilités :
- Créer/réutiliser des sessions OpenCode
- Envoyer des prompts (sync HTTP, async côté claudiscord)
- Gérer les tâches background (non-bloquant pour la conv principale)
- Notifier l'utilisateur via Discord DM à la fin
```

#### Constantes et configuration

```javascript
const OPENCODE_BASE_URL = 'http://127.0.0.1:4096';
const OPENCODE_TIMEOUT_MS = 600_000; // 10 min (tâches de dev longues)
const OPENCODE_USER = 'opencode';
const OPENCODE_PASSWORD = process.env.OPENCODE_PASSWORD || '';
```

Ajout dans `.env` :
```
OPENCODE_PASSWORD=<le même que OPENCODE_SERVER_PASSWORD>
```

#### Fonctions principales

**`createSession()`**
- `POST /session`
- Retourne un `sessionId`
- Le cwd est celui du service OpenCode (`/root`)
- Appelée une fois par tâche

**`sendPrompt(sessionId, prompt)`**
- `POST /session/{id}/message`
- Body : `{ parts: [{ type: "text", text: prompt }] }`
- Auth : HTTP Basic (`Authorization: Basic base64(user:pass)`)
- Bloquant côté HTTP (attend la réponse complète d'OpenCode)
- Mais non-bloquant côté claudiscord (Promise indépendante de la queue admin)
- Timeout : `AbortController` avec `OPENCODE_TIMEOUT_MS`
- Retourne le texte de la réponse de l'agent

**`runBackground(userId, prompt)`**
- Orchestrateur haut niveau pour les tâches background
- Flow :
  1. Génère un `taskId` unique (`crypto.randomUUID()`)
  2. Enregistre la tâche dans `backgroundTasks` (Map en mémoire)
  3. Lance `createSession()` + `sendPrompt()` dans une Promise séparée (fire-and-forget)
  4. Au resolve : envoie le résultat en DM via `sendDM()`
  5. Au reject (erreur/timeout) : envoie l'erreur en DM
  6. Dans tous les cas : nettoie `backgroundTasks`
- Retourne le `taskId` immédiatement (pour que l'appelant puisse confirmer à l'utilisateur)

**`abortTask(taskId)`**
- Récupère la tâche dans `backgroundTasks`
- `POST /session/{id}/abort` pour arrêter OpenCode
- Trigger l'`AbortController` côté fetch
- Nettoie la Map

**`getStatus()`**
- Retourne la liste des tâches en cours (depuis la Map en mémoire)
- Pour chaque tâche : id, prompt (tronqué), durée depuis le lancement

**`isAvailable()`**
- `GET /global/health` avec timeout court (3s)
- Vérifie que le service OpenCode répond
- Utilisée par `/opencode` pour un message d'erreur clair

### 3. System prompt OpenCode

OpenCode reçoit un system prompt dédié via le paramètre `system` de l'API `/session/{id}/message`. Ce prompt reprend les mêmes blocs que le system prompt admin de claudiscord, sans la partie scheduling.

Nouvelle fonction dans `src/prompts.js` :

```javascript
function getOpenCodeSystemPrompt({ userName } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return `Your name is DevBot. You are a development agent. ${userName ? `Working for ${userName}. ` : ''}The user is talking to you via Discord DM. Today's date is: ${today}.
You are invoked for coding tasks delegated from the main assistant (BatBot).
This is a one-shot task, not a conversation. Do not ask clarifying questions — make reasonable assumptions and proceed. Return a concise summary of what you did and the key changes made.

--- Critical rules ---
NEVER restart the claudiscord service (systemctl restart claudiscord, systemctl stop claudiscord, etc.).

--- Disabled skills ---
${getDisabledSkillsPrompt()}

--- Response format ---
${getDiscordFormattingPrompt()}`;
}
```

Le `CLAUDE.md` de `/root` est automatiquement chargé par OpenCode (même cwd), fournissant la connaissance du système, des projets et des permissions sans duplication.

### 4. Commande `/opencode`

Ajout dans `src/commands.js`. Réservée à l'admin (AUTHORIZED_USER_ID) en mode admin uniquement.

#### Sous-commandes

**`/opencode <prompt>`** — Exécution directe (bypass Claude)
```
1. Vérifier que l'utilisateur est admin et en mode admin
2. Valider que OpenCode est disponible (isAvailable)
3. Répondre immédiatement : "⏳ Tâche envoyée à DevBot..."
4. Appeler runBackground(userId, prompt)
5. L'utilisateur continue de discuter normalement avec BatBot
6. Quand c'est fini : DM avec le résultat
```

**`/opencode status`** — État des tâches en cours
```
Affiche la liste des tâches background actives :
- taskId (8 premiers chars)
- prompt (tronqué à 80 chars)
- durée depuis le lancement
```

**`/opencode stop <taskId>`** — Annuler une tâche
```
1. Trouver la tâche dans backgroundTasks (match partiel sur les premiers chars de l'id)
2. Appeler abortTask(taskId)
3. Confirmer à l'utilisateur
```

#### Accès

- Admin uniquement (AUTHORIZED_USER_ID)
- Mode admin uniquement (pas en sandbox)
- Message d'erreur clair si utilisé en sandbox ou par un non-admin

### 5. Délégation depuis Claude (phase 2)

Permettre au Claude principal (BatBot) de décider lui-même de déléguer une tâche à OpenCode (DevBot).

#### Mécanisme : fichier signal `background-tasks.json`

```json
[
  {
    "id": "abc123",
    "prompt": "Refactor the auth module in badly",
    "status": "pending",
    "created": "2026-03-28T14:00:00Z"
  }
]
```

- Claude écrit dans ce fichier (il a déjà accès à Write via le tool `Edit`/`Write`)
- Claudiscord watch ce fichier (même pattern que `scheduled-jobs.json` : `fs.watch` sur le répertoire + debounce 2s)
- Les tâches `pending` sont envoyées à OpenCode via `runBackground()`
- Le statut passe à `running` puis `done` ou `error`
- Fichier gitignored

#### Ajout au system prompt admin (BatBot)

```
--- Background tasks (DevBot) ---
To delegate a development task to a background agent (DevBot, powered by OpenCode),
write to /var/www/html/claudiscord/background-tasks.json:
[{ "id": "<uuid>", "prompt": "<task description>", "status": "pending", "created": "<ISO date>" }]
DevBot will execute the task and the result will be sent to the user via Discord DM.
You can continue the conversation while DevBot works.
Do NOT delegate tasks on files you are currently modifying (risk of conflicts).
```

### 6. Gestion des résultats

#### Notification Discord

Le résultat d'une tâche background est envoyé en DM. On réutilise `splitMessage()` en filet de sécurité pour les réponses longues.

Format succès :
```
✅ **DevBot — Tâche terminée**
> refactor the auth module in badly
<résultat (découpé par splitMessage si > 2000 chars)>
⏱️ Durée : 2m 34s
```

Format erreur :
```
❌ **DevBot — Erreur**
> refactor the auth module in badly
<message d'erreur>
```

Format timeout :
```
⏰ **DevBot — Timeout**
> refactor the auth module in badly
Pas de réponse après 10 minutes.
```

#### Injection dans le contexte Claude (phase 3, optionnel)

Pour que BatBot soit au courant des résultats des tâches background :
- Écrire le résultat dans un fichier `background-results/{taskId}.md`
- Ajouter une instruction dans le system prompt admin : *"Consulte background-results/ pour les résultats des tâches déléguées à DevBot"*
- BatBot peut alors lire ces fichiers et en discuter avec l'utilisateur

### 7. Suivi en mémoire

```javascript
/** @type {Map<string, BackgroundTask>} */
const backgroundTasks = new Map();

/**
 * @typedef {Object} BackgroundTask
 * @property {string} id
 * @property {string} userId
 * @property {string} prompt
 * @property {string} sessionId - OpenCode session ID
 * @property {string} status - 'running' | 'done' | 'error' | 'aborted'
 * @property {Date} startedAt
 * @property {AbortController} controller - Pour annulation
 */
```

Non persisté (perdu au restart du service). Acceptable pour des tâches ponctuelles — une tâche OpenCode dure quelques minutes, pas des heures.

## Fichiers modifiés / créés

### Créés
- `src/opencode.js` — Module de communication OpenCode (~150 lignes)
- `/etc/systemd/system/opencode.service` — Service systemd

### Modifiés
- `src/commands.js` — Ajout commande `/opencode` et sous-commandes
- `src/config.js` — Ajout constantes OpenCode (`OPENCODE_BASE_URL`, `OPENCODE_TIMEOUT_MS`, `OPENCODE_PASSWORD`)
- `src/prompts.js` — Ajout `getOpenCodeSystemPrompt()` + instructions background dans system prompt admin (phase 2)
- `.env` — Ajout `OPENCODE_PASSWORD`
- `CLAUDE.md` — Documentation de la nouvelle fonctionnalité
- `index.js` — Aucun changement (OpenCode est vérifié à la demande, pas au démarrage)

### Non modifiés
- `src/claude.js` — Aucun changement
- `src/container.js` — Aucun changement
- `src/scheduler.js` — Aucun changement
- `src/sessions.js` — Aucun changement
- `src/discord.js` — Aucun changement (on réutilise `sendDM` et `splitMessage` existants)

## Plan d'implémentation par phases

### Phase 1 — MVP : commande `/opencode` (priorité haute)

1. Installer OpenCode sur la machine (vérifier qu'un binaire ARM64 existe)
2. Configurer le provider GitHub Copilot (GITHUB_TOKEN)
3. Tester `opencode serve` manuellement
4. Créer le service systemd
5. Implémenter `src/opencode.js` (createSession, sendPrompt, runBackground, abortTask, getStatus, isAvailable)
6. Implémenter `getOpenCodeSystemPrompt()` dans `src/prompts.js`
7. Implémenter `/opencode`, `/opencode status`, `/opencode stop` dans `src/commands.js`
8. Ajouter les constantes dans `src/config.js` et `.env`
9. Ajouter `/opencode` au `/help` (visible en mode admin uniquement)
10. Tester end-to-end
11. Mettre à jour `CLAUDE.md`

**Résultat** : l'admin peut lancer `/opencode <prompt>` et recevoir le résultat en DM pendant qu'il continue de discuter avec BatBot.

### Phase 2 — Délégation depuis BatBot

1. Implémenter le watcher `background-tasks.json` (dans `src/opencode.js`)
2. Ajouter les instructions dans le system prompt admin (`src/prompts.js`)
3. Ajouter `background-tasks.json` au `.gitignore`
4. Tester que BatBot peut créer des tâches background de lui-même

**Résultat** : BatBot peut décider de déléguer une tâche longue à DevBot.

### Phase 3 — Enrichissements

1. Injection des résultats dans le contexte BatBot (`background-results/`)
2. Historique des tâches (persisté en JSON)
3. Streaming d'updates intermédiaires via SSE OpenCode (envoi de messages "DevBot travaille encore..." périodiques)

## Prérequis

- [ ] OpenCode installé (binaire ARM64 ou build depuis les sources)
- [ ] GitHub Copilot subscription active
- [ ] GITHUB_TOKEN avec scope `copilot` généré
- [ ] Tester `opencode serve` manuellement avant d'automatiser
- [ ] Choisir et configurer le modèle dans la config OpenCode

## Risques et mitigations

**OpenCode indisponible** → `isAvailable()` vérifie avant chaque tâche. Message clair : "DevBot is not available. Is the opencode service running?". Service systemd avec `Restart=on-failure`.

**Tâche qui tourne indéfiniment** → `AbortController` avec timeout de 10 min. `/opencode stop` en dernier recours. Le timeout est configurable (`OPENCODE_TIMEOUT_MS`).

**Consommation Copilot** → Pas de rate limiting prévu (usage personnel). À surveiller si l'usage augmente.

**Conflits de fichiers** → DevBot et BatBot pourraient modifier les mêmes fichiers simultanément. Mitigation : avertissement dans le system prompt admin ("Do NOT delegate tasks on files you are currently modifying"). L'utilisateur garde le contrôle via `/opencode` (explicite) ou la délégation BatBot (phase 2, avec consigne de prudence).

**Perte des tâches au restart** → Acceptable. Les tâches background sont ponctuelles (quelques minutes). Si claudiscord redémarre, les tâches en cours sont perdues mais OpenCode continue de tourner — le résultat est simplement perdu côté notification.

**Pas de binaire ARM64** → OpenCode est écrit en Go, cross-compilation facile. Sinon, `GOARCH=arm64 go install github.com/opencode-ai/opencode@latest`.
