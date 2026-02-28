#!/bin/bash
# Claudiscord - watches the authorized user's DM conversation file
# and processes new messages with Claude Code CLI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/.env"

WATCH_FILE="${MESSAGES_DIR}/${AUTHORIZED_USER_ID}.json"
MAX_TIMEOUT=180
LOCK_FILE="/tmp/claudiscord.lock"
LOG_TAG="claudiscord"
STDERR_LOG="/tmp/claudiscord-stderr.log"

# Se placer dans /root/ pour que Claude charge automatiquement /root/CLAUDE.md
cd /root

SYSTEM_PROMPT="Tu es l'assistant administrateur systeme du Raspberry Pi 4 (PI4). L'utilisateur te parle via Discord DM.
Tu as acces aux outils systeme pour administrer le serveur.
Tu peux gerer les jobs planifies (creer, modifier, supprimer, lister, executer) dans $SCRIPT_DIR/scheduled-jobs.json si l'utilisateur le demande. Champs : id, prompt, cron, profile (admin|online), enabled, notify, created, lastRun, description. Si notify=true, le runner envoie automatiquement l'output du job sur Discord — le job n'a pas besoin d'appeler notify_discord.sh lui-meme. Profil : admin seulement si le prompt necessite un acces systeme (Bash, fichiers, services). Pour tout le reste (recherche web, generation de texte, message simple), utilise online. L'utilisateur peut forcer le profil.
Fais des reponses concises adaptees a Discord (max ~1800 caracteres).
Utilise le markdown Discord (pas HTML). La date du jour est : $(date '+%Y-%m-%d')."

log() { logger -t "$LOG_TAG" "$@"; echo "[$(date '+%H:%M:%S')] $@"; }

append_message() {
    local role="$1" content="$2"
    local timestamp
    timestamp=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
    local content_json
    content_json=$(printf '%s' "$content" | jq -Rs .)
    jq --arg role "$role" --argjson content "$content_json" --arg ts "$timestamp" \
        '.messages += [{"role": $role, "content": $content, "timestamp": $ts}]' \
        "$WATCH_FILE" > "${WATCH_FILE}.tmp"
    cat "${WATCH_FILE}.tmp" > "$WATCH_FILE"
    rm -f "${WATCH_FILE}.tmp"
}

update_session_and_respond() {
    local sid="$1" content="$2"
    local timestamp
    timestamp=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
    local content_json
    content_json=$(printf '%s' "$content" | jq -Rs .)

    jq --arg sid "$sid" --argjson content "$content_json" --arg ts "$timestamp" '
        .sessionId = $sid
        | .messages += [{role: "assistant", content: $content, timestamp: $ts}]
    ' "$WATCH_FILE" > "${WATCH_FILE}.tmp"
    cat "${WATCH_FILE}.tmp" > "$WATCH_FILE"
    rm -f "${WATCH_FILE}.tmp"
}

process_request() {
    log "New user message detected, invoking Claude Code..."

    local session_id
    session_id=$(jq -r '.sessionId // empty' "$WATCH_FILE" 2>/dev/null || echo "")

    local last_message
    last_message=$(jq -r '.messages[-1].content' "$WATCH_FILE")

    local start_s
    start_s=$(date +%s)
    local output exit_code=0

    if [ -n "$session_id" ]; then
        log "Running: claude -p (resume session $session_id) --model opus"
        output=$(timeout "$MAX_TIMEOUT" "$CLAUDE_BIN" -p "$last_message" \
            --resume "$session_id" \
            --output-format json \
            --allowedTools "Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task" \
            --model opus </dev/null 2>>"$STDERR_LOG") || exit_code=$?
    else
        log "Running: claude -p (new session, prompt length: ${#last_message}) --model opus"
        output=$(timeout "$MAX_TIMEOUT" "$CLAUDE_BIN" -p "$last_message" \
            --system-prompt "$SYSTEM_PROMPT" \
            --output-format json \
            --allowedTools "Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task" \
            --model opus </dev/null 2>>"$STDERR_LOG") || exit_code=$?
    fi

    # Fallback: if resume failed, retry with new session
    if [ "$exit_code" -ne 0 ] && [ -n "$session_id" ]; then
        log "Resume failed (exit $exit_code), retrying with new session..."
        exit_code=0
        output=$(timeout "$MAX_TIMEOUT" "$CLAUDE_BIN" -p "$last_message" \
            --system-prompt "$SYSTEM_PROMPT" \
            --output-format json \
            --allowedTools "Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task" \
            --model opus </dev/null 2>>"$STDERR_LOG") || exit_code=$?
    fi

    log "Claude exited with code $exit_code, output length: ${#output}"

    local duration=$(( $(date +%s) - start_s ))

    if [ "$exit_code" -eq 124 ]; then
        log "Request timed out after ${MAX_TIMEOUT}s"
        append_message "assistant" "Timeout : Claude Code a mis plus de ${MAX_TIMEOUT}s."
    elif [ "$exit_code" -ne 0 ]; then
        log "Request failed (exit code ${exit_code}) after ${duration}s"
        local error_msg
        error_msg=$(echo "$output" | tail -5 | head -c 500)
        append_message "assistant" "Erreur Claude Code (code ${exit_code}): ${error_msg}"
    else
        log "Request completed in ${duration}s"
        local response_text new_session_id
        response_text=$(printf '%s' "$output" | jq -r '.result // empty')
        new_session_id=$(printf '%s' "$output" | jq -r '.session_id // empty')

        if [ -n "$response_text" ] && [ -n "$new_session_id" ]; then
            update_session_and_respond "$new_session_id" "$response_text"
        elif [ -n "$response_text" ]; then
            append_message "assistant" "$response_text"
        else
            log "Warning: empty response from Claude"
            append_message "assistant" "Reponse vide de Claude Code."
        fi
    fi
}

# Wait for the watch file to exist
while [ ! -f "$WATCH_FILE" ]; do
    log "Waiting for $WATCH_FILE to exist..."
    sleep 5
done

log "Daemon started, watching $WATCH_FILE"

# Main loop: watch for changes, process if last message is from user
inotifywait -m -e close_write "$WATCH_FILE" --format '%e' 2>/dev/null | while read -r _event; do
    last_role=$(jq -r '.messages[-1].role // empty' "$WATCH_FILE" 2>/dev/null || echo "")
    [ "$last_role" != "user" ] && continue

    (
        flock -n 9 || exit 0
        # Re-check after acquiring lock
        last_role=$(jq -r '.messages[-1].role // empty' "$WATCH_FILE" 2>/dev/null || echo "")
        [ "$last_role" != "user" ] && exit 0
        process_request
    ) 9>"$LOCK_FILE"
done
