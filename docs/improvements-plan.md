# Claudiscord — feature backlog: session forks, webhook, voice, Discord UX

Ideas discussed 2026-07-24, verified against the host Claude CLI 2.1.218,
codex-cli 0.146.0 and the current `src/`. Absorbs the former
`docs/voice-improvements-plan.md` (§4–7); its deferred items (agent cancel
while THINKING, realtime voice front-end) were dropped, not carried over.

§8–11 were added 2026-09-11 from a review of `six-ddc/disclaw`, re-verified
against Claude CLI 2.1.268 and codex-cli 0.154.0.

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
  routing — the pending work listed in `CLAUDE.md` ("Adding a transport")
  stays untouched.
- Flow: resolve mode/agent from sessions → build the system prompt →
  `executePrompt` through the channel FIFO → result posted to the Discord
  channel. HTTP answers `202` immediately (a prompt has no bounded duration).
- Exposure beyond localhost: Apache reverse proxy + TLS + fail2ban (existing
  infra on this host). Optional channel allowlist in `.env`.
- Use cases: iOS Shortcuts, CI, home automation.

## 4. Voice hallucination filter

Hermes' actual filter was fetched from the repo (`tools/voice_mode.py`):
~26 exact-match phrases (mostly EN: "thank you", "bye", "you", "the end", plus
RU/FR/IT/DE/JA subtitle credits), one repetition regex, one empty check.
**"ciao" is not in it** — the current FR patterns in `voice.js` are already
better targeted than Hermes' list, so simply porting their set is mostly moot.
Ordered by cost:

1. Extend the bare-pleasantry alternation in `HALLUCINATION_PATTERNS`
   (`voice.js`): add `ciao`, `bye`, `bonne journée/soirée/nuit`,
   `à plus (tard)`. Do NOT filter bare `oui`/`non`/`ok` — legitimate
   confirmation answers (the voice prompt explicitly asks for confirmation
   before acting).
2. Port Hermes' repetition regex, FR-adapted (collapses "Merci. Merci.
   Merci.") — their list's real added value.
3. RMS energy gate on the captured PCM before the Groq call (`MIN_TURN_MS`
   exists but there is no level check) — drops coughs/keyboard noise without
   paying for an API call.
4. Structural upgrade: request `response_format=verbose_json` instead of
   `text` (`stt.js`). Groq returns per-segment metadata including
   `no_speech_prob` (verified in Groq's speech-to-text docs); thresholding on
   `no_speech_prob`/`avg_logprob` catches *arbitrary* hallucinations with no
   list maintenance — the only approach that would have caught "ciao".
   Apply to voice-channel turns; Discord voice messages (mic button) can keep
   `text`.

## 5. Voice: barge-in v1 (interrupt while SPEAKING only)

Let the user cut the spoken reply and take the floor immediately. The voice
layer stays a thin I/O adapter around the unchanged `executePrompt` core.

Scope: **only the SPEAKING phase**, where the agent has already returned and
the bot is merely reading finished (already chat-posted) text — no agent
process is touched, so the interruption is lossless.

- Keep the per-user receiver live during `speaking` (today `onSpeakingStart`
  returns unless `state === 'listening'`, `voice.js`).
- On confirmed speech during `speaking`: `session.mixer.stopSpeech()` — the
  existing "barge-in rail" in `mixer.js` that drops the current clip and its
  queue — then transition straight into a normal capture/turn.
- Anti-cough guard: require ~200–300 ms of sustained speech before cutting
  (OpenClaw's `minBargeInAudioEndMs` idea). New const `VOICE_BARGE_IN_MS`.

Per-user Discord streams mean the bot never hears itself → no echo handling.
Files: `src/voice.js` (state machine), `src/config.js`. Effort: medium.
Value: high.

## 6. Voice: streaming TTS (sentence by sentence)

Cut time-to-first-word: today the bot waits for the *entire* agent reply
before synthesizing. Hermes streams per sentence (accumulate ≥~20 chars,
strip markdown / `<think>`, synth + play sequentially).

- Needs a streaming path from the agent: consume Claude's `stream-json`
  incrementally instead of only the final `result.result`. Requires an
  executor API that yields text deltas (new — `executePrompt` resolves once
  at the end). Codex `--json` is similar; can land Claude-first.
- Segment on sentence boundaries, enqueue each clip via `mixer.playSpeech()`
  (already plays back-to-back). Reduces reliance on the thinking bed.
- Interaction with §5: SPEAKING and THINKING now overlap. Barge-in v1 still
  just stops audio (`mixer.stopSpeech`) and lets the agent finish quietly —
  no agent kill.

Files: `src/claude.js` (delta emit), `src/executor.js` (streaming variant),
`src/voice.js`. Effort: medium-high. Value: high.

## 7. Voice: spoken ack before long tasks

A brief spoken "je regarde ça" as soon as a turn enters THINKING, so the gap
before the answer is filled by more than the ambient bed (Hermes / OpenClaw
verbal acks). Reuse the cached-phrase mechanism (`PHRASES` +
`speak(cache: true)`).

Files: `src/voice.js`. Effort: low. Value: UX polish.

## 8. Scheduling as an internal skill

Move the mechanics of the Scheduling section out of the system prompt and into
a `SKILL.md` the agent opens only when it schedules something. The section is
~3 KB of every system prompt today, paid on every turn of every channel, while
most turns never touch a job.

- Both CLIs read the same format and load only the frontmatter up front:
  `/root/.codex/skills/.system/*/SKILL.md` carry `name` + `description`, and
  `imagegen` is 19 KB — bodies are not inlined. `src/skills.js` already knows
  both paths (`.claude/skills`, `.codex/skills`).
- No spawn change needed: the `Skill` tool is not gated by `--allowedTools`
  (`claude.js:167`) — a claudiscord run lists the host skills today.
- **Stays in the prompt**: the trigger and the prohibitions ("recurring or
  delayed work → the scheduling skill; never crontab/at/systemd timers/
  `setTimeout`"). The agent opens a skill only if the always-loaded description
  convinced it, so the interdiction must precede that decision — otherwise it
  writes a crontab and never opens the file.
- **Moves to the body**: table schema, `.timeout 5000`, column semantics,
  `isolated`, `NOTIFY_NONE`. The token is safe to move: not knowing it means
  not emitting it, and a job that must stay silent carries the instruction in
  its own prompt, which is always in context.
- Ship `skills/claudiscord-scheduling/SKILL.md` in the repo and install/refresh
  it from `ensureStorage()` (which already prepares the sandbox config dirs)
  into the four targets — `.claude/skills/` and `.codex/skills/` under both
  homes. Versioned with the code instead of two hand-synced copies; document
  that it is regenerated at startup, since that directory also holds the user's
  own skills (listed by `/skills`).
- Buys nothing on validation: no cron check before insert, no server-side
  atomic write. `STRICT` and `recordJobRun`'s transaction remain the only
  guards. An in-process MCP server would have added that, at the cost of
  shipping every tool definition into every prompt — rejected on that trade.

Effort: low. Value: high (context paid on every turn).

## 9. Per-channel working directory

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
- Side effect worth having: Claude auto-loads the cwd's `CLAUDE.md`, so a
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

## 10. Code-fence-aware message splitting

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

## 11. Reply context

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

§8 (scheduling skill) is the cheapest real win — one file plus an install step,
and it pays off on every turn. `/btw` and the webhook have the best
value/effort ratio among the bigger items; thread-fork is small once `/btw`
exists. §10 and §11 are contained one-function changes; §9 is worth doing
before more channels accumulate a `depotPath`, and its autocomplete UI shares
the slash-command option support `/btw` needs — doing that once serves both. Voice: filter items 1–2 (§4)
and the spoken ack (§7) are trivial; the `verbose_json` gate (§4.4) is a small,
contained change to `stt.js` + `voice.js`; barge-in (§5) is the best UX win;
streaming TTS (§6) is the heaviest item and can come last.

## References

- OpenClaw — Discord channel (voice modes, barge-in, wake word):
  <https://docs.openclaw.ai/fr/channels/discord/>
- Hermes — Voice Mode (VAD, streaming TTS, hallucination filter):
  <https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/features/voice-mode.md>
- Hermes — `voice_mixer.py` (source of `src/mixer.js`, ambient bed / duck
  gains):
  <https://github.com/NousResearch/hermes-agent/blob/main/plugins/platforms/discord/voice_mixer.py>
- disclaw — Discord × Claude Code (source of §9–11: working-directory chain,
  fence-aware splitting, reply quoting):
  <https://github.com/six-ddc/disclaw>
