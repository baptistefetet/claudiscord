# Claudiscord

A single-user Discord bot that relays your messages to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or the optional [Codex CLI](https://developers.openai.com/codex/cli), with optional Docker sandboxing and a built-in job scheduler.

Works in both DMs and private guild channels. Each channel is an independent conversation (its own session, its own mode), and the channel topic is injected into the system prompt as a mini `CLAUDE.md` — perfect for per-project contexts without manual `/new`.

## Features

- **Per-channel conversations** — each Discord channel (DM included) keeps its own active-agent session
- **Threads** — a public thread is its own fresh session (inheriting the parent channel's mode/agent), so you can branch into a side conversation without disturbing the main channel
- **Per-channel agent** — use Claude Code by default, or switch any channel to Codex with `/codex`; `/claude` switches back
- **Channel topic = mini CLAUDE.md** — renaming or rewriting the topic immediately changes the agent's context
- **Two execution modes per channel** — `admin` runs the selected agent on the host, `sandbox` runs it in the Docker container
- **Two model tiers per agent** — your prompts always run the agent's high model (Claude `opus`, Codex `gpt-5.6-sol`), scheduled jobs always run its medium one (`sonnet` / `gpt-5.6-terra`); reasoning effort is `xhigh` everywhere. Nothing to pick, nothing to configure
- **Live progress** — while a prompt runs, a single message shows the tool the agent is using or what it is saying, updated in place and removed once the answer arrives. Scheduled jobs and voice turns don't stream
- **Per-channel queues** — prompts stay FIFO within a channel or thread while different channels can run concurrently
- **Single-user authorization** — only the Discord user whose ID is in `AUTHORIZED_USER_ID` can talk to the bot; everyone else is silently dropped
- **Optional Docker** — sandbox mode is disabled gracefully if Docker isn't installed; admin mode still works
- **Voice messages** — Discord voice messages (mic button) are transcribed via Groq Whisper before being passed to the active agent
- **Voice assistant** — talk to the bot in a guild voice channel (`/voice`): utterances are transcribed (Groq Whisper), answered by Claude, and spoken back (OpenAI TTS), with an ambient "thinking" pad masking the latency
- **File uploads** — drop files/photos into a channel and the bot saves them to `.claudiscord/files/`; add text in the same message to have the active agent act on them right away, or send them alone and reference them by name later
- **Scheduler** — cron-based jobs via `node-cron`, notifications delivered to the channel where the job was created

> **Linux only.** Claudiscord ships a systemd unit, expects GNU coreutils, and the sandbox aligns UIDs/GIDs the Linux way. macOS and Windows are not supported.

## Prerequisites

- Linux host (systemd recommended)
- Node.js 18+
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- On the portal **Bot** page: enable the **Message Content Intent**
- When generating the bot's invite link (portal **OAuth2 → URL Generator**, or the **Installation** page), select **both** the `bot` and `applications.commands` scopes — without `applications.commands` the native slash commands cannot be registered
- In that same invite step, grant the bot the **View Channels**, **Send Messages** and **Read Message History** permissions so it can read and reply in the channels you add it to (DMs need no extra permission). For the voice assistant, also grant **Connect** and **Speak** (or add them later on the bot's role / the voice channel). The `Guilds` / `Guild Messages` / `Direct Messages` / `Guild Voice States` gateway intents are non-privileged and already enabled in code — nothing to toggle on the portal for them
- Claude Code CLI installed on the host (`curl -fsSL https://claude.ai/install.sh | bash`) — claudiscord defaults to `~/.local/bin/claude` (the install script's default location); set `CLAUDE_BIN` in `.env` only if it's elsewhere
- **Optional**: Codex CLI installed and authenticated on the host; set `CODEX_BIN` only if it isn't available as `codex` in `PATH`. Each agent is a host-side prerequisite for sandbox mode too — the container borrows the host's copy, so an agent absent from the host is absent from the sandbox as well
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

`rebuild-sandbox.sh` creates `SANDBOX_HOME` if needed and builds the image with the in-container `claude` user UID/GID matching the directory's owner, so bind-mounted files are read/write-able on both sides without manual chown setup. After a successful rebuild, it removes dangling images and the unused Docker build cache.

The container runs the host's own Claude and Codex binaries through read-only bind-mounts, so you install and update each agent once, on the host, and the sandbox follows. Configuration stays separate — credentials, skills and `CLAUDE.md`/`AGENTS.md` are read from each environment's home, so an admin channel and a sandbox channel remain distinct agents.

The mounts are established when the container is created. `/version` probes the container and reports a line only when it disagrees with the host; rerun `rebuild-sandbox.sh` to recreate the container if it does.

## Systemd service

Save the unit below as `/etc/systemd/system/claudiscord.service`, replacing `/path/to/claudiscord` with your clone directory. Drop the `Requires=docker.service` line if you don't plan to use sandbox mode.

Run the service as the account that should own host-side administration:

- `User=root` gives the bot direct root access, which is the simplest setup for a private machine administration bot.
- A regular user also works. Install and authenticate Claude Code/Codex for that user, set `User=<that-user>`, and use that user's clone directory. Runtime state is stored in that user's `~/.claudiscord/`.
- If a regular user is expected to administer the machine, grant it non-interactive sudo permissions. Password-based sudo is not suitable here: Claudiscord runs agents without an interactive terminal, and commands that wait for a password will fail or time out.
- Docker sandbox mode requires Docker access. Membership in the `docker` group effectively grants root-equivalent privileges on the host.

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

For a non-root service user, `/restart` runs `sudo -n systemctl restart claudiscord`, so the sudoers rule must not require a password. For example:

```sudoers
claudiscord ALL=(ALL) NOPASSWD: ALL
```

Use a narrower sudoers rule if you want the bot to administer only specific commands.

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

If sandbox mode is configured you'll also see `Docker image 'claudiscord-sandbox' found`. If `SANDBOX_HOME` is empty or Docker isn't installed, expect a `sandbox mode disabled` warning instead — admin mode still works.

## Using channels

- Invite the bot to any guild channel you want (private or not — the bot only talks back to the authorized user anyway).
- Set the channel's **topic** to whatever you want the agent to keep in mind for this conversation — it's injected into the system prompt alongside the channel name.
- The first message in a new channel defaults to **admin** mode. Switch with `/sandbox` if you'd rather keep that channel to a containerized workspace.
- Claude Code is the default agent. `/codex` selects Codex in either mode; `/claude` selects Claude again. Either switch resets the channel session.
- Model and reasoning effort are forced by claudiscord for both agents, host and sandbox alike (`AGENT_MODELS` and `REASONING_EFFORT` in `src/config.js`) — they override any local CLI configuration.

## File uploads

Drag a file or photo into a channel and the bot always saves it to disk and replies with the saved file name(s). What happens next depends on whether the message also carries text:

- **Files only (no text)** — the bot just persists them and stops; the agent is not invoked. Reference the names in a later message and the active agent reads them from disk.
- **Files + text** — the files are saved first (same echo), then the text is processed as a normal prompt, so the agent can act on the freshly uploaded files in the same turn.

Details:

- Files land in `<home>/.claudiscord/files/`: `~/.claudiscord/files/` in admin mode, `SANDBOX_HOME/.claudiscord/files/` (visible in the container at `/home/claude/.claudiscord/files/`) in sandbox mode.
- Names are the original Discord file names, de-duplicated within a single message. A later upload with the same name overwrites the previous one — there is no automatic cleanup.

## Discord commands

| Command | Description |
|---------|-------------|
| `/new` | Reset the active agent session of the current channel (new conversation) |
| `/stop` | Stop the prompt currently running in this channel — the conversation survives, and anything queued behind it starts next |
| `/status` | Show the channel's mode, agent and runtime status |
| `/usage` | Show Claude and Codex account usage for the current mode |
| `/version` | Show the Claude and Codex CLI versions (one line per agent, plus a warning if the sandbox disagrees) |
| `/skills` | List the skills of both agents in both environments (admin + sandbox) |
| `/login` | Refresh the current agent login in the current mode via a Discord-friendly browser flow |
| `/jobs` | List all scheduled jobs (admin first, then sandbox) |
| `/admin` | Switch the current channel to admin mode (host) |
| `/sandbox` | Switch the current channel to sandbox mode (container) |
| `/claude` | Use Claude for this channel (default) |
| `/codex` | Use Codex for this channel |
| `/remote` | Claude only — toggle the channel between Discord mode and remote control via the Claude mobile app |
| `/voice` | Voice channels only — toggle the voice assistant in this voice channel (join/leave) |
| `/autojoin` | Voice channels only — toggle autojoin for this voice channel (the bot joins on its own when you connect) |
| `/upgrade` | Sandbox only — update the container's packages (the agents follow the host install) |
| `/restart` | Admin only — restart the claudiscord service |
| `!<command>` | Run a shell command (host if the channel is admin, container if sandbox) |

## Voice assistant

Type `/voice` in a **voice channel's text chat** to make the bot join that channel. Speak, pause ~1 s, and the bot transcribes the utterance, runs it through Claude (same session as the channel's text chat) and answers out loud — half-duplex, walkie-talkie style. `/voice` again makes it leave; it also leaves by itself after 15 min of silence.

- Requires `OPENAI_API_KEY` (TTS) and `GROQ_API_KEY` (STT) in `.env`.
- The transcript (`🎙️ …`) and the reply are also posted to the voice channel's chat.
- The voice channel is a regular channel: switch mode with `/admin` / `/sandbox` in its chat. Voice turns run the channel's agent; switching the agent is locked while the assistant is active (`/voice` to stop it first).
- Voice replies use a dedicated speakable system prompt (no markdown, confirmation questions when the transcript looks garbled).

### Autojoin

Type `/autojoin` in a voice channel's text chat and the bot connects on its own whenever you join that channel — no `/voice` needed. It is **per channel and off by default**: only the channels you opt in to are ever joined, so the bot never lands in a call with other people and turns what you say to them into prompts.

- Move to another autojoin channel and the bot follows; move to a channel without autojoin and it just leaves. Each voice channel keeps its own session, so following = a different conversation (its own mode/agent), not a moved one.
- `/autojoin` off does not disconnect a bot that is already there — use `/voice` for that. Conversely `/voice` to kick it out of an autojoin channel only holds until you leave the channel: reconnect and it comes back.
- `/status` shows `Autojoin: on` when the current channel is opted in.

Note: `@discordjs/opus` has no prebuilt binary for some platforms (e.g. ARM64 + recent glibc) and its bundled libopus fails to compile with GCC ≥ 14; if `npm install` fails there, rerun it as `CFLAGS="-Wno-error=implicit-function-declaration" npm install`.

## Authentication

Each environment authenticates independently: admin (host) and sandbox have their own credentials. Whichever environment runs an agent must be logged in there.

From Discord, select the target environment and agent first (`/admin` or `/sandbox`, then `/claude` or `/codex`), then run `/login`. Claude sends an OAuth link and accepts the returned code in the same channel. Codex sends a device-auth browser link and waits for the CLI to complete.

If an environment is not authenticated, the corresponding agent reports an authentication error until `/login` is completed for that same mode and agent.

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
| `OPENAI_API_KEY` | OpenAI API key for the voice assistant's TTS | Optional (`/voice` unavailable if unset) |
| `TTS_MODEL` | OpenAI TTS model id | Optional (defaults to `gpt-4o-mini-tts`) |
| `TTS_VOICE` | OpenAI TTS voice | Optional (defaults to `ash`) |
| `TTS_SPEED` | Speech rate multiplier, 0.25–4.0 | Optional (defaults to `1`) |

## License

MIT
