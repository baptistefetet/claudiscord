# Claudiscord

A Discord bot that relays DMs to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI, with Docker sandboxing and a built-in job scheduler.

Each user gets an isolated Docker container with Claude Code. The admin can also run commands directly on the host.

## Features

- **Discord DM relay** -- send a message, get a Claude Code response
- **Docker sandbox** -- each user runs in their own isolated container (512 MB RAM, 1 CPU)
- **Admin mode** -- toggle between sandbox (container) and admin (host) for system access
- **Session persistence** -- conversations are resumed across messages via `--resume`
- **Job scheduler** -- cron-based jobs with `node-cron`, auto-reload on file change
- **Monthly image rebuild** -- keeps Claude Code up to date in containers

## Prerequisites

- Node.js 18+
- Docker
- Claude Code CLI installed on the host (`curl -fsSL https://claude.ai/install.sh | bash`)
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))

## Installation

```bash
# Clone
git clone https://github.com/baptistefetet/claudiscord.git /var/www/html/claudiscord
cd /var/www/html/claudiscord

# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env: set AUTHORIZED_USER_ID, CLAUDE_BIN, DISCORD_TOKEN, DATA_DIR

# Build the sandbox Docker image
docker build -t claudiscord-sandbox .

# Copy example scheduled jobs (optional)
cp scheduled-jobs.example.json scheduled-jobs.json

# Create the data directory for sandbox volumes
mkdir -p /mnt/maxtor/claudiscord  # or wherever DATA_DIR points
```

## Systemd service

```bash
cat > /etc/systemd/system/claudiscord.service << 'EOF'
[Unit]
Description=Claudiscord - Claude Code Discord relay and scheduler
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/var/www/html/claudiscord
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
ExecStopPost=/bin/bash -c 'pkill -f "claude.*-p" || true'

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now claudiscord
```

## Discord commands

| Command | Who | Description |
|---------|-----|-------------|
| `/help` | everyone | Show available commands |
| `/clear` | everyone | Reset Claude session |
| `/upgrade` | everyone | Update Claude Code in the sandbox container |
| `/admin` | admin | Toggle admin (host) / sandbox (container) mode |
| `/login` | everyone | Without args: show auth instructions. With JSON: save credentials |
| `/status` | admin | Show current mode and auth status |

## Authentication

Users authenticate by running `claude auth login` on their own machine, then sending their credentials to the bot:

```
/login {"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":...}}
```

Credentials are stored in the user's persistent volume and the message is deleted automatically.

**Where to find credentials:**
- **Linux**: `cat ~/.claude/.credentials.json`
- **Mac**: `security find-generic-password -s "claude-credentials" -w`
- **Windows**: `type %USERPROFILE%\.claude\.credentials.json`

## Scheduled jobs

Jobs are defined in `scheduled-jobs.json` (see `scheduled-jobs.example.json` for examples). The file is watched and auto-reloaded on change.

```json
{
  "id": "my-job",
  "userId": null,
  "prompt": "The prompt Claude Code will execute",
  "cron": "0 7 * * *",
  "enabled": true,
  "notify": true,
  "created": "2026-01-01T00:00:00Z",
  "lastRun": null,
  "description": "Short description"
}
```

- `userId: null` → runs on host with full system access
- `userId: "<discord id>"` → runs in user's sandbox container
- Sandbox users manage their jobs in `/home/claude/.claudiscord/scheduled-jobs.json`, automatically merged after each execution.

## Architecture

```
DM (sandbox mode, default)
  -> Docker container -> claude -p -> Discord

DM (admin mode)
  -> host -> claude -p -> Discord

Scheduled jobs
  -> host -> claude -p -> DM notification (if notify: true)
```

- One container per user (`claudiscord-{userId}`), persistent (`--restart unless-stopped`)
- Volumes in `DATA_DIR/{userId}/home/` mounted as `/home/claude` (credentials, files, CLAUDE.md)
- Containers survive reboots and service restarts
- Monthly image rebuild updates Claude Code without losing user data

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTHORIZED_USER_ID` | Discord user ID of the admin | required |
| `DISCORD_TOKEN` | Discord bot token | required |
| `CLAUDE_BIN` | Path to Claude Code binary | required |
| `DATA_DIR` | Directory for sandbox user volumes | required |

## License

MIT
