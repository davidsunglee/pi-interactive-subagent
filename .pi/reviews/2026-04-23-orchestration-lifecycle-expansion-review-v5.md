# Production Readiness Review — Orchestration Lifecycle Expansion

**Review date:** 2026-04-23  
**Range reviewed:** `b88d10..1460ec`  
**Primary spec:** `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md`

## Scope and method

Reviewed the full diff in a detached worktree at `1460ec`, with the spec above as the requirements source. I read the orchestration/runtime changes directly, including the new registry, tool handlers, backend seams, resume path, widget integration, README updates, and the new orchestration-focused tests.

## Verification

I ran:

- `npm run typecheck`
- `npm test`
- `node --test test/integration/orchestration-async.test.ts test/integration/orchestration-block-resume-e2e.test.ts test/integration/orchestration-extension-async.test.ts test/integration/orchestration-extension-blocked.test.ts test/integration/orchestration-extension-resume-routing.test.ts`
- `node --test test/integration/orchestration-headless-no-mux.test.ts`

All of the above passed.

## What looks good

- The async registry split is cleanly factored. `registry.ts` keeps orchestration lifecycle state, ownership routing, and cancellation concerns separate from the serial/parallel runners.
- The `wait: false` path is implemented end-to-end rather than as a thin mock: immediate manifest return, steer-back completion, blocked notifications, cancellation, and resume re-ingestion all have both unit and integration coverage.
- The blocked widget-row handling is thoughtful. Keeping blocked rows alive after pane close, then clearing them on resume-start or terminal transition, matches the intended UX well.
- The code is well tested overall. The new orchestration suite covers a lot of edge cases: concurrency, cancellation, recursion, backend seams, resume routing, and headless/no-mux behavior.

## Findings

### 1. Medium — headless blocked/resume runs leave `usage`/`transcript` frozen at the pre-block snapshot instead of extending them cumulatively

**References:** `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md:109-115`, `pi-extension/subagents/index.ts:1847-1860`, `pi-extension/orchestration/registry.ts:243-248`

The spec explicitly says that when a task moves `blocked -> running` via resume, `usage` and `transcript` should extend cumulatively. That is not what the current resume re-ingestion path does.

When `subagent_resume` feeds a terminal result back into the owning orchestration, it only sends `finalMessage`, `transcriptPath`, `elapsedMs`, `exitCode`, `sessionKey`, and `error` into `registry.onResumeTerminal(...)`. `usage` and `transcript` are omitted entirely. Because `registry.onTaskTerminal(...)` merges the resumed result over the existing blocked snapshot, the slot keeps whatever `usage`/`transcript` it had at block time.

That means a headless task that blocks, resumes, and then does more work will report a final `finalMessage` from the resumed execution but stale `usage`/`transcript` from before the block. This is a real contract violation and produces misleading final telemetry/debug data.

**Recommended fix:** either:
- make resume re-ingestion accumulate the resumed leg's `usage`/`transcript` into the stored snapshot, or
- if that is not implementable with the current pane-only resume path, explicitly clear those fields on resumed completion and update the spec/docs to say cumulative `usage`/`transcript` is not guaranteed across resume in v1.

Keeping the stale pre-resume snapshot is the worst of the available options because it looks authoritative while being incomplete.

### 2. Minor — `OrchestratedTaskResult` should drop the redundant `sessionId` field and keep only `sessionKey`

**References:** `pi-extension/orchestration/types.ts:70-85`, `pi-extension/orchestration/tool-handlers.ts:406-420`, `README.md:89-90`

The lifecycle API already has the right abstraction: `sessionKey` is the resume-addressable identifier for both backends. Keeping `sessionId` alongside it in `OrchestratedTaskResult` just re-introduces the backend-specific split that the spec was trying to remove.

In practice, `sessionId` is just a Claude-only duplicate of `sessionKey`, and the code/comments/tests justify it solely as an additive backward-compatibility concession. Per the review instructions for this change, that compatibility requirement was unnecessary here. That was prior reviewer guidance, not an implementor mistake.

Because this fork does not need to preserve that old field, the public orchestration result should be tightened now:

- remove `sessionId` from `OrchestratedTaskResult`
- stop copying it through `toPublicResults(...)`
- delete the README/docs language that tells consumers to prefer `sessionKey` while still emitting `sessionId`

This is not a correctness blocker, but it is the right API-shape cleanup to make before more callers depend on both fields.

## Spec compliance notes

- The diff intentionally narrows initial-run `caller_ping`/`blocked` behavior to pi-backed children only, and the spec was updated to match that (`.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md:30-36,244-246`; `pi-extension/subagents/backends/headless.ts:529-536`; `pi-extension/subagents/plugin/hooks/on-stop.sh:5-13`). Given the current Claude CLI constraints, that spec change looks justified to me; I am not flagging it as a defect.
- Aside from the findings above, the implementation generally matches the revised spec well: async dispatch, registry ownership, blocked notifications, resume re-ingestion, cancellation semantics, tool renames, and widget behavior are all present and well covered by tests.

## Assessment

**Ready to merge: With fixes**

The core orchestration lifecycle work is strong and the overall architecture looks production-ready. I would address the stale `usage`/`transcript` behavior before merging, and I would also take the opportunity to remove the redundant `sessionId` field from the public orchestration result shape while this API is still settling.
