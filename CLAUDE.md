# Claudiscord

Discord DM relay to Claude Code CLI + scheduled job runner. Single Node.js process.

See `README.md` for installation, setup, configuration, and Discord commands reference.

## Architecture

```
DM (sandbox mode, default)
  -> executeInContainerQueued(userId, prompt) -> docker exec -> claude -p -> Discord

DM (admin mode, via /admin and /sandbox)
  -> executeDM(prompt) -> host spawn (direct CLI)

Scheduled jobs
  -> userId: null  -> executeClaudeCommand() -> host
  -> userId: <id>  -> executeInContainerQueued() -> user's container
```

- DM: prompt goes to Claude CLI, response sent back to Discord
- Jobs: `node-cron` triggers `executeJob()`, output sent via DM if `notify: true`
- Sessions: `sessions.json` stores session IDs only (no message history) + admin mode flag
- Admin DM mutex: single Claude at a time for host DMs (in-memory queue)
- Sandbox mutex: one lock per userId (Map of Promise queues), concurrent across users
- Job mutex: one lock per job ID (in-memory Set)

## Files

```
index.js              # Entry point, Discord handler, mode routing, shutdown
Dockerfile            # Sandbox image (node:22-slim + Claude CLI + user claude)
src/
  config.js           # .env + constants + system prompts + Docker config
  logger.js           # Logging to stdout/stderr (journald)
  discord.js          # Discord client, sendDM, splitMessage, typing indicator
  claude.js           # Spawn Claude CLI on host, DM mutex, job locks
  container.js        # Docker: ensureImage, ensureContainer, executeInContainer, credentials
  sessions.js         # In-memory map + persistence to sessions.json (sessions + adminMode)
  scheduler.js        # node-cron, auto-reload, executeJob, remaining counter
  commands.js         # /clear, /admin, /sandbox, /login, /status, /upgrade
sessions.json         # { adminMode, sessions: { userId: sessionId } } (gitignored)
scheduled-jobs.json   # Scheduled jobs array (gitignored)
.env                  # AUTHORIZED_USER_ID, CLAUDE_BIN, DISCORD_TOKEN, DATA_DIR
```

## Service

- **Service**: `claudiscord` (`systemctl status claudiscord`)
- **Logs**: `journalctl -u claudiscord -f`
- **Dependency**: `docker.service` (Requires + After)
- **ExecStopPost**: `pkill -f "claude.*-p"` (safety net)

## Modes

- **sandbox** (default): DMs executed in an isolated Docker container
- **admin**: DMs executed directly on the host (full system access)
- `/admin` switches to admin mode, `/sandbox` switches to sandbox mode (admin only)
- Persisted in `sessions.json` (`adminMode` field)
- Switching mode automatically clears the session (incompatible contexts)

## Docker Sandbox

- **Image**: `claudiscord-sandbox` (local arm64 build, `node:22-slim` + Claude Code)
- **Container**: `claudiscord-{userId}`, one per user, persistent (`--restart unless-stopped`)
- **Limits**: 512 MB RAM, 1 CPU
- **Volume**: `DATA_DIR/{userId}/home` -> `/home/claude`
- **Network**: bridge (internet access for Claude API)
- **User**: `claude` (non-root, required for `--dangerously-skip-permissions`)
- **CMD**: `sleep infinity` (container kept alive, commands via `docker exec`)
- Containers survive reboots and service restarts
- User data (credentials, files, CLAUDE.md) persists in volumes

### Sandbox storage

```
DATA_DIR/
  {userId}/
    home/                    # Mounted as /home/claude in the container
      CLAUDE.md              # Customizable by the user
      .claude/               # Auth state (from claude auth login)
      .claudiscord/          # Internal claudiscord data
        scheduled-jobs.json  # User's scheduled jobs
```

### Background task hook workaround

Claude Code's harness blocks `sleep` commands over 2 seconds in foreground Bash and returns an error suggesting `run_in_background: true`. The model follows this suggestion, gets back a background task ID, and immediately does `end_turn` — at which point claudiscord kills the process and the background task never completes.

**Workaround**: a PostToolUse hook (`wait-background.sh`) intercepts Bash tool results containing a `backgroundTaskId`, reconstructs the output file path (`/tmp/claude-{UID}/{cwd-encoded}/{session_id}/tasks/{taskId}.output`), and blocks (polling every 2s) until the file has content. Claude Code waits for the hook to finish before returning control to the model, so the background task completes and the model receives the actual output.

Files:
- `sandbox/wait-background.sh` — hook template (seeded by `ensureUserStorage`)
- `sandbox/settings.json` — settings template registering the hook (660s timeout)
- User volume: `~/.claude/hooks/wait-background.sh` + `~/.claude/settings.json`

**Note**: the output path encoding replaces every `/` with `-` including the leading one (`/home/claude` → `-home-claude`).

**TODO**: Remove if Claude Code adds a way to disable the `run_in_background` suggestion or to keep the process alive until background tasks complete.

### Skills symlink workaround

Claude Code has a hardcoded protection that blocks all tool writes (Write, Edit, Bash) to `~/.claude/` even with `--dangerously-skip-permissions` ([#37157](https://github.com/anthropics/claude-code/issues/37157)). The exemption list only includes `.claude/commands` and `.claude/agents`, not `.claude/skills` (bug). This prevents sandbox users from creating or editing skills.

**Workaround**: move `skills/` outside `.claude/` and symlink it back. The path check is string-based and doesn't resolve symlinks, so writes to `/home/claude/skills/` are allowed while Claude Code still reads skills from `~/.claude/skills/` via the symlink.

Setup (run from host, per user volume):
```bash
VOLUME=DATA_DIR/{userId}/home
mv "$VOLUME/.claude/skills" "$VOLUME/skills"
ln -s ../skills "$VOLUME/.claude/skills"
chown -R 1001:1001 "$VOLUME/skills" "$VOLUME/.claude/skills"
```

Each user's `CLAUDE.md` instructs the sandbox to write skills to `/home/claude/skills/` instead of `~/.claude/skills/`.

**TODO**: Remove this workaround when the upstream bug is fixed (`.claude/skills` added to the exemption list).

### Image rebuild

```bash
docker build --no-cache -t claudiscord-sandbox .
```

Existing containers must be removed first (they use the old image). They are recreated automatically on next use (volumes preserved).

## Claude CLI

- `claude -p` with `--output-format json` (DMs) or `text` (jobs)
- `--resume <sessionId>` for DMs, falls back to new session on failure
- `--allowedTools` depends on context (admin on host, sandbox in container)
- `--disallowedTools` blocks tools that shouldn't be available (CronCreate, Monitor, etc.)
- `--dangerously-skip-permissions` in sandbox (the container IS the sandbox)
- `--model opus`
- stdin closed immediately (`child.stdin.end()`)
- Host cwd: `/root` (auto-loads `/root/CLAUDE.md`)
- Sandbox cwd: `/home/claude` (loads the volume's CLAUDE.md)
- Timeout: 300s (SIGTERM then SIGKILL after 5s)

## Scheduled jobs

All users (admin and sandbox) can create scheduled jobs.

### Format

The central file is `scheduled-jobs.json` (admin). Sandbox users write to `/home/claude/.claudiscord/scheduled-jobs.json` in their container; their jobs are automatically merged into the central file after each execution.

```json
{
  "id": "check-system",
  "userId": null,
  "prompt": "...",
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

- `userId`: `null` = admin job (host), Discord user ID = sandbox job (container)
- `remaining`: execution counter. `0` = infinite (runs forever). `> 0` = decremented after each execution; job is automatically removed when it reaches `0`. Set to `1` for a one-shot job.
- Unique key: `userId` + `id` (two users can have the same `id`)

### Sandbox merge

After each Claude execution in a container, `mergeUserJobs(userId)`:
1. Reads `DATA_DIR/{userId}/home/.claudiscord/scheduled-jobs.json`
2. Validates each job (required fields, valid cron). Cleans the file if invalid.
3. Compares with the user's jobs in the central file:
   - New jobs -> added (with `userId` stamped)
   - Modified jobs -> updated (preserves `lastRun`)
   - Jobs deleted by the user -> removed from central
4. Saves the central file. `fs.watch` triggers scheduler reload.

### Execution

- `userId: null` -> host, all admin tools (`Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task`)
- `userId: <id>` -> user's container, all sandbox tools (`--dangerously-skip-permissions`)

### Behavior

- `node-cron` for scheduling
- In-memory lock per job key (`userId:id` or `id` alone for admin)
- Duplicate protection within the same minute
- `fs.watch()` on `scheduled-jobs.json` with 2s debounce for auto-reload
- Ephemeral jobs (no persistent session)
- If `notify: true`, output sent via DM to the job's `userId` (or admin if `null`). Filtered by `notifyPattern` if present (interpreted as regex, dotall flag `s` enabled).
