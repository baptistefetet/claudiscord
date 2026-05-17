# Claudiscord

Single-user Discord relay to Claude Code CLI + scheduled job runner. Single Node.js process.

See `README.md` for installation, setup and Discord commands reference.

## Architecture

```
Discord message (DM or guild text channel)
  -> authorization filter (authorized user only)
  -> command dispatcher (/admin, /sandbox, /clear, /login, …)
  -> session lookup by channelId
  -> executeForMode(mode, prompt)       [global queue — one Claude at a time]
       mode === 'admin'   -> host Claude  -> Discord channel
       mode === 'sandbox' -> single container -> Discord channel

Scheduled jobs
  -> node-cron
  -> executeJob(job)
  -> executeForMode(job.mode, …)        [same global queue]
  -> notification sent back to job.channelId
```

- Each Discord channel has its own mode (`admin` / `sandbox`), its own model (`opus` / `sonnet`, default `sonnet`) and its own Claude session. A DM channel is treated exactly like any other channel.
- The authorized user is stored in `.env` (`AUTHORIZED_USER_ID`) and is required at startup — without it the process refuses to boot.
- Global queue (`src/queue.js`): every prompt (interactive or scheduled) goes through a single FIFO. `isBusy()` is used to show a one-time "⏳ waiting" hint per channel.
- Jobs live in two separate files — never merged, never watched:
  - `scheduled-jobs.json` (project root) for admin jobs
  - `SANDBOX_HOME_DIR/.claudiscord/scheduled-jobs.json` for sandbox jobs
- Scheduler reloads both files after each prompt (no `fs.watch`).

## Files

```
index.js              # Entry point: Discord handler, queue wait UX
Dockerfile            # Sandbox image (node:22-slim + Claude CLI + user claude)
src/
  config.js           # .env loading + paths + constants
  prompts.js          # System prompt builder (per-channel context injection)
  logger.js           # stdout/stderr logging (journald-friendly)
  discord.js          # Client, sendToChannel, splitMessage, typing indicator
  queue.js            # Single global FIFO (runQueued, isBusy)
  claude.js           # Host Claude CLI execution (no queue — queue is in executor)
  container.js        # Docker: DOCKER_AVAILABLE, ensureImage/Container, creds
  executor.js         # executeForMode(mode, prompt, opts) — wraps queue
  jobs-store.js       # loadAllJobs (admin+sandbox), recordJobRun, jobKey
  sessions.js         # { channels: { channelId -> { mode, sessionId, lastName } } }
  scheduler.js        # node-cron, reloadJobs, executeJob, per-key lock
  commands.js         # /help /clear /status /admin /sandbox /opus /sonnet /remote /login /upgrade /restart !shell
  remote.js           # /remote helpers: startRemote, stopRemote, reconcileRemotes
  stt.js              # Groq Whisper transcription for Discord voice messages
claude/
  wait-background.sh  # PostToolUse hook: blocks until run_in_background completes
  settings.json       # Claude Code settings template (hooks config)
scripts/
  rebuild-sandbox.sh  # Rebuild Docker sandbox image
sessions.json         # { channels: { channelId -> {…} } } (gitignored)
scheduled-jobs.json   # Admin scheduled jobs (gitignored)
.env                  # AUTHORIZED_USER_ID, DISCORD_TOKEN, CLAUDE_BIN, SANDBOX_HOME_DIR, GROQ_API_KEY
```

## Service

- **Service**: `claudiscord` (`systemctl status claudiscord`)
- **Logs**: `journalctl -u claudiscord -f`
- **ExecStopPost**: `pkill -f "claude.*-p"` (safety net)
- **User**: root

## Voice messages (speech-to-text)

Discord voice messages (the mic button — flag `MessageFlags.IsVoiceMessage`)
are transcribed via Groq Whisper before being passed to Claude. Plain audio
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
  Claude executes, so the user sees what Whisper understood.
- API errors are surfaced to the channel and logged; the bot stays up.

## Authorization

- `AUTHORIZED_USER_ID` in `.env` identifies the single user allowed to talk to the bot. It is required at startup — `src/config.js` throws if missing, so the service won't run without it.
- The user finds their own ID via Discord's developer mode (right-click avatar → Copy User ID).
- Every non-authorized message is silently dropped — no reply, minimal logging.

## Modes (per channel)

- `admin` (default) — prompts executed directly on the host with access to system tools
- `sandbox` — prompts executed inside the Docker container with `--dangerously-skip-permissions`
- `/admin` and `/sandbox` switch the current channel's mode and clear its session
- `/sandbox` reports an error and does not switch if Docker is not installed
- The mode is persisted in `sessions.json`

## Model (per channel)

- Each channel has its own model (`opus` or `sonnet`, default `sonnet`).
- `/opus` and `/sonnet` switch the current channel's model. The Claude session is NOT reset.
- Effort is derived from the model (opus → xhigh, sonnet → high), centralized in `src/config.js::EFFORT_BY_MODEL`.
- The model is persisted in `sessions.json` next to the mode.
- Scheduled jobs created from a channel snapshot the channel's model at scheduling time in their `model` field (see Scheduled jobs > Format). Changing the channel's model afterwards does not affect previously scheduled jobs.

## Channel context injection

`src/prompts.js` builds the system prompt from `{ mode, channelName, channelTopic, isDM, botName, userName, today }`. The prompt always tells Claude whether it is in a DM or a named guild channel; if the channel has a `topic`, the topic is presented as a mini CLAUDE.md that scopes the conversation.

## Global queue

All executions — interactive prompts and scheduled jobs, admin and sandbox — go through `src/queue.js::runQueued`. Only one Claude process runs at a time. If a new message arrives while something is running, `index.js` sends a one-shot "⏳ Waiting for previous prompt..." notice to the concerned channel. This sequentiality simplifies invariants around concurrent file writes (jobs files, sessions file).

## Docker sandbox (optional)

- **Image**: `claudiscord-sandbox` (local build, `node:22-slim` + Claude CLI)
- **Container**: `claudiscord-sandbox` (single container, `--restart unless-stopped`)
- **Limits**: 512 MB RAM, 1 CPU
- **Volume**: `SANDBOX_HOME_DIR -> /home/claude`
- **Network**: bridge
- **User in container**: `claude` (non-root)
- **CMD**: `sleep infinity`; commands run via `docker exec`
- Docker availability is detected at startup; if `docker --version` fails, `DOCKER_AVAILABLE` becomes `false` and sandbox operations report a friendly error

### Host user/group alignment

`scripts/rebuild-sandbox.sh` reads the UID/GID of `SANDBOX_HOME_DIR` and
passes them as `--build-arg SANDBOX_UID=… SANDBOX_GID=…` so the in-container
`claude` user matches host ownership. If the directory doesn't exist yet,
the script creates it owned by `1001:1001` and uses those defaults.

Runtime echoes this: `src/container.js` reads `SANDBOX_HOME_DIR`'s ownership
via `fs.statSync` at startup (`readSandboxIds`) and uses those IDs for
every chown when seeding files. Single source of truth: the directory's
ownership.

Implication: if you move `SANDBOX_HOME_DIR` to a path with different
ownership, rerun `rebuild-sandbox.sh` so the image is rebuilt with matching
IDs.

### Sandbox storage layout

```
SANDBOX_HOME_DIR/         # = /home/claude in the container
  CLAUDE.md               # customisable
  .claude/
    .credentials.json     # written by /login
    settings.json         # hooks config (seeded)
    hooks/wait-background.sh
    skills/               # user skills
  .claudiscord/
    scheduled-jobs.json   # sandbox jobs
```

### Background task hook workaround

Claude Code's harness blocks `sleep` commands over 2 seconds in foreground Bash and returns an error suggesting `run_in_background: true`. The model follows this suggestion, gets back a background task ID, and immediately does `end_turn` — at which point claudiscord kills the process and the background task never completes.

**Workaround**: a PostToolUse hook (`wait-background.sh`) intercepts Bash tool results containing a `backgroundTaskId`, reconstructs the output file path (`/tmp/claude-{UID}/{cwd-encoded}/{session_id}/tasks/{taskId}.output`), and blocks (polling every 2s) until the file has content.

Files:
- `claude/wait-background.sh` — hook template (seeded by `ensureStorage()`)
- `claude/settings.json` — settings template registering the hook (660s timeout)
- Sandbox volume: `~/.claude/hooks/wait-background.sh` + `~/.claude/settings.json`

### Image rebuild

```bash
bash scripts/rebuild-sandbox.sh
```

## Claude CLI usage

- `claude -p` with `--output-format stream-json` for interactive messages, `text` for jobs
- Session flag chosen per channel: `--session-id <uuid>` on the first spawn (`sessionStarted: false`), `--resume <uuid>` on subsequent spawns (`sessionStarted: true`). UUID allocated up-front by `sessions.ensureSession()`. See "Sessions" below.
- `--dangerously-skip-permissions` in sandbox (the container IS the sandbox)
- Interactive: `--model opus --effort xhigh`
- Jobs: `--model sonnet --effort high`
- Host cwd: `os.homedir()` of the user running the service (auto-loads `$HOME/CLAUDE.md`) — typically `/root` on Linux when the service runs as root, `/var/root` on macOS
- Sandbox cwd: `/home/claude`
- Timeout: 1200s (SIGTERM then SIGKILL after 5s)

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
  "model": "sonnet",
  "created": "2026-02-21T10:00:00Z",
  "lastRun": null,
  "description": "Daily health check at 7am"
}
```

- `channelId` is **required** — it's where the notification is sent. DM channels have an ID too, so a DM-bound job works identically.
- `channelName` is a display-only snapshot of the channel name at job creation time. The scheduler refreshes it on every run.
- `model` is `"opus"` or `"sonnet"`. Snapshot of the channel's model at scheduling time. Optional for backward compatibility — fallback is `"sonnet"`.
- `remaining`: `0` = infinite, `>0` = decremented each run, job removed when it hits `0`.
- Unique key: `mode:id` (the mode is implicit from the file the job lives in).

### Storage

- **Admin jobs**: `scheduled-jobs.json` at the project root (readable/writable by the host Claude only).
- **Sandbox jobs**: `SANDBOX_HOME_DIR/.claudiscord/scheduled-jobs.json` (readable/writable by the container; the same path is readable from the host as well since the volume is a bind-mount).
- **No merge**: an admin prompt only sees admin jobs, a sandbox prompt only sees sandbox jobs. The scheduler loads both files and runs everything.

### Execution & reload

- `src/scheduler.js::reloadJobs()` rebuilds the `node-cron` tasks from both files.
- Called at startup, after every interactive prompt, and at the end of every scheduled job — so any change to the jobs files is picked up within one prompt.
- No `fs.watch` — only claudiscord writes to these files (directly via Claude Code), so polling after each prompt is enough.
- In-memory lock per job key prevents duplicate runs (including the "same wall-clock minute" edge case).

### Notifications

- When `notify: true` and the output matches `notifyPattern` (regex, dotall flag `s`, fallback `includes()` on invalid regex), the output is sent to `channelId`.
- Timeouts and errors are also announced on the channel when `notify: true`.

## Sessions

- `sessions.json` shape:
  ```json
  { "channels": { "<channelId>": { "mode": "admin"|"sandbox", "model": "opus"|"sonnet", "sessionId": "<uuid>", "sessionStarted": boolean, "remoteId": null|"<agentId>", "lastName": "..." } } }
  ```
- `sessionId` is a UUID v4 allocated by `sessions.ensureSession()` **before** the first claude spawn — so a message that times out is still resumable (we already know the session UUID).
- `sessionStarted` switches the CLI flag: `false` → `--session-id <uuid>` (creates the session); `true` → `--resume <uuid>` (reuses it; reusing `--session-id` on an existing UUID errors with "Session ID X is already in use"). Flipped to `true` after a successful spawn (and on timeout, since the JSONL is on disk).
- `remoteId` is `null` when the channel is in Discord mode (default), or an 8-hex agent ID when the channel is currently driven from the Claude mobile app via `/remote`. See "Remote control" below.
- `lastName` is a display snapshot to make `sessions.json` readable during debugging.
- A full reset is harmless — it only drops Claude session IDs and the `sessionStarted` bit (the next prompt starts a fresh conversation per channel).
- Startup purge (`index.js::purgeInvalidChannels`) drops entries whose Discord channel no longer exists. Runs after `login()` and after `reconcileRemotes()` (which needs to stop any remote agent first, before the entry vanishes). Strict: only `DiscordAPIError code 10003` (Unknown Channel) triggers removal; transient errors are logged and skipped. Scheduled jobs attached to a purged channel are intentionally NOT removed — job lifecycle is managed by hand.

## Remote control

`/remote` toggles the channel between Discord mode (default) and remote mode. In remote mode, the channel's Claude session is driven from the Claude mobile app (full UI, permissions, reasoning view, etc.) instead of from Discord.

- Implementation: `src/remote.js` spawns `claude --bg [--resume <channelSessionId>] --remote-control <channelName>` (host for admin, `docker exec` for sandbox). The CLI prints `backgrounded · <agentId>` on stdout — we parse the 8-hex agent ID and persist it as `remoteId` in `sessions.json`.
- Asymmetric continuity: `--resume` makes `claude --bg` copy the existing Discord conversation into the bg session's JSONL, so the mobile user picks up where Discord left off. But `--bg` manages its own UUID (warns "--bg manages the session id; ignoring --session-id") and we don't reconcile back — `setRemoteId` wipes the channel's `sessionId`/`sessionStarted`, so the next Discord message after `/remote` stop starts a fresh session. Going Discord → mobile keeps history; coming back Discord → fresh.
- Naming: the mobile app shows each session under `<channelName>` (DM = username), so multiple channels can run in parallel and stay discoverable.
- Gating (`src/commands.js`): while `remoteId` is set, only `/remote`, `/status`, `/help` are accepted in that channel. Every other input (plain text, `!shell`, other slash commands) returns an invalidation hint and does **not** spawn `claude -p` — this prevents two concurrent processes touching the same session. Voice messages are also dropped *before* Groq STT (`index.js`), so a vocal in remote mode neither pays for transcription nor leaks the `🎙️ <transcript>` echo.
- Cross-channel sandbox lockout: while *any* channel holds a sandbox remote, every other sandbox prompt / `!shell` / scheduled job is refused (`hasActiveSandboxRemote()` check in `executor.js`, `commands.js`, `scheduler.js`). Reason: `killClaudeInContainer` pkills every non-init PID in the container on timeout or early-result, which would scoop up the live remote daemon. Admin channels are unaffected.
- Stop: `/remote` while active runs `claude stop <agentId>` (host or container), then deletes `~/.claude/jobs/<agentId>/` so the agent stops showing up in `claude agents` as a stopped session (`claude stop` keeps the conversation around by design). Strict 8-hex guard on the agentId before any `rm -rf`. Finally clears `remoteId` and calls `scheduler.reloadJobs()` — Claude may have edited the jobs files during the mobile session, and we did not go through the executor path that normally triggers a reload.
- Startup reconciliation: `reconcileRemotes()` runs after `sessions.load()` and best-effort-stops every persisted `remoteId` (also doing the jobs/ cleanup). After a machine reboot the daemon is gone and the stop fails harmlessly; the channel reverts to Discord mode either way.
- Sandbox prerequisite: the in-container claude daemon needs valid credentials (`/login`). Without them the mobile app won't see the session.
