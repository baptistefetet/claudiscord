#!/bin/bash
# Rebuild the claudiscord-sandbox Docker image and recreate containers.
# Called by the weekly scheduled job via Claude CLI on the host.
# Volumes (credentials, user files) are preserved.

set -e

echo "Stopping claudiscord containers..."
for name in $(docker ps -a --filter "name=claudiscord-" --format "{{.Names}}" | grep "^claudiscord-"); do
    docker stop "$name" 2>/dev/null || true
    docker rm "$name" 2>/dev/null || true
    echo "  Removed $name"
done

echo "Rebuilding image..."
docker build --no-cache -t claudiscord-sandbox /opt/claudiscord/

echo "Cleaning up old images..."
docker image prune -f

echo "Done. Containers will be recreated on next use."
