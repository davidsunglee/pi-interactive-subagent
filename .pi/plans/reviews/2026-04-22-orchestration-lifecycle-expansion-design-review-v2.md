# Plan Review — Orchestration Lifecycle Expansion v2

## Verdict

[Issues Found]

## What’s strong

- v2 directly fixes the biggest structural problems from review v1: it standardizes on a canonical `sessionKey`, adds an explicit paused-on-block branch for async serial dispatch, introduces per-task terminal hooks for widget cleanup, restores spec-aligned `blocked` notification naming, and wires `subagent_resume` back into orchestration ownership.
- The phased split is much clearer now. Phase 1 is a coherent async/rename/cancel slice, and Phase 2 layers blocked/resume behavior on top of the registry rather than scattering ownership logic across the codebase.
- The plan now contains explicit tests for the high-risk state-machine edges: blocked transitions, cancel idempotency, serial downstream pending behavior, recursive re-blocking, and real extension-boundary resume routing.

## Status of review v1 findings

### 1) `sessionId` vs `sessionPath` mismatch on the unblock key
**Status:** Addressed

v2 replaces the old `sessionId` framing with a canonical `sessionKey` and defines it as the exact value the parent uses with `subagent_resume` for pi-backed children (the session file path). That contract is carried through Task 1 (`LaunchedHandle.sessionKey`), Task 9 (`BackendResult.sessionKey`), Task 10 (`blocked` payload includes `sessionKey`), and Task 12 (`subagent_resume` uses `params.sessionPath` as the ownership lookup key).

### 2) Async serial cleanup cancelling downstream tasks after a block
**Status:** Addressed

Task 10.5 now explicitly branches on `out.blocked` and forbids the generic pending/running cancellation sweep for paused serial runs. The new serial block test in Task 10.5 also locks the required invariant that downstream steps stay `pending` until the blocked slot is resumed.

### 3) Blocked widget rows only clearing on whole-orchestration completion
**Status:** Addressed

Task 5.7 introduces the `onTaskTerminal` hook, and Task 13 uses it to clear blocked widget rows per `(orchestrationId, taskIndex)` as soon as that specific slot becomes terminal. That matches the spec’s per-task cleanup requirement.

### 4) Recursive `caller_ping` behavior only simulated, not wired through real `subagent_resume`
**Status:** Addressed

Task 12 now routes both resume outcomes through the real `subagent_resume` handler: terminal completions go to `registry.onResumeTerminal(...)`, and ping-during-resume goes back to `registry.onTaskBlocked(...)`. Task 14.2 adds the corresponding real-extension e2e for recursion through the actual resume tool path.

### 5) Public blocked notification kind drifted from `blocked` to `orchestration_blocked`
**Status:** Addressed

v2 standardizes `BLOCKED_KIND = "blocked"` in Task 3 / `notification-kinds.ts`, emits that value from the registry and extension bridge, and adds a final grep invariant in Task 15.6 to catch drift.

### 6) Real backend / extension coverage was too weak for the new lifecycle
**Status:** Partially addressed

v2 improves this materially by adding real `subagentsExtension(...)`-level tests in Tasks 8.3b, 10.7b, and 14.2. However, the plan still stops short of true pane/headless lifecycle coverage for the new async/block/resume path: most new tests inject launcher/watch seams rather than exercising backend-specific ping/sessionKey propagation end-to-end.

## Remaining findings

### 1) Error — Task 11 resumes serial continuation after **any** resumed terminal result, not only after a resumed completion
**Impacted tasks:** Task 11.2, Task 11.3

**Problem:**
The plan’s own invariants say a paused serial run should resume “when the blocked slot transitions to `completed`” (see the modified-file note for `run-serial.ts` and the self-review checklist). But Task 11.2 wires `registry.onResumeTerminal(...)` to invoke the continuation callback whenever the slot *was blocked*, and Task 11.3’s `onResumeUnblock` callback always launches the remaining serial steps.

That means a resumed task that finishes as `failed` or `cancelled` would still advance the serial pipeline. This breaks serial orchestration semantics and would let downstream tasks run after a failed blocked step.

**Why this matters:**
This is execution-blocking for Phase 2 serial runs. The continuation driver is load-bearing, and in its current form it can produce incorrect orchestration results even if the registry state machine itself is otherwise correct.

**Concrete fix:**
Gate continuation on a successful resumed result only. In practice:
- make `registry.onResumeTerminal(...)` invoke the continuation callback only when the blocked slot transitions to `state: "completed"` (or equivalent `exitCode === 0 && !error`), and
- add a regression test where a blocked serial step resumes into `failed` (and another into `cancelled`) and assert that downstream tasks remain unlaunched while aggregated completion reports the failed/cancelled slot.

### 2) Warning — The new lifecycle tests still do not exercise real pane/headless backend propagation end-to-end
**Impacted tasks:** Task 8.3b, Task 9, Task 10.7b, Task 14.2

**Problem:**
The new extension-level tests are a real improvement, but they still rely mainly on injected `LauncherDeps` / `watchSubagent` seams. That proves the registry/tool-handler bridge, but it does not prove that the actual pane and headless backends surface `ping` and `sessionKey` correctly through the real launch/watch path.

This matters because the highest-risk Phase 2 logic depends on backend-specific result shaping:
- Task 9 changes `pane.ts` and `headless.ts` to surface `ping` and `sessionKey`,
- Task 10/12 consume those exact fields to drive `blocked` transitions and resume re-ingestion,
- but the planned tests never run those backend changes end-to-end.

**Concrete fix:**
Add at least one backend-real integration per applicable path:
- one async/block test that reaches the real pane watch path, and
- one async/block test that reaches the real headless watch path.

Those tests do not need to cover every branch, but they should prove that a real backend result carrying a ping is transformed all the way into the expected orchestration `blocked` / completion behavior.

### 3) Warning — Task 15.7’s final spec cross-check points at a non-existent spec file
**Impacted tasks:** Task 15.7

**Problem:**
Task 15.7 tells the implementer to open `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design.md`, but the spec artifact in this planning run is `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md`. There is no non-versioned file in `.pi/specs/`.

**Why this matters:**
This will not break the implementation itself, but it weakens the final verification pass and can send the implementer to the wrong artifact at the point where the plan is supposed to do a spec-to-task completeness check.

**Concrete fix:**
Update Task 15.7 to reference `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md` explicitly.

## Summary

v2 is substantially better than v1 and addresses five of the six original review findings cleanly. The remaining blocker is in the serial continuation logic: the plan currently resumes downstream steps after any resumed terminal result, not just after a resumed completion. There is also still a coverage gap around exercising the real pane/headless backend propagation for the new lifecycle, and the final self-review step points at the wrong spec file.

[Issues Found]
