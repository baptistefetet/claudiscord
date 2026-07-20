# Claudiscord

Single-user Discord relay to Claude Code CLI or optional Codex CLI + scheduled job runner. Single Node.js process.

See `README.md` for installation, setup and Discord commands reference.

## Architecture

```
Discord message (DM, guild text channel or text-in-voice chat)
  -> authorization filter (authorized user only)
  -> command dispatcher (/admin, /sandbox, /new, …)
  -> session lookup by channelId
  -> executePrompt(agent, mode, prompt) [FIFO queue keyed by channelId]
       claude + admin   -> host Claude
       claude + sandbox -> single container
       codex  + admin   -> host Codex
       codex  + sandbox -> single container

Scheduled jobs
  -> minute-resolution ticker
  -> executeJob(job)
  -> executePrompt(job.agent, job.mode, …) [queue keyed by job.channelId]
  -> notification sent back to job.channelId
```

- Each Discord channel has its own mode (`admin` / `sandbox`), agent (`claude` / `codex`, default `claude`), Claude model (`opus` / `sonnet`, default `sonnet`) and active-agent session. A DM channel is treated exactly like any other channel.
- Public threads are handled like any other channel (own `channelId` → own session). On first contact, a thread snapshots its parent channel's mode/agent/model (`sessions.ensureFromParent`, not a live link) but starts a fresh session. The system prompt shows both the parent channel name and the thread name (`prompts.js` `thread`/`threadName`); the topic falls back to the parent's. Jobs/uploads attach to the thread itself like any channel. System messages are dropped early (`if (message.system) return;`): creating a thread posts a `ThreadCreated` system message in the parent whose `content` is the thread NAME (not empty), which would otherwise be answered as a prompt. On a thread's first turn (sessionId still null), if it was created from an existing message, that anchor message (`channel.fetchStarterMessage()`) is prepended to the prompt as quoted context — otherwise the message the thread forks from would be invisible (it lives in the parent and appears in the thread only as a dropped system message).
- The authorized user is stored in `.env` (`AUTHORIZED_USER_ID`) and is required at startup — without it the process refuses to boot.
- Per-channel queues (`src/queue.js`): prompts sharing a `channelId` are FIFO; different channels run concurrently. One global maintenance gate protects login, shell, upgrades and remote transitions. `isBusy(channelId)` drives the one-time "⏳ waiting" hint.
- Jobs live in two separate SQLite databases — never merged, never watched:
  - `ADMIN_USER_HOME/.claudiscord/jobs.db` for admin jobs
  - `SANDBOX_HOST_HOME/.claudiscord/jobs.db` for sandbox jobs
- Sessions live in `ADMIN_USER_HOME/.claudiscord/sessions.json`.
- Scheduler reloads both databases after each prompt (no `fs.watch`).

## Files

```
Dockerfile            # Sandbox image (node:22-slim + Claude/Codex CLIs + user claude)
src/
  index.js            # Entry point: Discord handler, queue wait UX
  config.js           # .env loading + paths + constants
  prompts.js          # Shared system prompt builder with Claude-only sections
  logger.js           # stdout/stderr logging (journald-friendly)
  discord.js          # Client, sendToChannel, sendChunked (splitMessage now private), typing indicator
  queue.js            # Per-channel FIFOs + global maintenance gate
  spawn.js            # spawnCollect: generic subprocess runner (unbounded, no timeout)
  claude.js           # Claude exec/login (host + sandbox), stream-json parse, OAuth usage (getClaudeUsage)
  codex.js            # Codex exec/login (host + sandbox), JSONL parse, account usage (getCodexUsage)
  container.js        # Docker: image/container, sandbox env factories (sandboxClaudeEnv/sandboxCodexEnv)
  executor.js         # executePrompt(agent, mode) → pick env (host const / sandbox factory) → executeClaude|executeCodex; queue
  jobs-store.js       # SQLite jobs store via sqlite3 CLI: loadAllJobs (admin+sandbox), recordJobRun, ensureDb, jobKey
  sessions.js         # { channels: { channelId -> { mode, agent, sessionId, ... } } }
  scheduler.js        # minute-resolution ticker, reloadJobs, executeJob, per-key lock
  commands.js         # COMMANDS registry → dispatch + native slash metadata; /new /status /usage /login /jobs /admin /sandbox /opus /sonnet /codex /remote /voice /upgrade /restart !shell; transport-neutral dispatchSlashCommand + getRegisteredCommands (Discord plumbing stays in index.js)
  remote.js           # /remote helpers: startRemote, stopRemote, reconcileRemotes
  stt.js              # Groq Whisper transcription (voice messages + voice-channel turns)
  tts.js              # OpenAI TTS via REST fetch (voice assistant speech synthesis)
  pcm.js              # Pure-JS PCM resampling (TTS 24k mono → 48k stereo; capture → 16k WAV)
  mixer.js            # Continuous PCM mixer: ambient thinking bed + speech ducking
  voice.js            # Voice assistant: connection, turn capture, STT→Claude→TTS state machine
  uploads.js          # Save Discord file/photo attachments to .claudiscord/files
scripts/
  rebuild-sandbox.sh  # Rebuild Docker sandbox image
.env                  # AUTHORIZED_USER_ID, DISCORD_TOKEN, CLAUDE_BIN, CODEX_BIN, SANDBOX_HOME, GROQ_API_KEY, OPENAI_API_KEY
```

## Slash commands

The text dispatcher (`handleCommand`, message content compared to `COMMANDS[].name`) is doubled by native Discord Application Commands so the `/` autocomplete shows them. The split keeps the command logic free of the `discord.js` SDK: for messaging it uses only `channel.send`; the lone helper still pulled from `./discord` is `resolveChannelName` (for `/remote`). Discord's interaction plumbing lives in `index.js`.

- **Single source of truth**: `COMMANDS` drives both paths. `commands.js::getRegisteredCommands()` exposes neutral `{ name, help }` metadata (excludes `helpOnly` → `!shell` and free-form prompts, which stay text-only). Add a command to the registry → it registers itself.
- **Neutral core**: `remoteGateHint()` (remote-mode gate) and `runCommand()` (mode-gate + lookup + handler call) are shared by `handleCommand` (text) and `dispatchSlashCommand` (slash), so there is no duplicated gating. `dispatchSlashCommand({ channel, channelId, name })` resolves session state and dispatches; gating rejections post to the channel via `channel.send`, like the text path.
- **Discord adapter (index.js)**: the `Events.InteractionCreate` listener owns all Discord plumbing — authorization, `isChatInputCommand`, and routing the handler's output into the interaction's **non-ephemeral** response. A channel `Proxy` (real channel for property reads like `resolveChannelName`, `.send` overridden) feeds a `makeInteractionResponder`: first send → `reply`, later sends → `followUp`; a 2s safety net `deferReply`s so the 3s ack window holds (only the slow commands reach it). The channel then shows Discord's persistent "user used /command" marker + the result in one block, with no "thinking" on fast commands. Token lifetime is 15 min, which bounds a command's runtime. Auth/"channel unavailable" rejections stay ephemeral.
- **Registration**: `index.js::registerSlashCommands()` runs on `ClientReady`, maps the neutral metadata to Discord's Application Command shape (`ApplicationCommandType`, `dmPermission`) and bulk-overwrites (`client.application.commands.set`). Idempotent — safe on every boot. Global scope (guild channels + DMs); first-time propagation ~1h.
- **Prerequisite**: the bot must have been invited with the `applications.commands` OAuth scope (in addition to `bot`). Re-authorizing an already-present bot only adds the scope — it does not kick it or reset state (sessions are keyed by `channelId`).
- **Adding a transport**: implement another adapter (own event→`{channel,name}` mapping + native-command registration from `getRegisteredCommands`) and reuse `dispatchSlashCommand` / `handleCommand`. Still pending for a full second transport: per-transport notification routing in `scheduler.js` (today hard-wired to `discord.sendToChannel`) and namespacing the `channelId` keys (sessions/jobs) to avoid cross-transport collisions.

## Service

- **Service**: `claudiscord` (`systemctl status claudiscord`)
- **Logs**: `journalctl -u claudiscord -f`
- **ExecStopPost**: separate `pkill` safety nets for `claude -p` and `codex exec`
- **User**: root

## Voice messages (speech-to-text)

Discord voice messages (the mic button — flag `MessageFlags.IsVoiceMessage`) are transcribed via Groq Whisper before being passed to the active agent. Plain audio attachments (`.mp3` etc.) are ignored on purpose — only the dedicated voice message UI triggers transcription.

- Module: `src/stt.js`, no SDK. `transcribeAudio(buffer)` is the shared core (also used by the voice assistant); `transcribeVoiceMessage` downloads the attachment and delegates.
- Endpoint: `POST https://api.groq.com/openai/v1/audio/transcriptions`.
- Defaults: model `whisper-large-v3`, language `fr`. Override via `STT_MODEL` / `STT_LANGUAGE` in `.env`.
- If `GROQ_API_KEY` is missing, voice messages are silently dropped (warn log).
- Text wins if both text and voice are present in the same message — Groq is not called.
- The transcription is echoed back to the channel as `🎙️ <text>` before the agent executes, so the user sees what Whisper understood.
- API errors are surfaced to the channel and logged; the bot stays up.

## Voice assistant (voice channels)

`/voice` typed in a guild voice channel's text-in-voice chat toggles the assistant for THAT voice channel (one active session per process). Requires `OPENAI_API_KEY` (TTS) + `GROQ_API_KEY` (STT) — friendly error otherwise, same pattern as `/sandbox` without Docker.

- **Pipeline** (`src/voice.js`): `receiver.subscribe(AfterSilence 900ms)` → prism opus decode → JS downsample to 16 kHz mono WAV (`pcm.js`) → Groq Whisper (`stt.js::transcribeAudio`) → gate (min 300 ms, French Whisper hallucination patterns) → `executePrompt(agent, mode, text)` → OpenAI TTS `pcm` 24 kHz mono (`tts.js`) → JS upsample (`pcm.js`) → mixer playback. No ffmpeg dependency. The session is keyed by the voice channel's own `channelId` (text-in-voice shares it), so voice and chat share one conversation and `/admin`, `/sandbox`, `/status` typed in the chat apply.
- **Half-duplex**: speaking-start events are ignored unless the state is `listening`. The bot never hears itself (per-user streams). The transcript (`🎙️ …`) and the reply are also posted to the chat.
- **Mixer** (`src/mixer.js`): ONE permanent Readable (s16le 48 kHz stereo) for the whole session; a synthesized detuned-sine "thinking" bed, ducked under speech, gains smoothed per 20 ms frame (levels from Hermes, scaled by `BED_VOLUME`). The player is paused between turns so the speaking indicator turns off while idle. A player `Idle` means the pipeline broke → the mixer resource is rebuilt.
- **Voice system prompt**: `prompts.js` flag `voice: true` swaps the Discord response-format section for speakable-text rules (no markdown, mangled-name caveat for local project names, confirm before acting on garbled transcripts).
- **Gates mirrored from the text path**: `remoteId` set → turn dropped with a chat hint; sandbox-remote lockout enforced by the executor; `isBusy()` → spoken "un instant" notice; `scheduler.reloadJobs()` after each turn (like index.js) so voice-scheduled jobs fire on time. Canned spoken phrases are French (matches `STT_LANGUAGE` default) and their TTS output is cached. Speech rate: `TTS_SPEED`.
- Voice turns run the channel's agent/mode/model. Agent switches are locked while the assistant is active there — the shared sessionId (Claude UUID vs Codex thread id) must stay coherent with the executor's context guard. **The bot joins silently**: the mode goes to the chat, not the speakers. Auto-leave after 15 min without a turn (`VOICE_IDLE_TIMEOUT_MS`); the timer is suspended during a turn.
- **Discord requirements**: non-privileged `GuildVoiceStates` intent (enabled in `src/discord.js`), Connect + Speak permissions on the voice channel.

### Autojoin (per voice channel)

`/autojoin` typed in a voice channel's text-in-voice chat toggles that channel's autojoin policy: the bot then connects on its own when the authorized user joins it, no `/voice` needed. Persisted per channel in `sessions.json` (`autojoin`, default `false`).

- **Per-channel opt-in is the point**, not a global env var: the flag acts as an allowlist. Otherwise the bot sits in any call the user joins and turns everything they say to a human into a prompt (`onSpeakingStart` only reacts to `AUTHORIZED_USER_ID`). It also needs no restart, and `/status` shows it.
- **Policy and session are orthogonal**: `/autojoin` off never disconnects a connected bot (`/voice` does); `/voice` off suppresses the policy for the current stay only, never clears it.
- **Moves**: follow to another autojoin channel, leave on a move to one without. Following is leave+join, so the destination brings its own session — the conversation does not follow the user.
- **Known deviation**: `suppressed` is in-memory while `autojoin` is persisted, so a `/restart` re-joins a channel the user had kicked the bot from. Accepted — a restart drops live state by design.

The event filters, the join race and the convergence loop are documented at their call sites in `src/voice.js`.

**ARM64 build note**: `@discordjs/opus` has no prebuilt for node 22 / glibc 2.41 and its bundled libopus trips GCC 14's implicit-declaration error; it was built with `CFLAGS="-Wno-error=implicit-function-declaration" npm install`.

## File uploads

The user can drop files/photos into a channel (with no text). An upload does NOT spawn an agent: the bot saves the attachments and echoes their names. The user then references them by name in a later message.

- Module: `src/uploads.js` (single `saveUploads(attachments, mode)` function; download pattern borrowed from `src/stt.js`).
- Target dir, per channel mode, sibling of `jobs.db`:
  - admin → `ADMIN_USER_HOME/.claudiscord/files/`
  - sandbox → `SANDBOX_HOST_HOME/.claudiscord/files/`, bind-mounted as `/home/claude/.claudiscord/files/`. Files are `chown`'d to the container's `claude` user (`container.js::writeSandboxUpload`) so the non-root process can read them.
- Naming: original Discord `attachment.name` (basename), de-duplicated within a single batch (`image.png`, `image-2.png`). Across messages the same name is overwritten — no automatic cleanup.
- Text + attachments: the files are saved and echoed first (same as an upload-only message), then the text is processed as a normal prompt so the agent can reference them. With no text, the upload does not spawn the agent. Voice messages are excluded (their lone attachment is the audio, handled by STT). The detection in `src/index.js` runs before `handleCommand`, so uploads also work in `/remote` mode (files are saved, the text still gets the remote-mode rejection without spawning `claude -p`).
- The system prompt (`src/prompts.js`, "Uploaded files" section, `{{filesPath}}`) tells the agent the files dir and that a mentioned name *may* be an upload (re-read from disk each time, content can change) but could just as well be any other file in the environment.

## Authorization

- `AUTHORIZED_USER_ID` in `.env` identifies the single user allowed to talk to the bot. It is required at startup — `src/config.js` throws if missing, so the service won't run without it.
- The user finds their own ID via Discord's developer mode (right-click avatar → Copy User ID).
- Every non-authorized message is silently dropped — no reply, minimal logging.

## Modes (per channel)

- `admin` (default) — prompts executed directly on the host with access to system tools
- `sandbox` — prompts executed inside the Docker container; Claude uses `--dangerously-skip-permissions`, Codex uses `--yolo`
- `/admin` and `/sandbox` switch the current channel's mode and clear its session
- `/sandbox` reports an error and does not switch if Docker is not installed
- The mode is persisted in `sessions.json`

## Agent and model (per channel)

- Each channel has an agent (`claude` or `codex`, default `claude`).
- `/codex` selects Codex and resets the channel session. It works in admin and sandbox modes when the corresponding binary is installed.
- `/opus` and `/sonnet` select Claude and its model. Switching from Codex resets the session; changing only the Claude model does not.
- Codex uses the model configured by the Codex CLI; claudiscord does not override it.
- Reasoning effort is hardcoded in the arg builders: Claude `xhigh` (opus) / `medium` (sonnet) in `buildClaudeArgs`, Codex via the `CODEX_REASONING_EFFORT` constant in `codex.js`.
- Agent and model are persisted in `sessions.json` next to the mode.
- Scheduled jobs snapshot the channel's agent and Claude model at scheduling time. Missing `agent` fields fall back to `claude` for backward compatibility.

## Channel context injection

`src/prompts.js` builds the system prompt from `{ channelAgent, channelModel, mode, channelName, threadName, channelTopic, isDM, botName, userName }`. The shared prompt always includes channel context, uploads, scheduling and Discord response rules. Claude-specific CLI and skill-filtering instructions live inside `{{#claude}}...{{/claude}}` and are omitted for Codex.

## Execution queues

Interactive prompts, voice turns and scheduled jobs go through `src/queue.js::runQueued(channelId, ...)`. A channel or thread stays strictly FIFO, including its fresh-session job runs, while distinct IDs may execute without a global concurrency limit. `src/index.js` sends the one-shot "⏳ Waiting for previous prompt..." notice only when that same channel is busy. Rare operations (`/login`, `!shell`, `/upgrade`, `/remote` transitions) use `runMaintenance`: they are refused while any execution is pending, then briefly stop new queue work while they run. The single sandbox container accepts concurrent `docker exec` processes, so sandbox channels share its 1 CPU, home and filesystem. SQLite arbitrates concurrent jobs writes.

## Docker sandbox (optional)

- **Image**: `claudiscord-sandbox` (local build, `node:22-slim` + Claude and Codex CLIs)
- **Container**: `claudiscord-sandbox` (single container, `--restart unless-stopped`)
- **Limit**: 1 CPU; no container RAM limit
- **Volume**: `SANDBOX_HOME -> /home/claude`
- **Network**: bridge
- **User in container**: `claude` (non-root)
- **CMD**: `sleep infinity`; commands run via `docker exec`
- Docker availability is detected at startup; if `docker --version` fails, `DOCKER_AVAILABLE` becomes `false` and sandbox operations report a friendly error

### Host user/group alignment

`scripts/rebuild-sandbox.sh` reads the UID/GID of `SANDBOX_HOME` and passes them as `--build-arg SANDBOX_UID=… SANDBOX_GID=…` so the in-container `claude` user matches host ownership. If the directory doesn't exist yet, the script creates it owned by `1001:1001` and uses those defaults.

Runtime echoes this: `src/container.js` reads `SANDBOX_HOME`'s ownership via `fs.statSync` at startup (`readSandboxIds`) and uses those IDs for every chown when creating files. Single source of truth: the directory's ownership.

Implication: if you move `SANDBOX_HOME` to a path with different ownership, rerun `rebuild-sandbox.sh` so the image is rebuilt with matching IDs.

### State storage layout

Both modes store runtime state under `<home>/.claudiscord/`:

```
ADMIN_USER_HOME/.claudiscord/     # /root/.claudiscord on this host
  jobs.db                         # admin scheduled jobs (SQLite)
  sessions.json                   # per-channel state (shared across modes)
  files/                          # uploaded files (admin channels)

SANDBOX_HOST_HOME/.claudiscord/   # bind-mounted as /home/claude/.claudiscord
  jobs.db                         # sandbox scheduled jobs (SQLite)
  files/                          # uploaded files (sandbox channels)
```

The sandbox home also contains agent config:

```
SANDBOX_HOST_HOME/
  CLAUDE.md               # customisable
  .claude/
    .credentials.json     # sandbox Claude auth, created by sandbox /login or CLI
    skills/               # user skills
  .codex/
    auth.json             # sandbox Codex auth, created by sandbox /login or CLI
    config.toml           # minimal file config (auth store only)
```

`ensureStorage()` prepares the sandbox config dirs and minimal Codex config only; it does not read, copy, compare, or delete agent credentials. Host and sandbox auth are independent: `/login` uses the current channel mode and agent, so `/sandbox` + `/codex` + `/login` authenticates sandbox Codex without touching host Codex. Claude login relays the OAuth URL and returned code through Discord; Codex login uses `codex login --device-auth` and waits for browser completion.

### Background tasks

`spawnCollect` (`src/spawn.js`) waits for the active CLI to exit naturally, with no timeout: a prompt has no predictable duration and only the operator knows what a given one should take. A stuck agent therefore holds its channel queue indefinitely; other channels continue, while maintenance commands are refused until all queues are idle. Recovery is manual: inspect from a host shell, kill the offending process, then resume the channel session.

### Image rebuild

```bash
bash scripts/rebuild-sandbox.sh
```

## Claude CLI usage

- `claude -p` with `--output-format stream-json --verbose` for both interactive messages and jobs; the first `session_id` seen in the stream is recorded as the job's `lastSessionId`
- A first invocation omits session flags; Claude allocates an UUID and emits `session_id` in its JSON output. Subsequent invocations use `--resume <uuid>`.
- `--dangerously-skip-permissions` in sandbox (the container IS the sandbox)
- Model follows the channel/job snapshot; reasoning effort is hardcoded by model (`opus` → `xhigh`, `sonnet` → `medium`)
- Host cwd: `os.homedir()` of the user running the service (auto-loads `$HOME/CLAUDE.md`) — typically `/root` on Linux when the service runs as root, `/var/root` on macOS
- Sandbox cwd: `/home/claude`
- Timeout: none — the CLI runs until it exits on its own

## Codex CLI usage

- Optional host integration, detected at startup from `CODEX_BIN` (default `codex`); the sandbox image installs `@openai/codex`
- `codex exec --yolo --skip-git-repo-check --json -c model_reasoning_effort="high" -` for a new conversation
- `codex exec resume` uses the same flags plus `<uuid>` before the trailing `-` for subsequent prompts
- Prompts are passed through stdin; progress is not relayed to Discord
- `thread.started.thread_id` supplies the session UUID and the last completed `agent_message` supplies the response
- The shared Discord prompt is injected through the `developer_instructions` config override
- Codex model selection and authentication remain owned by the Codex CLI configuration; reasoning effort is forced by claudiscord (`CODEX_REASONING_EFFORT` in `codex.js`)
- Sandbox execution uses `/home/claude` as cwd and `/home/claude/.codex` as `CODEX_HOME`
- `/upgrade` (sandbox only) refreshes the container — apt packages, Claude Code, and the Codex package (`npm install -g --prefix /usr/local @openai/codex@latest`)
- Codex remains unsupported in `/remote`

## Scheduled jobs

### Format

Table `jobs`, one row per job (`src/jobs-store.js::SCHEMA`, `PRAGMA user_version = 1`):

```sql
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL,
  channel_name    TEXT,
  prompt          TEXT NOT NULL,
  cron            TEXT NOT NULL,
  enabled         INTEGER NOT NULL,
  notify          INTEGER NOT NULL DEFAULT 0,
  notify_pattern  TEXT,
  remaining       INTEGER NOT NULL DEFAULT 0,
  agent           TEXT,
  model           TEXT,
  created         TEXT,
  last_run        TEXT,
  last_session_id TEXT,
  description     TEXT
) STRICT;
```

- `STRICT` because agents write rows through the CLI, outside claudiscord's validation — mistyped values fail at insert instead of loading as junk.
- `channel_id` is **required** — it's where the notification is sent. DM channels have an ID too, so a DM-bound job works identically.
- `channel_name` is a display-only snapshot of the channel name at job creation time. The scheduler refreshes it on every run.
- `agent` is `'claude'` or `'codex'`. Snapshot of the channel's agent at scheduling time. NULL falls back to `claude`.
- `model` is `'opus'` or `'sonnet'`. Snapshot of the channel's Claude model at scheduling time and ignored by Codex. NULL falls back to `sonnet`.
- `remaining`: `0` = infinite, `>0` = decremented each run, job removed when it hits `0`.
- `last_session_id`: diagnostic-only. Scheduler writes the agent session UUID of the last run (set even on error via `err.sessionId`). Jobs always run with a fresh session (`sessionId: null`), so this is never resumed — it just locates the run's transcript on disk: Claude at `<home>/.claude/projects/<cwd-hash>/<uuid>.jsonl` (admin cwd `/root` → `-root`, sandbox `/home/claude` → `-home-claude`), Codex via `find <home>/.codex/sessions -name "*<uuid>*"`.
- Unique key: `mode:id` (the mode is implicit from the database the job lives in).

### Storage

- **Admin jobs**: `ADMIN_USER_HOME/.claudiscord/jobs.db` (readable/writable by the host agent).
- **Sandbox jobs**: `SANDBOX_HOST_HOME/.claudiscord/jobs.db` (readable/writable by the container; the same path is accessible from the host as well since the volume is a bind-mount).
- All access goes through the `sqlite3` CLI — claudiscord shells out (`execFileSync`, no Node driver), agents run it from their prompt instructions. Every invocation starts with `.timeout 5000` (the dot-command, not `PRAGMA busy_timeout`, which emits a result row that corrupts `-json` output).
- Default rollback journal, no WAL: no persistent `-wal`/`-shm` sidecars, so in-place writes never change the db file's ownership (the sandbox db must stay owned by the container user while root also writes it via `recordJobRun`).
- `recordJobRun` is a single atomic transaction (update + decrement + delete-at-0) — concurrent agent writes can no longer be lost, even from `/remote` sessions.
- **No merge**: an admin prompt only sees admin jobs, a sandbox prompt only sees sandbox jobs. The scheduler loads both databases and runs everything.

### Execution & reload

- A single minute-resolution ticker (`setInterval`, `TICK_MS`) fires every job whose cron matches the current minute, using node-cron only to parse/validate the expression and build its time matcher. This tolerates sub-minute timer/clock drift and never replays a missed minute — unlike node-cron's per-job `setTimeout`, which aimed at an exact second and silently dropped a run when the first heartbeat after a (re)start landed off that second.
- `src/scheduler.js::reloadJobs()` rebuilds the in-memory schedule (one matcher per job) from both databases.
- Called at startup, after every interactive prompt, and at the end of every scheduled job — so any change to the jobs databases is picked up within one prompt.
- No `fs.watch` — polling after each prompt is enough.
- In-memory lock per job key (plus a per-minute guard) prevents duplicate runs (including the "same wall-clock minute" edge case).

### Notifications

- When `notify: true` and the output matches `notifyPattern` (regex, dotall flag `s`, fallback `includes()` on invalid regex), the output is sent to `channelId`.
- Errors are also announced on the channel when `notify: true`.

## Sessions

- `ADMIN_USER_HOME/.claudiscord/sessions.json` shape:
  ```json
  { "channels": { "<channelId>": { "mode": "admin"|"sandbox", "agent": "claude"|"codex", "model": "opus"|"sonnet", "sessionId": "<uuid>", "remoteId": null|"<agentId>", "lastName": "..." } } }
  ```
- `sessionId` belongs to the active agent. Both Claude and Codex allocate it on the first invocation and emit it early in JSON output; `executor.js` persists it inside the channel queue. Context-mutating commands (`/new`, mode/agent switch) are refused while the channel is busy (`isBusy(channelId)` — a prompt or job running), so a late result cannot restore a session the user just changed; the executor still re-checks agent/mode before persisting (covers a context switch during a thread's pre-enqueue first-turn window). Remote mode blocks these commands upstream via `remoteGateHint`.
- Spawn errors retain partial stdout so the agent adapter can attach an already-emitted UUID before the error is surfaced. The next prompt can therefore resume even when the first failed after session initialization.
- Legacy entries without `agent` load as Claude. A legacy `sessionStarted: false` drops its possibly uncreated UUID; the field disappears on the next persistence.
- `remoteId` is `null` when the channel is in Discord mode (default), or an 8-hex agent ID when the channel is currently driven from the Claude mobile app via `/remote`. See "Remote control" below.
- `lastName` is a display snapshot to make the sessions file readable during debugging.
- A full reset is harmless — it only drops the active agent session ID.
- Startup purge (`src/index.js::purgeInvalidChannels`) drops entries whose Discord channel no longer exists. Runs after `login()` and after `reconcileRemotes()` (which needs to stop any remote agent first, before the entry vanishes). Strict: only `DiscordAPIError code 10003` (Unknown Channel) triggers removal; transient errors are logged and skipped. Scheduled jobs attached to a purged channel are intentionally NOT removed — job lifecycle is managed by hand.

## Remote control

`/remote` toggles the channel between Discord mode (default) and remote mode. In remote mode, the channel's Claude session is driven from the Claude mobile app (full UI, permissions, reasoning view, etc.) instead of from Discord.

- `/remote` is Claude-only; Codex channels must switch back with `/opus` or `/sonnet` first.
- Implementation: `src/remote.js` spawns `claude --bg [--resume <channelSessionId>] --remote-control <channelName>` (host for admin, `docker exec` for sandbox). The CLI prints `backgrounded · <agentId>` on stdout — we parse the 8-hex agent ID and persist it as `remoteId` in the sessions file.
- Asymmetric continuity: `--resume` makes `claude --bg` copy the existing Discord conversation into the bg session's JSONL, so the mobile user picks up where Discord left off. But `--bg` manages its own UUID and we don't reconcile back — `setRemoteId` wipes the channel's `sessionId`, so the next Discord message after `/remote` stop starts a fresh session. Going Discord → mobile keeps history; coming back Discord → fresh.
- Naming: the mobile app shows each session under `<channelName>` (DM = username), so multiple channels can run in parallel and stay discoverable.
- Gating (`src/commands.js`): while `remoteId` is set, only `/remote`, `/status`, `/jobs`, `/usage`, `/login` are accepted in that channel. Every other input (plain text, `!shell`, other slash commands) returns an invalidation hint and does **not** spawn `claude -p` — this prevents two concurrent processes touching the same session. Voice messages are also dropped *before* Groq STT (`src/index.js`), so a vocal in remote mode neither pays for transcription nor leaks the `🎙️ <transcript>` echo.
- Sandbox `!shell` lockout: while *any* channel holds a sandbox remote, sandbox `!shell` is refused (`hasActiveSandboxRemote()` check in `commands.js`). Reason: `executeShell`'s timeout pkills by command pattern inside the container, which can match the live remote daemon. Prompts and scheduled jobs are unaffected — they run concurrently with a remote by design.
- Stop: `/remote` while active runs `claude stop <agentId>` (host or container), then deletes `~/.claude/jobs/<agentId>/` so the agent stops showing up in `claude agents` as a stopped session (`claude stop` keeps the conversation around by design). Strict 8-hex guard on the agentId before any `rm -rf`. Finally clears `remoteId` and calls `scheduler.reloadJobs()` — Claude may have edited the jobs databases during the mobile session, and we did not go through the executor path that normally triggers a reload.
- Startup reconciliation: `reconcileRemotes()` runs after `sessions.load()` and best-effort-stops every persisted `remoteId` (also doing the jobs/ cleanup). After a machine reboot the daemon is gone and the stop fails harmlessly; the channel reverts to Discord mode either way.
- Sandbox prerequisite: the in-container claude daemon needs valid sandbox Claude credentials. Run `/sandbox`, select Claude with `/opus` or `/sonnet`, then `/login` before using sandbox `/remote`.
