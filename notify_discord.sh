#!/bin/bash
# Envoie un DM Discord à l'utilisateur autorisé via l'API REST
# Usage: /opt/claudiscord/notify_discord.sh "message"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/.env"

ENV_FILE="$DISCORD_TOKEN_FILE"
DISCORD_API="https://discord.com/api/v10"
MAX_LENGTH=1900

[ $# -eq 0 ] || [ -z "$1" ] && { echo "[notify_discord] ERREUR : message manquant" >&2; exit 1; }

MESSAGE="$1"
[ "${#MESSAGE}" -gt "$MAX_LENGTH" ] && MESSAGE="${MESSAGE:0:$MAX_LENGTH}...(tronqué)"

DISCORD_TOKEN=$(grep '^BATBOT_DISCORD_TOKEN=' "$ENV_FILE" | sed 's/^BATBOT_DISCORD_TOKEN=//' | tr -d '"')
[ -z "$DISCORD_TOKEN" ] && { echo "[notify_discord] ERREUR : DISCORD_TOKEN introuvable" >&2; exit 1; }

# Ouvrir canal DM
CHANNEL_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "${DISCORD_API}/users/@me/channels" \
    -H "Authorization: Bot ${DISCORD_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"recipient_id\":\"${AUTHORIZED_USER_ID}\"}")
HTTP_CODE=$(echo "$CHANNEL_RESPONSE" | tail -n1)
CHANNEL_BODY=$(echo "$CHANNEL_RESPONSE" | head -n-1)
[ "$HTTP_CODE" != "200" ] && { echo "[notify_discord] ERREUR ouverture DM (HTTP $HTTP_CODE): $CHANNEL_BODY" >&2; exit 1; }

CHANNEL_ID=$(echo "$CHANNEL_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
[ -z "$CHANNEL_ID" ] && { echo "[notify_discord] ERREUR : channel_id introuvable" >&2; exit 1; }

# Envoyer message
JSON_PAYLOAD=$(python3 -c "import json,sys; print(json.dumps({'content':sys.argv[1]}))" "$MESSAGE")
SEND_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "${DISCORD_API}/channels/${CHANNEL_ID}/messages" \
    -H "Authorization: Bot ${DISCORD_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$JSON_PAYLOAD")
[ "$SEND_CODE" != "200" ] && { echo "[notify_discord] ERREUR envoi (HTTP $SEND_CODE)" >&2; exit 1; }

echo "[notify_discord] Message envoyé (canal $CHANNEL_ID)"
