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

- Each Discord channel has its own mode (`admin` / `sandbox`) and its own Claude session. A DM channel is treated exactly like any other channel.
- The authorized user is stored in `.env` (`AUTHORIZED_USER_ID`). If empty, the first DM the bot receives registers its author.
- Global queue (`src/queue.js`): every prompt (interactive or scheduled) goes through a single FIFO. `isBusy()` is used to show a one-time "⏳ waiting" hint per channel.
- Jobs live in two separate files — never merged, never watched:
  - `scheduled-jobs.json` (project root) for admin jobs
  - `SANDBOX_HOME_DIR/.claudiscord/scheduled-jobs.json` for sandbox jobs
- Scheduler reloads both files after each prompt (no `fs.watch`).

## Files

```
index.js              # Entry point: Discord handler, bootstrap, queue wait UX
Dockerfile            # Sandbox image (node:22-slim + Claude CLI + user claude)
src/
  config.js           # .env + writeEnvValue + paths + constants
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
  commands.js         # /help /clear /status /admin /sandbox /login /upgrade /restart !shell
claude/
  wait-background.sh  # PostToolUse hook: blocks until run_in_background completes
  settings.json       # Claude Code settings template (hooks config)
scripts/
  rebuild-sandbox.sh  # Rebuild Docker sandbox image
sessions.json         # { channels: { channelId -> {…} } } (gitignored)
scheduled-jobs.json   # Admin scheduled jobs (gitignored)
.env                  # AUTHORIZED_USER_ID, DISCORD_TOKEN, CLAUDE_BIN, SANDBOX_HOME_DIR
```

## Service

- **Service**: `claudiscord` (`systemctl status claudiscord`)
- **Logs**: `journalctl -u claudiscord -f`
- **ExecStopPost**: `pkill -f "claude.*-p"` (safety net)
- **User**: root — required so the bootstrap can rewrite `.env`

## Authorization

- `AUTHORIZED_USER_ID` in `.env` identifies the single user allowed to talk to the bot.
- If empty at startup, the first DM the bot receives writes the author's user ID into `.env`. Guild messages never trigger the bootstrap.
- Every non-authorized message is silently dropped — no reply, minimal logging.
- Writing `.env` is atomic (tmp + rename); an in-memory `bootstrapPending` flag prevents a race between concurrent first-DMs.

## Modes (per channel)

- `admin` (default) — prompts executed directly on the host with access to system tools
- `sandbox` — prompts executed inside the Docker container with `--dangerously-skip-permissions`
- `/admin` and `/sandbox` switch the current channel's mode and clear its session
- `/sandbox` reports an error and does not switch if Docker is not installed
- The mode is persisted in `sessions.json`

## Channel context injection

`src/prompts.js` builds the system prompt from `{ mode, channelName, channelTopic, isDM, botName, userName, today }`. The prompt always tells Claude whether it is in a DM or a named guild channel; if the channel has a `topic`, the topic is presented as a mini CLAUDE.md that scopes the conversation.

## Global queue

All executions — interactive prompts and scheduled jobs, admin and sandbox — go through `src/queue.js::runQueued`. Only one Claude process runs at a time. If a new message arrives while something is running, `index.js` sends a one-shot "⏳ En attente du prompt précédent..." notice to the concerned channel. This sequentiality simplifies invariants around concurrent file writes (jobs files, sessions file).

## Docker sandbox (optional)

- **Image**: `claudiscord-sandbox` (local build, `node:22-slim` + Claude CLI)
- **Container**: `claudiscord-sandbox` (single container, `--restart unless-stopped`)
- **Limits**: 512 MB RAM, 1 CPU
- **Volume**: `SANDBOX_HOME_DIR -> /home/claude`
- **Network**: bridge
- **User in container**: `claude` (non-root)
- **CMD**: `sleep infinity`; commands run via `docker exec`
- Docker availability is detected at startup; if `docker --version` fails, `DOCKER_AVAILABLE` becomes `false` and sandbox operations report a friendly error

### Host user/group setup

The container user `claude` is baked into the image with fixed numeric IDs (`UID=1001`, `GID=1002`, see `Dockerfile`). For a bind-mount to work cleanly, the host side of `SANDBOX_HOME_DIR` must be owned by a user/group with the **same numeric IDs**. File ownership crosses the container boundary by UID/GID, not by name, so the names on each side don't have to match — only the numbers.

Recommended host setup (names are a suggestion):

```bash
# 1. Create a group at GID 1002 (pick a different GID if 1002 is taken on your host; then
#    update the Dockerfile to match and rebuild)
groupadd -g 1002 sandbox

# 2. Create a user at UID 1001 in that group, with its home pointing at SANDBOX_HOME_DIR
useradd -u 1001 -g sandbox -d /path/to/SANDBOX_HOME_DIR -s /usr/sbin/nologin sandbox

# 3. Own the mounted directory
mkdir -p /path/to/SANDBOX_HOME_DIR
chown -R sandbox:sandbox /path/to/SANDBOX_HOME_DIR
```

If the target UID or GID is already taken on your host, either pick different numbers **and** edit `Dockerfile` (`groupadd -g <new-GID>` / `useradd -u <new-UID> -g <new-GID>`) before building, or reassign the colliding user/group first (`groupmod -g …`, `chown -R …` on affected files). Don't leave the Dockerfile and host out of sync — every file created inside the container lands on the host with the container's numeric IDs.

### Sandbox storage layout

```
SANDBOX_HOME_DIR/         # = /home/claude in the container
  CLAUDE.md               # customisable
  .claude/
    .credentials.json     # written by /login
    settings.json         # hooks config (seeded)
    hooks/wait-background.sh
  .claudiscord/
    scheduled-jobs.json   # sandbox jobs
  skills/                 # symlink workaround (see below)
```

### Background task hook workaround

Claude Code's harness blocks `sleep` commands over 2 seconds in foreground Bash and returns an error suggesting `run_in_background: true`. The model follows this suggestion, gets back a background task ID, and immediately does `end_turn` — at which point claudiscord kills the process and the background task never completes.

**Workaround**: a PostToolUse hook (`wait-background.sh`) intercepts Bash tool results containing a `backgroundTaskId`, reconstructs the output file path (`/tmp/claude-{UID}/{cwd-encoded}/{session_id}/tasks/{taskId}.output`), and blocks (polling every 2s) until the file has content.

Files:
- `claude/wait-background.sh` — hook template (seeded by `ensureStorage()`)
- `claude/settings.json` — settings template registering the hook (660s timeout)
- Sandbox volume: `~/.claude/hooks/wait-background.sh` + `~/.claude/settings.json`

### Skills symlink workaround

Claude Code has a hardcoded protection that blocks all tool writes (Write, Edit, Bash) to `~/.claude/` even with `--dangerously-skip-permissions` ([#37157](https://github.com/anthropics/claude-code/issues/37157)). The exemption list only includes `.claude/commands` and `.claude/agents`, not `.claude/skills` (bug).

**Workaround**: move `skills/` outside `.claude/` and symlink it back. The path check is string-based and doesn't resolve symlinks.

Setup:
```bash
VOLUME=$SANDBOX_HOME_DIR
mv "$VOLUME/.claude/skills" "$VOLUME/skills"
ln -s ../skills "$VOLUME/.claude/skills"
chown -R 1001:1001 "$VOLUME/skills" "$VOLUME/.claude/skills"
```

### Image rebuild

```bash
docker build --no-cache -t claudiscord-sandbox .
docker rm -f claudiscord-sandbox  # next use recreates it (volume preserved)
```

## Claude CLI usage

- `claude -p` with `--output-format stream-json` for interactive messages, `text` for jobs
- `--resume <sessionId>` when the channel has one, fallback to new session on failure
- `--dangerously-skip-permissions` in sandbox (the container IS the sandbox)
- Interactive: `--model opus --effort xhigh`
- Jobs: `--model sonnet --effort high`
- Host cwd: `/root` (auto-loads `/root/CLAUDE.md`)
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
  "created": "2026-02-21T10:00:00Z",
  "lastRun": null,
  "description": "Daily health check at 7am"
}
```

- `channelId` is **required** — it's where the notification is sent. DM channels have an ID too, so a DM-bound job works identically.
- `channelName` is a display-only snapshot of the channel name at job creation time. The scheduler refreshes it on every run.
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
  { "channels": { "<channelId>": { "mode": "admin"|"sandbox", "sessionId": "...", "lastName": "..." } } }
  ```
- `lastName` is a display snapshot to make `sessions.json` readable during debugging.
- A full reset is harmless — it only drops Claude session IDs (the next prompt starts a fresh conversation per channel).
