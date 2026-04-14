#!/bin/bash
# PostToolUse hook: when Bash starts a background task, block until it completes
# and return the actual output. Prevents Claude from doing end_turn prematurely.

INPUT=$(cat)

# Only act on background tasks
echo "$INPUT" | grep -q '"run_in_background" *: *true' || exit 0

# Extract backgroundTaskId and session_id to reconstruct the output path
# tool_response contains: {"backgroundTaskId":"xxx", ...}
# The output file is at: /tmp/claude-{UID}/{cwd-encoded}/{session_id}/tasks/{taskId}.output
TASK_ID=$(echo "$INPUT" | grep -oP '"backgroundTaskId" *: *"\K[^"]+')
SESSION_ID=$(echo "$INPUT" | grep -oP '"session_id" *: *"\K[^"]+')
CWD=$(echo "$INPUT" | grep -oP '"cwd" *: *"\K[^"]+')
[ -z "$TASK_ID" ] || [ -z "$SESSION_ID" ] && exit 0

# Reconstruct path: CWD is encoded by replacing / with -  (leading / becomes -)
CWD_ENCODED=$(echo "$CWD" | sed 's|/|-|g')
UID_NUM=$(id -u)
OUTPUT_PATH="/tmp/claude-${UID_NUM}/${CWD_ENCODED}/${SESSION_ID}/tasks/${TASK_ID}.output"

# Wait for output (poll every 2s, max 10 minutes)
ELAPSED=0
while [ ! -s "$OUTPUT_PATH" ] && [ $ELAPSED -lt 600 ]; do
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if [ -s "$OUTPUT_PATH" ]; then
  RESULT=$(cat "$OUTPUT_PATH")
  RESULT=$(printf '%s' "$RESULT" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | awk '{printf "%s\\n", $0}' | sed '$ s/\\n$//')
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Background task completed. Output:\\n%s"}}\n' "$RESULT"
else
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Background task timed out after 10 minutes with no output."}}\n'
fi
