# Plan — Sortie vocale TTS dans un salon vocal Discord

> Statut : **idée / non implémenté**. Rédigé suite à une discussion de faisabilité.
> But : permettre à claudiscord de **rejoindre un salon vocal** et d'y **parler**
> (text-to-speech), en complément du STT entrant déjà en place (`src/stt.js`).

## 1. Verdict de faisabilité

**Faisable**, mais ce n'est PAS un simple branchement d'un moteur TTS : c'est un ajout
de fonctionnalité dans le **cœur** de claudiscord (le process Node permanent), pas
quelque chose que l'agent `claude -p` peut faire à la volée.

## 2. Contrainte architecturale clé

- claudiscord = process Node **permanent** (service systemd) qui tient la connexion
  Discord (gateway).
- L'agent (`claude -p` / `codex exec`) tourne en **sous-process jeté à chaque message** :
  dès qu'il répond, son process meurt.
- Une connexion à un salon vocal (`VoiceConnection`) est **stateful** et doit vivre dans
  le process permanent.

➡️ **Conséquence** : la feature vocale doit être codée dans `src/` (process permanent) et
déclenchée par claudiscord lui-même (commande / hook sur l'envoi de message), **pas**
pilotée depuis un prompt agent.

## 3. État actuel du code (constaté)

- `discord.js` v14.19.3 ✅
- `ffmpeg` présent sur le host (`/usr/bin/ffmpeg`) ✅
- `src/stt.js` : brique audio **entrante** (Discord voice message → Groq Whisper → texte)
  déjà en place. Rien pour le **sortant**.
- Intents actuels (`src/discord.js`) : `Guilds`, `GuildMessages`, `DirectMessages`,
  `MessageContent`. **Pas** de `GuildVoiceStates`.
- Aucune dépendance vocale installée : pas de `@discordjs/voice`, pas d'encodeur opus,
  pas de lib de chiffrement sodium.

## 4. Choix du moteur TTS

Recommandation : **edge-tts** (voix Microsoft Edge « Read Aloud », gratuit, sans clé API,
excellentes voix FR comme `fr-FR-DeniseNeural` / `fr-FR-HenriNeural`). Nécessite un accès
réseau (le Pi l'a).

- En Node : lib `msedge-tts` ou `node-edge-tts`, ou appel du binaire Python `edge-tts`.
- Sortie : **mp3** (le endpoint gratuit est verrouillé sur `audio-24khz-48kbitrate-mono-mp3`).
- **Point important** : en lecture dans un salon vocal, le problème « mp3 → ogg » n'existe
  pas. `@discordjs/voice` + ffmpeg transcode le mp3 → opus tout seul via
  `createAudioResource`. La conversion ogg/waveform n'est nécessaire QUE pour les
  « voice messages » (notes vocales dans un salon texte), pas pour la lecture en vocal.

Alternatives : **Piper** (TTS neural 100 % local/offline, conçu pour le Raspberry Pi) si
on veut se passer du réseau ; `gTTS` (simple) ; ElevenLabs/Google Cloud TTS/Polly (tiers
gratuits avec clé + limites).

## 5. Dépendances à ajouter (⚠️ nécessite accord explicite — règle « aucune install sans autorisation »)

- `@discordjs/voice` (gestion de la connexion vocale et du player)
- Encodeur opus : `@discordjs/opus` (natif, rapide — build node-gyp requis) **ou**
  `opusscript` (pur JS, plus lent, fallback sans compilation)
- Chiffrement : **optionnel**. Node gère `aes-256-gcm` nativement ; sinon une lib parmi
  `sodium-native` / `libsodium-wrappers` / `@noble/ciphers` / `@stablelib/xchacha20poly1305`.
- Le moteur TTS choisi (`msedge-tts` côté Node, ou binaire `edge-tts` / `piper`).

## 6. Modifications de code

1. **`src/discord.js`** : ajouter l'intent `GatewayIntentBits.GuildVoiceStates`.
2. **`src/voice.js`** (nouveau module, dans le process permanent) :
   - `joinChannel(voiceChannel)` → `joinVoiceChannel(...)` + `createAudioPlayer()`
   - `speak(text)` → TTS → mp3 → `createAudioResource(stream)` → `player.play(resource)`
   - file d'attente locale (un seul flux à la fois) + auto-leave après inactivité
   - gestion des erreurs / reconnexion
3. **`src/tts.js`** (nouveau) : génération audio (edge-tts → buffer/stream mp3), miroir
   structurel de `src/stt.js`.
4. **Déclencheur** — au choix :
   - commande `/join` / `/leave` + `/say <texte>` (`src/commands.js`)
   - et/ou « lire à voix haute chaque réponse texte du bot » quand il est connecté à un
     vocal (hook dans `sendToChannel` / le flux de réponse de `src/index.js`).
5. **`.env`** : options TTS (voix, langue, moteur) ; doc dans `README.md` + section dans
   le `CLAUDE.md` du projet (miroir de la section « Voice messages »).

## 7. Limites connues

- **Serveur uniquement** : un bot ne peut pas être en vocal dans un DM. La feature ne
  marche que dans une guild.
- edge-tts dépend du réseau (sinon, basculer sur Piper en local).
- L'agent ne peut pas « tenir » la connexion : tout pilotage par prompt devrait passer par
  un canal IPC vers le process permanent (fichier/socket) — à éviter si possible, préférer
  une commande native.

## 8. Effort estimé

Modéré : ≈ 1 nouveau module vocal + 1 module TTS + 1 intent + 2-3 dépendances + câblage
d'un déclencheur. Pas de refonte de l'architecture existante. Le STT déjà présent sert de
modèle pour le style et la gestion réseau/erreurs.

## 9. Prochaines étapes (quand on s'y mettra)

1. Valider le moteur TTS (edge-tts vs Piper) et le mode de déclenchement (`/say` vs
   lecture auto des réponses).
2. Autoriser l'installation des dépendances.
3. POC sur une branche : rejoindre un vocal + lire un texte fixe.
4. Brancher edge-tts, puis le déclencheur, puis la doc.
