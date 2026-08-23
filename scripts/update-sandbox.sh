#!/bin/bash
set -euo pipefail

CONTAINER_NAME="claudiscord-sandbox"

echo "[SANDBOX/APT] Update..."
docker exec -u root "$CONTAINER_NAME" bash -c '
    set -euo pipefail
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" 2>&1 | tail -10
'

echo "[SANDBOX/CLAUDE] Update..."
docker exec "$CONTAINER_NAME" bash -c '
    set -euo pipefail
    installer=$(mktemp /tmp/claude-install.XXXXXX)
    trap '\''rm -f "$installer"'\'' EXIT
    curl -fsSL https://claude.ai/install.sh -o "$installer"
    bash "$installer" 2>&1 | tail -5
'
docker exec -u root "$CONTAINER_NAME" bash -c '
    set -euo pipefail
    latest=$(ls -t /home/claude/.local/share/claude/versions/ | head -1)
    cp "/home/claude/.local/share/claude/versions/$latest" /usr/local/bin/claude
    chmod 755 /usr/local/bin/claude
'

echo "[SANDBOX/CODEX] Update..."
docker exec -u root "$CONTAINER_NAME" \
    npm install -g --prefix /usr/local @openai/codex@latest --no-fund --no-audit

echo "Sandbox updated."
