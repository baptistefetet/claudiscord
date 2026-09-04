# Claudiscord

A single-user Discord bot that drives [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and the [Codex CLI](https://developers.openai.com/codex/cli) from any Discord client, in DMs or private guild channels, on a VPS or a plain Raspberry Pi.

**Two agents, one interface.** `/claude` and `/codex` switch which agent answers in a channel, and nothing else changes: same commands, same scheduler, same uploads, same voice. Each agent keeps its own session and its own login, so switching back resumes where you left it.

**Two environments, one bot.** An `admin` channel runs the agent on the host with your own rights. A `sandbox` channel runs it inside a Docker container with separate credentials, separate skills and its own agent instructions file. Same commands on both sides. Jobs, uploads and shell commands all follow the channel's environment.

## Features

**Conversations**

- **One per channel** — every channel and DM keeps its own session, mode and agent
- **Threads** — a public thread starts a fresh session while inheriting its parent's mode and agent, so you can branch off without disturbing the main channel
- **Channel topic** — injected into the system prompt alongside the channel name, so a channel can carry standing context for its subject
- **Per-channel queues** — prompts stay FIFO within a channel while different channels run concurrently

**Running prompts**

- **Live progress** — while a prompt runs, one message shows what the agent is doing, updated in place and removed when the answer arrives
- **Fixed models** — your prompts use the agent's high model (Claude `opus`, Codex `gpt-6-astra`), scheduled jobs its medium one (`sonnet` / `gpt-5.6-terra`), reasoning effort `xhigh` everywhere. Nothing to pick
- **Escape hatches** — stop a runaway prompt, or hand a channel's Claude session to the Claude mobile app when you want permission prompts and the reasoning view

**Scheduling**

- **Jobs written by asking** — "check the disk every morning and only tell me if it's above 90%" creates the job; the agent owns the schedule, no config file to edit
- **Delivered where they belong** — each job notifies its channel, and can stay silent when it has nothing to report

**Reviewing changes**

- **Uncommitted work, whole** — one line in the channel, and the patch itself as a secret gist however large it is. Nothing has to be committed first
- **One repository per channel** — asked for the first time you ask for a diff, then remembered. Host or container, following the channel's environment

**Voice**

- **Voice messages** — the mic button is transcribed via Groq Whisper and handed to the channel's agent
- **Voice assistant** — talk to the bot in a voice channel: transcribed, answered by the channel's agent, spoken back via OpenAI TTS, with an ambient pad covering the latency

**Files**

- **Uploads** — drop files or photos in; add text in the same message and the agent gets their paths right away, or send them alone and name them later

**Safety**

- **Single user** — only `AUTHORIZED_USER_ID` is answered; every other message is dropped without a reply
- **Optional Docker** — without it, sandbox mode reports itself unavailable and admin mode carries on

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

Because both sides run the same binaries, both report the same version. `/version` checks it: when the sandbox answers something else, its mount is pointing at a binary you have since replaced, and recreating the container with `rebuild-sandbox.sh` is what fixes it — the mounts are fixed when the container is created and never re-resolved.

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

## Scheduling

There is no job syntax to learn and no file to edit: ask, and the agent writes the job itself. "Every morning at 8, check for new releases of the projects in /srv and tell me only if there are any" is a complete specification — the agent turns it into a scheduled prompt attached to the channel you asked in.

Same for the rest of the lifecycle: `/jobs` lists them, and asking to reschedule or drop one works the same way. There is no paused state — a job you no longer want is deleted. The jobs live in a SQLite file per environment, which the agent reads and writes directly.

A run notifies its channel unless the job's own prompt told it to stay quiet when there is nothing to report — that condition belongs in the wording you asked for, which is why "only if there are any" above is enough. Runs are capped at one hour, and a job stopped mid-run keeps its schedule.

**Isolated or not.** By default a job runs in a fresh session each time: it knows nothing of the channel's conversation and leaves it untouched, which is what you want for anything recurring. Ask for a follow-up instead — "in an hour, run that same check again and tell me whether the leak is still growing" — and the job runs *inside* the channel's ongoing conversation, which is the only place "that same check" means anything. Its result lands as a turn you can reply to. That kind of job is tied to that exact conversation: resetting the session with `/new`, or switching the channel's mode or agent, deletes it rather than firing it into a conversation nobody is reading.

**The environment is the channel's, not the job's choice.** A job created in a sandbox channel always runs in the sandbox, whichever channel it reports to — writing to the other environment's job list is not something an agent can do.

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
| `/status` | Show the channel's mode, agent, conversation size and cost, and runtime status |
| `/usage` | Show Claude and Codex account usage for the current mode |
| `/version` | Show the Claude and Codex CLI versions (one line per agent, plus a warning when the sandbox reports a different one, meaning its mount went stale) |
| `/skills` | List the skills of both agents in both environments (admin + sandbox) |
| `/login` | Refresh the current agent login in the current mode via a Discord-friendly browser flow |
| `/jobs` | List all scheduled jobs (admin first, then sandbox) |
| `/diff` | Show the uncommitted changes of the channel's repository: one message with the file and line counts, carrying a link to the patch as a secret gist. Requires `GITHUB_TOKEN`. Asks for the repository path the first time, like `/login` asks for its code; the path is read in the channel's own environment, so switching mode asks again |
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

## Remote control

Some turns want the full Claude app rather than a chat bubble: permission prompts, the reasoning view. `/remote` hands the channel's session over to the [Claude mobile app](https://claude.com/product/claude-code) and back.

- `/remote` starts a backgrounded Claude agent for this channel and stops answering in Discord. The session appears in the app under the channel's name, so several channels stay distinct.
- `/remote` again stops it and returns the channel to Discord.
- **Going out keeps the history, coming back does not.** The Discord conversation is copied into the app session, but the return trip starts fresh — the app manages its own session id and claudiscord does not adopt it.
- While remote, the channel accepts only `/remote`, `/status`, `/jobs`, `/diff`, `/usage`, `/version`, `/skills` and `/login`. Anything else, voice messages included, is refused rather than run, so two processes never share one session. Uploads are still saved.
- Claude only: a Codex channel must `/claude` first. In sandbox mode the container needs its own Claude login (`/sandbox`, `/claude`, `/login`) before `/remote` works.
- Isolated jobs keep firing during a remote session. Non-isolated ones do not survive it: `/remote` resets the channel session, and a job bound to that exact conversation is deleted with it, like on `/new`.

## Voice assistant

Type `/voice` in a **voice channel's text chat** to make the bot join that channel. Speak, pause ~1 s, and the bot transcribes the utterance, runs it through the channel's agent (same session as the channel's text chat) and answers out loud — half-duplex, walkie-talkie style. `/voice` again makes it leave; it also leaves by itself after 15 min of silence.

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
| `GITHUB_TOKEN` | GitHub PAT with the `gist` scope, to publish `/diff` patches as gists | Optional (`/diff` refuses to run if unset) |

## License

MIT
