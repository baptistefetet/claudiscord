#!/bin/bash
#
# Operator helper — host upkeep for claudiscord. Run it from cron; the bot
# never invokes it. Claudiscord owns the sandbox image (scripts/rebuild-sandbox.sh),
# but the host's Claude Code and Codex CLIs predate claudiscord, so keeping the
# host up to date is the operator's job, not the bot's.
#
# Updates: APT packages, Claude Code CLI, Codex CLI.
#
# No `set -e`: the three steps are independent, so a failure in one must not
# skip the others. Each step's status is reported in the summary.
#
# Assumes privileges that allow `apt-get` and `npm install -g` (root, like the
# claudiscord service); otherwise both steps need sudo.

status() { [ "$1" -eq 0 ] && echo OK || echo "FAIL ($1)"; }

# APT: DEBIAN_FRONTEND=noninteractive + confdef/confold so apt never blocks on a
# conffile prompt in a headless cron.
echo "=== APT ==="
DEBIAN_FRONTEND=noninteractive apt-get update -qq && \
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq \
  -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold"
apt_status=$?

# Claude Code: the official installer writes a new versioned binary and swaps the
# ~/.local/bin/claude symlink. A claude already running finishes on the old
# version; the next spawn picks up the new one. No in-place overwrite of a busy
# binary, so this is safe to run while claudiscord is up.
echo "=== Claude Code ==="
curl -fsSL https://claude.ai/install.sh | bash
claude_status=$?

# Codex is optional on the host: only update it if it's already installed,
# so this upkeep script never provisions a tool the operator chose to skip.
echo "=== Codex ==="
if command -v codex >/dev/null 2>&1; then
	npm install -g @openai/codex
	codex_status=$?
else
	echo "skipped (codex not installed)"
	codex_status=0
fi

echo "=== Summary ==="
echo "APT:    $(status $apt_status)"
echo "Claude: $(status $claude_status)"
echo "Codex:  $(status $codex_status)"
