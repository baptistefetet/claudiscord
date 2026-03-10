FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git openssh-client && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && cp /root/.local/share/claude/versions/$(ls -t /root/.local/share/claude/versions/ | head -1) /usr/local/bin/claude \
    && chmod 755 /usr/local/bin/claude \
    && rm -rf /root/.local/share/claude /root/.local/bin/claude
RUN useradd -m -s /bin/bash claude
USER claude
WORKDIR /home/claude
CMD ["sleep", "infinity"]
