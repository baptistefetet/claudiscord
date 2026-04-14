#!/bin/bash
# PostToolUse hook: when Bash starts a background task, block until it completes
# and return the actual output. Prevents Claude from doing end_turn prematurely.

INPUT=$(cat)

# Only act on background tasks (check for "run_in_background": true in tool_input)
echo "$INPUT" | grep -q '"run_in_background"' || exit 0
echo "$INPUT" | grep -q '"run_in_background": *true' || exit 0

# Extract the output file path from the tool result
OUTPUT_PATH=$(echo "$INPUT" | grep -oP 'Output is being written to: \K\S+')
[ -z "$OUTPUT_PATH" ] && exit 0

# Wait for output (poll every 2s, max 10 minutes)
ELAPSED=0
while [ ! -s "$OUTPUT_PATH" ] && [ $ELAPSED -lt 600 ]; do
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if [ -s "$OUTPUT_PATH" ]; then
  RESULT=$(cat "$OUTPUT_PATH")
  # Escape for JSON: backslashes, quotes, newlines, tabs
  RESULT=$(printf '%s' "$RESULT" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | awk '{printf "%s\\n", $0}' | sed '$ s/\\n$//')
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Background task completed. Output:\\n%s"}}\n' "$RESULT"
else
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Background task timed out after 10 minutes with no output."}}\n'
fi
