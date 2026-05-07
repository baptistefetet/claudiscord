# Claudiscord

A single-user Discord bot that relays your messages to [Claude Code](https://docs.anthropic.com/en/docs/claude-code), with optional Docker sandboxing and a built-in job scheduler.

Works in both DMs and private guild channels. Each channel is an independent conversation (its own session, its own mode), and the channel topic is injected into the system prompt as a mini `CLAUDE.md` — perfect for per-project contexts without manual `/clear`.

## Features

- **Per-channel conversations** — each Discord channel (DM included) keeps its own Claude session
- **Channel topic = mini CLAUDE.md** — renaming or rewriting the topic immediately changes the agent's context
- **Two execution modes per channel** — `admin` runs Claude on the host (full system access), `sandbox` runs it in the Docker container
- **Global queue** — one Claude prompt at a time across every channel and scheduled job (keeps jobs files race-free)
- **Single-user authorization** — only the Discord user whose ID is in `AUTHORIZED_USER_ID` can talk to the bot; everyone else is silently dropped
- **Optional Docker** — sandbox mode is disabled gracefully if Docker isn't installed; admin mode still works
- **Voice messages** — Discord voice messages (mic button) are transcribed via Groq Whisper before being passed to Claude
- **Scheduler** — cron-based jobs via `node-cron`, notifications delivered to the channel where the job was created

> **Linux only.** Claudiscord ships a systemd unit, expects GNU coreutils,
> and the sandbox aligns UIDs/GIDs the Linux way. macOS and Windows are
> not supported.

## Prerequisites

- Linux host (systemd recommended)
- Node.js 18+
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- On the portal **Bot** page: enable the **Message Content Intent**
- On the portal **Installation / Bot** page: in addition to `Direct Messages` grant the **Guilds** and **Guild Messages** privileges so the bot can read the channels you invite it to
- Claude Code CLI installed on the host (`curl -fsSL https://claude.ai/install.sh | bash`) — claudiscord defaults to `~/.local/bin/claude` (the install script's default location); set `CLAUDE_BIN` in `.env` only if it's elsewhere
- **Optional**: Docker (only required for sandbox mode)

## Installation

```bash
git clone https://github.com/baptistefetet/claudiscord.git
cd claudiscord
npm install

cp .env.example .env
# Fill DISCORD_TOKEN and AUTHORIZED_USER_ID (enable Discord Developer Mode,
# right-click your avatar → "Copy User ID"). Set CLAUDE_BIN only if claude
# isn't at ~/.local/bin/claude. Set SANDBOX_HOME_DIR only if you plan to
# use sandbox mode.

# Only if you want sandbox mode:
bash scripts/rebuild-sandbox.sh
```

`rebuild-sandbox.sh` creates `SANDBOX_HOME_DIR` if needed and builds the
image with the in-container `claude` user UID/GID matching the directory's
owner, so bind-mounted files are read/write-able on both sides without
manual chown setup.

## Systemd service

Save the unit below as `/etc/systemd/system/claudiscord.service`, replacing
`/path/to/claudiscord` with your clone directory. Drop the
`Requires=docker.service` line if you don't plan to use sandbox mode.

```ini
[Unit]
Description=Claudiscord - Claude Code Discord relay and scheduler
After=network.target docker.service
Requires=docker.service

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

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claudiscord
```

## Verify the install

```bash
journalctl -u claudiscord -f
```

You should see something like:

```
[claudiscord] Loaded N channel session(s)
[claudiscord] Discord client connected as YourBot#1234
[claudiscord] Connected as YourBot#1234
[claudiscord] Scheduler reloaded: 0 active job(s)
```

If sandbox mode is configured you'll also see `Docker image
'claudiscord-sandbox' found`. If `SANDBOX_HOME_DIR` is empty or Docker
isn't installed, expect a `sandbox mode disabled` warning instead — admin
mode still works.

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

**Where to find credentials** (on the Linux box where you ran `claude auth login`):

```
cat ~/.claude/.credentials.json
```

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `AUTHORIZED_USER_ID` | Discord user ID of the only user allowed to talk to the bot | Yes |
| `DISCORD_TOKEN` | Discord bot token | Yes |
| `CLAUDE_BIN` | Path to Claude Code binary on the host | Optional (defaults to `~/.local/bin/claude`) |
| `SANDBOX_HOME_DIR` | Directory bind-mounted into the container as `/home/claude` | Optional (required only for sandbox mode) |
| `GROQ_API_KEY` | Groq API key for transcribing Discord voice messages via Whisper | Optional (voice messages ignored if unset) |
| `STT_MODEL` | Groq Whisper model id | Optional (defaults to `whisper-large-v3`) |
| `STT_LANGUAGE` | Transcription language, ISO-639-1 | Optional (defaults to `fr`) |

## License

MIT
