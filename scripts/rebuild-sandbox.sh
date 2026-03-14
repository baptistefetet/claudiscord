#!/bin/bash
set -euo pipefail

IMAGE="claudiscord-sandbox"
DOCKERFILE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Building $IMAGE ==="
docker build --no-cache -t "$IMAGE" "$DOCKERFILE_DIR"

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
