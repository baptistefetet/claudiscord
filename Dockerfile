FROM node:22-slim

# UID/GID of the in-container `claude` user. rebuild-sandbox.sh sets these
# to match the owner of SANDBOX_HOME_DIR on the host so bind-mounted files
# are readable/writable on both sides without further chown.
ARG SANDBOX_UID=1001
ARG SANDBOX_GID=1001

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git openssh-client chromium && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && cp /root/.local/share/claude/versions/$(ls -t /root/.local/share/claude/versions/ | head -1) /usr/local/bin/claude \
    && chmod 755 /usr/local/bin/claude \
    && rm -rf /root/.local/share/claude /root/.local/bin/claude
RUN npm install -g @openai/codex@latest --no-fund --no-audit
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && cp /root/.local/bin/uv /usr/local/bin/uv \
    && cp /root/.local/bin/uvx /usr/local/bin/uvx \
    && rm -rf /root/.local
RUN groupadd -g ${SANDBOX_GID} claude && useradd -u ${SANDBOX_UID} -g ${SANDBOX_GID} -m -s /bin/bash claude
USER claude
WORKDIR /home/claude
CMD ["sleep", "infinity"]
