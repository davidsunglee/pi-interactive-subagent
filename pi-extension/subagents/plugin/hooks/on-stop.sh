#!/usr/bin/env bash
# Stop hook for pi-spawned Claude sessions.
# Sole responsibility: surface the transcript path to the watcher so it can
# archive the JSONL and resolve the Claude session id early. Completion
# signaling lives in the bundled MCP `subagent_done` tool.

set -euo pipefail

input=$(cat)

# Loop guard
stop_hook_active=$(printf '%s' "$input" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).stop_hook_active||false)))')
[ "$stop_hook_active" = "true" ] && exit 0

# Only act for pi-spawned sessions
[ -z "${PI_CLAUDE_SENTINEL:-}" ] && exit 0

# Surface the transcript path
transcript_path=$(printf '%s' "$input" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).transcript_path||""))')
[ -n "$transcript_path" ] && [ -f "$transcript_path" ] && \
  printf '%s\n' "$transcript_path" > "${PI_CLAUDE_SENTINEL}.transcript"

exit 0
