# The Debian release is pinned because it fixes the glibc the bind-mounted
# host binaries link against. bookworm ships 2.36.
FROM node:22-bookworm-slim

# UID/GID of the in-container `claude` user. rebuild-sandbox.sh sets these
# to match the owner of SANDBOX_HOME on the host so bind-mounted files
# are readable/writable on both sides without further chown.
ARG SANDBOX_UID=1001
ARG SANDBOX_GID=1001

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git openssh-client chromium sqlite3 && rm -rf /var/lib/apt/lists/*
# Both agents come from the host: container.js bind-mounts them read-only at
# /opt/claude-bin and /opt/codex-releases, so one install serves admin and
# sandbox alike. They execute inside the container's namespaces like any other
# file — only their bytes come from the host, which works because the two share
# a kernel and an architecture. Claude is a self-contained ELF needing at most
# GLIBC_2.26 (this image ships 2.36) and Codex vendors a statically linked
# musl binary, so neither pulls in a host library.
# Each wrapper runs the highest version present in its mount, the same choice
# the host installers' own symlinks make. An absent mount is reported as "not
# found", which is what container.js keys the agent-unavailable message on.
RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -e' \
      'bin=$(find /opt/claude-bin -maxdepth 1 -type f -perm -u+x -printf "%f\\n" 2>/dev/null | sort -V | tail -1)' \
      '[ -n "$bin" ] || { echo "claude: not found (/opt/claude-bin is empty)" >&2; exit 127; }' \
      'exec "/opt/claude-bin/$bin" "$@"' \
      > /usr/local/bin/claude \
    && printf '%s\n' \
      '#!/bin/sh' \
      'set -e' \
      'rel=$(find /opt/codex-releases -maxdepth 1 -mindepth 1 -type d -printf "%f\\n" 2>/dev/null | sort -V | tail -1)' \
      '[ -n "$rel" ] || { echo "codex: not found (/opt/codex-releases is empty)" >&2; exit 127; }' \
      'exec "/opt/codex-releases/$rel/bin/codex" "$@"' \
      > /usr/local/bin/codex \
    && chmod 755 /usr/local/bin/claude /usr/local/bin/codex
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && cp /root/.local/bin/uv /usr/local/bin/uv \
    && cp /root/.local/bin/uvx /usr/local/bin/uvx \
    && rm -rf /root/.local
# -o allows a duplicate UID/GID: the base image already ships a user/group at
# 1000, and SANDBOX_HOME may be owned by 1000, so tolerate the clash instead
# of failing the build.
RUN groupadd -o -g ${SANDBOX_GID} claude && useradd -o -u ${SANDBOX_UID} -g ${SANDBOX_GID} -m -s /bin/bash claude
USER claude
WORKDIR /home/claude
CMD ["sleep", "infinity"]
