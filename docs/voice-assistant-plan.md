# Voice Assistant — Design Plan (deferred)

**Status: PLANNED, not implemented.** Talk to BatBot in a Discord voice channel,
reusing the existing `claude -p` request/response mold. To be built later.

## Goal

Answer by voice in a Discord **guild voice channel**: the user speaks, the bot
replies out loud. Fluidity is explicitly a non-goal — a half-duplex,
walkie-talkie turn-taking feel is acceptable.

## Approach: STT → `claude -p` → TTS (near-$0)

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
- **Gating / filtering** — single-user by design (Bat is the only speaker and the
  only person in the room when using it), so **no wake word**: every captured
  utterance from the allowed user is transcribed and sent straight to Claude.
  - Still drop empty / too-short transcripts and known Whisper silence
    hallucinations ("Sous-titres…", "Merci d'avoir regardé", etc.).
- **Brain** — `executePrompt('claude', mode, text)`; session keyed by the voice
  channel's own `channelId` (its text-in-voice chat shares the same ID — see
  "Mode selection") so multi-turn memory works like text. The reply text is
  also posted to the voice channel's chat.
- **Voice system prompt** — new voice-specific section in `src/prompts.js`
  (same mechanism as `{{#claude}}`), replacing the Discord text-formatting rules:
  - Replies must be **speakable**: no markdown, no code blocks / lists / tables,
    short sentences, concise (Piper synthesizes every word).
  - The input is a Whisper transcript, not typed text. Local project names
    (claudiscord, batflix, …) are not in the STT vocabulary and arrive
    phonetically mangled — treat odd words as candidates for known project
    names.
  - When the transcript is garbled or the intent uncertain, **ask a short
    confirmation question** before acting instead of guessing — especially in
    admin mode (root powers, no visual echo of what was understood before
    execution).
- **TTS** — **OpenAI `gpt-4o-mini-tts`** (~$0.015/min of audio), the sole
  retained solution (reliability + simplicity). Plain REST (`POST
  https://api.openai.com/v1/audio/speech`, Bearer key) called with Node's
  native `fetch` — no SDK, zero new npm dependency, own module in the
  `src/stt.js` mold. French supported; tone steerable via `instructions`.
  - **Key-gated**: `OPENAI_API_KEY` in `.env`, optional exactly like
    `GROQ_API_KEY`. Its presence enables voice mode; without it `/voice join`
    reports a friendly error (same pattern as `/sandbox` without Docker).
  - Output: `mp3` decoded by ffmpeg for playback (`opus` response format
    exists but its container is undocumented — probe it at build time).
  - Rejected: **Piper** (local ONNX — binary + model + Pi4 CPU too heavy for
    an optional feature); **edge-tts** (free but unofficial Edge
    impersonation, breakage risk + ~6 npm deps).
- **Playback** — `createAudioPlayer` + `createAudioResource(wav)` into the
  connection (Opus encode handled by the lib).
- **Lifecycle** — `/voice join` / `/voice leave` commands; auto-leave after an
  inactivity timeout (cost/CPU hygiene).

## State machine

`LISTENING → (silence) CAPTURED → TRANSCRIBING (Whisper) → [gate] → THINKING
(claude -p, serialized by the FIFO) → SPEAKING (TTS + playback) → LISTENING`

v1 is **half-duplex**: ignore new input while THINKING/SPEAKING. The bot never
hears its own output (Discord separates per-user streams).

Queue contention: THINKING goes through the global FIFO, which a scheduled job
or a text prompt may hold for minutes (1200 s timeout). If `isBusy()` when the
turn is captured, speak a short "busy, one moment" notice — the voice
equivalent of the text "⏳ waiting" hint — so the wait is explained instead of
leaving only the ambient bed playing.

## Mode selection (admin / sandbox)

A voice channel IS a regular channel: its built-in text chat ("text-in-voice")
shares the voice channel's ID, so the channel gets its own `sessions.json`
entry (mode/agent/model) like any text channel. No new mechanism:

- **Mode**: type `/admin` or `/sandbox` in the voice channel's own text chat.
  Mode switching stays **text-only** — never voice-triggered: a switch clears
  the session, too destructive to fire on a mistranscription. `/status` works
  there too; the bot announces the mode out loud on join.
- **Code prerequisite**: the message handler's channel-type allowlist
  (`src/index.js`, DM/GuildText/PublicThread check) must also accept
  `ChannelType.GuildVoice`. To confirm at build time: `messageCreate` firing
  for text-in-voice with `channel.type === GuildVoice` (standard Discord
  behavior, untested on this bot).
- **Agent**: voice turns always run Claude with the channel's mode; `/codex`
  on a voice channel is refused.
- The `🎙️ <transcript>` echo and the text copy of replies post to that same
  chat, next to the spoken conversation. Sandbox voice inherits container
  execution and the cross-channel sandbox-remote lockout.

## Dependencies (Pi4 / ARM64, host)

- npm: `@discordjs/voice`, `@discordjs/opus` (native; `opusscript` fallback),
  `prism-media`. No sodium package: Node's built-in `aes-256-gcm` handles
  voice encryption (verified available on the host's node v22). TTS adds no
  dependency (native `fetch`).
- system: `ffmpeg` — already installed on the host (7.1.x). Used on the STT
  input path (user Opus 48 kHz → WAV for Whisper) and to decode the TTS mp3
  for playback.

## Non-functional

- **Latency**: ~4–10 s/turn (silence wait + Whisper + `claude -p` + TTS API),
  longer when Claude runs tools. Acceptable by design.
- **Cost**: near-$0 (Whisper already used, TTS ~$0.015/min ≈ $2–3/month at
  daily use, Claude via the existing plan).
- **Effort**: working prototype ~2–3 focused days; polish (wake word, auto-leave,
  filtering, barge-in) more.

## Open decisions

1. Duplex: half-duplex v1 (no interruption). Barge-in stays out of scope for now
   (see below), but the mixer approach keeps the rails for it.
2. Whisper hallucination filter thresholds.

Decided:
- **No wake word** — claudiscord is single-user (one speaker, alone in the room),
  so every allowed-user utterance goes to Claude directly.
- **Mode/agent scope** — per-channel like everywhere else: the voice channel's
  own session entry decides admin vs sandbox (default admin), switched from
  its text-in-voice chat. Voice turns always run Claude (see "Mode selection").

## Ideas borrowed from Hermes voice mode

Hermes (NousResearch, `plugins/platforms/discord/`) ships the same core shape
(STT → agent → TTS, half-duplex, silence-based turn end), which validates the
approach. Worth reusing:

- **Continuous audio mixer** (`voice_mixer.py`) — instead of play/stop clips,
  install ONE permanent audio source for the whole session that sums 20 ms PCM
  frames. It carries a low-volume looping **ambient "thinking" bed** while Claude
  works, plus a **speech** layer (TTS + acks) played over it that **ducks** the
  bed down (0.18 → 0.06) and swells it back smoothly (Grok-voice feel), never
  stop-and-swap. Directly masks the 5–12 s latency so the channel doesn't feel
  dead. ~50 lines of numpy in Hermes; portable to JS.
- **Verbal acknowledgement** — speak a short random phrase ("one moment", "on it")
  on the FIRST tool call of a turn, so the user knows it's working. Opt-in.
- **Synthesised ambient bed** — no asset file needed: a soft detuned-sine pad +
  slow tremolo, looped seamlessly; falls back to this if no custom loop is set.
- **Echo prevention** — Hermes pauses the receiver during playback (belt-and-
  braces). With `@discordjs/voice` the bot never hears its own stream (per-user
  streams), so keeping the receiver live is fine and cleaner.
- **UDP keepalive** — send a tiny packet (`\xf8\xff\xfe`) every ~N s or Discord
  drops the UDP session after ~60 s of silence.
- **SSRC→user inference** — on rejoin Discord may not resend SPEAKING; if a single
  allowed user is in the channel, map the stray SSRC to them.
- **Barge-in primitive (present but not wired)** — Hermes has `stop_speech()`
  (drop in-flight TTS, release the duck) but never triggers it on user speech.
  The rails exist; only the trigger is missing (see Out of scope).

## Out of scope (future)

- **Full-duplex / barge-in** — kept out of scope. If ever wanted, the mixer makes
  it ~10 lines: on a user speaking-start while `mixer.speech_active`, call
  `stop_speech()` and cancel the in-flight turn. Needs a small energy/duration
  threshold to avoid false barge-in (a "ok", a laugh, background noise).
- Multi-speaker mixing and turn arbitration (irrelevant while single-user).
- Upgrade path to a realtime speech-to-speech model if fluidity ever becomes a
  priority.

## References

- discord.js voice receive: https://discordjs.guide/voice/receiving-audio.html
- OpenAI create-speech endpoint: https://developers.openai.com/api/docs/api-reference/audio/createSpeech
- edge-tts (rejected — unofficial Edge impersonation, breakage risk): https://github.com/rany2/edge-tts
- Piper on Raspberry Pi (rejected — local model too heavy): https://rmauro.dev/how-to-run-piper-tts-on-your-raspberry-pi-offline-voice-zero-internet-needed/
- Groq TTS (EN/AR only, paid — why not used): https://console.groq.com/docs/text-to-speech
- OpenAI Realtime (rejected on cost): https://developers.openai.com/api/docs/guides/realtime
- Hermes voice mode guide: https://hermes-agent.nousresearch.com/docs/guides/use-voice-mode-with-hermes
- Hermes mixer/duck source: https://github.com/NousResearch/hermes-agent/blob/main/plugins/platforms/discord/voice_mixer.py
- Hermes VC adapter (receiver, ack, keepalive): https://github.com/NousResearch/hermes-agent/blob/main/plugins/platforms/discord/adapter.py
