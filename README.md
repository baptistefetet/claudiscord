# Claudiscord

A single-user Discord bot that relays your messages to [Claude Code](https://docs.anthropic.com/en/docs/claude-code), with optional Docker sandboxing and a built-in job scheduler.

Works in both DMs and private guild channels. Each channel is an independent conversation (its own session, its own mode), and the channel topic is injected into the system prompt as a mini `CLAUDE.md` — perfect for per-project contexts without manual `/clear`.

## Features

- **Per-channel conversations** — each Discord channel (DM included) keeps its own Claude session
- **Channel topic = mini CLAUDE.md** — renaming or rewriting the topic immediately changes the agent's context
- **Two execution modes per channel** — `admin` runs Claude on the host (full system access), `sandbox` runs it in the Docker container
- **Global queue** — one Claude prompt at a time across every channel and scheduled job (keeps jobs files race-free)
- **Bootstrap on first DM** — leave `AUTHORIZED_USER_ID` empty in `.env` and the first person to DM the bot is registered as the only authorized user
- **Optional Docker** — sandbox mode is disabled gracefully if Docker isn't installed; admin mode still works
- **Scheduler** — cron-based jobs via `node-cron`, notifications delivered to the channel where the job was created

## Prerequisites

- Node.js 18+
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- On the portal **Bot** page: enable the **Message Content Intent**
- On the portal **Installation / Bot** page: in addition to `Direct Messages` grant the **Guilds** and **Guild Messages** privileges so the bot can read the channels you invite it to
- Claude Code CLI installed on the host (`curl -fsSL https://claude.ai/install.sh | bash`)
- **Optional**: Docker (only required for sandbox mode)

## Installation

```bash
git clone https://github.com/baptistefetet/claudiscord.git
cd claudiscord
npm install

cp .env.example .env
# Fill DISCORD_TOKEN, CLAUDE_BIN, SANDBOX_HOME_DIR.
# Leave AUTHORIZED_USER_ID empty to bootstrap on first DM.

# Only if you want sandbox mode:
docker build -t claudiscord-sandbox .
mkdir -p "$SANDBOX_HOME_DIR"
```

## Systemd service

```ini
[Unit]
Description=Claudiscord - Claude Code Discord relay and scheduler
After=network.target docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/claudiscord
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
ExecStopPost=/bin/bash -c 'pkill -f "claude.*-p" || true'

[Install]
WantedBy=multi-user.target
```

The service needs to run as root (or any user with write access to `.env`) so that the first-DM bootstrap can persist `AUTHORIZED_USER_ID`.

## First run / bootstrap

1. Start the service with `AUTHORIZED_USER_ID=` empty in `.env`.
2. Send the bot a DM from your personal Discord account.
3. The bot writes your Discord user ID into `.env` and answers that first message normally.
4. Every subsequent message from any other user is silently ignored, both in DMs and in channels the bot has been invited to.

If you'd rather skip the bootstrap, just put your Discord user ID directly in `AUTHORIZED_USER_ID` before starting.

## Using channels

- Invite the bot to any guild channel you want (private or not — the bot only talks back to the authorized user anyway).
- Set the channel's **topic** to whatever you want Claude to keep in mind for this conversation — it's injected into the system prompt alongside the channel name.
- The first message in a new channel defaults to **admin** mode. Switch with `/sandbox` if you'd rather keep that channel to a containerized workspace.

## Discord commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Reset the Claude session of the current channel |
| `/status` | Show the channel's mode and sandbox authentication status |
| `/admin` | Switch the current channel to admin mode (host) |
| `/sandbox` | Switch the current channel to sandbox mode (container) |
| `/upgrade` | Sandbox only — update the container (apt + Claude Code) |
| `/login` | Sandbox only — show auth instructions, or `/login <json>` to save credentials |
| `/restart` | Admin only — restart the claudiscord service |
| `!<command>` | Run a shell command (host if the channel is admin, container if sandbox) |

## Sandbox authentication

Run `claude auth login` on your own machine, then send the credentials to the bot **inside a sandbox-mode channel**:

```
/login {"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":...}}
```

Credentials are written to `SANDBOX_HOME_DIR/.claude/.credentials.json` and the message carrying them is deleted automatically.

**Where to find credentials:**
- **Linux**: `cat ~/.claude/.credentials.json`
- **Mac**: `security find-generic-password -s "claude-credentials" -w`
- **Windows**: `type %USERPROFILE%\.claude\.credentials.json`

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `AUTHORIZED_USER_ID` | Discord user ID of the authorized user | Optional (bootstrapped on first DM if empty) |
| `DISCORD_TOKEN` | Discord bot token | Yes |
| `CLAUDE_BIN` | Path to Claude Code binary on the host | Yes |
| `SANDBOX_HOME_DIR` | Directory bind-mounted into the container as `/home/claude` | Yes |

## License

MIT
