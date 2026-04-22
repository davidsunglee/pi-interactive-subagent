# Plan Review — Orchestration Lifecycle Expansion

## Verdict

[Issues Found]

## What’s strong

- The plan is generally well-structured and maps most of the spec into concrete phases and task-sized steps.
- The lifecycle vocabulary (`pending | running | blocked | completed | failed | cancelled`) is introduced early and then threaded through tests, tool handlers, registry work, and docs, which is the right structural shape for this feature.
- The registry seam is a good design choice for async orchestration and cancellation. Keeping orchestration state out of the backends should make Phase 1 easier to land safely.
- The plan does a good job protecting existing sync behavior with explicit regression tests, especially around aborts and ping compatibility.
- The breaking rename is handled explicitly rather than implicitly, which is important for execution clarity.

## Issues

### 1) Error — Phase 2’s blocked/resume path is keyed to `sessionId`, but the real resume surface is `sessionPath`, and the default pi backend does not expose a usable `sessionId`

**Impacted tasks:** Task 9, Task 10, Task 12

**Problem:**
The plan’s Phase 2 orchestration flow is written around `sessionId` ownership and blocked notifications carrying `sessionId`, but the current production resume tool is `subagent_resume({ sessionPath })`, not a session-id-based API (`pi-extension/subagents/index.ts`, `subagent_resume` registration). On top of that, the current pane/pi path returns `sessionFile` for pi children and only uses `claudeSessionId` for Claude (`pi-extension/subagents/index.ts`, `watchSubagent`; `pi-extension/subagents/backends/pane.ts`). Task 10’s async blocked branch specifically gates on `result.sessionId`, which the default pi backend does not provide.

That means the plan, as written, does not actually define a buildable unblock key for the main pi path. A blocked async pi child cannot reliably surface the identifier the caller needs to invoke `subagent_resume`, and the registry cannot consistently look the resumed child back up.

**Why this matters:**
This is not just a naming nit; it breaks the core Phase 2 user flow. The spec requires a blocked task to be resumable through the existing standalone resume tool. As written, the plan leaves the default backend without a consistent resume identifier.

**Concrete fix:**
Pick one canonical ownership/resume key and use it end-to-end in the plan. Given the current codebase, the lowest-risk option is:
- make blocked notifications include `sessionPath`/`sessionFile` for pi-backed children,
- key the ownership map on that same value for pi paths,
- either extend `BackendResult` to carry that value directly or route it from the launch handle into the blocked transition,
- only use Claude session ids where the actual resume surface can consume them.

If the intended public API is truly `sessionId`, then the plan must also add the corresponding `subagent_resume` surface change and migration steps instead of assuming the current `sessionPath` tool continues to work.

### 2) Error — Task 10’s fallback sweep cancels future serial tasks immediately after a block, which prevents Task 11’s continuation model from working

**Impacted tasks:** Task 10, Task 11

**Problem:**
Task 10 changes async serial execution so a pinging child returns early with `blocked: true`, but the same task also keeps the async-dispatch fallback sweep that converts any remaining `pending`/`running` slots to `cancelled`. In a serial orchestration, all later tasks are still `pending` when step N blocks. So the fallback will cancel steps N+1..end immediately.

That directly contradicts Task 11’s continuation design, which expects those later steps to remain launchable after `onResumeTerminal(...)` fires.

**Why this matters:**
This is an execution blocker, not just an ambiguity. With the plan as written, a serial orchestration that blocks will likely either:
- finalize early with later tasks already marked `cancelled`, or
- be unable to continue correctly after resume because the downstream slots are already terminal.

**Concrete fix:**
The plan needs an explicit “paused due to block” outcome for the async runner path. When `runSerial()` returns because of a block, the dispatcher must **not** perform the generic “mark pending/running as cancelled” cleanup. That cleanup should run only for true terminal exits (success/failure/cancel), not for a paused serial orchestration awaiting resume.

### 3) Error — The widget cleanup plan leaves stale blocked rows until whole-orchestration completion, but the spec requires clearing on each task’s terminal transition

**Impacted tasks:** Task 13

**Problem:**
Task 13 adds virtual blocked widget entries and removes them only inside the `orchestration_complete` handler. But the spec’s widget section says blocked rows should be “cleared on transition to any terminal state,” not only when the full orchestration finishes.

This matters especially for serial runs: after a blocked task is resumed and completes, the orchestration may continue with later steps. Under the current plan, the blocked row would remain visible while the next serial steps are already running.

**Why this matters:**
That produces incorrect UI state for the central human-in-the-loop feature the spec is adding.

**Concrete fix:**
Add a per-task terminal notification/cleanup path in the registry or widget bridge so a blocked row is removed as soon as that specific `(orchestrationId, taskIndex)` slot reaches `completed | failed | cancelled`, even if the rest of the orchestration is still running.

### 4) Error — The production resume path never re-surfaces a second `caller_ping`, so the spec’s recursion behavior is not actually implemented

**Impacted tasks:** Task 11, Task 12, Task 14

**Problem:**
The plan claims recursive `blocked → running → blocked` support, but Task 11’s recursion test explicitly sidesteps the real runtime path by calling `registry.onTaskBlocked(...)` directly. Task 12 only wires `subagent_resume` completion back into `registry.onResumeTerminal(...)`; it does **not** add the corresponding production hook for “resumed child pinged again.”

So in the actual system path, a resumed child that pings again would still go through the existing `subagent_resume` ping handling and emit a standalone `subagent_ping`, but the owning orchestration would not be re-blocked structurally.

**Why this matters:**
Recursive re-blocking is explicitly in the spec. The plan currently tests the registry primitive, not the real resume-to-registry integration that would make recursion work for users.

**Concrete fix:**
Extend the Task 12 runtime wiring so `subagent_resume` forwards both outcomes into orchestration ownership handling:
- terminal completion → `onResumeTerminal(...)`
- ping/block during resume → `onTaskBlocked(...)` (or an equivalent resume-specific blocked hook)

Then replace the simulated recursion test with one that exercises the real `subagent_resume` path.

### 5) Error — The plan changes the public blocked notification kind from the spec’s `blocked` to `orchestration_blocked`

**Impacted tasks:** Task 3, Task 5, Task 14

**Problem:**
The spec’s public API summary defines the Phase 2 blocked steer-back kind as `blocked`. The plan instead standardizes on `orchestration_blocked` in `notification-kinds.ts`, in registry emissions, and in the renderer wiring.

**Why this matters:**
This is a public API drift from the approved spec. Any downstream caller or documentation written against the spec would observe a different event kind.

**Concrete fix:**
Either:
- align the plan to the spec and use `blocked`, or
- explicitly amend the spec/API section and every related acceptance/test/docs step to the renamed event kind before execution.

### 6) Warning — The test strategy is weaker than the spec on real backend coverage for the new async/block/resume lifecycle

**Impacted tasks:** Task 8, Task 10, Task 12, Task 14

**Problem:**
Most of the new “integration” coverage is still registry-level or `registerOrchestrationTools(...)`-level with mocked `LauncherDeps`. That is useful, but it does not fully exercise the real `subagentsExtension(...)` wiring, the real `pi.sendMessage(..., { deliverAs: "steer" })` bridge, or the actual pane/headless backend ping propagation for the new orchestration lifecycle.

The spec explicitly calls for both backends to be exercised where applicable.

**Why this matters:**
The riskiest parts of this feature are exactly the boundaries between backend result shapes, registry transitions, resume handling, and steer-back delivery. Those are the areas most likely to break even if mocked registry tests are green.

**Concrete fix:**
Add at least one real extension-level integration test per major new behavior:
- async completion delivery through `subagentsExtension(...)`,
- blocked notification delivery through the real backend/watch path,
- resume re-ingestion through the real `subagent_resume` registration.

At minimum, the block/resume e2e test should go through the actual extension entrypoint instead of manually invoking `registry.onResumeTerminal(...)`.

## Summary

The plan is close to execution-ready in Phase 1, and the overall architecture is solid. The main problems are concentrated in Phase 2: the ownership/resume key is inconsistent with the actual resume tool surface, the serial blocked-path cleanup would cancel future work too early, blocked widget rows do not clear at the right time, and the recursion story is only simulated in tests rather than wired through the real `subagent_resume` path. Those issues should be fixed before execution.
