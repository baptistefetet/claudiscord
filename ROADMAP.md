# Claudiscord — roadmap

Backlog only: a shipped item is removed from this file, not marked done — its
reasoning belongs in `AGENTS.md` or the code.

## 1. Webhook — trigger prompts from outside Discord

Minimal HTTP server in the same process (`node:http`, no framework):
`POST /prompt` with `{ channelId, prompt }`, Bearer token from `.env`
(constant-time compare), bound to `127.0.0.1` by default.

- Require an EXISTING Discord `channelId` → this is a *trigger*, not a second
  transport: no session/jobs key namespacing, no scheduler notification
  routing.
- Flow: resolve mode/agent from sessions → build the system prompt →
  `executePrompt` through the channel FIFO → result posted to the Discord
  channel. HTTP answers `202` immediately (a prompt has no bounded duration).
- Exposure beyond localhost: Apache reverse proxy + TLS + fail2ban (existing
  infra on this host). Optional channel allowlist in `.env`.
- Use cases: iOS Shortcuts, CI, home automation. The same server could take
  mid-run file uploads from agents (today end of turn only).

## 2. Voice assistant follow-ups

The GPT-Live front end (`src/live.js`, `src/voice.js`) serializes delegations
on the channel FIFO. Next steps:

- **`ack_filler`**: kimaki opens calls with
  `delegation: { type: 'client', ack_filler: true }`. Undocumented; presumably a
  spoken filler while a delegation runs. Try it.
- **Delegation policy**: kimaki's GPT-Live instructions use explicit "Delegate
  when" / "Do not delegate when" lists plus backchannel and interruption
  policies. Compare with `LIVE_INSTRUCTIONS`.
- **Parallel delegations**: run each task on an isolated session (e.g. one
  Discord thread per task) instead of the channel session, so a long task no
  longer blocks the next one. Costs the shared context with the text chat.
- **Agent startup latency**: a simple spoken question takes 20–28 s, of which
  only 3–5 s is the model — measured on a sandbox Claude resume: ~14 s until
  the CLI is up, 5–10 s more before the prompt reaches the session. Keeping one
  agent process alive per channel (streamed input) instead of spawning one per
  prompt would remove most of it, for text prompts too.
- **Call renewal**: sessions expire ~2 h after start and the assistant leaves.
  Reopen a call instead, seeding it with the recent transcript
  (`initial_items`) and the tasks still running.
- **Audio glitches**: kimaki's output path is simpler (raw Opus packets into
  one `AudioResource` per reply, 120 ms prebuffer, no decoding, reply ended
  after 1 s of trailing silence), but nothing shows it glitches less: only an
  A/B test would tell.

Effort: low for `ack_filler` and policy; medium for the others.
Value: medium.

### Fast backend (large, later)

kimaki puts a tool loop between GPT-Live and the real work (`voice-agent.ts`):
a fast model (`gpt-6-luna`, reasoning `low`, `service_tier: priority`) on the
Codex Responses endpoint, same ChatGPT login. Every transcribed turn is
appended to its history; its tools are `shell`, `post_message` and `end_call`.

- For claudiscord: tools `delegate` (`executePrompt` on the channel's agent),
  `post_message`, `end_call`.
- Solves at once: hang-up by voice (`end_call` sets a flag, the call ends once
  the goodbye has played), simple-question latency (no agent spawn), and
  fragmentary or repeated delegations (the backend sees the whole transcript,
  replacing the batching heuristics of `voice.js::handleDelegation`).
- Costs: a third model, another undocumented endpoint, subscription quota.

Effort: high. Value: high.

## 3. Per-channel working directory

Every run uses the home directory as cwd — `cwd: ADMIN_USER_HOME` on the host
(every spawn in `claude.js` and `codex.js`), `-w SANDBOX_USER_HOME` in the
container (`container.js`). One channel per project needs a cwd per channel.

- Half of it exists: `sessions.depotPath` (the repository `/diff` reports on,
  asked for on first use, cleared on mode switch). Generalize it into the
  channel cwd and let `/diff` read that instead of its own field.
- disclaw resolves through a chain: per-message `[~/path]` override > thread
  config > channel config > env > fallback. The per-message override is the
  cheap half and needs no persistence.
- Side effect worth having: Claude auto-loads the cwd's `AGENTS.md`, so a
  project channel picks up the project's instructions instead of `$HOME`'s.
- Keep the mode-switch reset (the path names a filesystem the channel left),
  and validate existence before the spawn — a bad cwd fails the process with
  nothing useful in the output.

Effort: low-medium. Value: high.

### Picking the path: autocomplete, not a button picker

Typing an absolute path on a phone is the whole problem. disclaw ships both
answers — a button-based filesystem browser (`dir-picker.ts`, 222 lines) and a
plain string option taken straight from autocomplete when supplied
(`interactions.ts:151`). Only the second one fits claudiscord.

- The picker keeps its state in a module-level `Map` keyed by a short id
  encoded in each button's `customId`, rebuilds the message on every click and
  expires after 2 min; a restart drops pending pickers. It needs message
  components and a stateful button router — irreducibly Discord-specific, so it
  would live in `index.js` while `commands.js` stays SDK-free. In a sandbox
  channel it would also have to list *inside* the container (`docker exec`) on
  every click, since only `SANDBOX_HOST_HOME` is visible from the host.
- Autocomplete has no state, no timeout, and works in DMs. The handler answers
  one directory level filtered on what is typed — Discord caps a response at 25
  choices and expects it within 3 s, so no recursive walk, and the sandbox
  variant needs that budget in mind (cap the listing, or restrict suggestions
  to paths under the sandbox home).
- Suggestions are hints, not a whitelist: with autocomplete the user can submit
  any string, so the path is still validated at dispatch (unlike static
  choices, which Discord enforces).
- **Prerequisite**: commands already declare required string options, but the
  `InteractionCreate` listener returns unless `isChatInputCommand()`, so
  autocomplete interactions are dropped. The option spec needs an
  `autocomplete` flag and the adapter an autocomplete branch. That is the real
  work; the picker is not.

## 4. Code-fence-aware message splitting

`discord.js::splitMessage` cuts on the last `\n`, then the last space, then
hard at the limit, with no knowledge of ``` fences. A code block longer than a
chunk is split in two: the first chunk keeps an unterminated fence, the second
renders as plain text.

- Fix inside the function: track fence state while walking the chunks, close an
  open fence at the end of a chunk and reopen it (same info string) at the
  start of the next.
- Applies to everything long the bot posts — `/diff` output, job notifications,
  `!shell` results.

Effort: low, contained in one function. Value: medium.

## 5. Reply context

Replying to a message is the Discord-native way of pointing at something, and
today nothing reads it: only a thread's starter message is injected
(`index.js`), `message.reference` is ignored.

- `message.fetchReference()` on the incoming message, injected as quoted
  context in the same shape as the starter injection (author + content), which
  the formatting can be reused from.
- Bound it: one level only, truncate long quotes, and skip when the referenced
  message is the bot's own previous reply — already in the session, so quoting
  it back only burns context.

Effort: low. Value: medium.

## 6. Progress display follow-ups

The live line (`discord.js::startProgressReporter`) shows only the latest
step, edited at most every `PROGRESS_EDIT_MS` (2 s).

- **Short history**: the previous 3–4 steps as `-#` subtext above the current
  one; today a step faster than the throttle is never seen.
- **Parallel tool calls**: `claudeProgress` keeps the first `tool_use` of an
  event; group the rest ("Reading 3 files").
- **Subagent steps**: prefix them with `↳` using `parent_tool_use_id`. To check
  first: whether `claude -p --output-format stream-json` emits a subagent's
  inner events at all.
- **Elapsed time and step count** as a subtext line (`-# 2 min 10 · 14 steps`).
- **Codex**: `codexProgress` relays only `command_execution` and
  `agent_message`; also map `file_change`, `web_search`, `mcp_tool_call` and
  `todo_list` items.

Effort: low-medium. Value: medium.

## 7. Job pre-check

An optional shell command run before a job's agent, to spend no LLM run on an
empty check (e.g. "is there a new mail?"). kimaki's `--pre-run`.

- Column `pre_check TEXT` (`user_version` 5), documented in `getSchedulingDoc`.
- Exit 0: the agent runs, with the command's stdout (bounded) appended to the
  prompt. Exit 1: occurrence skipped silently. Any other code or a timeout:
  error notified, so a typo (exit 127) cannot disable a job unnoticed.
- Runs in the job's environment: host for admin, container for sandbox — never
  on the host for a sandbox job, whose database the sandbox agent writes.
- A skip consumes no `remaining` and leaves `last_run` (`skipRecord`): with
  `remaining = 1` and a check every 5 min, a job says "the mail arrived" once.
- Runs before the job enters the channel FIFO, with its own short timeout, so
  it never waits behind a prompt.

Effort: low-medium. Value: high.

## 8. OpenCode agent (large, later)

A third agent beside Claude and Codex, `/opencode`, with no model selection:
claudiscord never passes `--model`. Per OpenCode's docs a session keeps its
model, and new sessions take `model` from `opencode.json`, else the newest
available one. So jobs use the same model: no tiers, no effort override.

- Same process-per-prompt shape as the others:
  `opencode run --format json --session <id>` (flags from the CLI docs; check
  `--help` on OpenCode 2). kimaki drives a long-lived `opencode serve` over HTTP
  instead: richer, but it breaks the one-process-per-prompt model and needs a
  server per environment.
- Work: `opencode.js` adapter (exec, session id, progress mapping, version),
  availability probe, sandbox binary mount and per-environment credentials.
  `opencode auth login` is interactive: `/login` may stay manual at first.
  `/usage` does not apply.
- Not installed on the host yet.

Effort: high. Value: medium.

## 9. Windows host, admin mode only (large, later)

The README states Linux only. Blockers in the code:

- Process-tree kill through process groups (`detached` + `process.kill(-pid)`
  in `spawn.js`, `shell.js`): `taskkill /T /F /PID` instead.
- `!shell` runs `bash -c`: PowerShell instead.
- Jobs: the `sqlite3` CLI (bot and agents), and a scheduling doc written as
  bash heredocs.
- `/restart` calls `systemctl`: needs a Windows service wrapper.
- Default agent paths (`~/.local/bin/…`) and a system prompt that mentions
  systemd.
- Voice: the native `@discordjs/opus` build is untested on Windows.

The sandbox stays off (the no-Docker path exists). Testing needs a Windows
machine or a Windows GitHub Actions runner.

Effort: high. Value: medium.

## Priorities

Quick tasks first: §7, the contained §4 and §5, and the cheap half of §2
(`ack_filler`, policy). Then the webhook (§1) and §3 before more
channels accumulate a `depotPath`. §6 stays within the progress relay
(`claude.js`, `codex.js`, `discord.js`). Large projects for later: §2's fast
backend, §8, §9.

## References

- disclaw — Discord × Claude Code (source of §3–5: working-directory chain,
  fence-aware splitting, reply quoting):
  <https://github.com/six-ddc/disclaw>
- kimaki — Discord × OpenCode (source of §2's voice findings and §7–§8):
  <https://kimaki.dev>, <https://github.com/remorses/kimaki>
