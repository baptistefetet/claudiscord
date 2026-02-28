#!/bin/bash
# Scheduled jobs runner for Claudiscord
# Executed every minute by cron. Reads scheduled-jobs.json,
# checks if any job's cron matches the current minute, and runs it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/.env"

JOBS_FILE="$SCRIPT_DIR/scheduled-jobs.json"
NOTIFY_SCRIPT="$SCRIPT_DIR/notify_discord.sh"
MAX_TIMEOUT=300

# Se placer dans /root/ pour que Claude charge automatiquement /root/CLAUDE.md
cd /root

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# --- Cron matching ---
# Uses python3 inline to match a 5-field cron expression against the current time.
# Supports: *, */N, N, N-M, N,M,O (and combinations)
cron_matches() {
    local cron_expr="$1"
    python3 -c "
import sys, datetime

def match_field(field, value, max_val):
    for part in field.split(','):
        if part == '*':
            return True
        if '/' in part:
            base, step = part.split('/', 1)
            step = int(step)
            if base == '*':
                if value % step == 0:
                    return True
            elif '-' in base:
                lo, hi = map(int, base.split('-', 1))
                if lo <= value <= hi and (value - lo) % step == 0:
                    return True
        elif '-' in part:
            lo, hi = map(int, part.split('-', 1))
            if lo <= value <= hi:
                return True
        else:
            if int(part) == value:
                return True
    return False

fields = '$cron_expr'.split()
if len(fields) != 5:
    sys.exit(1)

now = datetime.datetime.now()
minute, hour, dom, month, dow = now.minute, now.hour, now.day, now.month, now.weekday()
# Cron: 0=Sunday, Python weekday: 0=Monday. Convert.
dow_cron = (dow + 1) % 7

if (match_field(fields[0], minute, 59) and
    match_field(fields[1], hour, 23) and
    match_field(fields[2], dom, 31) and
    match_field(fields[3], month, 12) and
    match_field(fields[4], dow_cron, 6)):
    sys.exit(0)
else:
    sys.exit(1)
" 2>/dev/null
}

# --- Main ---

[ ! -f "$JOBS_FILE" ] && { log "ERREUR: $JOBS_FILE introuvable"; exit 1; }

JOB_COUNT=$(jq 'length' "$JOBS_FILE")
[ "$JOB_COUNT" -eq 0 ] && exit 0

NOW_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
NOW_MINUTE=$(date '+%Y-%m-%d %H:%M')

for i in $(seq 0 $(( JOB_COUNT - 1 ))); do
    ENABLED=$(jq -r ".[$i].enabled" "$JOBS_FILE")
    [ "$ENABLED" != "true" ] && continue

    JOB_ID=$(jq -r ".[$i].id" "$JOBS_FILE")
    CRON_EXPR=$(jq -r ".[$i].cron" "$JOBS_FILE")
    PROFILE=$(jq -r ".[$i].profile" "$JOBS_FILE")
    PROMPT=$(jq -r ".[$i].prompt" "$JOBS_FILE")
    NOTIFY=$(jq -r ".[$i].notify" "$JOBS_FILE")
    LAST_RUN=$(jq -r ".[$i].lastRun // empty" "$JOBS_FILE")

    # Check cron match
    cron_matches "$CRON_EXPR" || continue

    # Avoid duplicate run in the same minute
    if [ -n "$LAST_RUN" ]; then
        LAST_RUN_MINUTE=$(date -d "$LAST_RUN" '+%Y-%m-%d %H:%M' 2>/dev/null || echo "")
        [ "$LAST_RUN_MINUTE" = "$NOW_MINUTE" ] && continue
    fi

    log "Job '$JOB_ID' matched (cron: $CRON_EXPR, profile: $PROFILE)"

    # Lock per job (skip if already running)
    LOCK_FILE="/tmp/scheduled-job-${JOB_ID}.lock"
    exec 8>"$LOCK_FILE"
    flock -n 8 || { log "Job '$JOB_ID' skipped (already running)"; continue; }

    # Determine allowed tools based on profile
    case "$PROFILE" in
        admin)
            ALLOWED_TOOLS="Bash(*) Read Write Edit Glob Grep WebSearch WebFetch Task"
            ;;
        online)
            ALLOWED_TOOLS="WebSearch WebFetch"
            ;;
        *)
            log "Job '$JOB_ID': profil inconnu '$PROFILE', skipped"
            continue
            ;;
    esac

    # Inject today's date into the prompt
    TODAY=$(date '+%Y-%m-%d')
    FULL_PROMPT="Date du jour : ${TODAY}

${PROMPT}"

    # Execute Claude
    log "Job '$JOB_ID': invoking claude (profile: $PROFILE)..."
    OUTPUT=""
    EXIT_CODE=0
    OUTPUT=$(timeout "$MAX_TIMEOUT" "$CLAUDE_BIN" -p "$FULL_PROMPT" \
        --output-format text \
        --allowedTools "$ALLOWED_TOOLS" \
        --model opus </dev/null 2>&1) || EXIT_CODE=$?

    # Update lastRun in JSON
    TMP_FILE="${JOBS_FILE}.tmp"
    jq --arg idx "$i" --arg ts "$NOW_ISO" \
        '.[($idx | tonumber)].lastRun = $ts' "$JOBS_FILE" > "$TMP_FILE"
    mv "$TMP_FILE" "$JOBS_FILE"

    if [ "$EXIT_CODE" -eq 124 ]; then
        log "Job '$JOB_ID': TIMEOUT after ${MAX_TIMEOUT}s"
        if [ "$NOTIFY" = "true" ]; then
            "$NOTIFY_SCRIPT" "🚨 **[PI4] Job '$JOB_ID' — TIMEOUT**
Pas de réponse après ${MAX_TIMEOUT}s." || true
        fi
    elif [ "$EXIT_CODE" -ne 0 ]; then
        log "Job '$JOB_ID': ERREUR (code $EXIT_CODE)"
        if [ "$NOTIFY" = "true" ]; then
            "$NOTIFY_SCRIPT" "🚨 **[PI4] Job '$JOB_ID' — ERREUR**
Claude a échoué avec le code $EXIT_CODE." || true
        fi
    else
        log "Job '$JOB_ID': terminé (output: ${#OUTPUT} chars)"
        if [ "$NOTIFY" = "true" ] && [ -n "$OUTPUT" ]; then
            "$NOTIFY_SCRIPT" "📋 **[PI4] Job '$JOB_ID'**
$OUTPUT" || true
        fi
    fi

    # Release lock
    exec 8>&-

done
