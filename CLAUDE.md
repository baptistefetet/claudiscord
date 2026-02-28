# Claudiscord

Daemon qui relaie les messages Discord DM vers Claude Code CLI pour l'administration système du Raspberry Pi 4.

## Architecture

Le bot Discord (batflix, www-data) et le daemon (claudiscord, root) communiquent via les fichiers `messages/{userId}.json` :

1. Bot reçoit un DM → persiste le message user dans le JSON
2. Daemon surveille le JSON avec `inotifywait`
3. Daemon détecte un nouveau message user → invoque `claude -p` (Opus, timeout 180s)
4. Daemon écrit la réponse dans le JSON
5. Bot détecte la réponse via `fs.watch` → l'envoie sur Discord

## Fichiers

| Fichier | Rôle |
|---------|------|
| `daemon.sh` | Daemon principal (inotifywait, invocation Claude Code) |
| `scheduled-runner.sh` | Runner des jobs planifiés (exécuté chaque minute par cron) |
| `notify_discord.sh` | Envoi de DM Discord via l'API REST |
| `scheduled-jobs.json` | Stockage des jobs (runtime, gitignored) |
| `.env` | Configuration locale (gitignored) |

## Variables du `.env`

```env
AUTHORIZED_USER_ID=<discord user id>
MESSAGES_DIR=<chemin vers batflix/messages>
DISCORD_TOKEN_FILE=<chemin vers batflix/.env contenant DISCORD_TOKEN>
CLAUDE_BIN=<chemin vers le binaire claude>
```

## Daemon

- **Service** : `claudiscord` (`systemctl status claudiscord`)
- **Lock** : `/tmp/claudiscord.lock` (empêche les invocations concurrentes)
- **Stderr** : `/tmp/claudiscord-stderr.log` (séparé de stdout JSON)
- **Sessions persistantes** : `--resume <sessionId>` pour conserver le contexte entre chaque message Discord. Fallback en nouvelle session si le resume échoue.
- Le `cd /root` dans daemon.sh charge automatiquement `/root/CLAUDE.md`
- `--dangerously-skip-permissions` est interdit en root → on utilise `--allowedTools`
- stdin redirigé depuis `/dev/null` (sinon Claude hang sur le pipe hérité de inotifywait)

### Format des messages (`messages/{userId}.json`)

```json
{
  "sessionId": "uuid-de-session-claude-ou-null",
  "messages": [
    {"role": "user", "content": "...", "timestamp": "..."},
    {"role": "assistant", "content": "...", "timestamp": "..."}
  ]
}
```

Réinitialisé à `{sessionId: null, messages: []}` par `/claude` et `/clear` dans Discord.

## Jobs planifiés

### Format d'un job

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
  "description": "Check santé quotidien à 7h"
}
```

### Profils d'exécution

- `admin` : accès complet (`Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task`)
- `online` : recherche web uniquement (`WebSearch, WebFetch`), zéro accès système

Le profil est déterminé automatiquement par Claude à la création du job (admin si accès système nécessaire, online sinon). L'utilisateur peut forcer le profil.

### Runner

- Cron : `/etc/cron.d/scheduled-jobs` (toutes les minutes)
- Lock par job (`/tmp/scheduled-job-<id>.lock`), timeout 300s
- Logs : `/var/log/scheduled-jobs.log` (rotation via `/etc/logrotate.d/scheduled-jobs`)
- Si `notify=true`, le runner envoie automatiquement l'output du job sur Discord via `notify_discord.sh`

### Gestion

Via Discord en langage naturel : "Crée un job...", "Liste mes jobs", "Désactive le job X", "Lance le job Y maintenant". Claude manipule `scheduled-jobs.json` directement.

## Commandes utiles

```bash
systemctl status claudiscord
journalctl -u claudiscord -f
tail -f /var/log/scheduled-jobs.log
jq '.[].id' /opt/claudiscord/scheduled-jobs.json
/opt/claudiscord/notify_discord.sh "Test"
/opt/claudiscord/scheduled-runner.sh
```
