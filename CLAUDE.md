# Claudiscord

Relay Discord DM vers Claude Code CLI + scheduler de jobs planifies. Un seul process Node.js.

## Architecture

```
DM (admin, mode sandbox = defaut)
  -> executeInContainerQueued(userId, prompt) -> docker exec -> claude -p -> Discord

DM (admin, mode admin via /admin)
  -> executeDM(prompt) -> spawn direct hote (comportement Phase 1)

Jobs planifies (scheduler)
  -> executeClaudeCommand() -> toujours sur l'hote (inchange)
```

- DM : le prompt va en memoire, la reponse repart sur Discord
- Jobs : `node-cron` declenche `executeJob()`, output envoye par DM si `notify: true`
- Sessions : `sessions.json` stocke uniquement les session IDs (pas d'historique de messages)
- Mutex DM admin : un seul Claude a la fois pour les DM hote (queue en memoire)
- Mutex sandbox : un lock par userId (Map de Promise queues), concurrent entre utilisateurs
- Mutex jobs : un lock par job ID (Set en memoire)

## Fichiers

```
index.js              # Point d'entree, handler Discord, routing mode, shutdown
Dockerfile            # Image sandbox (node:22-slim + claude CLI + user claude)
rebuild-sandbox.sh    # Script rebuild image + recreation containers (job mensuel)
src/
  config.js           # .env + constantes + system prompt + Docker config
  logger.js           # Logging stdout/stderr (journald)
  discord.js          # Client Discord, sendDM, splitMessage, typing
  claude.js           # Spawn claude CLI hote, mutex DM, locks jobs
  container.js        # Docker : ensureImage, ensureContainer, executeInContainer, credentials, rebuild
  mode.js             # Persistance admin/sandbox mode (admin-mode.json)
  sessions.js         # Map memoire + persistence sessions.json
  scheduler.js        # node-cron, reload auto, executeJob
  commands.js         # /clear, /admin, /login, /status
sessions.json         # { userId: sessionId } (gitignored)
scheduled-jobs.json   # Jobs planifies (gitignored)
admin-mode.json       # { adminMode: bool } (gitignored)
.env                  # AUTHORIZED_USER_ID, CLAUDE_BIN, DISCORD_TOKEN, DATA_DIR
```

## Service

- **Service** : `claudiscord` (`systemctl status claudiscord`)
- **Logs** : `journalctl -u claudiscord -f`
- **Dependance** : `docker.service` (Requires + After)
- **ExecStopPost** : `pkill -f "claude.*-p"` (filet de securite)

## Modes

- **sandbox** (defaut) : DM admin executes dans un container Docker isole
- **admin** : DM admin executes directement sur l'hote (acces systeme complet)
- Toggle via `/admin`, persiste dans `admin-mode.json`
- Le toggle clear automatiquement la session (contextes incompatibles)

## Docker Sandbox

- **Image** : `claudiscord-sandbox` (build local arm64, `node:22-slim` + Claude Code)
- **Container** : `claudiscord-{userId}`, un par utilisateur, persistant (`--restart unless-stopped`)
- **Limites** : 512 Mo RAM, 1 CPU
- **Volume** : `DATA_DIR/{userId}/home` -> `/home/claude`
- **Reseau** : bridge (acces internet pour l'API Claude)
- **User** : `claude` (non-root, requis pour `--dangerously-skip-permissions`)
- **CMD** : `sleep infinity` (container alive, commandes via `docker exec`)

### Stockage sandbox

```
/mnt/maxtor/claudiscord/    # DATA_DIR (.env)
  {userId}/
    home/                    # Volume monte comme /home/claude dans le container
      CLAUDE.md              # Personnalisable par l'utilisateur
      .claude/               # Auth state (cree par claude auth login)
      .claudiscord/           # Donnees internes claudiscord
        scheduled-jobs.json  # Jobs planifies de l'utilisateur
```

### Rebuild image

Rebuild manuel (ou via le job `rebuild-sandbox` le 1er du mois a 4h) :
```bash
bash /opt/claudiscord/rebuild-sandbox.sh
```
Le script stoppe les containers, rebuild l'image, et nettoie. Les containers sont recrees automatiquement au prochain usage (volumes preserves).

## Claude CLI

- `claude -p` avec `--output-format json` (DM) ou `text` (jobs)
- `--resume <sessionId>` pour les DM, fallback en nouvelle session si echec
- `--allowedTools` selon le contexte (admin sur hote, sandbox dans container)
- `--dangerously-skip-permissions` en sandbox (le container EST le sandbox)
- `--model opus`
- stdin ferme immediatement (`child.stdin.end()`)
- cwd hote: `/root` (charge automatiquement `/root/CLAUDE.md`)
- cwd sandbox: `/home/claude` (charge le CLAUDE.md du volume)
- Timeout: 300s (SIGTERM puis SIGKILL apres 5s)

## Commandes Discord

| Commande | Qui | Action |
|----------|-----|--------|
| `/help` | tous | Affiche les commandes disponibles |
| `/clear` | tous | Reset session Claude |
| `/upgrade` | tous | Met a jour Claude Code dans le container sandbox |
| `/admin` | admin | Toggle admin/sandbox, clear session |
| `/login` | tous | Sans arg: instructions. Avec JSON: enregistre les credentials |
| `/status` | admin | Affiche le mode actuel |

## Jobs planifies

Tous les utilisateurs (admin et sandbox) peuvent creer des jobs planifies.

### Format

Le fichier central est `scheduled-jobs.json` (admin). Les users sandbox ecrivent dans `/home/claude/.claudiscord/scheduled-jobs.json` dans leur container ; leurs jobs sont merges automatiquement dans le fichier central apres chaque execution.

```json
{
  "id": "check-system",
  "userId": null,
  "prompt": "...",
  "cron": "0 7 * * *",
  "enabled": true,
  "notify": true,
  "notifyPattern": "STATUT: PROBLEME",
  "created": "2026-02-21T10:00:00Z",
  "lastRun": null,
  "description": "Check sante quotidien a 7h"
}
```

- `userId` : `null` = job admin (hote), Discord user ID = job sandbox (container)
- Cle unique : `userId` + `id` (deux users peuvent avoir le meme `id`)

### Merge sandbox

Apres chaque execution de Claude dans un container, `mergeUserJobs(userId)` :
1. Lit `DATA_DIR/{userId}/home/scheduled-jobs.json`
2. Valide chaque job (champs requis, cron valide). Nettoie le fichier si invalide.
3. Compare avec les jobs du user dans le fichier central :
   - Jobs nouveaux → ajoutes (avec `userId` stampe)
   - Jobs modifies → mis a jour (preserve `lastRun`)
   - Jobs supprimes par le user → retires du central
4. Sauvegarde le fichier central. `fs.watch` declenche le rechargement du scheduler.

### Execution

- `userId: null` → hote, tous les outils admin (`Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task`)
- `userId: <id>` → container de l'utilisateur, tous les outils sandbox (`--dangerously-skip-permissions`)
- Tous les outils sont toujours disponibles dans l'environnement d'execution

### Comportement

- `node-cron` pour le scheduling
- Lock en memoire par job key (`userId:id` ou `id` seul pour admin)
- Protection doublon dans la meme minute
- `fs.watch()` sur `scheduled-jobs.json` avec debounce 2s pour recharger automatiquement
- Jobs ephemeres (pas de session persistante)
- Si `notify: true`, output envoye par DM au `userId` du job (ou admin si `null`). Filtre par `notifyPattern` si present.

## Variables .env

```env
AUTHORIZED_USER_ID=<discord user id>
CLAUDE_BIN=<chemin vers le binaire claude>
DISCORD_TOKEN=<token du bot Discord>
DATA_DIR=/mnt/maxtor/claudiscord
```
