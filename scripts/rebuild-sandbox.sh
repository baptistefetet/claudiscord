#!/bin/bash
set -euo pipefail

IMAGE="claudiscord-sandbox"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Pick UID/GID for the in-container `claude` user. If SANDBOX_HOME_DIR is set
# in .env and exists, mirror its ownership so bind-mounted files are
# read/write-able on both sides without additional chown gymnastics.
# Otherwise default to 1001:1001 and create the directory.
SANDBOX_HOME_DIR=""
if [ -f "$PROJECT_DIR/.env" ]; then
    SANDBOX_HOME_DIR=$(grep -E '^SANDBOX_HOME_DIR=' "$PROJECT_DIR/.env" | head -1 | cut -d= -f2-)
fi

if [ -n "$SANDBOX_HOME_DIR" ] && [ -d "$SANDBOX_HOME_DIR" ]; then
    SANDBOX_UID=$(stat -c '%u' "$SANDBOX_HOME_DIR")
    SANDBOX_GID=$(stat -c '%g' "$SANDBOX_HOME_DIR")
    echo "Detected SANDBOX_HOME_DIR ownership: ${SANDBOX_UID}:${SANDBOX_GID}"
else
    SANDBOX_UID=1001
    SANDBOX_GID=1001
    echo "Using default UID:GID 1001:1001"
    if [ -n "$SANDBOX_HOME_DIR" ]; then
        mkdir -p "$SANDBOX_HOME_DIR"
        chown "${SANDBOX_UID}:${SANDBOX_GID}" "$SANDBOX_HOME_DIR"
        echo "Created and chowned $SANDBOX_HOME_DIR"
    fi
fi

echo "=== Building $IMAGE (UID=$SANDBOX_UID GID=$SANDBOX_GID) ==="
docker build --no-cache \
    --build-arg "SANDBOX_UID=$SANDBOX_UID" \
    --build-arg "SANDBOX_GID=$SANDBOX_GID" \
    -t "$IMAGE" "$PROJECT_DIR"

echo ""
echo "=== Removing old containers (volumes preserved) ==="
containers=$(docker ps -a --filter "ancestor=$IMAGE" --format '{{.Names}}' 2>/dev/null || true)
# Also catch containers referencing the old (now dangling) image by name prefix
containers="$containers"$'\n'"$(docker ps -a --filter "name=claudiscord-" --format '{{.Names}}' 2>/dev/null || true)"
containers=$(echo "$containers" | sort -u | grep -v '^$' || true)

if [ -n "$containers" ]; then
    echo "$containers" | while read -r name; do
        echo "  Stopping and removing $name"
        docker stop "$name" 2>/dev/null || true
        docker rm "$name" 2>/dev/null || true
    done
else
    echo "  No containers to remove"
fi

echo ""
echo "=== Pruning dangling images ==="
docker image prune -f

echo ""
echo "Done. Containers will be recreated on next use."
