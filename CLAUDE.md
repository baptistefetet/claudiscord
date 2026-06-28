# Claudiscord

Single-user Discord relay to Claude Code CLI or optional Codex CLI + scheduled job runner. Single Node.js process.

See `README.md` for installation, setup and Discord commands reference.

## Architecture

```
Discord message (DM or guild text channel)
  -> authorization filter (authorized user only)
  -> command dispatcher (/admin, /sandbox, /new, …)
  -> session lookup by channelId
  -> executePrompt(agent, mode, prompt) [global queue — one agent at a time]
       claude + admin   -> host Claude
       claude + sandbox -> single container
       codex  + admin   -> host Codex
       codex  + sandbox -> single container

Scheduled jobs
  -> minute-resolution ticker
  -> executeJob(job)
  -> executePrompt(job.agent, job.mode, …) [same global queue]
  -> notification sent back to job.channelId
```

- Each Discord channel has its own mode (`admin` / `sandbox`), agent (`claude` / `codex`, default `claude`), Claude model (`opus` / `sonnet`, default `sonnet`) and active-agent session. A DM channel is treated exactly like any other channel.
- Public threads are handled like any other channel (own `channelId` → own session). On first contact, a thread snapshots its parent channel's mode/agent/model (`sessions.ensureFromParent`, not a live link) but starts a fresh session. The system prompt shows both the parent channel name and the thread name (`prompts.js` `thread`/`threadName`); the topic falls back to the parent's. Jobs/uploads attach to the thread itself like any channel. System messages are dropped early (`if (message.system) return;`): creating a thread posts a `ThreadCreated` system message in the parent whose `content` is the thread NAME (not empty), which would otherwise be answered as a prompt. On a thread's first turn (sessionId still null), if it was created from an existing message, that anchor message (`channel.fetchStarterMessage()`) is prepended to the prompt as quoted context — otherwise the message the thread forks from would be invisible (it lives in the parent and appears in the thread only as a dropped system message).
- The authorized user is stored in `.env` (`AUTHORIZED_USER_ID`) and is required at startup — without it the process refuses to boot.
- Global queue (`src/queue.js`): every prompt (interactive or scheduled) goes through a single FIFO. `isBusy()` is used to show a one-time "⏳ waiting" hint per channel.
- Jobs live in two separate files — never merged, never watched:
  - `ADMIN_USER_HOME/.claudiscord/jobs.json` for admin jobs
  - `SANDBOX_HOST_HOME/.claudiscord/jobs.json` for sandbox jobs
- Sessions live in `ADMIN_USER_HOME/.claudiscord/sessions.json`.
- Scheduler reloads both files after each prompt (no `fs.watch`).

## Files

```
Dockerfile            # Sandbox image (node:22-slim + Claude/Codex CLIs + user claude)
src/
  index.js            # Entry point: Discord handler, queue wait UX
  config.js           # .env loading + paths + constants
  prompts.js          # Shared system prompt builder with Claude-only sections
  logger.js           # stdout/stderr logging (journald-friendly)
  discord.js          # Client, sendToChannel, sendChunked (splitMessage now private), typing indicator
  queue.js            # Single global FIFO (runQueued, isBusy)
  spawn.js            # spawnWithTimeout: generic subprocess runner (timeout, SIGTERM→SIGKILL)
  claude.js           # Host Claude exec (executeClaude + hostClaudeEnv), stream-json parse, OAuth usage (getClaudeUsage)
  codex.js            # Host Codex exec (executeCodex + hostCodexEnv), JSONL parse, account usage (getCodexUsage)
  container.js        # Docker: image/container, sandbox env factories (sandboxClaudeEnv/sandboxCodexEnv), creds
  executor.js         # executePrompt(agent, mode) → pick env (host const / sandbox factory) → executeClaude|executeCodex; queue
  jobs-store.js       # loadAllJobs (admin+sandbox), recordJobRun, jobKey
  sessions.js         # { channels: { channelId -> { mode, agent, sessionId, ... } } }
  scheduler.js        # minute-resolution ticker, reloadJobs, executeJob, per-key lock
  commands.js         # COMMANDS registry → dispatch + auto-generated /help; /new /status /usage /jobs /admin /sandbox /opus /sonnet /codex /remote /upgrade /restart !shell; transport-neutral dispatchSlashCommand + getRegisteredCommands (Discord plumbing stays in index.js)
  remote.js           # /remote helpers: startRemote, stopRemote, reconcileRemotes
  stt.js              # Groq Whisper transcription for Discord voice messages
  uploads.js          # Save Discord file/photo attachments to .claudiscord/files
scripts/
  rebuild-sandbox.sh  # Rebuild Docker sandbox image
.env                  # AUTHORIZED_USER_ID, DISCORD_TOKEN, CLAUDE_BIN, CODEX_BIN, SANDBOX_HOME, GROQ_API_KEY
```

## Slash commands

The text dispatcher (`handleCommand`, message content compared to `COMMANDS[].name`)
is doubled by native Discord Application Commands so the `/` autocomplete shows them.
The split keeps the command logic free of the `discord.js` SDK: for messaging it uses
only `channel.send`; the lone helper still pulled from `./discord` is `resolveChannelName`
(for `/remote`). Discord's interaction plumbing lives in `index.js`.

- **Single source of truth**: `COMMANDS` drives both paths. `commands.js::getRegistered
  Commands()` exposes neutral `{ name, help }` metadata (excludes `helpOnly` → `!shell`
  and free-form prompts, which stay text-only). Add a command to the registry → it
  registers itself.
- **Neutral core**: `remoteGateHint()` (remote-mode gate) and `runCommand()` (mode-gate +
  lookup + handler call) are shared by `handleCommand` (text) and `dispatchSlashCommand`
  (slash), so there is no duplicated gating. `dispatchSlashCommand({ channel, channelId,
  name })` resolves session state and dispatches; gating rejections post to the channel
  via `channel.send`, like the text path.
- **Discord adapter (index.js)**: the `Events.InteractionCreate` listener owns all
  Discord plumbing — authorization, `isChatInputCommand`, and routing the handler's
  output into the interaction's **non-ephemeral** response. A channel `Proxy` (real
  channel for property reads like `resolveChannelName`, `.send` overridden) feeds a
  `makeInteractionResponder`: first send → `reply`, later sends → `followUp`; a 2s
  safety net `deferReply`s so the 3s ack window holds (only the slow commands reach
  it). The channel then shows Discord's persistent "user used /command" marker + the
  result in one block, with no "thinking" on fast commands. Token lifetime is 15 min,
  which bounds a command's runtime. Auth/"channel unavailable" rejections stay ephemeral.
- **Registration**: `index.js::registerSlashCommands()` runs on `ClientReady`, maps the
  neutral metadata to Discord's Application Command shape (`ApplicationCommandType`,
  `dmPermission`) and bulk-overwrites (`client.application.commands.set`). Idempotent —
  safe on every boot. Global scope (guild channels + DMs); first-time propagation ~1h.
- **Prerequisite**: the bot must have been invited with the `applications.commands` OAuth
  scope (in addition to `bot`). Re-authorizing an already-present bot only adds the scope —
  it does not kick it or reset state (sessions are keyed by `channelId`).
- **Adding a transport**: implement another adapter (own event→`{channel,name}` mapping +
  native-command registration from `getRegisteredCommands`) and reuse `dispatchSlashCommand`
  / `handleCommand`. Still pending for a full second transport: per-transport notification
  routing in `scheduler.js` (today hard-wired to `discord.sendToChannel`) and namespacing
  the `channelId` keys (sessions/jobs) to avoid cross-transport collisions.

## Service

- **Service**: `claudiscord` (`systemctl status claudiscord`)
- **Logs**: `journalctl -u claudiscord -f`
- **ExecStopPost**: separate `pkill` safety nets for `claude -p` and `codex exec`
- **User**: root

## Voice messages (speech-to-text)

Discord voice messages (the mic button — flag `MessageFlags.IsVoiceMessage`)
are transcribed via Groq Whisper before being passed to the active agent. Plain audio
attachments (`.mp3` etc.) are ignored on purpose — only the dedicated voice
message UI triggers transcription.

- Module: `src/stt.js` (single `transcribeVoiceMessage` function, no SDK).
- Endpoint: `POST https://api.groq.com/openai/v1/audio/transcriptions`.
- Defaults: model `whisper-large-v3`, language `fr`. Override via `STT_MODEL`
  / `STT_LANGUAGE` in `.env`.
- If `GROQ_API_KEY` is missing, voice messages are silently dropped (warn log).
- Text wins if both text and voice are present in the same message — Groq is
  not called.
- The transcription is echoed back to the channel as `🎙️ <text>` before
  the agent executes, so the user sees what Whisper understood.
- API errors are surfaced to the channel and logged; the bot stays up.

## File uploads

The user can drop files/photos into a channel (with no text). An upload does NOT
spawn an agent: the bot saves the attachments and echoes their names. The user then
references them by name in a later message.

- Module: `src/uploads.js` (single `saveUploads(attachments, mode)` function; download
  pattern borrowed from `src/stt.js`).
- Target dir, per channel mode, sibling of `jobs.json`:
  - admin → `ADMIN_USER_HOME/.claudiscord/files/`
  - sandbox → `SANDBOX_HOST_HOME/.claudiscord/files/`, bind-mounted as
    `/home/claude/.claudiscord/files/`. Files are `chown`'d to the container's
    `claude` user (`container.js::writeSandboxUpload`) so the non-root process can read
    them.
- Naming: original Discord `attachment.name` (basename), de-duplicated within a single
  batch (`image.png`, `image-2.png`). Across messages the same name is overwritten — no
  automatic cleanup.
- Text + attachments: the files are saved and echoed first (same as an upload-only
  message), then the text is processed as a normal prompt so the agent can reference
  them. With no text, the upload does not spawn the agent. Voice messages are excluded
  (their lone attachment is the audio, handled by STT). The detection in `src/index.js`
  runs before `handleCommand`, so uploads also work in `/remote` mode (files are saved,
  the text still gets the remote-mode rejection without spawning `claude -p`).
- The system prompt (`src/prompts.js`, "Uploaded files" section, `{{filesPath}}`) tells
  the agent the files dir and that a mentioned name *may* be an upload (re-read from disk
  each time, content can change) but could just as well be any other file in the
  environment.

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
- Codex reasoning effort is always overridden to `xhigh`, centralized in `src/config.js::CODEX_REASONING_EFFORT`.
- Effort is derived from the model (opus → xhigh, sonnet → high), centralized in `src/config.js::EFFORT_BY_MODEL`.
- Agent and model are persisted in `sessions.json` next to the mode.
- Scheduled jobs snapshot the channel's agent and Claude model at scheduling time. Missing `agent` fields fall back to `claude` for backward compatibility.

## Channel context injection

`src/prompts.js` builds the system prompt from `{ channelAgent, channelModel, mode, channelName, threadName, channelTopic, isDM, botName, userName }`. The shared prompt always includes channel context, uploads, scheduling and Discord response rules. Claude-specific CLI and skill-filtering instructions live inside `{{#claude}}...{{/claude}}` and are omitted for Codex.

## Global queue

All executions — interactive prompts and scheduled jobs, Claude and Codex — go through `src/queue.js::runQueued`. Only one agent process runs at a time. If a new message arrives while something is running, `src/index.js` sends a one-shot "⏳ Waiting for previous prompt..." notice to the concerned channel. This sequentiality simplifies invariants around concurrent file writes (jobs files, sessions file).

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

`scripts/rebuild-sandbox.sh` reads the UID/GID of `SANDBOX_HOME` and
passes them as `--build-arg SANDBOX_UID=… SANDBOX_GID=…` so the in-container
`claude` user matches host ownership. If the directory doesn't exist yet,
the script creates it owned by `1001:1001` and uses those defaults.

Runtime echoes this: `src/container.js` reads `SANDBOX_HOME`'s ownership
via `fs.statSync` at startup (`readSandboxIds`) and uses those IDs for
every chown when seeding files. Single source of truth: the directory's
ownership.

Implication: if you move `SANDBOX_HOME` to a path with different
ownership, rerun `rebuild-sandbox.sh` so the image is rebuilt with matching
IDs.

### State storage layout

Both modes store runtime state under `<home>/.claudiscord/`:

```
ADMIN_USER_HOME/.claudiscord/     # /root/.claudiscord on this host
  jobs.json                       # admin scheduled jobs
  sessions.json                   # per-channel state (shared across modes)
  files/                          # uploaded files (admin channels)

SANDBOX_HOST_HOME/.claudiscord/   # bind-mounted as /home/claude/.claudiscord
  jobs.json                       # sandbox scheduled jobs
  files/                          # uploaded files (sandbox channels)
```

The sandbox home also contains agent config:

```
SANDBOX_HOST_HOME/
  CLAUDE.md               # customisable
  .claude/
    .credentials.json     # seeded from host on first use
    skills/               # user skills
  .codex/
    auth.json             # seeded from host on first use
    config.toml           # minimal file config, xhigh reasoning
```

`ensureStorage()` seeds `SANDBOX_HOST_HOME/.claude/.credentials.json` from
`ADMIN_USER_HOME/.claude/.credentials.json` when the sandbox file is absent.
It likewise seeds `SANDBOX_HOST_HOME/.codex/auth.json` from
`ADMIN_USER_HOME/.codex/auth.json`. Copies are atomic, mode `0600`, and chowned
to the sandbox UID/GID. Host and sandbox share one rotating-token account, so
after a successful run their credentials are kept in sync (newer mtime wins,
`syncAgentCredentials`); a failed sandbox run drops its credentials to re-seed
from the host next run (`dropSandboxAuthFile`). If host credentials are missing or
invalid, sandbox creation continues but the corresponding agent reports an
authentication error.

### Background tasks

`spawnWithTimeout` (`src/spawn.js`) waits for the active CLI to exit naturally.
After 20 minutes, the process is killed and the user receives a timeout error;
partial output is not recovered. The channel session remains resumable.

### Image rebuild

```bash
bash scripts/rebuild-sandbox.sh
```

## Claude CLI usage

- `claude -p` with `--output-format stream-json` for interactive messages, `json` for jobs (the `json` object carries `session_id`, recorded as the job's `lastSessionId`; `text` would not)
- A first invocation omits session flags; Claude allocates an UUID and emits `session_id` in its JSON output. Subsequent invocations use `--resume <uuid>`.
- `--dangerously-skip-permissions` in sandbox (the container IS the sandbox)
- Model and effort follow the channel/job snapshot (`opus` → `xhigh`, `sonnet` → `high`)
- Host cwd: `os.homedir()` of the user running the service (auto-loads `$HOME/CLAUDE.md`) — typically `/root` on Linux when the service runs as root, `/var/root` on macOS
- Sandbox cwd: `/home/claude`
- Timeout: 1200s (SIGTERM then SIGKILL after 5s, no partial-answer recovery)

## Codex CLI usage

- Optional host integration, detected at startup from `CODEX_BIN` (default `codex`); the sandbox image installs `@openai/codex`
- `codex exec --yolo --skip-git-repo-check --json -c model_reasoning_effort="xhigh" -` for a new conversation
- `codex exec resume --yolo --skip-git-repo-check --json -c model_reasoning_effort="xhigh" <uuid> -` for subsequent prompts
- Prompts are passed through stdin; progress is not relayed to Discord
- `thread.started.thread_id` supplies the session UUID and the last completed `agent_message` supplies the response
- The shared Discord prompt is injected through the `developer_instructions` config override
- Codex model selection and authentication remain owned by the Codex CLI configuration; reasoning effort is forced to `xhigh`
- Sandbox execution uses `/home/claude` as cwd and `/home/claude/.codex` as `CODEX_HOME`
- `/upgrade` updates the sandbox Codex package with `npm install -g @openai/codex@latest`
- Codex remains unsupported in `/remote`

## Scheduled jobs

### Format

```json
{
  "id": "check-system",
  "channelId": "1234567890",
  "channelName": "ops-admin",
  "prompt": "…",
  "cron": "0 7 * * *",
  "enabled": true,
  "notify": true,
  "notifyPattern": "STATUT: PROBLEME",
  "remaining": 0,
  "agent": "claude",
  "model": "sonnet",
  "created": "2026-02-21T10:00:00Z",
  "lastRun": null,
  "lastSessionId": null,
  "description": "Daily health check at 7am"
}
```

- `channelId` is **required** — it's where the notification is sent. DM channels have an ID too, so a DM-bound job works identically.
- `channelName` is a display-only snapshot of the channel name at job creation time. The scheduler refreshes it on every run.
- `agent` is `"claude"` or `"codex"`. Snapshot of the channel's agent at scheduling time. Optional for backward compatibility — fallback is `"claude"`.
- `model` is `"opus"` or `"sonnet"`. Snapshot of the channel's Claude model at scheduling time and ignored by Codex. Optional for backward compatibility — fallback is `"sonnet"`.
- `remaining`: `0` = infinite, `>0` = decremented each run, job removed when it hits `0`.
- `lastSessionId`: diagnostic-only. Scheduler writes the agent session UUID of the last run (set even on error/timeout via `err.sessionId`). Jobs always run with a fresh session (`sessionId: null`), so this is never resumed — it just locates the run's transcript on disk: Claude at `<home>/.claude/projects/<cwd-hash>/<uuid>.jsonl` (admin cwd `/root` → `-root`, sandbox `/home/claude` → `-home-claude`), Codex via `find <home>/.codex/sessions -name "*<uuid>*"`.
- Unique key: `mode:id` (the mode is implicit from the file the job lives in).

### Storage

- **Admin jobs**: `ADMIN_USER_HOME/.claudiscord/jobs.json` (readable/writable by the host agent).
- **Sandbox jobs**: `SANDBOX_HOST_HOME/.claudiscord/jobs.json` (readable/writable by the container; the same path is readable from the host as well since the volume is a bind-mount).
- Both modes use the same `<home>/.claudiscord/` layout.
- **No merge**: an admin prompt only sees admin jobs, a sandbox prompt only sees sandbox jobs. The scheduler loads both files and runs everything.

### Execution & reload

- A single minute-resolution ticker (`setInterval`, `TICK_MS`) fires every job whose cron matches the current minute, using node-cron only to parse/validate the expression and build its time matcher. This tolerates sub-minute timer/clock drift and never replays a missed minute — unlike node-cron's per-job `setTimeout`, which aimed at an exact second and silently dropped a run when the first heartbeat after a (re)start landed off that second.
- `src/scheduler.js::reloadJobs()` rebuilds the in-memory schedule (one matcher per job) from both files.
- Called at startup, after every interactive prompt, and at the end of every scheduled job — so any change to the jobs files is picked up within one prompt.
- No `fs.watch` — only claudiscord writes to these files (directly via the active agent), so polling after each prompt is enough.
- In-memory lock per job key (plus a per-minute guard) prevents duplicate runs (including the "same wall-clock minute" edge case).

### Notifications

- When `notify: true` and the output matches `notifyPattern` (regex, dotall flag `s`, fallback `includes()` on invalid regex), the output is sent to `channelId`.
- Timeouts and errors are also announced on the channel when `notify: true`.

## Sessions

- `ADMIN_USER_HOME/.claudiscord/sessions.json` shape:
  ```json
  { "channels": { "<channelId>": { "mode": "admin"|"sandbox", "agent": "claude"|"codex", "model": "opus"|"sonnet", "sessionId": "<uuid>", "remoteId": null|"<agentId>", "lastName": "..." } } }
  ```
- `sessionId` belongs to the active agent. Both Claude and Codex allocate it on the first invocation and emit it early in JSON output; `executor.js` persists it inside the global queue.
- Timeout errors retain partial stdout so the agent adapter can attach an already-emitted UUID before the error is surfaced. The next prompt can therefore resume even when the first timed out after session initialization.
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
- Gating (`src/commands.js`): while `remoteId` is set, only `/remote`, `/status`, `/help`, `/jobs`, `/usage` are accepted in that channel. Every other input (plain text, `!shell`, other slash commands) returns an invalidation hint and does **not** spawn `claude -p` — this prevents two concurrent processes touching the same session. Voice messages are also dropped *before* Groq STT (`src/index.js`), so a vocal in remote mode neither pays for transcription nor leaks the `🎙️ <transcript>` echo.
- Cross-channel sandbox lockout: while *any* channel holds a sandbox remote, every other sandbox prompt / `!shell` / scheduled job is refused (`hasActiveSandboxRemote()` check in `executor.js`, `commands.js`, `scheduler.js`). Reason: `killAgentProcessesInContainer` pkills every non-init PID in the container on timeout, which would scoop up the live remote daemon. Admin channels are unaffected.
- Stop: `/remote` while active runs `claude stop <agentId>` (host or container), then deletes `~/.claude/jobs/<agentId>/` so the agent stops showing up in `claude agents` as a stopped session (`claude stop` keeps the conversation around by design). Strict 8-hex guard on the agentId before any `rm -rf`. Finally clears `remoteId` and calls `scheduler.reloadJobs()` — Claude may have edited the jobs files during the mobile session, and we did not go through the executor path that normally triggers a reload.
- Startup reconciliation: `reconcileRemotes()` runs after `sessions.load()` and best-effort-stops every persisted `remoteId` (also doing the jobs/ cleanup). After a machine reboot the daemon is gone and the stop fails harmlessly; the channel reverts to Discord mode either way.
- Sandbox prerequisite: the in-container claude daemon needs valid credentials, seeded from the host on first use. Without them the mobile app won't see the session.
