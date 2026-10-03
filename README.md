# Claudiscord

A single-user Discord bot that drives [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and the [Codex CLI](https://developers.openai.com/codex/cli) from any Discord client, in DMs or guild channels, on a VPS or a Raspberry Pi.

- **Two agents, one interface.** `/claude` and `/codex` switch the agent answering in a channel; commands, jobs, uploads and voice work the same with both.
- **Two environments.** An `admin` channel runs the agent on the host with the service's rights. A `sandbox` channel runs it in a Docker container with its own credentials, skills and `AGENTS.md`.

## Features

- **One conversation per channel**: each channel, DM or thread has its own session, mode and agent. The channel topic is injected as standing context. Prompts are queued per channel, and different channels run in parallel.
- **Live progress** of the running prompt, which can be stopped without losing the conversation.
- **Fixed models**: prompts use the agent's high model (`opus` / `sol`), jobs the medium one (`sonnet` / `luna`), reasoning effort `xhigh`.
- **Scheduled jobs, created by asking**: "check the disk every morning and tell me only if it's above 90%" is enough. Jobs report to their channel and can stay silent when there's nothing to say.
- **Repository diff**: each channel can point at a git repository, whose uncommitted changes are published on demand as a secret gist.
- **Voice**: voice messages are transcribed (Groq Whisper). In voice channels, a realtime voice assistant (GPT-Live, on your ChatGPT subscription) holds the conversation and hands tasks to the channel's agent.
- **Uploads**: files dropped in a channel are saved to disk for the agent to use.
- **Single user**: only `AUTHORIZED_USER_ID` gets answers. Docker is optional; without it only admin mode is available.

> **Linux only** (systemd, GNU coreutils, Linux UID/GID mapping).

## Prerequisites

- Linux host, Node.js 22.12+
- A Discord bot ([Developer Portal](https://discord.com/developers/applications)):
  - **Bot** page: enable **Message Content Intent**
  - Invite link: scopes `bot` **and** `applications.commands`, permissions **View Channels**, **Send Messages**, **Read Message History** (+ **Connect**, **Speak** for voice)
- At least one agent CLI installed and authenticated on the host (the sandbox reuses the host binaries):
  - Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
  - Codex: `curl -fsSL https://chatgpt.com/codex/install.sh | sh` (the sandbox needs this installer layout; npm/brew installs work on the host only)
- Optional: Docker, for sandbox mode

## Installation

```bash
git clone https://github.com/baptistefetet/claudiscord.git
cd claudiscord
npm install
cp .env.example .env    # fill in at least DISCORD_TOKEN and AUTHORIZED_USER_ID
bash scripts/rebuild-sandbox.sh   # sandbox mode only
```

`rebuild-sandbox.sh` creates `SANDBOX_HOME` if needed and builds the image with a container user matching the directory's owner. Rerun it after replacing an agent binary, or when `/version` reports a sandbox mismatch.

On ARM64 with GCC ≥ 14, if `@discordjs/opus` fails to build: `CFLAGS="-Wno-error=implicit-function-declaration" npm install`.

## Systemd service

`/etc/systemd/system/claudiscord.service` (adjust the path; drop `Requires=docker.service` without sandbox mode):

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
ExecStopPost=-/usr/bin/docker exec claudiscord-sandbox bash -c 'for p in /proc/[0-9]*; do grep -qz CLAUDISCORD_RUN= "$${p}/environ" 2>/dev/null && kill -KILL "$${p#/proc/}" 2>/dev/null; done; true'

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claudiscord
journalctl -u claudiscord -f    # expect "Connected as YourBot#1234"
```

`User=` is the account the admin agent runs as; state goes to its `~/.claudiscord/`. A non-root user needs the agents installed for it, and **passwordless** sudo for administration and `/restart` (agents run without a terminal). Docker group membership is root-equivalent.

## Usage

New channels start in admin mode with Claude (Codex if Claude is absent). Authenticate each environment separately: pick the mode and agent, then `/login`.

| Command | Description |
|---------|-------------|
| `/new` | New conversation in this channel |
| `/stop` | Stop the running prompt (queued ones start next) |
| `/status` | Mode, agent, conversation size, runtime status |
| `/usage` | Claude and Codex account usage |
| `/version` | Agent CLI versions (warns on a stale sandbox mount) |
| `/skills` | Skills of both agents in both environments |
| `/login` | Log in the current agent in the current mode |
| `/jobs` | List scheduled jobs |
| `/git` | Set or change this channel's git repository |
| `/diff` | Uncommitted changes of that repository as a secret gist (needs `GITHUB_TOKEN`) |
| `/admin` / `/sandbox` | Switch mode (resets the session) |
| `/claude` / `/codex` | Switch agent (resets the session) |
| `/voice` | Voice channels: toggle the voice assistant |
| `/autojoin` | Voice channels: join automatically when you connect |
| `/upgrade` | Sandbox: update container packages |
| `/restart` | Admin: restart the service |
| `!<command>` | Shell command on the host or in the container |

**Jobs** run in a fresh session by default, and are limited to 1 h per run. A follow-up ("in an hour, check again") runs inside the channel's conversation instead, and is deleted if that conversation is reset (so jobs created by voice are always isolated). A job always runs in the environment of the channel that created it.

**Voice assistant** needs the host Codex ChatGPT login (`/codex` + `/login` in an admin channel). It relies on an undocumented endpoint that may break.

## Configuration (`.env`)

| Variable | Description |
|----------|-------------|
| `AUTHORIZED_USER_ID` | **Required.** Your Discord user ID |
| `DISCORD_TOKEN` | **Required.** Bot token |
| `CLAUDE_BIN` / `CODEX_BIN` | Agent paths (default `~/.local/bin/claude`, `~/.local/bin/codex`) |
| `SANDBOX_HOME` | Host dir mounted as `/home/claude`; enables sandbox mode |
| `GROQ_API_KEY` | Voice message transcription |
| `STT_MODEL` / `STT_LANGUAGE` | Whisper model / language (default `whisper-large-v3`, `fr`) |
| `GITHUB_TOKEN` | PAT with `gist` scope, required by `/diff` |

## License

MIT
