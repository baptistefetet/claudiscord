# Claudiscord — feature backlog: session forks, webhook, voice filter, inline jobs

Ideas discussed 2026-07-24, verified against the host Claude CLI 2.1.218,
codex-cli 0.145.0 and the current `src/`. Absorbs the former
`docs/voice-improvements-plan.md` (§4–7); its deferred items (agent cancel
while THINKING, realtime voice front-end) were dropped, not carried over.

## Verified capabilities

- `claude -p --resume <uuid> --fork-session` resumes a session while allocating
  a NEW session id — the parent transcript is never touched.
- The Codex CLI has no fork equivalent (`codex exec resume` only), so every
  fork-based feature below is **Claude-only**, gated like `/remote`.

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

Today `ensureFromParent` snapshots mode/agent/model but starts fresh
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
- Flow: resolve mode/agent/model from sessions → build the system prompt →
  `executePrompt` through the channel FIFO → result posted to the Discord
  channel. HTTP answers `202` immediately (a prompt has no bounded duration).
- Respect the remote gate (refuse when `remoteId` is set), like the text path.
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

## 8. Inline jobs — run a scheduled job inside the channel session

Discussed 2026-07-25. Goal: "check X in 5 minutes" runs *in the conversation*,
so the user can reply to the result. Today every job runs with
`sessionId: null` (`scheduler.js::executeJob`), so its output is a dead end.
Modelled on OpenClaw's cron `sessionTarget`, without its heartbeat file.

New column `session_target TEXT`: `'isolated'` (default, current behaviour) or
`'channel'`. Explicit rather than inferred from NULL `agent`/`model`: NULL
already means "not applicable / default" (`check-system` is `agent='codex',
model=NULL`), so overloading it would silently change that row's meaning, and
it would make illegal states representable.

Session resolution:

- `executePrompt` already resolves the channel session when given `channelId`;
  jobs currently pass `queueKey` only. The per-channel FIFO already serialises
  a job against interactive prompts, so there is no race to add.
- **Live lookup, never a snapshot.** Freezing the uuid in the row would, after
  a `/new`, `--resume` a dead session and fork it — and `executor.js` writes
  the returned id back to the channel, hijacking the live conversation.
- **Resolve inside the queue callback**, not at tick time: a `/codex` while the
  job waits in the FIFO would otherwise trip the `CHANNEL_CONTEXT_CHANGED`
  guard and fail the run. Consequence: `executePrompt(agent, mode, …)` must
  accept "use the channel's" instead of fixed values.

Marking the run as automatic:

- The system prompt is re-sent on every invocation, including on resume (Claude
  `--system-prompt`, Codex `developer_instructions`), so a `{{#job}}` block
  would correctly mark the turn itself. But it is not persisted in the
  transcript, and swapping it mid-session breaks the cached prefix twice (the
  job turn, then the next interactive turn reverting to the normal one).
- So an inline job uses the **normal** system prompt (no `jobId`) and the
  marker goes **in-band**, at the head of the injected prompt:
  `[scheduled job "<id>" — automatic run, not typed by <user>]`. In-band is
  required regardless: the user message is the only thing that survives in the
  transcript, otherwise the next turn reads the job's instructions as if the
  user had typed them. Same intent as OpenClaw's "system event" for
  main-session cron jobs.
- The `{{#job}}` line "do not end with a question; user replies cannot resume
  this job" is false for an inline job — replying is the point.

Skip conditions, evaluated at execution time and non-permanent (the job becomes
valid again once the channel is compatible):

- A job from the sandbox db must not run on a channel currently in admin mode.
  `job.mode` comes from the db the job lives in, and the container only mounts
  the sandbox db — that *is* the security boundary. Taking the mode live from
  the channel would let a sandboxed agent schedule an arbitrary prompt as root
  on the host.
- `remoteId` set → the session is driven from the mobile app and `setRemoteId`
  wiped `sessionId`; running would start a parallel session or race the `--bg`
  daemon.
- **A skipped run must bypass `recordJobRun`**, which today sits in
  `executeJob`'s `finally` and therefore always fires: otherwise the skip
  consumes a `remaining` and overwrites `last_run`, silently burning a one-shot
  that never ran.

Prerequisite for the "in 5 minutes" use case — cron is the wrong tool. The
ticker never replays a missed minute, so a one-shot that is missed (restart,
late tick, or a skip above) stays armed and fires at the same minute the *next
day*. Nullable `at` column (ISO 8601) taking precedence over `cron`, firing
when `now >= at`: catch-up after a reboot becomes natural, and a stale one-shot
can be disarmed past a threshold. This is OpenClaw's `kind: at`.

Open points:

- Stale session: an inline job can fail on `--resume` (expired session, or a
  uuid from a 0-turn run) for reasons unrelated to its task. Hard error, or
  fall back to a fresh session? A fallback silently breaks the "same session"
  promise.
- `NOTIFY_NONE` still applies — an inline job may stay silent — but the turn
  remains in the shared context either way.
- Context cost: a recurring inline job re-injects its whole prompt into the
  conversation on every run. Accepted: inline targets short, finite tasks;
  long monitoring prompts stay `isolated`.

Files: `src/jobs-store.js` (schema), `src/scheduler.js` (skip conditions,
in-band prefix, no-decrement path), `src/executor.js` (channel-resolved
agent/mode), `src/prompts.js` (Scheduling section), `src/commands.js`
(`/jobs`). Effort: medium. Value: high.

## Priorities

`/btw` and the webhook have the best value/effort ratio; thread-fork is small
once `/btw` exists. Voice: filter items 1–2 (§4) and the spoken ack (§7) are
trivial; the `verbose_json` gate (§4.4) is a small, contained change to
`stt.js` + `voice.js`; barge-in (§5) is the best UX win; streaming TTS (§6)
is the heaviest item and can come last.

Inline jobs (§8) are self-contained and independent of the fork work; the `at`
column is a small prerequisite worth landing first, since it fixes one-shot
scheduling for isolated jobs too.

## References

- OpenClaw — Discord channel (voice modes, barge-in, wake word):
  <https://docs.openclaw.ai/fr/channels/discord/>
- OpenClaw — cron jobs (`sessionTarget`: isolated / main / current / custom,
  `kind: at`, system events): <https://docs.openclaw.ai/automation/cron-jobs>
- OpenClaw — heartbeat (`isolatedSession`, `lightContext`, `HEARTBEAT_OK`
  silence contract): <https://docs.openclaw.ai/gateway/heartbeat>
- Hermes — Voice Mode (VAD, streaming TTS, hallucination filter):
  <https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/features/voice-mode.md>
- Hermes — `voice_mixer.py` (source of `src/mixer.js`, ambient bed / duck
  gains):
  <https://github.com/NousResearch/hermes-agent/blob/main/plugins/platforms/discord/voice_mixer.py>
