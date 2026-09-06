# Claudiscord

Single-user Discord relay to Claude Code CLI and/or Codex CLI + scheduled job runner. Single Node.js process.

See `README.md` for installation, setup and Discord commands reference.

## Architecture

```
Discord message (DM, guild text channel or text-in-voice chat)
  -> authorization filter (authorized user only)
  -> command dispatcher (/admin, /sandbox, /new, …)
  -> session lookup by channelId
  -> executePrompt(agent, mode, prompt, { tier: 'high' }) [FIFO queue keyed by channelId]
       claude + admin   -> host Claude
       claude + sandbox -> single container
       codex  + admin   -> host Codex
       codex  + sandbox -> single container

Scheduled jobs
  -> minute-resolution ticker
  -> executeJob(job)
  -> executePrompt(channel's agent, job.mode, …, { tier: 'medium' }) [queue keyed by job.channelId]
  -> notification sent back to job.channelId
```

- Each Discord channel has its own mode (`admin` / `sandbox`), agent (`claude` / `codex`, default `claude`) and active-agent session. The model is not a channel setting — it is derived from the agent and the execution tier (see "Agent and models"). A DM channel is treated exactly like any other channel.
- Public threads are handled like any other channel (own `channelId` → own session). On first contact, a thread snapshots its parent channel's mode/agent (`sessions.ensureFromParent`, not a live link) but starts a fresh session. The system prompt shows both the parent channel name and the thread name (`prompts.js` `thread`/`threadName`); the topic falls back to the parent's. Jobs/uploads attach to the thread itself like any channel. System messages are dropped early (`if (message.system) return;`): creating a thread posts a `ThreadCreated` system message in the parent whose `content` is the thread NAME (not empty), which would otherwise be answered as a prompt. On a thread's first turn (sessionId still null), if it was created from an existing message, that anchor message (`channel.fetchStarterMessage()`) is prepended to the prompt as quoted context — otherwise the message the thread forks from would be invisible (it lives in the parent and appears in the thread only as a dropped system message).
- The authorized user is stored in `.env` (`AUTHORIZED_USER_ID`) and is required at startup — without it the process refuses to boot.
- Per-channel queues (`src/queue.js`): prompts sharing a `channelId` are FIFO; different channels run concurrently. One global maintenance gate protects login, shell and upgrades. `isBusy(channelId)` drives the one-time "⏳ waiting" hint.
- Jobs live in two separate SQLite databases — never merged, never watched:
  - `ADMIN_USER_HOME/.claudiscord/jobs.db` for admin jobs
  - `SANDBOX_HOST_HOME/.claudiscord/jobs.db` for sandbox jobs
- Sessions live in `ADMIN_USER_HOME/.claudiscord/sessions.json`.
- Scheduler reloads both databases after each prompt (no `fs.watch`).

## Files

```
Dockerfile            # Sandbox image (node:22-bookworm-slim + user claude; agents come from host mounts)
src/
  index.js            # Entry point: Discord handler, queue wait UX
  config.js           # .env loading + paths + constants
  prompts.js          # Shared system prompt builder (agent-agnostic — no per-agent sections)
  logger.js           # stdout/stderr logging (journald-friendly)
  discord.js          # Client, sendToChannel, sendChunked (splitMessage now private), typing indicator, startProgressReporter
  queue.js            # Per-channel FIFOs + global maintenance gate + the run currently executing per key (/stop)
  spawn.js            # spawnCollect: generic subprocess runner (unbounded, no timeout, cancellable, line-streaming via onLine); probeVersion: `--version` probe
  claude.js           # Claude exec/login (host + sandbox), stream-json parse, OAuth usage (getClaudeUsage), CLI version (getClaudeVersion)
  codex.js            # Codex exec/login (host + sandbox), JSONL parse, account usage (getCodexUsage), CLI version (getCodexVersion)
  container.js        # Docker: image/container, sandbox env factories (sandboxClaudeEnv/sandboxCodexEnv)
  executor.js         # executePrompt(agent, mode) → resolve tier→model → pick env (host const / sandbox factory) → executeClaude|executeCodex; queue
  jobs-store.js       # SQLite jobs store via sqlite3 CLI: loadAllJobs (admin+sandbox), recordJobRun, deleteJob, deleteNonIsolatedJobs, ensureDb, jobKey
  sessions.js         # { channels: { channelId -> { mode, agent, sessionId, usage, depotPath, ... } } }; onSessionCleared observer
  scheduler.js        # minute-resolution ticker, reloadJobs, executeJob, handleSessionCleared, per-key lock
  commands.js         # COMMANDS registry → dispatch + native slash metadata; /new /stop /status /usage /version /skills /login /jobs /diff /admin /sandbox /claude /codex /voice /upgrade /restart !shell; transport-neutral dispatchSlashCommand + getRegisteredCommands (Discord plumbing stays in index.js); /login and !shell handlers live in login.js / shell.js
  login.js            # /login flow state machine: pending login, URL relay, Discord code input, timeouts
  diff.js             # /diff: git collection (numstat + porcelain), one-line header, patch published via gist.js; asks for the channel's repository path on first use (sessions.depotPath, cleared on mode change since git runs on the host or in the container)
  gist.js             # Secret-gist upload for /diff: one gist per channel rewritten in place, URL carries the revision SHA so old links keep their content. GITHUB_TOKEN gates /diff entirely — there is no fallback
  shell.js            # !shell: executeShell (host/container, SIGTERM→SIGKILL) + gating, output truncation
  skills.js           # listSkills(agent, mode): skill names read from <home>/.claude|.codex/skills
  stt.js              # Groq Whisper transcription (voice messages + voice-channel turns)
  tts.js              # OpenAI TTS via REST fetch (voice assistant speech synthesis)
  pcm.js              # Pure-JS PCM resampling (TTS 24k mono → 48k stereo; capture → 16k WAV)
  mixer.js            # Continuous PCM mixer: ambient thinking bed + speech ducking
  voice.js            # Voice assistant: connection, turn capture, STT→Claude→TTS state machine
  uploads.js          # Save Discord file/photo attachments to .claudiscord/files
scripts/
  update-sandbox.sh   # Update the live sandbox's apt packages
  rebuild-sandbox.sh  # Rebuild Docker sandbox image; opens the Claude versions dir to the container user
.env                  # AUTHORIZED_USER_ID, DISCORD_TOKEN, CLAUDE_BIN, CODEX_BIN, SANDBOX_HOME, GROQ_API_KEY, OPENAI_API_KEY
```

## Slash commands

The text dispatcher (`handleCommand`, message content compared to `COMMANDS[].name`) is doubled by native Discord Application Commands so the `/` autocomplete shows them. The split keeps the command logic free of the `discord.js` SDK: for messaging it uses only `channel.send`; the helpers still pulled from `./discord` are `sendChunked`, `resolveChannelName` and `getClient` (the last two for `/voice` and `/autojoin`). Discord's interaction plumbing lives in `index.js`.

- **Single source of truth**: `COMMANDS` drives both paths. `commands.js::getRegisteredCommands()` exposes neutral `{ name, help }` metadata (excludes `helpOnly` → `!shell` and free-form prompts, which stay text-only). Add a command to the registry → it registers itself.
- **Neutral core**: `runCommand()` (mode-gate + lookup + handler call) is shared by `handleCommand` (text) and `dispatchSlashCommand` (slash), so there is no duplicated gating. `dispatchSlashCommand({ channel, channelId, name })` resolves session state and dispatches; gating rejections post to the channel via `channel.send`, like the text path.
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
- **Gates mirrored from the text path**: `isBusy()` → spoken "un instant" notice; `scheduler.reloadJobs()` after each turn (like index.js) so voice-scheduled jobs fire on time. Canned spoken phrases are French (matches `STT_LANGUAGE` default) and their TTS output is cached. Speech rate: `TTS_SPEED`.
- Voice turns run the channel's agent/mode at the `high` tier. Agent switches are locked while the assistant is active there — the shared sessionId (Claude UUID vs Codex thread id) must stay coherent with the executor's context guard. **The bot joins silently**: the mode goes to the chat, not the speakers. Auto-leave after 15 min without a turn (`VOICE_IDLE_TIMEOUT_MS`); the timer is suspended during a turn.
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
- Text + attachments: the files are saved and echoed first (same as an upload-only message), then the text is processed as a normal prompt, prefixed with the saved paths as the agent sees them (`SANDBOX_FILES_DIR` in sandbox, the container's view). With no text, the upload does not spawn the agent and no path is injected — the user references the name later. Voice messages are excluded (their lone attachment is the audio, handled by STT). The detection in `src/index.js` runs before `handleCommand`, so a file dropped alongside a command is saved too.
- The system prompt (`src/prompts.js`, "Uploaded files" section, `{{filesPath}}`) covers what the injected paths cannot: a name mentioned with no path may be an earlier upload or any other file in the environment, and content behind a name can change between mentions.

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

## Agent and models (per channel)

- Each channel has an agent (`claude` or `codex`), and only the agent. It is persisted in `sessions.json` next to the mode.
- **Both agents are optional; at least one must be installed.** `config.js` probes `CLAUDE_BIN` and `CODEX_BIN` once at startup and exports `CLAUDE_AVAILABLE` / `CODEX_AVAILABLE`; with neither present it throws rather than failing one prompt at a time. `CHANNEL_DEFAULT_AGENT` is `claude`, or `codex` when Claude is absent — it is also the fallback for a stored agent that is no longer valid.
- The probe is host-only. Sandbox availability is a live container probe (`isClaudeAvailableInContainer` / `isCodexAvailableInContainer`), because the mount can break independently of the host install. `commands.js::isAgentAvailable(agent, mode)` picks the right one.
- `/claude` and `/codex` select the agent; either switch resets the channel session (the sessionId belongs to the agent — Claude UUIDs vs Codex thread ids). Either reports an error and does not switch when that agent is unavailable in the channel's mode.
- A missing binary surfaces as `CLAUDE_NOT_AVAILABLE` / `CODEX_NOT_AVAILABLE` through the env descriptor's `precheck` (before spawning), `onSpawnError` (ENOENT remap) and `isUnavailable` (the container wrapper's "not found" on an empty mount).
- Each agent has **two model tiers** (`AGENT_MODELS` in `config.js`):

  | agent | `high` | `medium` |
  |---|---|---|
  | claude | `opus` | `sonnet` |
  | codex | `gpt-6-astra` | `gpt-5.6-terra` |

- Interactive prompts (text and voice) always run `high`; scheduled jobs always run `medium`. There is nothing to choose and nothing to persist.
- The tier→model resolution lives **only** in `executor.js`; no other module names a model id. Callers pass `tier`, which defaults to `high`.
- Reasoning effort is one hardcoded `xhigh` for every agent and model (`REASONING_EFFORT` in `config.js`): `--effort` for Claude, `-c model_reasoning_effort` for Codex. The `-c` override wins over `config.toml`, so host and sandbox Codex behave identically.
- Jobs store an `isolated` flag but neither agent nor model. `executeJob` resolves the channel's **current** agent on every run, so switching a channel's agent retroactively changes which agent every isolated job attached to that channel runs on — including jobs living in the other mode's database. Non-isolated ones do not survive the switch at all (see "Non-isolated jobs"). `job.mode` is deliberately NOT live: it comes from the database the job lives in, which is the admin/sandbox security boundary.

## Channel context injection

`src/prompts.js` builds the system prompt from `{ channelAgent, mode, channelName, threadName, channelTopic, isDM, botName, userName }`. The prompt is agent-agnostic — it always includes channel context, uploads, scheduling and Discord response rules, with no per-agent conditional sections. `channelAgent` only feeds the "Current channel agent" context line.

## Progress relay

An interactive prompt shows what the agent is doing while it runs: `spawn.js` hands each complete stdout line to `onLine`, each agent turns it into `{ icon, summary, detail? }` (`claudeProgress` / `codexProgress`), and `discord.js` assembles and shortens that into one message kept updated with the latest activity, deleted when the answer is ready. The agents describe, the display formats — how much fits is a Discord constraint, not an agent one.

- Both CLIs emit one JSON event per line, which is what makes this possible without a streaming protocol.
- Edits are throttled to `PROGRESS_EDIT_MS` and fire-and-forget: a rate-limited or failed progress line must never disturb the run it describes, and neither must an exception thrown by the callback (`spawnCollect` catches those).
- Only the newest line is kept, so the display summarizes rather than accumulates.
- A tool call is shown as a sentence plus its target (`TOOL_ACTIVITY` in `claude.js`), not as the raw tool name: `Grep: startProgress` means nothing to a reader who does not know the tool set. An agent's own narration wins over the tool call it sits next to — the sentence says why, the tool only says what.
- Progress deliberately shows the narration `finalTextFromEvents` strips from the final answer: in a transient line, "let me check the logs" is the useful part, and it is gone once the run ends.
- Jobs and voice turns pass no `onProgress` — nobody is watching a job, and a voice turn is spoken.

## Execution queues

Interactive prompts, voice turns and scheduled jobs go through `src/queue.js::runQueued(channelId, ...)`. A channel or thread stays strictly FIFO, including its job runs, while distinct IDs may execute without a global concurrency limit. `src/index.js` sends the one-shot "⏳ Waiting for previous prompt..." notice only when that same channel is busy. Rare operations (`/login`, `!shell`, `/upgrade`) use `runMaintenance`: they are refused while any execution is pending, then briefly stop new queue work while they run. The single sandbox container accepts concurrent `docker exec` processes, so sandbox channels share its 1 CPU, home and filesystem. SQLite arbitrates concurrent jobs writes.

### Stopping a run

`/stop` terminates the agent process running in the channel. Without it a stuck or runaway prompt holds its channel queue until someone opens a host shell, and every maintenance command stays refused meanwhile.

- `/stop` replies once, after awaiting the run's `settled` promise, bounded by `STOP_REPORT_TIMEOUT_MS`. Past that bound the process is unkillable and the reply says so. `index.js`, `voice.js` and `scheduler.js` therefore send nothing on CANCELLED, while keeping their bookkeeping.
- The reply names the run from `stopInfo` `{ label, note }`, which the scheduler sets to the job's id — a job fires unannounced, so the default "the current prompt" would be wrong.
- **It stops the running process, not the queue.** Prompts already queued behind it start as soon as it dies; `/stop` again to take them out one by one. A prompt that has not spawned yet has nothing to signal, so `/stop` answers that nothing is running.
- **Outside the queue and outside `runMaintenance`.** Both refuse to act while an execution is pending, which is the only state where `/stop` has anything to do.
- `spawn.js` publishes each run to `queue.js` under its `cancelKey` — the executor's `queueKey`, threaded through the agent's `env.spawn`. The registry lives beside the FIFOs because it is the same per-key execution state, and `stopRun(key)` is the counterpart of `isBusy(key)`. Keyed on the queue and not on `channelId` so that an isolated job, which withholds `channelId` but still occupies a channel's FIFO, is stoppable from the channel it is blocking.
- A stopped run rejects with code `CANCELLED`, carrying the output produced so far. That is what keeps the conversation usable — the agent adapters recover the session id from that partial output, so the next message resumes where the run was cut. A stopped job also skips `recordJobRun`, so its schedule and `remaining` are untouched.
- **The sandbox needs a second kill.** `docker exec` leaves the process it started in the container running when its client dies (verified). `container.js::killContainerRun` signals it through a `CLAUDISCORD_RUN=<uuid>` marker injected at exec time and matched against `/proc/<pid>/environ`. Matching on the command name instead would also hit the other channels' agents, which share the single container. The marker is inherited by the agent's children, so they go too. The call is asynchronous: a synchronous `docker exec` would block the event loop, and with it the Discord heartbeat.
- **The host kills the process group**, hence `detached: true` on both host agent envs — a signal to the CLI alone can leave the tools it spawned behind.
- `run.stop(reason)` takes `'user'` or `'timeout'`, which is what separates code `CANCELLED` from code `TIMEOUT` at the reject. The first caller wins: a later stop returns false and changes nothing, so a run already killed by its deadline stays a `TIMEOUT`.
- SIGTERM first, SIGKILL after `KILL_GRACE_MS`. The escalation is deliberately not cancelled when the local child exits: killing a `docker exec` client is instant and says nothing about the container-side process, so the second signal has to outlive it.

## Docker sandbox (optional)

- **Image**: `claudiscord-sandbox` (local build, `node:22-bookworm-slim`; both agents come from host mounts)
- **Container**: `claudiscord-sandbox` (single container, `--restart unless-stopped`)
- **Limit**: 1 CPU; no container RAM limit
- **Volumes**: `SANDBOX_HOME -> /home/claude`, plus the two read-only agent mounts below
- **Network**: bridge
- **User in container**: `claude` (non-root)
- **CMD**: `sleep infinity`; commands run via `docker exec`
- Docker availability is detected at startup; if `docker --version` fails, `DOCKER_AVAILABLE` becomes `false` and sandbox operations report a friendly error

### Agent binaries come from the host

`container.js::hostBinMounts()` bind-mounts the host CLIs read-only at container creation, so one install serves admin and sandbox alike. Both execute inside the container's namespaces like any other file — only their bytes come from the host, which works because the two share a kernel and an architecture.

- **Claude** → the installer's `versions/` dir at `/opt/claude-bin`. The *directory* is the mount source because an update writes a new `<semver>` file next to the old one and moves the symlink — mounting the file would pin the container to the version present at creation time. The image's `/usr/local/bin/claude` is a shell wrapper running the highest executable it finds there.
- **Codex** → the installer's `releases/` dir at `/opt/codex-releases`, same reasoning as Claude: an update unpacks `<version>-<target>/` next to the old one and moves the `current` symlink. `/usr/local/bin/codex` is the same kind of wrapper, running `<highest>/bin/codex`. The mount is `releases/` and not `packages/standalone/` or `CODEX_HOME`, because the Codex installer puts its binaries under `~/.codex` alongside `auth.json` — the sandbox has no business reading the admin's credentials. The release dir also holds `codex-resources/` (bwrap) and `codex-path/` (rg), which the binary resolves relative to itself, so the whole tree has to come along.
- **Each source is layout-checked before it is mounted** (`claudeMountSource` / `codexMountSource`): `versions/` for Claude, `releases/<release>/bin/` for Codex. `CLAUDE_BIN` and `CODEX_BIN` accept any path, and mounting the parent of an arbitrary binary would hand the sandbox whatever else lives beside it. A source that fails the check is a warning that disables that agent in the sandbox; the container stays useful for the other one and for `!shell`. A package-manager Codex (npm, brew…) fails this check by design: it works on the host, not in the sandbox.
- **The mounts are fixed at container creation.** `/version` probes the container and prints a line only when it disagrees with the host — that disagreement is what a stale mount, a changed `CLAUDE_BIN`/`CODEX_BIN` or an unreadable versions dir looks like from outside. The remedy is recreating the container.
- The wrapper picks the highest version in the mount, which is the host's current one unless an older build is deliberately pinned while a newer file remains in `versions/`.
- **Permissions are a setup step, never a runtime one.** Everything under `/root` is 0700, so the container user needs the Claude versions dir opened up to traverse the mount. `scripts/rebuild-sandbox.sh` chmods it 0755 once (parents untouched, so no host user gains anything); `hostBinMounts()` only *reads* the mode and warns when it is wrong. Claudiscord never changes host permissions on its own — a sandbox prompt has no business mutating the admin environment's filesystem, least of all under a concurrently running host agent. The whole step exists only because the default Claude install lives under `/root`: a `CLAUDE_BIN` pointing outside it needs no chmod at all. Codex needs none either — its installer already creates `~/.codex/packages/` 0755 — and the script deliberately does not chmod anything under `CODEX_HOME`, which is also where `auth.json` lives.
- **Compatibility is a property of the base image**, hence the `node:22-bookworm-slim` pin (glibc 2.36). Claude is a self-contained aarch64 ELF requiring at most `GLIBC_2.26`; Codex vendors a statically linked musl binary and requires nothing. If a future Claude raises its floor above the image's glibc, sandbox Claude stops starting while admin keeps working — check with `docker exec claudiscord-sandbox claude --version`, and move the pin to the trixie variant (glibc 2.41, matching this host).

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

`spawnCollect` (`src/spawn.js`) waits for the active CLI to exit naturally: an interactive prompt has no predictable duration and only the operator knows what a given one should take, so a stuck agent holds its channel queue until `/stop` ends it (see "Stopping a run"). Other channels continue meanwhile, while maintenance commands are refused until all queues are idle.

Scheduled runs are the exception. `executor.js` passes `timeoutMs: JOB_TIMEOUT_MS` (1 h) for the `medium` tier, and only that tier: a job fires with nobody watching, so an unbounded one would hold its channel's queue and block maintenance until someone happened to notice. The deadline reuses the `/stop` machinery — same SIGTERM/SIGKILL, same container kill — but rejects with code `TIMEOUT`, which the scheduler reports as a failed run rather than as a decision, consuming the occurrence like any other error.

### Image rebuild

```bash
bash scripts/rebuild-sandbox.sh
```

## Claude CLI usage

- `claude -p` with `--output-format stream-json --verbose` for both interactive messages and jobs; the first `session_id` seen in the stream is recorded as the job's `lastSessionId`
- A first invocation omits session flags; Claude allocates an UUID and emits `session_id` in its JSON output. Subsequent invocations use `--resume <uuid>`.
- `--dangerously-skip-permissions` in sandbox (the container IS the sandbox)
- `--model` follows the execution tier (`opus` for prompts, `sonnet` for jobs); `--effort xhigh` always
- Host cwd: `os.homedir()` of the user running the service (auto-loads `$HOME/CLAUDE.md`) — typically `/root` on Linux when the service runs as root, `/var/root` on macOS
- Sandbox cwd: `/home/claude`
- Timeout: none — the CLI runs until it exits on its own

## Codex CLI usage

- Optional host integration, detected at startup from `CODEX_BIN` (default `~/.local/bin/codex`); the sandbox runs that same host install through a read-only mount
- `codex exec --yolo --skip-git-repo-check --json -c model_reasoning_effort="xhigh" -m <model> -` for a new conversation
- `codex exec resume` uses the same flags plus `<uuid>` before the trailing `-` for subsequent prompts. `-m` and `-c` belong to the OPTIONS block, which precedes `<SESSION_ID>` in both forms
- Prompts are passed through stdin
- `thread.started.thread_id` supplies the session UUID and the last completed `agent_message` supplies the response
- The shared Discord prompt is injected through the `developer_instructions` config override
- Model and reasoning effort are both forced by claudiscord (`AGENT_MODELS` / `REASONING_EFFORT` in `config.js`), overriding `config.toml`; only authentication remains owned by the Codex CLI
- Sandbox execution uses `/home/claude` as cwd and `/home/claude/.codex` as `CODEX_HOME`
- `/upgrade` (sandbox only) calls `scripts/update-sandbox.sh`, which refreshes the container's apt packages only — both agents follow the host install

## Scheduled jobs

### Format

Table `jobs`, one row per job (`src/jobs-store.js::SCHEMA`, `PRAGMA user_version = 4`):

```sql
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL,
  channel_name    TEXT,
  prompt          TEXT NOT NULL,
  cron            TEXT NOT NULL,
  remaining       INTEGER NOT NULL DEFAULT 0,
  isolated        INTEGER NOT NULL DEFAULT 1 CHECK (isolated IN (0, 1)),
  created         TEXT,
  last_run        TEXT,
  last_session_id TEXT,
  description     TEXT
) STRICT;
```

- `STRICT` because agents write rows through the CLI, outside claudiscord's validation — mistyped values fail at insert instead of loading as junk.
- `channel_id` is **required** — it's where the notification is sent. DM channels have an ID too, so a DM-bound job works identically.
- `channel_name` is a display-only snapshot of the channel name at job creation time. The scheduler refreshes it on every run.
- No `agent`, `model` or `enabled` column: the agent is the channel's current one, resolved at each run; the model is its `medium` tier; a job is stopped by deleting its row.
- `remaining`: `0` = infinite, `>0` = decremented each run, job removed when it hits `0`.
- `isolated`: `1` (default) = fresh session each run, `0` = runs inside the channel's ongoing conversation (see "Non-isolated jobs" below). A run that never happened never decrements `remaining` nor touches `last_run`.
- `last_session_id`: diagnostic-only. Scheduler writes the agent session UUID of the last run (set even on error via `err.sessionId`), never resumed from here — it just locates the run's transcript on disk: Claude at `<home>/.claude/projects/<cwd-hash>/<uuid>.jsonl` (admin cwd `/root` → `-root`, sandbox `/home/claude` → `-home-claude`), Codex via `find <home>/.codex/sessions -name "*<uuid>*"`.
- Unique key: `mode:id` (the mode is implicit from the database the job lives in).

### Storage

- **Admin jobs**: `ADMIN_USER_HOME/.claudiscord/jobs.db` (readable/writable by the host agent).
- **Sandbox jobs**: `SANDBOX_HOST_HOME/.claudiscord/jobs.db` (readable/writable by the container; the same path is accessible from the host as well since the volume is a bind-mount).
- All access goes through the `sqlite3` CLI — claudiscord shells out (`execFileSync`, no Node driver), agents run it from their prompt instructions. Every invocation starts with `.timeout 5000` (the dot-command, not `PRAGMA busy_timeout`, which emits a result row that corrupts `-json` output).
- Default rollback journal, no WAL: no persistent `-wal`/`-shm` sidecars, so in-place writes never change the db file's ownership (the sandbox db must stay owned by the container user while root also writes it via `recordJobRun`).
- `recordJobRun` is a single atomic transaction (update + decrement + delete-at-0) — concurrent agent writes can no longer be lost.
- **No merge**: an admin prompt only sees admin jobs, a sandbox prompt only sees sandbox jobs. The scheduler loads both databases and runs everything.

### Execution & reload

- A single minute-resolution ticker (`setInterval`, `TICK_MS`) fires every job whose cron matches the current minute, using node-cron only to parse/validate the expression and build its time matcher. This tolerates sub-minute timer/clock drift and never replays a missed minute — unlike node-cron's per-job `setTimeout`, which aimed at an exact second and silently dropped a run when the first heartbeat after a (re)start landed off that second.
- `src/scheduler.js::reloadJobs()` rebuilds the in-memory schedule (one matcher per job) from both databases.
- Called at startup, after every interactive prompt, and at the end of every scheduled job — so any change to the jobs databases is picked up within one prompt.
- No `fs.watch` — polling after each prompt is enough.
- In-memory lock per job key (plus a per-minute guard) prevents duplicate runs (including the "same wall-clock minute" edge case).

### Non-isolated jobs

`isolated = 0` runs the job inside the channel's live agent conversation instead of a fresh session, so its result can be replied to ("check X in 5 minutes"). The scheduler passes `channelId` to `executePrompt`, which resolves the session live and persists the result back like any interactive turn.

- **A lost target is fatal to the job**, and the deletion happens when the target is lost, not when the job next fires. Every path that drops a channel's session — `/new`, a mode or agent switch — funnels through `sessions.js::dropSession`, which notifies the observer `index.js` registers at boot (`scheduler.js::handleSessionCleared`); the startup purge of a deleted channel notifies it directly from `removeChannel`, unconditionally, since there is no session left to lose. It deletes that channel's non-isolated jobs in BOTH databases (`deleteNonIsolatedJobs` — the row's mode is the database it lives in, so a channel that just switched mode would otherwise strand the other one), reloads the schedule and posts the list. Running them in a fresh session instead would strand their output where nobody is reading, and write that session's id back over the channel's.
- **The observer is fire-and-forget**: `sessions.js` is synchronous and depends on neither the jobs store nor Discord, hence the injection. A throwing handler is caught and logged; the session reset itself always goes through.
- **The runtime guards are the backstop, not the mechanism.** `executePrompt`'s `requireSession` still raises `SESSION_REQUIRED` inside the queue callback, and `CHANNEL_CONTEXT_CHANGED` still fires on an agent/mode change; both delete the row (`dropStaleJob`). They catch what the observer structurally cannot: a run already past `tick()` but not yet enqueued. `isBusy(channelId)` only turns true when `executePrompt` claims the queue, so `rejectIfChannelBusy` lets a `/new` through during `fetchJobPromptContext`'s awaits. `CHANNEL_CONTEXT_CHANGED` also serves the interactive path (`index.js`), which has the same pre-enqueue window.
- **Known residual gap**, accepted: `requireSession` tests the session's existence, not its identity. A run caught in that pre-enqueue window is only stopped if the channel is still session-less when it reaches the head of its queue. Should an interactive prompt slip in first and open a fresh session, the run joins that one instead. Closing it would mean stamping the target session id on the row and comparing it in the queue — not worth a column for a window measured in milliseconds.
- The run marks itself **in-band**, at the head of the prompt: the system prompt is not persisted in the transcript, so without it the next interactive turn would read the job's instructions as user input. The `{{#job}}` block is dropped for these runs — its "user replies cannot resume this job" line is precisely what they invert.
- An unresolved Discord channel skips the run (transient, no `remaining` consumed): the turn would land in the shared conversation with no visible trace.
- Context cost is the caller's problem: a recurring non-isolated job re-injects its whole prompt every run, so long monitoring prompts stay isolated.

### Notifications

A job's output is sent to its `channel_id`, unless it ends with `NOTIFY_NONE` — the whole output is then dropped, never stripped and resent (`src/scheduler.js::suppressesNotification`).

- Matching: last non-empty line, trimmed, must *be* the token. Symmetric markdown emphasis and one trailing period are tolerated; the line is rejected when an odd number of ` ``` ` fences precedes it (token quoted inside an unterminated block). Anything else notifies — a spurious message is recoverable, a dropped report is not.
- A job that must stay silent under some condition says so in its own `prompt`; there is no column for it. The convention is documented once, in the Scheduling section of `src/prompts.js`, and carries its own "never end with NOTIFY_NONE unless the job's prompt asks for it" guard — the token must never be described without it, or an agent could decide to go silent on its own.
- Errors always notify: a crash produces no output, so it cannot opt out.
- A dropped output is logged (`NOTIFY_NONE, output dropped (N chars)`) and stays readable in the run's transcript via `last_session_id`.

## Sessions

- `ADMIN_USER_HOME/.claudiscord/sessions.json` shape:
  ```json
  { "channels": { "<channelId>": { "mode": "admin"|"sandbox", "agent": "claude"|"codex", "sessionId": "<uuid>", "usage": null|{...}, "lastName": "...", "depotPath": null|"/abs/path", "diffGistId": null|"<gistId>" } } }
  ```
- `sessionId` belongs to the active agent. Both Claude and Codex allocate it on the first invocation and emit it early in JSON output; `executor.js` persists it inside the channel queue. Context-mutating commands (`/new`, mode/agent switch) are refused while the channel is busy (`isBusy(channelId)` — a prompt or job running), so a late result cannot restore a session the user just changed; the executor still re-checks agent/mode before persisting (covers a context switch during a thread's pre-enqueue first-turn window).
- Spawn errors retain partial stdout so the agent adapter can attach an already-emitted UUID before the error is surfaced. The next prompt can therefore resume even when the first failed after session initialization.
- Legacy entries without `agent` load as Claude — that was the unconditional default when they were written, so their session id is a Claude one. `ensureChannel()` stamps `agent` on every new entry precisely so this stays a legacy-only path: `CHANNEL_DEFAULT_AGENT` depends on which CLIs are installed, and an agent-less entry would otherwise be re-read under a different default after an install change, pairing one agent's session id with the other agent. A legacy `sessionStarted: false` drops its possibly uncreated UUID, and a legacy `model` key is ignored; both disappear on the next persistence (`load()` rebuilds each entry field by field).
- `lastName` is a display snapshot to make the sessions file readable during debugging.
- `depotPath` is the repository `/diff` reports on, cleared by a mode switch (the path names a filesystem the channel left). `diffGistId` is the gist it rewrites, and survives a mode switch: it names an output, not a filesystem.
- `usage` backs `/status`'s conversation line: `{ context, window, costUsd }`. The context is the LAST assistant event's input tokens, cache included — `result.usage` sums every model call of the turn, so a three-tool run reported 90k against a 22k conversation. Cost is the opposite, a turn total, and accumulates across turns. Recorded on failed and cancelled turns too, which spent tokens all the same. Codex sets none: `turn.completed.usage` is a turn total and Codex exposes no context window, so nothing there answers "how full is this conversation".
- A full reset drops the active agent session ID, and with it the channel's non-isolated jobs (see "Non-isolated jobs"). Isolated jobs are untouched.
- Startup purge (`src/index.js::purgeInvalidChannels`) drops entries whose Discord channel no longer exists. Runs after `login()`. Strict: only `DiscordAPIError code 10003` (Unknown Channel) triggers removal; transient errors are logged and skipped. Removing the entry takes the channel's non-isolated jobs with it, through the same observer as a reset; its isolated jobs are intentionally kept — their lifecycle is managed by hand.
