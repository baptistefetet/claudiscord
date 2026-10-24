# Claudiscord — roadmap

Backlog only: a shipped item is removed from this file, not marked done — its
reasoning belongs in `AGENTS.md` or the code.

## 1. `/btw <question>` — side question on a forked context

Ask a quick side question without polluting the channel session; the answer
appears as a Discord **reply** to the `/btw` message to mark it as an aside.

- Fork the channel's `sessionId` with the CLI `fork` flag `/fork` uses
  (`executor.js` sets it only from `forkFrom` today), and NEVER persist the
  returned session id → new `ephemeral: true` option in `executePrompt` that
  skips `sessions.setSessionId`.
- No active session → plain fresh one-shot, still unpersisted.
- Queue: dedicated key (`${channelId}#btw`) so it does not wait behind a
  long-running prompt. Accepted trade-off: the fork sees the last *persisted*
  turn, not one still in flight (not yet in the parent JSONL).
- Reply UX: `message.reply()` (the text path has the Message object); needs a
  `sendChunked` variant that replies on the first chunk.
- Command infra: the registry matches the full content exactly
  (`commands.js::runCommand`), so the text form needs prefix matching like `!`;
  the native one just declares a `question` option.

## 2. Webhook — trigger prompts from outside Discord

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
- Use cases: iOS Shortcuts, CI, home automation.

## 3. Voice assistant follow-ups

The GPT-Live front end (`src/live.js`, `src/voice.js`) serializes delegations
on the channel FIFO. Next steps:

- **Parallel delegations**: run each task on an isolated session (e.g. one
  Discord thread per task) instead of the channel session, so a long task no
  longer blocks the next one. Costs the shared context with the text chat.
- **Spoken control**: cancellation and redirects by voice (status questions
  are answered by the call from commentary context). Needs a
  host-side classification of the delegation (OpenClaw classifies spoken
  input as `status` / `steer` / `cancel` / `followup`) wired to `stopRun`,
  instead of queueing it behind the work it targets.
- **Agent startup latency**: a simple spoken question takes 20–28 s, of which
  only 3–5 s is the model — measured on a sandbox Claude resume: ~14 s until
  the CLI is up, 5–10 s more before the prompt reaches the session. Keeping one
  agent process alive per channel (streamed input) instead of spawning one per
  prompt would remove most of it, for text prompts too.
- **Call renewal**: sessions expire ~2 h after start and the assistant leaves.
  Reopen a call instead, seeding it with the recent transcript
  (`initial_items`) and the tasks still running.
- **Output audio quality**: speech sounds choppy. Measured on a live call: the
  player inserts single 20 ms silence frames mid-sentence (~1 per 2 s of
  speech) because the next output chunk is late — the sideband goes silent for
  up to ~450 ms every 10–15 s, with no packet loss on the path, while the
  Pi → Discord send cadence stays regular (≤ 34 ms). Each underrun only adds
  20 ms of slack, hence repeated micro-cuts. Fix: when a chunk reaches a dry
  stream (`bytes written / 192 − resource.playbackDuration` ≈ 0), write ~200 ms
  of silence before it — rare short pauses instead of micro-cuts, without
  raising `PREBUFFER_MS` (200 ms, paid at the start of every reply). Log
  underruns per burst to confirm. Minor: `liveToDiscord` does not interpolate
  across chunk boundaries.

Effort: medium each. Value: medium.

## 4. Per-channel working directory

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

## 5. Code-fence-aware message splitting

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

## 6. Reply context

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

## 7. Progress display follow-ups

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

## Priorities

`/btw` and the webhook have the best value/effort ratio among the bigger
items; `/btw` is small now that `/fork` has the fork mechanics. §5 and §6 are
contained one-function changes; §4 is worth doing before more channels
accumulate a `depotPath`. Voice: §3 once the
GPT-Live front end has been used for a while. §7 stays within the progress
relay (`claude.js`, `codex.js`, `discord.js`).

## References

- disclaw — Discord × Claude Code (source of §4–6: working-directory chain,
  fence-aware splitting, reply quoting):
  <https://github.com/six-ddc/disclaw>
