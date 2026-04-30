# Plan Review — Orchestration Lifecycle Expansion v4

## Summary verdict

[Issues Found]

v4 is a meaningful improvement over v3. It directly addresses the two concrete buildability problems from the previous review by adding a dedicated resumable-ping fixture in Step 14.2a and by rewriting the headless backend-real coverage around the current runtime controls in Step 14.2c (`PI_SUBAGENT_MODE`, mux-aware skip semantics, and the existing headless test harness pattern). It also makes the extension-level test seams explicit in Task 7b instead of leaving later tests to invent them ad hoc.

I re-checked the rename concern against the repository and agree it should not be called a blocking error in this review. The remaining material issue is narrower: the serial failed/cancelled-resume path still states the desired behavior without assigning a concrete implementation step that will make the orchestration actually finalize.

## Addressed previous findings

1. **`sessionId` vs `sessionPath` mismatch on the unblock key**  
   **Status:** Addressed  
   v4 continues to use the `sessionKey` contract consistently and explicitly ties the pi-backed key to the same value `subagent_resume({ sessionPath })` accepts. This appears in the plan's key decisions, Task 1 (types), Task 9 (backend propagation), and Task 12 (resume re-ingestion wiring).

2. **Async serial cleanup cancelling downstream tasks after a block**  
   **Status:** Addressed  
   Task 10.5 now explicitly guards the serial async path with `if (out.blocked) return;` before any cancellation sweep runs, and Task 11 adds the continuation driver for the resumed-success path. The plan also adds a dedicated regression test in Task 10.5 to prove downstream steps remain `pending` until resume completes.

3. **Blocked widget rows only clearing on whole-orchestration completion**  
   **Status:** Addressed  
   Task 13 keeps the per-task `onTaskTerminal` hook and wires it to `(orchestrationId, taskIndex)`-keyed virtual rows so blocked rows clear on each task terminal transition, not only on overall orchestration completion.

4. **Recursive `caller_ping` behavior only simulated, not wired through real `subagent_resume`**  
   **Status:** Addressed  
   Task 7b adds the explicit `watchSubagent` seam, Task 12 routes both terminal resumes and ping-during-resume through the real `subagent_resume` handler into the registry, and Task 14.2 requires exercising both recursion and terminal completion through the registered tool path.

5. **Public blocked notification kind drifted from `blocked` to `orchestration_blocked`**  
   **Status:** Addressed  
   v4 retains `BLOCKED_KIND = "blocked"`, uses that value in registry emissions and extension sendMessage wiring, and preserves the explicit final grep invariant in Task 15.6.

6. **Real backend / extension coverage was too weak for the new lifecycle**  
   **Status:** Addressed  
   v4 closes the gaps identified in v3 review: Task 7b defines the extension seams explicitly, Step 14.2a adds the missing resumable fixture, Step 14.2b adds pane backend-real coverage, and Step 14.2c now matches the current headless runtime/testing constraints instead of assuming a non-existent backend selector and harness mode.

## Remaining findings

### 1) Error — The failed/cancelled resume path still lacks a concrete implementation step that finalizes the serial orchestration
**Implicated plan areas:** Task 11.2, Task 11.3, Task 11.5b  
**Spec basis:** The plan's own invariants require that a resumed serial slot only advances on `state === "completed"`, and that failed/cancelled resumes produce aggregated completion with untouched downstream tasks surfaced as `cancelled`.

**Problem:**  
v4 adds the right tests for this invariant in Step 11.5b, but the implementation path is still incomplete.

- Step 11.2 updates `registry.onResumeTerminal(...)` so continuation only runs for `state === "completed"`.
- Step 11.3 adds `continueSerialFromIndex(...)`, but that callback is only invoked on successful resume.
- For the non-success path, Step 11.2 only states that the pending tail should be collapsed to `cancelled` via an "extend that sweep path" instruction, but it does not assign an actual code change showing **where** that sweep lives, **who** triggers it, or **how** aggregated completion is emitted once no runnable work remains.

As written, a serial orchestration that blocks on step N and then resumes into `failed` or `cancelled` has no concrete planned mechanism that turns steps N+1..end from `pending` into `cancelled` and finalizes the orchestration. The tests in Step 11.5b expect that behavior, but the implementation steps do not yet make it buildable.

**Why this matters:**  
This is one of the core lifecycle invariants in the plan's self-review section. Leaving it implicit risks an execution dead-end where the orchestration remains stuck with a failed resumed slot and a pending tail that never transitions, so the final aggregated completion never fires.

**What to change in the plan:**  
Add an explicit implementation step for the non-success resume branch. For example:
- either make `registry.onResumeTerminal(...)` detect `wasBlocked && state !== "completed"` for serial runs and synchronously collapse all downstream `pending` slots to `cancelled` before calling `tryFinalize`,
- or add a dedicated failure/cancel callback from the registry back to the tool-handler layer that performs that sweep there.

Whichever design is chosen, the plan should name the file(s) to edit and the exact control flow that satisfies Step 11.5b.

## Strengths

- The plan now explicitly validates every prior v3 finding instead of implicitly superseding them.
- The new `test-ping-resumable` fixture in Step 14.2a fixes the biggest backend-real test blocker from v3.
- Task 7b is a real improvement in plan quality: it turns formerly implicit extension-test plumbing into a named, reusable contract.
- Task 14.2c now matches the current environment model and no longer assumes unsupported headless test controls.
- The self-review invariants are strong and correctly target the risky lifecycle edges.

## Recommended next steps

1. Add one explicit implementation step for the serial failed/cancelled-resume finalization path, not just tests and intent text.
2. Re-run review after that gap is resolved; the rest of the plan looks structurally sound.

[Issues Found]
