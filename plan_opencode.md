# Plan d'intégration OpenCode dans Claudiscord

## Objectif

Permettre l'exécution de tâches de développement en arrière-plan via OpenCode (utilisant l'abonnement GitHub Copilot), sans bloquer la conversation principale avec Claude, et sans consommer l'abonnement Anthropic.

## Contexte

- **Claude CLI** (`claude -p`) : mode one-shot, bloquant, utilise l'abonnement Anthropic
- **OpenCode** (`opencode serve`) : serveur HTTP REST, sessions persistantes, supporte GitHub Copilot comme provider (modèles Claude inclus dans l'abonnement Copilot)
- **Claudiscord** : process Node.js unique, queues par user, communication Discord DM

## Architecture cible

```
User DM
  ├─ message normal    → claude -p (inchangé)
  ├─ /copilot <prompt> → OpenCode HTTP API (bypass total de Claude)
  └─ Claude délègue    → écriture dans background-tasks.json → OpenCode HTTP API

OpenCode daemon
  ← opencode serve (port 4096, localhost uniquement)
  ← provider: GitHub Copilot (via GITHUB_TOKEN)
  ← cwd configurable par session (pointe vers le repo à travailler)
```

## Composants

### 1. Service OpenCode (systemd)

**Fichier** : `/etc/systemd/system/opencode.service`

```ini
[Unit]
Description=OpenCode Server
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/html
ExecStart=/chemin/vers/opencode serve --port 4096 --hostname 127.0.0.1
Environment=GITHUB_TOKEN=<token>
Environment=OPENCODE_SERVER_PASSWORD=<password>
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- Tourne en `www-data` pour accéder aux repos dans `/var/www/html/`
- Écoute uniquement sur localhost (pas d'exposition externe)
- Auth HTTP Basic pour sécuriser l'API

### 2. Module `src/opencode.js`

Nouveau module responsable de toute la communication avec OpenCode.

```
Responsabilités :
- Créer/réutiliser des sessions OpenCode
- Envoyer des prompts (sync)
- Gérer les tâches background (async, non-bloquant)
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

**`createSession(cwd)`**
- `POST /session` avec le `cwd` du repo cible
- Retourne un `sessionId`
- Appelée une fois par tâche ou réutilisée si session existante

**`sendPrompt(sessionId, prompt)`**
- `POST /session/{id}/message`
- Body : `{ parts: [{ type: "text", text: prompt }] }`
- Auth : HTTP Basic (`Authorization: Basic base64(user:pass)`)
- Bloquant côté HTTP (attend la réponse complète d'OpenCode)
- Mais non-bloquant côté claudiscord (Promise indépendante)
- Timeout : `AbortController` avec `OPENCODE_TIMEOUT_MS`
- Retourne le texte de la réponse de l'agent

**`runBackground(userId, prompt, options)`**
- Orchestrateur haut niveau pour les tâches background
- Flow :
  1. Génère un `taskId` unique (`crypto.randomUUID()`)
  2. Enregistre la tâche dans `backgroundTasks` (Map en mémoire)
  3. Lance `createSession()` + `sendPrompt()` dans une Promise séparée (fire-and-forget du point de vue de l'appelant)
  4. Au resolve : envoie le résultat en DM via `sendDM()`
  5. Au reject : envoie l'erreur en DM
  6. Dans tous les cas : nettoie `backgroundTasks`
- Options : `{ cwd, model, notify }` (cwd par défaut : `/var/www/html`)

**`getStatus()`**
- Retourne la liste des tâches en cours (depuis la Map en mémoire)
- Utilisée par `/copilot status`

**`isAvailable()`**
- `GET /global/health` avec timeout court (3s)
- Vérifie que le service OpenCode répond
- Utilisée au démarrage et par `/copilot` pour un message d'erreur clair

### 3. Commande `/copilot`

Ajout dans `src/commands.js`.

#### Sous-commandes

**`/copilot <prompt>`** — Exécution directe (bypass Claude)
```
1. Valider que OpenCode est disponible (isAvailable)
2. Répondre immédiatement : "⏳ Tâche envoyée à Copilot..."
3. Appeler runBackground(userId, prompt, { cwd })
4. L'utilisateur continue de discuter normalement
5. Quand c'est fini : DM avec le résultat
```

**`/copilot status`** — État des tâches en cours
```
Affiche la liste des tâches background actives :
- taskId (tronqué)
- prompt (tronqué)
- durée depuis le lancement
- statut (running)
```

**`/copilot stop <taskId>`** — Annuler une tâche
```
1. Trouver la tâche dans backgroundTasks
2. POST /session/{id}/abort
3. Nettoyer la Map
4. Confirmer à l'utilisateur
```

**`/copilot <prompt> --cwd <path>`** — Spécifier le répertoire de travail
```
Permet de pointer OpenCode vers un repo spécifique.
Ex : /copilot refactor the auth module --cwd /var/www/html/badly
Par défaut : /var/www/html
```

#### Accès

- Admin uniquement (AUTHORIZED_USER_ID) pour l'instant
- Extensible aux sandbox users plus tard (sessions OpenCode isolées)

### 4. Délégation depuis Claude (optionnel, phase 2)

Permettre au Claude principal de décider lui-même de déléguer une tâche à OpenCode.

#### Mécanisme : fichier signal `background-tasks.json`

```json
[
  {
    "id": "abc123",
    "prompt": "Refactor the auth module in badly",
    "cwd": "/var/www/html/badly",
    "status": "pending",
    "created": "2026-03-28T14:00:00Z"
  }
]
```

- Claude écrit dans ce fichier (il a déjà accès à Write)
- Claudiscord watch ce fichier (même pattern que `scheduled-jobs.json`)
- Les tâches `pending` sont envoyées à OpenCode via `runBackground()`
- Le statut passe à `running` puis `done` ou `error`
- Claude reçoit l'instruction dans son system prompt :
  *"Pour déléguer une tâche de développement longue à un agent background, écris dans background-tasks.json"*

#### Ajout au system prompt admin

```
## Tâches background (OpenCode)
Pour déléguer une tâche de développement à un agent en arrière-plan (sans bloquer
la conversation), écris dans /var/www/html/claudiscord/background-tasks.json :
[{ "id": "<uuid>", "prompt": "<description de la tâche>", "cwd": "<chemin du repo>", "status": "pending", "created": "<ISO date>" }]
L'agent OpenCode exécutera la tâche et le résultat te sera envoyé en DM.
Tu peux continuer à discuter pendant ce temps.
```

### 5. Gestion des résultats

#### Notification Discord

Le résultat d'une tâche background est envoyé en DM avec le format :

```
✅ **Copilot — Tâche terminée**
> refactor the auth module in badly
<résultat tronqué si > 1800 chars>
⏱️ Durée : 2m 34s
```

En cas d'erreur :
```
❌ **Copilot — Erreur**
> refactor the auth module in badly
<message d'erreur>
```

En cas de timeout :
```
⏰ **Copilot — Timeout**
> refactor the auth module in badly
Pas de réponse après 10 minutes.
```

#### Injection dans le contexte Claude (phase 3, optionnel)

Pour que Claude soit au courant des résultats des tâches background :
- Écrire le résultat dans un fichier `background-results/{taskId}.md`
- Ajouter une instruction dans le system prompt : *"Consulte background-results/ pour les résultats des tâches déléguées"*
- Claude peut alors lire ces fichiers et en discuter avec l'utilisateur

### 6. Suivi en mémoire

```javascript
/** @type {Map<string, BackgroundTask>} */
const backgroundTasks = new Map();

/**
 * @typedef {Object} BackgroundTask
 * @property {string} id
 * @property {string} userId
 * @property {string} prompt
 * @property {string} cwd
 * @property {string} sessionId - OpenCode session ID
 * @property {string} status - 'running' | 'done' | 'error'
 * @property {Date} startedAt
 * @property {AbortController} controller - Pour annulation
 */
```

Non persisté (perdu au restart du service, acceptable pour des tâches ponctuelles).

## Fichiers modifiés / créés

### Créés
- `src/opencode.js` — Module de communication OpenCode (~150 lignes)
- `/etc/systemd/system/opencode.service` — Service systemd

### Modifiés
- `src/commands.js` — Ajout commande `/copilot` et sous-commandes
- `src/config.js` — Ajout constantes OpenCode (`OPENCODE_*`)
- `src/prompts.js` — Ajout instructions background dans system prompt admin (phase 2)
- `.env` — Ajout `OPENCODE_PASSWORD`
- `CLAUDE.md` — Documentation de la nouvelle fonctionnalité
- `index.js` — Vérification disponibilité OpenCode au démarrage (optionnel)

### Non modifiés
- `src/claude.js` — Aucun changement
- `src/container.js` — Aucun changement
- `src/scheduler.js` — Aucun changement
- `src/sessions.js` — Aucun changement

## Plan d'implémentation par phases

### Phase 1 — MVP : commande `/copilot` (priorité haute)

1. Installer OpenCode sur la machine
2. Configurer le provider GitHub Copilot (GITHUB_TOKEN)
3. Créer le service systemd
4. Implémenter `src/opencode.js` (createSession, sendPrompt, runBackground, isAvailable)
5. Implémenter `/copilot <prompt>` dans `src/commands.js`
6. Implémenter `/copilot status` et `/copilot stop`
7. Ajouter `/copilot` au `/help`
8. Tester end-to-end

**Résultat** : l'utilisateur peut lancer `/copilot <prompt>` et recevoir le résultat en DM pendant qu'il continue de discuter avec Claude.

### Phase 2 — Délégation depuis Claude

1. Implémenter le watcher `background-tasks.json`
2. Ajouter les instructions dans le system prompt admin
3. Tester que Claude peut créer des tâches background de lui-même

**Résultat** : Claude peut décider de déléguer une tâche longue à OpenCode.

### Phase 3 — Enrichissements

1. Injection des résultats dans le contexte Claude (`background-results/`)
2. Support multi-repo (--cwd)
3. Support sandbox users (sessions OpenCode isolées)
4. Historique des tâches (persisté en JSON)
5. Streaming d'updates intermédiaires via SSE OpenCode

## Prérequis

- [ ] OpenCode installé (`go install` ou binaire ARM64)
- [ ] GitHub Copilot subscription active
- [ ] GITHUB_TOKEN avec scope `copilot` généré
- [ ] Tester `opencode serve` manuellement avant d'automatiser

## Risques et mitigations

**OpenCode instable / crash** → Service systemd avec `Restart=on-failure`. `isAvailable()` vérifie avant chaque tâche. Message clair à l'utilisateur si indisponible.

**Tâche qui tourne indéfiniment** → `AbortController` avec timeout de 10 min. `/copilot stop` en dernier recours.

**Consommation Copilot excessive** → Pas de rate limiting prévu pour l'instant (usage personnel). À surveiller.

**Conflits de fichiers** → OpenCode et Claude pourraient modifier les mêmes fichiers si on n'y prend pas garde. Mitigation : ne pas lancer de tâche Copilot sur un repo que Claude est en train de modifier. Avertissement dans le system prompt.

**Perte des tâches au restart** → Acceptable pour un MVP. Les tâches background sont ponctuelles et courtes. Phase 3 pourrait ajouter de la persistance si nécessaire.
