# Claudiscord

Relay Discord DM vers Claude Code CLI + scheduler de jobs planifies. Un seul process Node.js.

## Architecture

```
Discord DM -> [index.js] --spawn--> claude -p -> reponse Discord
                  |-- scheduler interne --spawn--> claude -p -> DM notification
```

- DM : le prompt va en memoire a `executeDM()`, la reponse repart sur Discord
- Jobs : `node-cron` declenche `executeJob()`, output envoye par DM si `notify: true`
- Sessions : `sessions.json` stocke uniquement les session IDs (pas d'historique de messages)
- Mutex DM : un seul Claude a la fois pour les DM (queue en memoire)
- Mutex jobs : un lock par job ID (Set en memoire)

## Fichiers

```
index.js              # Point d'entree, handler Discord, shutdown
src/
  config.js           # .env + constantes + system prompt + profils
  logger.js           # Logging stdout/stderr (journald)
  discord.js          # Client Discord, sendDM, splitMessage, typing
  claude.js           # Spawn claude CLI, mutex DM, locks jobs
  sessions.js         # Map memoire + persistence sessions.json
  scheduler.js        # node-cron, reload auto, executeJob
  commands.js         # /clear (et futur /sandbox)
sessions.json         # { userId: sessionId } (gitignored)
scheduled-jobs.json   # Jobs planifies (gitignored)
.env                  # AUTHORIZED_USER_ID, CLAUDE_BIN, BATBOT_DISCORD_TOKEN
```

## Service

- **Service** : `claudiscord` (`systemctl status claudiscord`)
- **Logs** : `journalctl -u claudiscord -f`
- **ExecStopPost** : `pkill -f "claude.*-p"` (filet de securite)

## Claude CLI

- `claude -p` avec `--output-format json` (DM) ou `text` (jobs)
- `--resume <sessionId>` pour les DM, fallback en nouvelle session si echec
- `--allowedTools` selon le profil (admin ou online)
- `--model opus`
- stdin ferme immediatement (`child.stdin.end()`)
- cwd: `/root` (charge automatiquement `/root/CLAUDE.md`)
- Timeout: 300s (SIGTERM puis SIGKILL apres 5s)

## Commandes Discord

- `/clear` : reinitialise la session (admin only)

## Jobs planifies

Format dans `scheduled-jobs.json` :
```json
{
  "id": "check-system",
  "prompt": "...",
  "cron": "0 7 * * *",
  "profile": "admin",
  "enabled": true,
  "notify": false,
  "created": "2026-02-21T10:00:00Z",
  "lastRun": null,
  "description": "Check sante quotidien a 7h"
}
```

### Profils

- `admin` : `Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task`
- `online` : `WebSearch WebFetch`

### Comportement

- `node-cron` pour le scheduling (plus de cron systeme)
- Lock en memoire par job ID
- Protection doublon dans la meme minute
- `fs.watch()` sur `scheduled-jobs.json` avec debounce 2s pour recharger automatiquement
- Jobs ephemeres (pas de session persistante)
- Si `notify: true`, output envoye par DM Discord

## Variables .env

```env
AUTHORIZED_USER_ID=<discord user id>
CLAUDE_BIN=<chemin vers le binaire claude>
BATBOT_DISCORD_TOKEN=<token du bot Discord>
```
