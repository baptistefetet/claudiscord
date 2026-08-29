#!/bin/bash
# Update the sandbox container's apt packages.
#
# The container runs the host's Claude and Codex through read-only bind-mounts
# (see Dockerfile), so upgrading either agent is a host-side operation and the
# sandbox picks the new version up on its own.
set -euo pipefail

CONTAINER_NAME="claudiscord-sandbox"

echo "[SANDBOX/APT] Update..."
docker exec -u root "$CONTAINER_NAME" bash -c '
    set -euo pipefail
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" 2>&1 | tail -10
'

echo "Sandbox packages updated. Claude and Codex follow the host install."
