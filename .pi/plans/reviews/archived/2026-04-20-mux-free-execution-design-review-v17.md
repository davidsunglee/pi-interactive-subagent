# Plan review: `2026-04-20-mux-free-execution-design-v13.md`

## Verdict

[Issues Found]

## What is strong

- The compression is mostly successful: v13 is materially easier to scan than earlier revisions while still preserving the important design constraints.
- The plan still covers the spec's three no-mux entrypoints: `subagent`, `subagent_serial`, and `subagent_parallel`.
- The previously important invariants are still present in the plan text:
  - bare-`subagent` headless lifecycle must remain tracked by shutdown/reload cleanup,
  - Task 26 keeps the no-loss `onUpdate` invariant with explicit buffer/replay direction,
  - the Claude identity/task-body contract is preserved (`spec.identity` via flags, `spec.claudeTaskBody` as task body),
  - pane and headless Claude share a single `PI_TO_CLAUDE_TOOLS` source of truth,
  - Claude transcript handling still keys off `sessionId` rather than slug reconstruction.
- The Claude transcript/tool-use coverage is now stronger and properly includes `toolResult` handling, which resolves an earlier gap.

## Findings

### Error — Task 23b still does not contain the promised shutdown/reload assertion for bare `subagent`

**Plan locations:**
- Task 7b Step 4b lifecycle requirement
- Task 23b intro paragraph
- Task 23b Step 1 test body

**Problem:** The plan text says Task 23b must include a shutdown-path assertion for the bare `subagent` headless path, but the actual test content only verifies successful launch/completion in forced-headless and auto+no-mux cases. It never emits `session_shutdown` or exercises reload cleanup, and it never asserts that a tracked headless bare-subagent is aborted/cleaned up instead of outliving the parent session.

**Why this matters:** This was one of the key regression guards called out by prior review. Task 7b correctly states the lifecycle invariant, but v13's execution-level test no longer enforces it. As written, the plan could be executed and still pass Task 23b even if the headless bare-`subagent` path regressed back into effectively untracked fire-and-forget behavior.

**Actionable fix direction:** Add an explicit Task 23b case that starts a long-running bare `subagent`, triggers the registered `session_shutdown` handler (and/or reload cleanup path), and asserts the headless run is aborted/cleaned up with no orphaned background completion after shutdown.

## Execution readability note

Compression mostly helped. The main place where it went too far is Task 23b: the narrative retained the shutdown-path requirement, but the concrete test block no longer implements it. That should be restored before execution.

## Overall assessment

v13 is close. The important architectural and contract-level fixes from prior reviews remain intact, and the document is easier to execute than earlier versions. But the plan is not fully review-clean yet because the Task 23b regression guard for the bare-`subagent` shutdown/reload lifecycle is still only described, not actually planned as a test.
