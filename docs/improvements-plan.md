# Claudiscord — feature backlog: session forks, webhook, voice, Discord UX

Ideas discussed 2026-07-24, verified against the host Claude CLI 2.1.218,
codex-cli 0.146.0 and the current `src/`.

§5–7 were added 2026-09-11 from a review of `six-ddc/disclaw`, re-verified
against Claude CLI 2.1.268 and codex-cli 0.154.0. §4 was added 2026-09-22 from
a review of `KNQuoc/clod-voice` and OpenAI's Realtime docs.

Backlog only: a shipped item is removed from this file, not marked done — its
reasoning belongs in `AGENTS.md` or the code.

## Verified capabilities

- `claude -p --resume <uuid> --fork-session` resumes a session while allocating
  a NEW session id — the parent transcript is never touched.
- The Codex CLI has no fork equivalent (`codex exec resume` only), so every
  fork-based feature below is **Claude-only**.

## 1. `/btw <question>` — side question on a forked context

Ask a quick side question without polluting the channel session; the answer
appears as a Discord **reply** to the `/btw` message to mark it as an aside.

- Read the channel's `sessionId`, run `claude -p --resume <id> --fork-session`,
  and NEVER persist the returned session id → new `ephemeral: true` option in
  `executePrompt` that skips `sessions.setSessionId` (`executor.js`).
- No active session → plain fresh one-shot, still unpersisted.
- Queue: dedicated key (`${channelId}#btw`) so it does not wait behind a
  long-running prompt. Accepted trade-off: the fork sees the last *persisted*
  turn, not one still in flight (not yet in the parent JSONL).
- Reply UX: `message.reply()` (the text path has the Message object); needs a
  `sendChunked` variant that replies on the first chunk.
- Command infra: the registry matches the full content exactly
  (`commands.js::runCommand`), so `/btw` needs prefix matching like `!`. The
  native slash version needs option support — `registerSlashCommands` registers
  no options and the interaction adapter only passes the command name. Can land
  text-only first.

## 2. Threads forking the parent session

Today `ensureFromParent` snapshots mode/agent but starts fresh
(`sessionId: null`) + starter-message injection (`index.js`).

- When the thread has an anchor message AND the parent holds an active Claude
  session: store `forkFrom: <parentSessionId>` in the thread's sessions entry;
  the first execution builds `--resume <forkFrom> --fork-session`, then persists
  the NEW uuid to the thread. Parent untouched.
- Default-fork for anchored threads (Discord semantics: "develop this point");
  standalone threads stay fresh. `/new` reverts a thread to fresh.
- Starter-message injection becomes redundant in the forked case (the anchor is
  already in the parent transcript); keep it for the fresh case.
- Codex channels: unchanged (no fork). Same mechanics as `/btw` — small once
  `/btw` has landed.

## 3. Webhook — trigger prompts from outside Discord

Minimal HTTP server in the same process (`node:http`, no framework):
`POST /prompt` with `{ channelId, prompt }`, Bearer token from `.env`
(constant-time compare), bound to `127.0.0.1` by default.

- Require an EXISTING Discord `channelId` → this is a *trigger*, not a second
  transport: no session/jobs key namespacing, no scheduler notification
  routing — the pending work listed in `AGENTS.md` ("Adding a transport")
  stays untouched.
- Flow: resolve mode/agent from sessions → build the system prompt →
  `executePrompt` through the channel FIFO → result posted to the Discord
  channel. HTTP answers `202` immediately (a prompt has no bounded duration).
- Exposure beyond localhost: Apache reverse proxy + TLS + fail2ban (existing
  infra on this host). Optional channel allowlist in `.env`.
- Use cases: iOS Shortcuts, CI, home automation.

## 4. Realtime voice front-end with async delegation

The chosen voice direction. It replaces the turn-based pipeline of the
`/voice` assistant (Groq STT → agent → OpenAI TTS, half-duplex) instead of
improving it: an OpenAI Realtime model holds the spoken conversation and
delegates the real work to the channel's agent in the background, so the
conversation stays live while tasks run.

- **Reference**: `KNQuoc/clod-voice` (`src/realtime-client.ts`) — Discord
  voice ↔ OpenAI Realtime over WebSocket (`gpt-4o-realtime-preview`), server
  VAD (threshold 0.5, 300 ms prefix padding, 800 ms silence), tools declared on
  the session, delegated results injected with `conversation.item.create` and
  queued while a response is in progress. Early POC (3 commits) built on an
  OpenClaw gateway + FFmpeg: a pattern, not code to reuse.
- **Kept**: connection/autojoin, per-user receiver + opus decode, `pcm.js`
  (plus a PCM16 24 kHz mono target, the format clod-voice streams), `mixer.js`
  playback, `executePrompt`, `stopRun`. **Replaced**: `tts.js`, the half-duplex
  state machine and the hallucination gate. `stt.js` stays for Discord voice
  messages.
- **Barge-in and streamed speech** come from the API (VAD `interrupt_response`,
  audio streamed as generated); local playback still has to be cut
  (`mixer.stopSpeech`).
- **Tools**: `delegate(task)` starts `executePrompt` without awaiting it and
  returns a task id at once; on completion the result is injected
  (`conversation.item.create` + `response.create`) so the model announces it,
  and posted to the chat. `task_status` / `cancel_task` sit on a task registry
  + `stopRun`. The API's native async function calling keeps a session going
  while a call is pending, but a task can run for minutes: returning the id
  immediately keeps delegation independent of that.

Open decisions:

- **Parallelism vs context**: the channel FIFO serializes. Either every task
  runs on the channel session (context shared with the text chat, one at a
  time) or each gets an isolated session (parallel, fresh context each —
  e.g. one Discord thread per task). Start serialized.
- **Two brains**: the Realtime model sees nothing of the host. It must delegate
  anything about the system instead of answering from its own knowledge, and
  pass the user's verbatim transcript to the agent along with its
  reformulation.
- **Safety**: a misheard order reaching admin mode → spoken confirmation
  before any destructive task.
- **Session cap**: 60 min per Realtime session → reconnect, re-seeding the
  running tasks.
- **Cost** (OpenAI pricing, 2026-09-22), per 1M audio tokens in/out:
  `gpt-realtime-2.1` $32 / $64, `gpt-realtime-2.1-mini` $10 / $20. Start with
  mini.

Files: new `src/realtime.js` (WebSocket client, tool dispatch, task registry),
`src/voice.js`, `src/pcm.js`. Effort: high. Value: high.

## 5. Per-channel working directory

Every run uses the home directory as cwd — `ADMIN_USER_HOME` on the host
(`claude.js:131,441`, `codex.js:119,263,501`), `SANDBOX_USER_HOME` in the
container (`-w`, `container.js:378`). One channel per project needs a cwd per
channel.

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
- **Shared prerequisite with §1**: `registerSlashCommands` (`index.js:356`)
  emits only `name`/`description`/`type`/`dmPermission` — no `options` — and
  the `InteractionCreate` listener returns unless `isChatInputCommand()`
  (`index.js:302`), so autocomplete interactions are dropped. Extending the
  neutral metadata in `commands.js` with an optional argument spec, and the
  adapter with an autocomplete branch, unlocks `/btw <question>` and
  `/cd <path>` at once. That is the real work; the picker is not.

## 6. Code-fence-aware message splitting

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

## 7. Reply context

Replying to a message is the Discord-native way of pointing at something, and
today nothing reads it: only a thread's starter message is injected
(`index.js:148`), `message.reference` is ignored.

- `message.fetchReference()` on the incoming message, injected as quoted
  context in the same shape as the starter injection (author + content), which
  the formatting can be reused from.
- Bound it: one level only, truncate long quotes, and skip when the referenced
  message is the bot's own previous reply — already in the session, so quoting
  it back only burns context.

Effort: low. Value: medium.

## Priorities

`/btw` and the webhook have the best value/effort ratio among the bigger
items; thread-fork is small once `/btw` exists. §6 and §7 are contained
one-function changes; §5 is worth doing before more channels accumulate a
`depotPath`, and its autocomplete UI shares the slash-command option support
`/btw` needs — doing that once serves both. Voice: §4 is deferred, and no
further work goes into the turn-based `/voice` pipeline it replaces.

## References

- clod-voice — Discord × OpenAI Realtime, delegation to Claude (source of
  §4): <https://github.com/KNQuoc/clod-voice/blob/master/src/realtime-client.ts>
- OpenAI — Realtime API notes (async function calling, 60 min sessions):
  <https://developers.openai.com/blog/realtime-api>
- OpenAI — Realtime VAD (`server_vad` / `semantic_vad`, `interrupt_response`):
  <https://developers.openai.com/api/docs/guides/realtime-vad>
- Hermes — `voice_mixer.py` (source of `src/mixer.js`, ambient bed / duck
  gains):
  <https://github.com/NousResearch/hermes-agent/blob/main/plugins/platforms/discord/voice_mixer.py>
- disclaw — Discord × Claude Code (source of §5–7: working-directory chain,
  fence-aware splitting, reply quoting):
  <https://github.com/six-ddc/disclaw>
