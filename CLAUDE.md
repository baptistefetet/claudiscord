# Claudiscord

Système d'administration via Discord DM, composé de deux processus :

- **BatBot** (`batbot.service`, Node.js) : bot Discord qui reçoit les DMs et relaie les messages vers le daemon
- **Daemon** (`claudiscord.service`, bash) : surveille les fichiers JSON et invoque Claude Code CLI

## Architecture

1. BatBot reçoit un DM → persiste le message user dans `messages/{userId}.json`
2. Daemon surveille le JSON avec `inotifywait`
3. Daemon détecte un nouveau message user → invoque `claude -p` (Opus, timeout 300s)
4. Daemon écrit la réponse dans le JSON
5. BatBot détecte la réponse via `fs.watch` → l'envoie sur Discord

## Fichiers

| Fichier | Rôle |
|---------|------|
| `bot.js` | Bot Discord Node.js (DM only, relay vers daemon) |
| `package.json` | Dépendances Node.js (discord.js, dotenv) |
| `daemon.sh` | Daemon principal (inotifywait, invocation Claude Code) |
| `scheduled-runner.sh` | Runner des jobs planifiés (exécuté chaque minute par cron) |
| `notify_discord.sh` | Envoi de DM Discord via l'API REST (utilise BATBOT_DISCORD_TOKEN) |
| `scheduled-jobs.json` | Stockage des jobs (runtime, gitignored) |
| `messages/` | Fichiers JSON de conversation par userId (gitignored) |
| `.env` | Configuration locale (gitignored) |

## Variables du `.env`

```env
AUTHORIZED_USER_ID=<discord user id>
MESSAGES_DIR=<chemin vers le dossier messages/>
DISCORD_TOKEN_FILE=<chemin vers un fichier contenant BATBOT_DISCORD_TOKEN=...>
CLAUDE_BIN=<chemin vers le binaire claude>
BATBOT_DISCORD_TOKEN=<token du bot Discord BatBot>
```

## BatBot (bot.js)

- **Service** : `batbot` (`systemctl status batbot`)
- **Token** : `BATBOT_DISCORD_TOKEN` dans `.env`
- DM uniquement (ignore les mentions serveur)
- Seule commande : `/clear` (réinitialise sessionId + messages)
- Tourne en root (même owner que daemon.sh et les fichiers messages)

## Daemon (daemon.sh)

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

Réinitialisé à `{sessionId: null, messages: []}` par `/clear` dans Discord.

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
- **Important** : Les jobs planifiés sont "fire and forget". Chaque job est une session Claude éphémère (`claude -p`), sans lien avec le daemon ni les conversations Discord. Si un utilisateur répond sur Discord à la notification d'un job, le daemon traitera ce message dans sa propre session sans aucun contexte de ce que le job a produit.

### Gestion

Via Discord en langage naturel : "Crée un job...", "Liste mes jobs", "Désactive le job X", "Lance le job Y maintenant". Claude manipule `scheduled-jobs.json` directement.

## Commandes utiles

```bash
systemctl status batbot
systemctl status claudiscord
journalctl -u batbot -f
journalctl -u claudiscord -f
tail -f /var/log/scheduled-jobs.log
jq '.[].id' /opt/claudiscord/scheduled-jobs.json
/opt/claudiscord/notify_discord.sh "Test"
/opt/claudiscord/scheduled-runner.sh
```
