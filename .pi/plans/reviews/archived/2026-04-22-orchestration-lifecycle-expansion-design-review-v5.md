# Plan Review — Orchestration Lifecycle Expansion v5

## Summary verdict

[Issues Found]

v5 is materially stronger than v4. It closes the prior blocking gap on serial failed/cancelled resume finalization, keeps the blocked-kind/sessionKey contract much tighter, and adds substantially better real-extension/backend-real coverage around blocked/resume behavior. However, I still see two spec-coverage errors and one sequencing warning before I would call the plan execution-ready.

## Prior v4 findings and disposition in v5

1. **`sessionId` vs `sessionPath` mismatch on the unblock key**  
   **Disposition:** Addressed  
   v5 consistently uses `sessionKey` as the cross-surface identifier, explicitly ties the pi-backed value to the same string `subagent_resume({ sessionPath })` accepts, and threads that contract through the type work, registry, backend propagation, blocked payloads, and resume-routing tasks.

2. **Async serial cleanup cancelling downstream tasks after a block**  
   **Disposition:** Addressed  
   Task 10.5 now explicitly preserves downstream serial tasks as `pending` when a run pauses on `blocked`, and the self-review invariants keep that behavior load-bearing.

3. **Blocked widget rows only clearing on whole-orchestration completion**  
   **Disposition:** Addressed  
   Task 13 still uses the per-task terminal hook keyed on `(orchestrationId, taskIndex)` so blocked rows clear on each slot's terminal transition, not only on final orchestration completion.

4. **Recursive `caller_ping` behavior only simulated, not wired through real `subagent_resume`**  
   **Disposition:** Addressed  
   Task 7b provides the extension-level seams, Task 12 routes ping-during-resume and terminal resume through the real `subagent_resume` handler, and Task 14 assigns real-extension recursion coverage.

5. **Public blocked notification kind drifted from `blocked` to `orchestration_blocked`**  
   **Disposition:** Addressed  
   v5 keeps `BLOCKED_KIND = "blocked"`, uses that value across emission sites, and preserves the final grep invariant in Task 15.

6. **Real backend / extension coverage was too weak for the new lifecycle**  
   **Disposition:** Addressed for the specific v4 concern  
   v5 keeps the explicit extension seams from Task 7b and adds concrete real-extension/backend-real Phase 2 coverage in Tasks 10.7b and 14.2b/14.2c. I do have a separate new finding below about missing **Phase 1** backend-real async coverage, but the narrower v4 concern about the blocked/resume lifecycle no longer stands.

7. **The failed/cancelled resume path lacked a concrete implementation step that finalizes the serial orchestration**  
   **Disposition:** Addressed  
   This was the one remaining v4 blocker, and v5 fixes it directly. The self-review invariants now require synchronous downstream-tail collapse on non-successful serial resumes, and Task 11.2/11.5b assign both the implementation and regression coverage for `failed` and `cancelled` resume outcomes.

## New findings

### 1) Error — The plan explicitly narrows resume-awareness to pi-backed/session-file-keyed children, but the spec defines the ownership/sessionKey contract for Claude-backed children too
**Implicated plan areas:** Key decisions and invariants (`Claude-session-id-keyed re-ingestion is a documented v1 gap`), Task 9.5, Task 14.3  
**Spec basis:** The spec's shared result envelope and session-ownership-map sections define `sessionKey` for both backends: pi-backed children use the session file path, Claude-backed children use the Claude session id. The same sections say the ownership map is populated at launch and is load-bearing for blocked routing and resume re-ingestion.

**Problem:**  
v5 does not just defer an implementation detail here; it explicitly narrows scope. The plan says Claude-session-id-keyed re-ingestion is a documented v1 gap, tells Task 9.5 to leave Claude headless `sessionKey` unset at launch time, and repeats the limitation in the docs task. That means the Phase 2 ownership/resume model is only fully implemented for pi-backed children, while the spec describes a cross-backend `sessionKey` contract.

**Why this matters:**  
This is a spec-coverage gap, not just a testing preference. As written, a meaningful slice of the spec's resume-awareness model is unassigned and untested.

**What to change in the plan:**  
Either:
- add concrete implementation + test work for Claude session-id ownership/routing, or
- revise the governing spec before execution starts so the narrower pi-only support is explicitly approved.

### 2) Error — Phase 1 still has no backend-real `wait:false` coverage for pane and headless async orchestration/cancel paths
**Implicated plan areas:** Tasks 6–8, Task 15.7  
**Spec basis:** The spec's Phase 1 testing strategy explicitly says both backends should be exercised where applicable.

**Problem:**  
Task 8's new async tests are registry/tool-handler tests with fake or injected `LauncherDeps`, plus a real-extension wiring test that still overrides the launch/wait layer. Task 4 only renames an existing **sync** headless orchestration integration test. The first backend-real pane/headless tests do not appear until Task 14, and those cover Phase 2 blocked/resume behavior rather than the new Phase 1 async dispatch/cancel path itself.

So the plan never assigns a concrete pane-real or headless-real test proving that:
- `subagent_run_serial({ wait: false })` / `subagent_run_parallel({ wait: false })` work through the actual backend stack, and
- `subagent_run_cancel` really aborts/cleans up correctly through those same real backends.

**Why this matters:**  
Phase 1's new behavior is precisely where backend differences can hide: background watcher lifetime, cancellation propagation, and async completion delivery. The spec asked for both backends to be exercised, but the plan leaves that to a generic final regression pass rather than giving it concrete, buildable tasks.

**What to change in the plan:**  
Add explicit pane-real and headless-real Phase 1 async/cancel tests, or repurpose named existing real-backend integration files to cover `wait:false` before Phase 2 begins.

### 3) Warning — Task 10.7b asks for a widget assertion before the widget blocked-row machinery exists
**Implicated plan areas:** Task 10.7b, Task 13.4

**Problem:**  
Step 10.7b says the real-extension blocked test should also assert that the widget has a virtual blocked row via the `__test__` surface. But Task 13 is where the plan actually introduces the virtual blocked-row map, the `(orchestrationId, taskIndex)` keying, and the related cleanup hook. As written, Task 10 depends on code and test surface that are only added later.

**Why this matters:**  
This is a sequencing/dependency mistake. A worker following the plan literally in order would hit a failing assertion that depends on future work.

**What to change in the plan:**  
Move that widget assertion to Task 13, or explicitly mark it deferred until Task 13 lands.

## Strengths

- The prior v4 blocker on serial non-successful resume finalization is now concretely fixed in the plan.
- The self-review invariants are strong and focus on the real lifecycle-risk edges.
- Task 7b remains a significant structural improvement; it keeps later real-extension tests from inventing ad-hoc seams.
- The new backend-real pane/headless blocked tests in Task 14 materially improve confidence in the Phase 2 lifecycle path.

## Recommended next steps

1. Resolve the Claude-backed `sessionKey` / resume-awareness scope mismatch before execution starts.
2. Add concrete Phase 1 backend-real async/cancel coverage for both pane and headless paths.
3. Reorder or defer the Task 10 widget assertion so task dependencies are accurate.

[Issues Found]
