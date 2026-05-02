#!/usr/bin/env bash
# SessionStart hook for pi-spawned Claude sessions.
# Sole responsibility: surface the transcript path to the watcher so the
# pane backend's file-tail can lock onto the active jsonl during the run.
# The Stop hook re-writes this same pointer on exit (idempotent).

set -euo pipefail

input=$(cat)

# Only act for pi-spawned sessions
[ -z "${PI_CLAUDE_SENTINEL:-}" ] && exit 0

# Surface the transcript path
transcript_path=$(printf '%s' "$input" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).transcript_path||""))')
[ -n "$transcript_path" ] && [ -f "$transcript_path" ] && \
  printf '%s\n' "$transcript_path" > "${PI_CLAUDE_SENTINEL}.transcript"

exit 0
