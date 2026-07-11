# Voice Assistant — Design Plan (deferred)

**Status: PLANNED, not implemented.** Talk to BatBot in a Discord voice channel,
reusing the existing `claude -p` request/response mold. To be built later.

## Goal

Answer by voice in a Discord **guild voice channel**: the user speaks, the bot
replies out loud. Fluidity is explicitly a non-goal — a half-duplex,
walkie-talkie turn-taking feel is acceptable.

## Approach: STT → `claude -p` → TTS (~$0)

A realtime speech-to-speech model (OpenAI Realtime API / "gpt-live") was rejected
purely on cost (~$0.18–0.46 / min of audio) since full-duplex fluidity is not
needed. Instead the voice layer is only an **I/O adapter** around the unchanged
core: one utterance = one `executePrompt('claude', ...)` through the existing
global FIFO queue.

## Components

- **Voice connection** — `@discordjs/voice`, join a guild voice channel with
  `selfDeaf: false`. Runs in the host process (claudiscord runs as root on host),
  so the voice agent is the **admin/host** Claude with full powers.
- **Turn capture** — `receiver.subscribe(userId, { end: { behavior:
  EndBehaviorType.AfterSilence, duration: ~900 } })`. Silence ends the per-user
  Opus stream = end-of-turn signal (built in, free). Tune `duration` (known to be
  finicky on micro-pauses).
- **Decode** — Opus 48 kHz stereo → PCM16/WAV via `prism-media` / `ffmpeg`
  (resample to what the STT expects).
- **STT** — reuse Groq Whisper already in `src/stt.js` (`whisper-large-v3`,
  French). Effectively free at this volume.
- **Gating / filtering**
  - Wake word on the transcript ("batbot …"): always transcribe, but only call
    Claude when present → avoids one `claude -p` per random sentence.
  - Drop empty / too-short transcripts and known Whisper silence hallucinations
    ("Sous-titres…", "Merci d'avoir regardé", etc.).
- **Brain** — `executePrompt('claude', mode, text)`; session keyed by the voice
  (or linked text) `channelId` so multi-turn memory works like text. The reply
  text can also be posted to the text channel.
- **TTS** — **Piper** local binary + a French **medium** voice (ONNX). Offline,
  $0. On a Pi4 use a low/medium voice for near-real-time; high-quality voices add
  several seconds. text → WAV.
- **Playback** — `createAudioPlayer` + `createAudioResource(wav)` into the
  connection (Opus encode handled by the lib).
- **Lifecycle** — `/voice join` / `/voice leave` commands; auto-leave after an
  inactivity timeout (cost/CPU hygiene).

## State machine

`LISTENING → (silence) CAPTURED → TRANSCRIBING (Whisper) → [gate] → THINKING
(claude -p, serialized by the FIFO) → SPEAKING (Piper + playback) → LISTENING`

v1 is **half-duplex**: ignore new input while THINKING/SPEAKING. The bot never
hears its own output (Discord separates per-user streams).

## Dependencies (Pi4 / ARM64, host)

- npm: `@discordjs/voice`, `@discordjs/opus` (native; `opusscript` fallback),
  `sodium-native` (or `libsodium-wrappers`) for voice encryption, `prism-media`.
- system: `ffmpeg`, `piper` binary + a French voice model (`.onnx` + `.json`).

## Non-functional

- **Latency**: ~5–12 s/turn (silence wait + Whisper + `claude -p` + Piper),
  longer when Claude runs tools. Acceptable by design.
- **Cost**: ~$0 incremental (Whisper already used, Piper free, Claude via the
  existing plan).
- **Effort**: working prototype ~2–3 focused days; polish (wake word, auto-leave,
  filtering, barge-in) more.

## Open decisions

1. Trigger: wake-word-on-transcript (recommended) vs `/listen` toggle +
   push-to-talk.
2. Duplex: half-duplex v1 (no interruption). Barge-in (stop the player on
   `speaking start`) is a later add.
3. Agent scope: host/admin (full powers) — voice would pilot the Pi as root; to
   confirm.
4. Whisper hallucination filter thresholds.

## Out of scope (future)

- Full-duplex / barge-in, multi-speaker mixing and turn arbitration.
- Upgrade path to a realtime speech-to-speech model if fluidity ever becomes a
  priority.

## References

- discord.js voice receive: https://discordjs.guide/voice/receiving-audio.html
- Piper on Raspberry Pi: https://rmauro.dev/how-to-run-piper-tts-on-your-raspberry-pi-offline-voice-zero-internet-needed/
- Groq TTS (EN/AR only, paid — why not used): https://console.groq.com/docs/text-to-speech
- OpenAI Realtime (rejected on cost): https://developers.openai.com/api/docs/guides/realtime
