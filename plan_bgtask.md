# Plan d'intégration des tâches background dans Claudiscord

## Objectif

Permettre l'exécution de tâches en arrière-plan via la queue de jobs existante. Une tâche background est simplement un job sans `cron` : même fichier, même watcher, même exécution, même merge sandbox.

Point important sur le comportement attendu :

- **Mode admin / host** : la tâche background peut tourner en parallèle de la conversation principale, car les DM passent par `executeDM()` alors que les jobs host passent par `executeClaudeCommand()`
- **Mode sandbox** : la tâche background ne bloque pas la réponse courante qui l'a créée, mais elle **bloque les messages suivants du même utilisateur** tant qu'elle tourne, car jobs et DM sandbox partagent la même queue `executeInContainerQueued(userId, ...)`

## Concept

**Une tâche background = un job avec `cron: null`.**

```json
{
  "id": "refactor-auth",
  "prompt": "Refactor /var/www/html/badly/src/auth.js to use async/await",
  "cron": null,
  "enabled": true,
  "notify": true,
  "remaining": 1,
  "created": "2026-03-29T14:00:00Z",
  "lastRun": null,
  "description": "Refactor badly auth"
}
```

- `cron: null` → exécution immédiate (pas de scheduling cron)
- `remaining: 1` → auto-suppression après exécution (mécanisme existant)
- Tout le reste est identique aux jobs classiques
- Ordre d'exécution = ordre dans le tableau JSON

Pas de nouveau fichier, pas de nouveau module, pas de nouveau watcher.

## Architecture

```
User DM
  ├─ message normal       → exécution normale du message
  └─ BatBot délègue       → écrit N jobs cron:null dans scheduled-jobs.json
                                ↓
                          (BatBot finit sa réponse)
                                ↓
                          index.js appelle processImmediateTasks()
                                ↓
                          pickup de la 1ère tâche pending → executeJob()
                                ↓
                          notification DM → remaining: 1 → 0 → auto-supprimé
                                ↓
                          executeJob() finally rappelle processImmediateTasks()
                                ↓
                          pickup de la 2ème tâche pending → ...
                                ↓
                          (chaînage séquentiel jusqu'à épuisement de la queue)
```

**Exécution séquentielle** : une seule tâche background à la fois. Cela garantit qu'il n'y a pas de conflits entre tâches (ex: deux tâches qui modifient le même projet). L'ordre d'exécution suit l'ordre dans le tableau JSON.

**Concurrence avec la conversation** :

- **Host/admin** : oui, la tâche background est hors de la `dmQueue` et peut tourner pendant qu'une autre instance Claude traite un message
- **Sandbox** : non, la tâche background et les messages du même utilisateur passent tous deux par `executeInContainerQueued(userId, ...)` ; ils sont donc sérialisés

## Accès concurrent au fichier — Analyse et solution

### Le problème

`scheduled-jobs.json` est modifié par deux acteurs indépendants :

- **BatBot** (process `claude -p` externe) : lit le fichier, ajoute une entrée, réécrit le fichier via le Write tool
- **Claudiscord** (Node.js, dans `executeJob()` et `mergeUserJobs()`) : lit le fichier, met à jour `lastRun`/`remaining`, réécrit le fichier

Sans protection, un read-modify-write côté scheduler peut écraser un ajout de BatBot (ou inversement).

### Solution primaire : `updateJobs()` (merge-on-write optimiste)

**Déjà implémenté** dans `scheduler.js`. Toutes les écritures du scheduler (`executeJob()` finally, `mergeUserJobs()`) passent par `updateJobs()`, qui lit la version **la plus récente** du fichier juste avant d'écrire, de manière synchrone :

```javascript
function updateJobs(updateFn) {
  const jobs = loadJobs();          // re-lit la version fraîche
  const result = updateFn(jobs);    // applique les modifications
  if (result.changed) saveJobs(result.jobs);  // écrit atomiquement (tmp + rename)
  return result;
}
```

Le read → modify → write est **synchrone** (bloquant). La fenêtre de race se réduit à quelques **microsecondes** (durée du `writeFileSync`), contre plusieurs secondes avec l'ancien pattern `loadJobs()` ... logique ... `saveJobs()`. En pratique, la probabilité de collision devient quasi nulle.

### Protection complémentaire pour les tâches immédiates

`updateJobs()` protège les écritures **du scheduler**. Mais BatBot (process externe) peut toujours écrire le fichier complet via le Write tool. Scénario résiduel :

```
1. BatBot lit le fichier : [jobA, jobB]
2. jobA se termine → updateJobs() supprime jobA → fichier = [jobB]
3. BatBot écrit [jobA, jobB, taskC] (stale read) → jobA réapparaît en fantôme
```

Trois filets de sécurité pour les tâches immédiates (`cron: null`) :

**Principe 1 — Démarrage différé** : les tâches immédiates ne sont PAS déclenchées par le `fs.watch`. Elles sont démarrées uniquement **après la fin de l'exécution DM** via `processImmediateTasks()`. Au moment du pickup, BatBot a terminé d'écrire → fichier stable.

```
BatBot écrit la tâche → BatBot finit → processImmediateTasks() → pickup safe
```

**Principe 2 — `completedKeys` Set** : un `Set<string>` en mémoire stocke les clés des tâches immédiates terminées. Si une tâche réapparaît (ghost dû à un write concurrent de BatBot), elle est ignorée.

```javascript
const completedKeys = new Set();

// Avant exécution d'une tâche immédiate :
if (completedKeys.has(key)) return; // déjà exécutée, ignorer

// Après exécution (dans finally) :
completedKeys.add(key);
```

**Principe 3 — Nettoyage des fantômes** : dans `scheduleTasks()`, les tâches immédiates présentes dans `completedKeys` sont supprimées du fichier via `updateJobs()`.

### Résultat

| Scénario | Protection |
|----------|-----------|
| Scheduler et BatBot écrivent en même temps | `updateJobs()` re-lit la version fraîche → pas d'écrasement côté scheduler |
| BatBot écrit pendant le pickup d'une tâche | Impossible : pickup déclenché après fin DM (démarrage différé) |
| Tâche se termine pendant que BatBot écrit | `completedKeys` empêche la ré-exécution du fantôme |
| Tâche fantôme dans le fichier | Nettoyée par `scheduleTasks()` au prochain reload |
| Double pickup (watcher + post-DM) | `acquireJobLock()` existant empêche le doublon |

### Déclenchement de `processImmediateTasks()`

La fonction est appelée dans ces contextes :

- **Après chaque DM admin** (`index.js`, après `executeDM()`) — cas principal : BatBot vient d'écrire une tâche
- **Après chaque exécution sandbox** (`index.js`, après `executeInContainerQueued()`) — idem pour les sandbox
- **Après chaque exécution de job** (`scheduler.js`, fin de `executeJob()`) — un job cron pourrait créer une tâche immédiate
- **Au démarrage** (`scheduler.js`, dans `start()`) — pickup de tâches pending restantes

Le `fs.watch` / `scheduleTasks()` ne déclenche PAS `processImmediateTasks()` directement (il ne gère que les jobs cron). Par contre, il nettoie les fantômes via `completedKeys`.

## Modifications du code

### `src/scheduler.js` (~25 lignes ajoutées)

```javascript
// Nouveau : Set des tâches immédiates complétées
const completedKeys = new Set();

// Modifié : scheduleTasks() — séparer cron et immédiat, nettoyer fantômes via updateJobs
function scheduleTasks() {
  for (const [, task] of tasks) task.stop();
  tasks.clear();

  // Nettoyer les fantômes (tâches immédiates déjà complétées) — atomic read-modify-write
  const { jobs } = updateJobs(jobs => {
    let cleaned = false;
    for (let i = jobs.length - 1; i >= 0; i--) {
      if (jobs[i].cron === null && completedKeys.has(jobKey(jobs[i]))) {
        jobs.splice(i, 1);
        cleaned = true;
      }
    }
    return { jobs, changed: cleaned };
  });

  // Ne scheduler que les jobs avec cron
  for (const job of jobs) {
    if (!job.enabled || job.cron === null) continue;
    // ... cron.schedule() existant (inchangé)
  }
}

// Nouveau : pickup séquentiel des tâches immédiates (une seule à la fois)
function processImmediateTasks() {
  const jobs = loadJobs();

  // Trouver la première tâche immédiate pending (ordre du tableau = ordre d'exécution)
  const next = jobs.find(j => j.cron === null && j.enabled && !completedKeys.has(jobKey(j)));
  if (!next) return;

  const key = jobKey(next);
  if (!acquireJobLock(key)) return; // déjà en cours

  // Une seule tâche : executeJob() rappellera processImmediateTasks() dans son finally
  // → chaînage séquentiel automatique (tâche 1 → fin → tâche 2 → fin → ...)
  executeJob(next).catch(err => log.error(`Immediate task '${key}' error:`, err));
}

// Modifié : executeJob() finally — dans le callback updateJobs existant, ajouter :
if (job.cron === null) {
  completedKeys.add(key);
}
// Après updateJobs (toujours dans le finally) :
processImmediateTasks(); // un job (cron ou immédiat) pourrait avoir créé une nouvelle tâche

// Modifié : validateJob() — accepter cron: null
// Remplacer : if (typeof job.cron !== 'string' || !cron.validate(job.cron)) return false;
// Par :      if (job.cron !== null && (typeof job.cron !== 'string' || !cron.validate(job.cron))) return false;

// Export : ajouter processImmediateTasks
module.exports = { start, stop, mergeUserJobs, processImmediateTasks };
```

### `index.js` (~4 lignes ajoutées)

```javascript
const scheduler = require('./src/scheduler');

// Après executeDM() (dans le try, après l'envoi de la réponse) :
scheduler.processImmediateTasks();

// Après executeInContainerQueued() (même endroit) :
scheduler.processImmediateTasks();
```

### `src/prompts.js` — Mise à jour des instructions scheduling

Ajouter la documentation des tâches immédiates dans `getSchedulingPrompt()` :

```
Background tasks: to run a task after your current response ends, create a job with cron set to null and remaining set to 1. The task will be executed automatically in a separate Claude process with no access to the conversation context. The prompt must be self-contained with all necessary information. The task is auto-removed after execution. Tasks are executed sequentially (one at a time) in array order — if you create multiple tasks, they will run one after the other. In admin/host mode, this does not block the main conversation. In sandbox mode, the current response can finish first, but subsequent messages from the same user will wait until the background task completes because both use the same per-user container queue.

Background task example:
[{"id":"refactor-auth","prompt":"Refactor /var/www/html/badly/src/auth.js to use async/await. Read the file, apply changes, ensure it works.","cron":null,"enabled":true,"notify":true,"remaining":1,"created":"2026-03-29T14:00:00Z","lastRun":null,"description":"Refactor badly auth"}]
```

### System prompt de la tâche

Pas de changement : `getJobSystemPrompt()` existant est utilisé tel quel. Le `CLAUDE.md` de `/root` est chargé automatiquement (même cwd).

Le system prompt des tâches immédiates n'inclut PAS les instructions de scheduling → pas de risque de boucle (une tâche ne peut pas en créer une autre).

## Fichiers modifiés / créés

### Modifiés
- `src/scheduler.js` — `completedKeys` Set, `processImmediateTasks()`, nettoyage fantômes, validation cron null (~25 lignes)
- `src/prompts.js` — Documentation des tâches immédiates dans `getSchedulingPrompt()`
- `index.js` — Appel `processImmediateTasks()` après DM et sandbox execution (~4 lignes)

### Non modifiés
- `src/config.js` — Rien à ajouter (même fichier que les jobs)
- `src/claude.js` — Réutilisation des locks existants
- `src/container.js` — Inchangé
- `src/discord.js` — Inchangé
- `src/commands.js` — Pas de commande dédiée (BatBot gère via le fichier)
- `src/sessions.js` — Inchangé

### Pas de fichiers créés
Pas de nouveau module, pas de nouveau fichier JSON, pas de nouveau watcher.

## Plan d'implémentation

### Phase 1 — MVP

1. Modifier `validateJob()` dans `scheduler.js` pour accepter `cron: null`
2. Modifier `scheduleTasks()` pour ignorer les jobs `cron: null` (ne pas les passer à node-cron) et nettoyer les fantômes
3. Ajouter `completedKeys` Set et `processImmediateTasks()`
4. Ajouter `completedKeys.add(key)` + `processImmediateTasks()` dans `executeJob()` finally
5. Exporter `processImmediateTasks` depuis scheduler
6. Appeler `processImmediateTasks()` dans `index.js` après chaque DM/sandbox execution
7. Mettre à jour les instructions dans `getSchedulingPrompt()` (prompts.js)
8. Tester end-to-end
9. Mettre à jour `CLAUDE.md`

**Résultat** : BatBot peut créer un job `cron: null` pour déléguer une tâche. Elle s'exécute dès que BatBot finit sa réponse et le résultat arrive en DM. En mode admin/host, l'utilisateur peut continuer à discuter pendant l'exécution. En mode sandbox, les messages suivants du même utilisateur attendront la fin de la tâche.

### Phase 2 — Sandbox

Support technique partiel seulement. Le merge sandbox (`mergeUserJobs`) fonctionne tel quel : un utilisateur sandbox crée un job `cron: null, remaining: 1` dans son fichier, le merge le ramène dans le fichier central, `processImmediateTasks()` le pickup.

Mais avec l'architecture actuelle, cela **ne fournit pas un vrai background non bloquant** pour cet utilisateur :

- la réponse courante peut se terminer
- ensuite la tâche démarre dans le container
- pendant qu'elle tourne, les nouveaux messages sandbox du même utilisateur restent en queue

Donc deux options possibles :

1. **Documenter explicitement cette limite** dans `getSandboxSystemPrompt()` et accepter un "background différé mais bloquant pour les messages suivants"
2. **Faire évoluer l'architecture** pour séparer les files sandbox `chat` et `job` par utilisateur si l'objectif est un vrai parallélisme conversation + tâche

### Phase 3 — Enrichissements (optionnel)

1. Injection des résultats dans le contexte BatBot (fichier `background-results/{taskId}.md`)
2. Support d'annulation (track du child process + status "cancelled")
3. Nettoyage périodique du `completedKeys` Set (éviter fuite mémoire sur le très long terme)

## Risques et mitigations

**Race condition fichier** — Couvert par `updateJobs()` (merge-on-write optimiste, déjà implémenté) qui réduit la fenêtre de race à ~microsecondes côté scheduler. Pour les tâches immédiates, 3 filets de sécurité supplémentaires : démarrage différé (post-DM), `completedKeys` (anti ré-exécution), nettoyage fantômes (dans `scheduleTasks()`). Voir section dédiée ci-dessus.

**Tâche qui tourne indéfiniment** — `spawnWithTimeout` avec SIGTERM → SIGKILL (même timeout que les DM : `CLAUDE_TIMEOUT_MS`).

**Tâches perdues au restart** — Les tâches `cron: null` encore dans le fichier au redémarrage seront re-pickupées par `processImmediateTasks()` dans `start()`. Pas de perte.

**Conflits de fichiers source** — En mode admin/host, la tâche background et BatBot pourraient modifier les mêmes fichiers du projet simultanément. Instruction dans le system prompt : ne pas déléguer de tâches sur des fichiers en cours de modification. En mode sandbox actuel, ce risque est plus faible pour un même utilisateur car les exécutions sont sérialisées.

**Prompt autosuffisant** — La tâche n'a aucun accès au contexte de conversation. Instruction claire dans le prompt : inclure toutes les informations nécessaires.

**Boucle infinie** — Le `getJobSystemPrompt()` n'inclut PAS les instructions de scheduling → une tâche ne peut pas en créer une autre.

**Fuite mémoire `completedKeys`** — Chaque tâche immédiate ajoute une entrée au Set (jamais nettoyée en phase 1). En pratique négligeable (quelques strings par jour, uniquement les tâches `cron: null`). Phase 3 prévoit un nettoyage périodique si nécessaire.
