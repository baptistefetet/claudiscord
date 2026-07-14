# Voice assistant — improvement plan

Backlog for `src/voice.js` & friends, inspired by Hermes (already the source of
`src/mixer.js`) and OpenClaw's Discord voice modes. Ordered by value/effort. The
voice layer stays a thin I/O adapter around the unchanged `executePrompt` core.

## Current state

Half-duplex walkie-talkie: capture-until-silence → Groq Whisper (batch) →
`executePrompt` → OpenAI TTS of the *whole* reply → mixer (thinking bed + duck).
No interruption; the receiver is ignored unless the state is `listening`.

## P1 — Barge-in v1 (interrupt while SPEAKING only)

Goal: let the user cut the spoken reply and take the floor immediately.

Scope: **only the SPEAKING phase**, where claude/codex has already returned and
we are merely reading finished (already chat-posted) text. No agent process is
touched → lossless.

- Keep the per-user receiver live during `speaking` (today `onSpeakingStart`
  returns unless `state === 'listening'`, `voice.js`).
- On confirmed speech during `speaking`: call `session.mixer.stopSpeech()` — the
  existing "barge-in rail" (`mixer.js`) that drops the current clip + queue —
  then transition straight into a normal capture/turn.
- Anti-cough guard: require a short sustained-speech threshold before cutting
  (OpenClaw's `minBargeInAudioEndMs` idea, ~200–300 ms). New const
  `VOICE_BARGE_IN_MS`.
- Per-user Discord streams mean the bot never hears itself → no echo handling.

Files: `src/voice.js` (state machine), `src/config.js` (new const).
Effort: medium. Value: high.

## P2 — Streaming TTS (sentence by sentence)

Goal: cut time-to-first-word; today we wait for the *entire* Claude reply before
synthesizing. Hermes streams per sentence (accumulate ≥~20 chars, strip
markdown / `<think>`, synth + play sequentially).

- Needs a streaming path from the agent: consume Claude's `stream-json`
  incrementally instead of only the final `result.result`. Requires an executor
  API that yields text deltas (new — `executePrompt` resolves once at the end).
  Codex `--json` is similar; can land Claude-first.
- Segment on sentence boundaries, enqueue each clip via `mixer.playSpeech()`
  (already plays back-to-back). Reduces reliance on the thinking bed.
- Interaction with P1: SPEAKING and THINKING now overlap. v1 barge-in still just
  stops audio (`mixer.stopSpeech`) and lets claude finish quietly — no agent kill.

Files: `src/claude.js` (delta emit), `src/executor.js` (streaming variant),
`src/voice.js`. Effort: medium-high. Value: high.

## P3 — Expand the hallucination filter

Port Hermes' larger set (~26 multi-language phrases + a repetitive-variation
regex) into `HALLUCINATION_PATTERNS` (`voice.js`, currently ~6 FR patterns).

Files: `src/voice.js`. Effort: low. Value: robustness.

## Autojoin

Goal: the bot joins the voice channel automatically when the authorized user
joins one, without typing `/voice` (OpenClaw follow-users, simplified to the
single authorized user).

- Listen to `voiceStateUpdate`; when `AUTHORIZED_USER_ID` joins a supported
  `GuildVoice` channel and no session is active, call `joinVoice`. Leave when
  they leave (we already have `leaveVoice` + the idle timeout).
- Gate behind config `VOICE_AUTOJOIN` (default off) to avoid surprise joins.

Files: `src/index.js` (event), `src/voice.js`, `src/config.js`.
Effort: medium. Value: convenience.

## Vocal ack before long tasks

Goal: a brief spoken "je regarde ça" as soon as a turn enters THINKING, so the
gap before the answer is filled by more than the ambient bed (Hermes / OpenClaw
verbal acks). Reuse the cached-phrase mechanism (`PHRASES` + `speak(cache:true)`).

Files: `src/voice.js`. Effort: low. Value: UX polish.

## Deferred to v2 — Case B: interrupt while THINKING (agent cancel)

Cutting the bot *while the agent is still running* requires killing the
`claude -p` / `codex exec` child. The mechanism exists (`spawnWithTimeout`
already does SIGTERM→SIGKILL on timeout) but it needs new plumbing and accepts a
lossy cancel:

- Thread an `AbortController` from `voice.js` → `executor.js` → `spawn.js` to kill
  the specific in-flight FIFO item (`queue.js` is a bare promise chain today, no
  cancel API).
- Hard kill, no partial recovery; the session stays resumable (UUID persisted on
  error) but the interrupted turn's assistant message is partial.
- Sandbox caveat: `killAgentProcessesInContainer` pkills all non-init PIDs →
  interacts with the sandbox-remote lockout.

Out of scope for v1.
