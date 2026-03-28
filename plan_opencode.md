# Plan d'intégration OpenCode dans Claudiscord

## Objectif

Permettre l'exécution de tâches de développement en arrière-plan via OpenCode CLI (utilisant l'abonnement GitHub Copilot), sans bloquer la conversation principale avec Claude, et sans consommer l'abonnement Anthropic.

## Contexte

- **Claude CLI** (`claude -p`) : mode one-shot, bloquant, utilise l'abonnement Anthropic
- **OpenCode CLI** (`opencode -p`) : mode one-shot, même pattern que Claude, supporte GitHub Copilot comme provider (modèles Claude inclus dans l'abonnement Copilot)
- **Claudiscord** : process Node.js unique, queues par user, communication Discord DM

## Architecture cible

```
User DM (admin mode uniquement, cwd: /root)
  ├─ message normal      → claude -p (inchangé)
  ├─ /opencode <prompt>  → opencode -p (subprocess fire-and-forget)
  └─ Claude délègue      → écriture dans background-tasks.json → opencode -p

Pas de daemon OpenCode — CLI one-shot uniquement.
```

## CLI OpenCode — Paramètres

```bash
opencode -p "prompt" -f text -q -c /root
```

| Flag | Description |
|------|-------------|
| `-p "prompt"` | Mode one-shot (non-interactif) |
| `-f text` | Format de sortie texte (aussi : `json`) |
| `-q` | Quiet — supprime le spinner (pour scripts) |
| `-c /root` | Working directory (charge le CLAUDE.md de /root) |

**Permissions** : en mode `-p`, toutes les permissions sont **auto-approuvées** pour la session. Pas de flag supplémentaire nécessaire (équivalent au `--dangerously-skip-permissions` de Claude).

**Configuration** : modèle et provider configurés dans `~/.opencode.json` (pas via CLI).

```json
{
  "providers": {
    "copilot": { "disabled": false }
  },
  "agents": {
    "coder": { "model": "claude-sonnet-4-20250514", "maxTokens": 16000 }
  }
}
```

**Authentification Copilot** : via variable d'environnement `GITHUB_TOKEN`.

**System prompt** : pas de flag CLI pour le system prompt. Deux options :
1. Le `CLAUDE.md` dans le cwd (`/root`) est chargé automatiquement par OpenCode
2. Les instructions DevBot sont **prepend au prompt** dans `getOpenCodePrompt()`

## Composants

### 1. Intégration dans `src/claude.js`

Pas de nouveau module. On réutilise `spawnWithTimeout` existant pour lancer OpenCode en subprocess.

Nouvelle fonction (ou ajout dans `src/opencode.js` minimaliste ~40 lignes) :

```javascript
const crypto = require('crypto');
const { spawnWithTimeout } = require('./claude');
const { sendDM } = require('./discord');
const { OPENCODE_BIN, OPENCODE_TIMEOUT_MS } = require('./config');
const log = require('./logger');

/** @type {Map<string, BackgroundTask>} */
const backgroundTasks = new Map();

function getOpenCodePrompt(prompt, userName) {
  const today = new Date().toISOString().slice(0, 10);
  return `[System] Your name is DevBot. You are a development agent working for ${userName || 'the admin'}. Today: ${today}.
You are invoked for a coding task delegated from the main assistant (BatBot).
This is a one-shot task. Do not ask clarifying questions — make reasonable assumptions and proceed.
Return a concise summary of what you did and the key changes made.
NEVER restart the claudiscord service.
Keep your response under 1800 characters (Discord limit).

[Task] ${prompt}`;
}

function runBackground(userId, prompt, userName) {
  const taskId = crypto.randomUUID();
  const startedAt = Date.now();

  const child = spawnWithTimeout(
    OPENCODE_BIN,
    ['-p', getOpenCodePrompt(prompt, userName), '-f', 'text', '-q', '-c', '/root'],
    { timeoutMs: OPENCODE_TIMEOUT_MS, label: `DevBot:${taskId.slice(0, 8)}` }
  );

  backgroundTasks.set(taskId, { id: taskId, userId, prompt, startedAt, child });

  child
    .then(result => {
      const duration = formatDuration(Date.now() - startedAt);
      const output = (result.stdout || '').trim() || '(no output)';
      sendDM(userId, `✅ **DevBot — Tâche terminée**\n> ${prompt.slice(0, 80)}\n${output}\n⏱️ ${duration}`);
    })
    .catch(err => {
      const duration = formatDuration(Date.now() - startedAt);
      if (err.code === 124) {
        sendDM(userId, `⏰ **DevBot — Timeout**\n> ${prompt.slice(0, 80)}\nPas de réponse après ${OPENCODE_TIMEOUT_MS / 60000} minutes.`);
      } else {
        sendDM(userId, `❌ **DevBot — Erreur**\n> ${prompt.slice(0, 80)}\n${err.message}`);
      }
    })
    .finally(() => backgroundTasks.delete(taskId));

  return taskId;
}

function abortTask(taskId) { /* SIGTERM le child process */ }
function getStatus() { /* liste des tâches depuis backgroundTasks */ }
function formatDuration(ms) { /* "2m 34s" */ }

module.exports = { runBackground, abortTask, getStatus, backgroundTasks };
```

### 2. System prompt DevBot

Pas de flag CLI pour le system prompt → les instructions DevBot sont **intégrées au prompt** via `getOpenCodePrompt()`.

Le `CLAUDE.md` de `/root` est automatiquement chargé par OpenCode (même cwd), fournissant la connaissance du système, des projets et des permissions sans duplication.

### 3. Commande `/opencode`

Ajout dans `src/commands.js`. Réservée à l'admin (AUTHORIZED_USER_ID) en mode admin uniquement.

#### Sous-commandes

**`/opencode <prompt>`** — Exécution directe (bypass Claude)
```
1. Vérifier que l'utilisateur est admin et en mode admin
2. Répondre immédiatement : "⏳ Tâche envoyée à DevBot..."
3. Appeler runBackground(userId, prompt, userName)
4. L'utilisateur continue de discuter normalement avec BatBot
5. Quand c'est fini : DM avec le résultat
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

### 4. Délégation depuis Claude (phase 2)

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
- Les tâches `pending` sont envoyées à `runBackground()`
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

### 5. Gestion des résultats

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

### 6. Suivi en mémoire

```javascript
/** @type {Map<string, BackgroundTask>} */
const backgroundTasks = new Map();

/**
 * @typedef {Object} BackgroundTask
 * @property {string} id
 * @property {string} userId
 * @property {string} prompt
 * @property {string} status - 'running' | 'done' | 'error' | 'aborted'
 * @property {Date} startedAt
 * @property {object} child - Promise retournée par spawnWithTimeout (pour abort)
 */
```

Non persisté (perdu au restart du service). Acceptable pour des tâches ponctuelles — une tâche dure quelques minutes, pas des heures.

## Fichiers modifiés / créés

### Créés
- `src/opencode.js` — Module minimaliste (~40 lignes) : `runBackground`, `abortTask`, `getStatus`, `getOpenCodePrompt`

### Modifiés
- `src/commands.js` — Ajout commande `/opencode` et sous-commandes
- `src/config.js` — Ajout constantes `OPENCODE_BIN`, `OPENCODE_TIMEOUT_MS`
- `src/prompts.js` — Instructions background dans system prompt admin (phase 2)
- `CLAUDE.md` — Documentation de la nouvelle fonctionnalité

### Non modifiés
- `src/claude.js` — Aucun changement (on réutilise `spawnWithTimeout` et `parseClaudeOutput`)
- `src/container.js` — Aucun changement
- `src/scheduler.js` — Aucun changement
- `src/sessions.js` — Aucun changement
- `src/discord.js` — Aucun changement (on réutilise `sendDM` et `splitMessage`)
- `index.js` — Aucun changement
- `.env` — Aucun changement (`GITHUB_TOKEN` est dans l'environnement système ou dans `~/.opencode.json`)

## Plan d'implémentation par phases

### Phase 1 — MVP : commande `/opencode` (priorité haute)

1. Installer OpenCode (vérifier binaire ARM64 : `GOARCH=arm64 go install github.com/opencode-ai/opencode@latest`)
2. Configurer `~/.opencode.json` (provider Copilot, modèle, GITHUB_TOKEN)
3. Tester `opencode -p "hello" -f text -q` manuellement
4. Créer `src/opencode.js` (~40 lignes : runBackground, abortTask, getStatus)
5. Ajouter `OPENCODE_BIN` et `OPENCODE_TIMEOUT_MS` dans `src/config.js`
6. Implémenter `/opencode`, `/opencode status`, `/opencode stop` dans `src/commands.js`
7. Ajouter `/opencode` au `/help` (visible en mode admin uniquement)
8. Tester end-to-end
9. Mettre à jour `CLAUDE.md`

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

## Prérequis

- [ ] OpenCode installé (binaire ARM64 ou `go install`)
- [ ] GitHub Copilot subscription active
- [ ] GITHUB_TOKEN avec scope `copilot` généré
- [ ] `~/.opencode.json` configuré (provider, modèle)
- [ ] Tester `opencode -p` manuellement

## Risques et mitigations

**Pas de binaire ARM64** → OpenCode est écrit en Go, cross-compilation facile : `GOARCH=arm64 go install github.com/opencode-ai/opencode@latest`. Bloqueur si ça ne compile pas.

**Tâche qui tourne indéfiniment** → `spawnWithTimeout` envoie SIGTERM puis SIGKILL après 5s. `/opencode stop` en dernier recours. Timeout configurable (`OPENCODE_TIMEOUT_MS`).

**Consommation Copilot** → Pas de rate limiting prévu (usage personnel). À surveiller si l'usage augmente.

**Conflits de fichiers** → DevBot et BatBot pourraient modifier les mêmes fichiers simultanément. Mitigation : avertissement dans le system prompt admin ("Do NOT delegate tasks on files you are currently modifying"). L'utilisateur garde le contrôle via `/opencode` (explicite) ou la délégation BatBot (phase 2, avec consigne de prudence).

**Perte des tâches au restart** → Acceptable. Les tâches background durent quelques minutes. Si claudiscord redémarre, les subprocess sont tués — l'utilisateur relance manuellement.

**Pas de system prompt CLI** → Contourné en prepend les instructions DevBot au prompt via `getOpenCodePrompt()`. Le CLAUDE.md est chargé automatiquement via le cwd.
