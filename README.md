# Claudiscord

A single-user Discord bot that relays your messages to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or the optional [Codex CLI](https://developers.openai.com/codex/cli), with optional Docker sandboxing and a built-in job scheduler.

Works in both DMs and private guild channels. Each channel is an independent conversation (its own session, its own mode), and the channel topic is injected into the system prompt as a mini `CLAUDE.md` — perfect for per-project contexts without manual `/clear`.

## Features

- **Per-channel conversations** — each Discord channel (DM included) keeps its own active-agent session
- **Threads** — a public thread is its own fresh session (inheriting the parent channel's mode/agent/model), so you can branch into a side conversation without disturbing the main channel
- **Per-channel agent** — use Claude Code by default, or switch any channel to Codex with `/codex`
- **Channel topic = mini CLAUDE.md** — renaming or rewriting the topic immediately changes the agent's context
- **Two execution modes per channel** — `admin` runs the selected agent on the host, `sandbox` runs it in the Docker container
- **Per-channel Claude model** — pick `opus` or `sonnet` per channel with `/opus` / `/sonnet` (default `sonnet`); scheduled jobs snapshot the channel's agent and model at scheduling time
- **Global queue** — one agent prompt at a time across every channel and scheduled job (keeps jobs files race-free)
- **Single-user authorization** — only the Discord user whose ID is in `AUTHORIZED_USER_ID` can talk to the bot; everyone else is silently dropped
- **Optional Docker** — sandbox mode is disabled gracefully if Docker isn't installed; admin mode still works
- **Voice messages** — Discord voice messages (mic button) are transcribed via Groq Whisper before being passed to the active agent
- **File uploads** — drop files/photos into a channel (no text) and the bot saves them to `.claudiscord/files/`; reference them by name in your next message and the active agent reads them
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
- **Optional**: Codex CLI installed and authenticated on the host; set `CODEX_BIN` only if it isn't available as `codex` in `PATH`
- **Optional**: Docker (only required for sandbox mode)

## Installation

```bash
git clone https://github.com/baptistefetet/claudiscord.git
cd claudiscord
npm install

cp .env.example .env
# Fill DISCORD_TOKEN and AUTHORIZED_USER_ID (enable Discord Developer Mode,
# right-click your avatar → "Copy User ID"). Set CLAUDE_BIN only if claude
# isn't at ~/.local/bin/claude. Set CODEX_BIN only if Codex isn't in PATH.
# Set SANDBOX_HOME only if you plan to use sandbox mode.

# Only if you want sandbox mode:
bash scripts/rebuild-sandbox.sh
```

`rebuild-sandbox.sh` creates `SANDBOX_HOME` if needed and builds the
image with the in-container `claude` user UID/GID matching the directory's
owner, so bind-mounted files are read/write-able on both sides without
manual chown setup. After a successful rebuild, it removes dangling images
and the unused Docker build cache.

## Systemd service

Save the unit below as `/etc/systemd/system/claudiscord.service`, replacing
`/path/to/claudiscord` with your clone directory. Drop the
`Requires=docker.service` line if you don't plan to use sandbox mode.

Run the service as the account that should own host-side administration:

- `User=root` gives the bot direct root access, which is the simplest setup for
  a private machine administration bot.
- A regular user also works. Install and authenticate Claude Code/Codex for
  that user, set `User=<that-user>`, and use that user's clone directory.
  Runtime state is stored in that user's `~/.claudiscord/`.
- If a regular user is expected to administer the machine, grant it
  non-interactive sudo permissions. Password-based sudo is not suitable here:
  Claudiscord runs agents without an interactive terminal, and commands that
  wait for a password will fail or time out.
- Docker sandbox mode requires Docker access. Membership in the `docker` group
  effectively grants root-equivalent privileges on the host.

```ini
[Unit]
Description=Claudiscord - Claude Code Discord relay and scheduler
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/claudiscord
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
ExecStopPost=/bin/bash -c 'pkill -f "[c]laude.*-p" || true; pkill -f "[c]odex exec" || true'

[Install]
WantedBy=multi-user.target
```

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claudiscord
```

For a non-root service user, `/restart` runs `sudo -n systemctl restart
claudiscord`, so the sudoers rule must not require a password. For example:

```sudoers
claudiscord ALL=(ALL) NOPASSWD: ALL
```

Use a narrower sudoers rule if you want the bot to administer only specific
commands.

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
'claudiscord-sandbox' found`. If `SANDBOX_HOME` is empty or Docker
isn't installed, expect a `sandbox mode disabled` warning instead — admin
mode still works.

## Using channels

- Invite the bot to any guild channel you want (private or not — the bot only talks back to the authorized user anyway).
- Set the channel's **topic** to whatever you want the agent to keep in mind for this conversation — it's injected into the system prompt alongside the channel name.
- The first message in a new channel defaults to **admin** mode. Switch with `/sandbox` if you'd rather keep that channel to a containerized workspace.
- Claude Code is the default agent. `/codex` selects Codex in either mode; `/opus` or `/sonnet` selects Claude again.
- Codex reasoning effort is forced to `xhigh` for host and sandbox executions.

## File uploads

Drag a file or photo into a channel **without any text** and the bot saves it instead of
prompting the agent — it replies with the saved file name(s). Reference those names in your
next message and the active agent reads them from disk.

- Files land in `<home>/.claudiscord/files/`: `~/.claudiscord/files/` in admin mode,
  `SANDBOX_HOME/.claudiscord/files/` (visible in the container at
  `/home/claude/.claudiscord/files/`) in sandbox mode.
- Names are the original Discord file names, de-duplicated within a single message. A later
  upload with the same name overwrites the previous one — there is no automatic cleanup.
- A caption wins: a message carrying both text and attachments is treated as a normal
  prompt and the attachments are ignored (same rule as voice messages).

## Discord commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Reset the active agent session of the current channel |
| `/status` | Show the channel's mode, agent and runtime status |
| `/usage` | Show Claude and Codex account usage (5h window + weekly) |
| `/jobs` | List all scheduled jobs (admin first, then sandbox) |
| `/admin` | Switch the current channel to admin mode (host) |
| `/sandbox` | Switch the current channel to sandbox mode (container) |
| `/opus` | Use Claude Opus for this channel |
| `/sonnet` | Use Claude Sonnet for this channel (default) |
| `/codex` | Use Codex for this channel |
| `/upgrade` | Sandbox only — update the container (apt + Claude Code + Codex) |
| `/restart` | Admin only — restart the claudiscord service |
| `!<command>` | Run a shell command (host if the channel is admin, container if sandbox) |

## Sandbox authentication

When sandbox storage is initialized, Claudiscord copies the host credentials:

- `~/.claude/.credentials.json` to `SANDBOX_HOME/.claude/.credentials.json`
- `~/.codex/auth.json` to `SANDBOX_HOME/.codex/auth.json`

At runtime, host and sandbox share one rotating-token account, so after a
successful run their credentials are synced (newer copy wins) and a failed
sandbox run drops its own to re-seed from the host on the next run. Both files
contain secrets and are written with mode `0600`.

Authenticate Claude Code on the host before first use:

```
claude auth login
codex login
```

If host credentials are missing or invalid, sandbox initialization continues
but the corresponding agent reports an authentication error until the host is
authenticated and the missing sandbox credential can be seeded.

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `AUTHORIZED_USER_ID` | Discord user ID of the only user allowed to talk to the bot | Yes |
| `DISCORD_TOKEN` | Discord bot token | Yes |
| `CLAUDE_BIN` | Path to Claude Code binary on the host | Optional (defaults to `~/.local/bin/claude`) |
| `CODEX_BIN` | Path or command name for Codex CLI on the host | Optional (defaults to `codex`) |
| `SANDBOX_HOME` | Directory bind-mounted into the container as `/home/claude` | Optional (required only for sandbox mode) |
| `GROQ_API_KEY` | Groq API key for transcribing Discord voice messages via Whisper | Optional (voice messages ignored if unset) |
| `STT_MODEL` | Groq Whisper model id | Optional (defaults to `whisper-large-v3`) |
| `STT_LANGUAGE` | Transcription language, ISO-639-1 | Optional (defaults to `fr`) |

## License

MIT
