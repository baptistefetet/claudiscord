# Claudiscord

Single-user Discord relay to Claude Code CLI and/or Codex CLI + scheduled job runner. Single Node.js process. See `README.md` for installation and the commands reference.

Mechanisms are documented at their call sites; this file keeps only the cross-module rules.

## Architecture

```
Discord message (DM, guild channel, thread, text-in-voice)
  -> authorized user only (AUTHORIZED_USER_ID, required at boot) -> command dispatcher
  -> executePrompt(agent, mode, prompt, { tier: 'high' })   [FIFO keyed by channelId]
       mode admin -> host CLI, mode sandbox -> docker exec in the single container
Scheduler (minute ticker) -> executePrompt(channel's agent, job.mode, …, { tier: 'medium' }) -> notify job.channel_id
```

- Each channel (DM and public thread included) has its own `mode` (`admin`/`sandbox`), `agent` (`claude`/`codex`) and session, persisted in `ADMIN_USER_HOME/.claudiscord/sessions.json`. A thread snapshots its parent's mode/agent on first contact but starts a fresh session.
- `sessionId` belongs to the agent (Claude UUID vs Codex thread id): `/new`, a mode switch or an agent switch reset it, and are refused while the channel is busy.
- Both agents are optional, at least one required (`CLAUDE_AVAILABLE`/`CODEX_AVAILABLE`, probed once at boot). Sandbox availability is a live container probe.

## Files

```
src/index.js       Discord handler, message batching, slash-command adapter, thread/upload handling
src/config.js      .env, paths, constants, AGENT_MODELS, REASONING_EFFORT
src/prompts.js     System prompt (agent-agnostic), scheduling doc, GPT-Live instructions, SOUL.md injection
src/executor.js    executePrompt: tier→model, host/sandbox env, session persistence
src/queue.js       Per-channel FIFOs, maintenance gate, running-run registry (/stop)
src/spawn.js       spawnCollect: subprocess runner (cancellable, line streaming)
src/claude.js      Claude exec/login/usage/version + progress parsing
src/codex.js       Codex exec/login/usage/version + progress parsing
src/container.js   Docker image/container, host binary mounts, sandbox file writes
src/scheduler.js   Ticker, reloadJobs, executeJob, NOTIFY_NONE, non-isolated job cleanup
src/jobs-store.js  SQLite jobs via the sqlite3 CLI
src/sessions.js    sessions.json, dropSession observer
src/commands.js    COMMANDS registry + dispatch (text and slash)
src/login.js src/shell.js src/diff.js src/gist.js src/skills.js src/uploads.js src/stt.js
src/voice.js       Voice channel assistant (connection, delegation, autojoin)
src/live.js        GPT-Live call (WebRTC + sideband)
scripts/rebuild-sandbox.sh  Build image (UID/GID from SANDBOX_HOME), open Claude versions dir
scripts/update-sandbox.sh   apt upgrade inside the container (/upgrade)
```

## Models

- `AGENT_MODELS` has two tiers per agent: interactive prompts (text, voice) run `high`, jobs run `medium`. Nothing is user-selectable or persisted.
- Tier→model resolution lives **only** in `executor.js`. Reasoning effort is always `REASONING_EFFORT`; both override local CLI config.

## Queues and stopping

- `queue.js::runQueued(key)`: strict FIFO per channel (jobs included), channels run concurrently. `/login`, `!shell`, `/upgrade` use `runMaintenance`: refused while anything runs, then block new work.
- Messages sent while a channel is busy merge into one batch (⏳ reaction), closed when it reaches the head of the queue and echoed as a quote before its answer.
- `/stop` kills the running process, not the queue. Registry keyed by the queue key (not `channelId`) so an isolated job is stoppable from the channel it blocks.
- A stopped run rejects `CANCELLED` with its partial output, from which adapters recover the session id; a stopped job skips `recordJobRun`.
- Host runs are `detached` so the whole process group is killed. Sandbox runs need a second, container-side kill: `docker exec` does not propagate signals, so `killContainerRun` matches the `CLAUDISCORD_RUN=<uuid>` env marker (never the command name: other channels share the container). The service's `ExecStopPost` does the same at stop.
- Interactive runs have no timeout. Only the `medium` tier gets `JOB_TIMEOUT_MS` (1 h), rejecting `TIMEOUT` through the same kill path.

## Sandbox

- Single container `claudiscord-sandbox` (1 CPU, bridge, user `claude`, `sleep infinity` + `docker exec`), `SANDBOX_HOME` → `/home/claude`. Docker is optional (`DOCKER_AVAILABLE`).
- Agent binaries come from the host, bind-mounted read-only at container creation: Claude's `versions/` dir and Codex's `releases/` dir (directories, so updates are visible; the image wrappers run the highest version). Never mount `CODEX_HOME`: it holds the admin `auth.json`. Sources are layout-checked before mounting, so a package-manager Codex is host-only.
- Mounts are fixed at creation: a stale one shows up as a `/version` mismatch, fixed by recreating the container.
- Claudiscord never changes host permissions at runtime; `rebuild-sandbox.sh` opens the Claude versions dir once. The container `claude` UID/GID follow `SANDBOX_HOME` ownership (build arg + `readSandboxIds` for every chown).
- Base image pinned to `node:22-bookworm-slim` (glibc 2.36) for binary compatibility.
- The container user owns the sandbox home: overwrites go through `refreshContainerFile` (single `O_NOFOLLOW` fd), seed-only writes are guarded by `existsSync`.
- Host and sandbox credentials are independent; `/login` targets the channel's current mode and agent.

## Scheduled jobs

- Two SQLite databases, never merged: `<home>/.claudiscord/jobs.db` for admin and sandbox. `job.mode` is the database the job lives in: that is the security boundary. The agent is resolved live from the channel at each run.
- Schema in `jobs-store.js::SCHEMA` (`STRICT`, since agents insert rows through the CLI). A job is stopped by deleting its row; `remaining` 0 = infinite.
- All access through the `sqlite3` CLI, each call starting with `.timeout 5000`. No WAL (sidecar files would change ownership of the sandbox db). `recordJobRun` is one transaction.
- The minute ticker never replays missed minutes. `reloadJobs()` runs at boot and after every prompt and job (no `fs.watch`).
- Agent-facing reference: the system prompt holds the prohibitions (no crontab etc.) and a pointer to `<home>/.claudiscord/scheduling.md`; job runs get the doc inline. The file is regenerated from `prompts.js::getSchedulingDoc` (admin at boot, sandbox in `ensureStorage`): edit the source, not the file.
- `NOTIFY_NONE` as last line drops the output. The convention must never be described without its "only if the job's prompt asks for it" guard. Errors always notify.
- Non-isolated jobs (`isolated = 0`) run in the channel's live session. Any session drop (`sessions.js::dropSession`, or channel purge) deletes that channel's non-isolated jobs in **both** databases through the `scheduler.handleSessionCleared` observer; `SESSION_REQUIRED`/`CHANNEL_CONTEXT_CHANGED` are only the backstop for runs already past `tick()` but not yet enqueued. Accepted gap: `requireSession` checks that a session exists, not which one, so such a run can join a session opened in the meantime. These runs mark themselves in-band at the head of the prompt, because the system prompt is not in the transcript.

## Slash commands

`COMMANDS` in `commands.js` is the single source for text and native slash commands; `runCommand()` holds the shared gating. All Discord interaction plumbing stays in `index.js` (`registerSlashCommands` on ready, global scope). Requires the `applications.commands` OAuth scope.

## Voice

- Voice messages (flag `IsVoiceMessage` only, not audio attachments) → Groq Whisper (`stt.js`), echoed as `🎙️ <text>`. Text wins over voice; no `GROQ_API_KEY` → dropped.
- `/voice` in a voice channel's chat starts a GPT-Live call (`live.js`) on the **host** Codex ChatGPT login. Undocumented wire, expect breakage. Input must be RTP Opus over WebRTC; output arrives on the sideband only.
- The call has no tools: every delegation goes through `executePrompt` (`high` tier, channel FIFO, `voice: true` prompt flag). The session is the voice channel's `channelId`, shared with its chat. Each join resets it (skipped while a task runs there), so voice-created jobs must be isolated; agent switches are locked while the call is active.
- `/autojoin` is a per-channel allowlist persisted in `sessions.json`, on purpose: the bot must never join calls with other people by default.

## Uploads, progress, sessions

- Uploads go to `<home>/.claudiscord/files/` per mode (chowned in the sandbox). Upload-only messages don't spawn the agent; with text, the saved paths prefix the prompt.
- Progress relay: each agent maps stream lines to `{ icon, summary, detail }`, `discord.js` renders one edited message. Updates are fire-and-forget and must never disturb the run. Jobs pass no `onProgress`; voice relays it to the chat (no typing indicator) and as silent context to the call.
- `sessions.json` entries: `mode, agent, sessionId, context, lastName, depotPath, diffGistId, autojoin`. `context` = last assistant event's input tokens (Codex: none). `depotPath` is cleared by a mode switch. Agent-less legacy entries load as Claude. Startup purge only removes channels on Discord error 10003.
