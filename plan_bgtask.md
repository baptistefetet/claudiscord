# Plan d'intégration des tâches background dans Claudiscord

## Objectif

Permettre l'exécution de tâches en arrière-plan via la queue de jobs existante, sans bloquer la conversation principale. Une tâche background est simplement un job sans `cron` : même fichier, même watcher, même exécution, même merge sandbox.

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
  ├─ message normal       → executeDM() avec mutex admin (inchangé)
  └─ BatBot délègue       → écrit un job cron:null dans scheduled-jobs.json
                                ↓
                          (BatBot finit sa réponse)
                                ↓
                          index.js appelle processImmediateTasks()
                                ↓
                          executeJob() HORS mutex DM (indépendant)
                                ↓
                          notification DM (succès/erreur/timeout)
                                ↓
                          remaining: 1 → 0 → job auto-supprimé
```

## Accès concurrent au fichier — Analyse et solution

### Le problème

`scheduled-jobs.json` est modifié par deux acteurs indépendants :

- **BatBot** (process `claude -p` externe) : lit le fichier, ajoute une entrée, réécrit le fichier
- **Claudiscord** (Node.js, dans `executeJob() finally`) : lit le fichier, met à jour `lastRun`/`remaining`, réécrit le fichier

Si les deux écrivent au même instant, l'un écrase les modifications de l'autre. Ce problème existe déjà avec les jobs cron mais est quasi invisible (les modifications se chevauchent rarement). Avec les tâches immédiates, le risque augmente car l'exécution est déclenchée par une écriture de BatBot.

### Scénario de race condition

```
1. BatBot lit le fichier : [jobA, jobB]
2. jobA se termine → scheduler lit [jobA, jobB], supprime jobA, écrit [jobB]
3. BatBot écrit [jobA, jobB, taskC]  (il avait lu avant la suppression)
4. jobA réapparaît avec remaining: 0 → traité comme job infini → ré-exécution en boucle !
```

### Solution : démarrage différé + tracking en mémoire

**Principe 1 — Démarrage différé** : les tâches immédiates (`cron: null`) ne sont PAS déclenchées par le `fs.watch`. Elles sont démarrées uniquement **après la fin de l'exécution DM** de BatBot, via un appel explicite `processImmediateTasks()` depuis `index.js`. Ainsi, au moment du pickup, BatBot a terminé d'écrire → le fichier est dans un état stable.

```
BatBot écrit la tâche → BatBot finit → processImmediateTasks() → pickup safe
```

**Principe 2 — `completedKeys` Set** : un `Set<string>` en mémoire dans le scheduler stocke les clés des tâches immédiates terminées. Si une tâche supprimée réapparaît dans le fichier (à cause d'un write concurrent de BatBot), le scheduler l'ignore.

```javascript
const completedKeys = new Set();

// Avant exécution d'une tâche immédiate :
if (completedKeys.has(key)) return; // déjà exécutée, ignorer

// Après exécution (dans finally) :
completedKeys.add(key);
```

**Principe 3 — Nettoyage des fantômes** : dans `scheduleTasks()` (appelée par fs.watch à chaque modification du fichier), les tâches immédiates présentes dans `completedKeys` sont supprimées du fichier. Cela nettoie les éventuels fantômes laissés par un write concurrent.

```javascript
// Dans scheduleTasks(), après le chargement :
const jobs = loadJobs();
let cleaned = false;
for (let i = jobs.length - 1; i >= 0; i--) {
  if (jobs[i].cron === null && completedKeys.has(jobKey(jobs[i]))) {
    jobs.splice(i, 1);
    cleaned = true;
  }
}
if (cleaned) saveJobs(jobs);
```

### Résultat : sécurité complète

| Scénario | Protection |
|----------|-----------|
| BatBot écrit pendant le pickup | Impossible : pickup déclenché après fin DM |
| Tâche se termine pendant que BatBot écrit | `completedKeys` empêche la ré-exécution |
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

// Modifié : scheduleTasks() — séparer cron et immédiat
function scheduleTasks() {
  for (const [, task] of tasks) task.stop();
  tasks.clear();

  const jobs = loadJobs();

  // Nettoyer les fantômes (tâches immédiates déjà complétées)
  let cleaned = false;
  for (let i = jobs.length - 1; i >= 0; i--) {
    if (jobs[i].cron === null && completedKeys.has(jobKey(jobs[i]))) {
      jobs.splice(i, 1);
      cleaned = true;
    }
  }
  if (cleaned) saveJobs(jobs);

  // Ne scheduler que les jobs avec cron
  for (const job of jobs) {
    if (!job.enabled || job.cron === null) continue;
    // ... cron.schedule() existant (inchangé)
  }
}

// Nouveau : pickup des tâches immédiates
function processImmediateTasks() {
  const jobs = loadJobs();

  for (const job of jobs) {
    if (job.cron !== null || !job.enabled) continue;

    const key = jobKey(job);
    if (completedKeys.has(key)) continue;
    if (!acquireJobLock(key)) continue;

    // Fire-and-forget : executeJob gère tout (exécution, notification, remaining, cleanup)
    executeJob(job).catch(err => log.error(`Immediate task '${key}' error:`, err));
  }
}

// Modifié : executeJob() finally — ajouter au completedKeys si immédiat + appeler processImmediateTasks
// (dans le bloc finally existant, après saveJobs)
if (job.cron === null) {
  completedKeys.add(key);
}
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
Background tasks: to run a task in the background without blocking the conversation, create a job with cron set to null and remaining set to 1. The task will be executed automatically after your current response ends, in a separate Claude process with no access to the conversation context. The prompt must be self-contained with all necessary information. The task is auto-removed after execution.

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

**Résultat** : BatBot peut créer un job `cron: null` pour déléguer une tâche. Elle s'exécute dès que BatBot finit sa réponse. Le résultat arrive en DM. L'utilisateur peut continuer à discuter.

### Phase 2 — Sandbox

Déjà supporté ! Le merge sandbox (`mergeUserJobs`) fonctionne tel quel : un utilisateur sandbox crée un job `cron: null, remaining: 1` dans son fichier, le merge le ramène dans le fichier central, `processImmediateTasks()` le pickup.

Seul ajout : documenter les tâches immédiates dans `getSandboxSystemPrompt()`.

### Phase 3 — Enrichissements (optionnel)

1. Injection des résultats dans le contexte BatBot (fichier `background-results/{taskId}.md`)
2. Support d'annulation (track du child process + status "cancelled")
3. Nettoyage périodique du `completedKeys` Set (éviter fuite mémoire sur le très long terme)

## Risques et mitigations

**Race condition fichier** — Couvert par la solution en 3 couches : démarrage différé (post-DM), `completedKeys` (anti ré-exécution), nettoyage fantômes (dans `scheduleTasks()`). Voir section dédiée ci-dessus.

**Tâche qui tourne indéfiniment** — `spawnWithTimeout` avec SIGTERM → SIGKILL (même timeout que les DM : `CLAUDE_TIMEOUT_MS`).

**Tâches perdues au restart** — Les tâches `cron: null` encore dans le fichier au redémarrage seront re-pickupées par `processImmediateTasks()` dans `start()`. Pas de perte.

**Conflits de fichiers source** — La tâche background et BatBot pourraient modifier les mêmes fichiers du projet simultanément. Instruction dans le system prompt : ne pas déléguer de tâches sur des fichiers en cours de modification.

**Prompt autosuffisant** — La tâche n'a aucun accès au contexte de conversation. Instruction claire dans le prompt : inclure toutes les informations nécessaires.

**Boucle infinie** — Le `getJobSystemPrompt()` n'inclut PAS les instructions de scheduling → une tâche ne peut pas en créer une autre.

**Fuite mémoire `completedKeys`** — Chaque tâche ajoute une entrée au Set (jamais nettoyée en phase 1). En pratique négligeable (quelques strings par jour). Phase 3 prévoit un nettoyage périodique si nécessaire.
