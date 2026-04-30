# Plan Review — Orchestration Lifecycle Expansion v7

## Summary verdict

[Issues Found]

v7 is materially stronger than v6. It closes the prior sync-envelope/index gap, fixes the earlier `sessionKey` typing/ordering problem by moving those fields earlier in the plan, and adds concrete Phase 1 backend-real async/cancel coverage plus a much more explicit Claude late-binding design. However, I do not think it is execution-ready yet. One execution-relevant issue remains: the pane-Claude `sessionKey` late-binding design is still race-prone against fast `caller_ping` exits. I also recommend tightening one public-API test gap before execution starts.

## Prior review v6 findings and disposition

### 1) Claude-backed `sessionKey` / resume-awareness plumbing gap
**Disposition:** Partially addressed

v7 meaningfully improves this area. It adds a concrete `Backend.watch(..., onSessionKey)` seam (Task 9.5b Part A), threads that callback through `LauncherDeps.waitForCompletion` and the runners into `registry.updateSessionKey` (Parts D–F), and adds a seam-level contract test (`test/orchestration/backend-seam.test.ts`, Part G). That is a real correction to the v6 concern.

However, the pane-Claude implementation in Task 9.5b Part B still relies on `watchSubagent` discovering the `.transcript` pointer from `pollForExit`'s `onTick`, which the plan itself describes as a 1000ms polling loop. That does not guarantee ownership-map population before a fast `caller_ping` result can arrive. So the old finding is improved but not fully resolved; see Current finding 1.

### 2) Sync `wait:true` results missing the shared-envelope `index`
**Disposition:** Addressed

Task 2.7 now explicitly maps sync tool returns to the public `OrchestratedTaskResult[]` envelope and includes `index` on every result. The self-review checklist also now names this invariant directly.

### 3) Task-ordering/typecheck break from using `result.sessionKey` before typing it
**Disposition:** Addressed

Task 1.3 now adds `state`, `index`, `sessionKey`, and `ping` to `OrchestrationResult` up front, so Task 5's async-dispatch work no longer depends on Task 9 landing first.

## Current findings

### 1) Error — Pane-Claude `sessionKey` late-binding is still race-prone versus a fast `caller_ping`
**Implicated plan areas:** Task 9.5b Part B, architecture item 4, self-review invariant on Claude late-binding

**Spec basis:** The blocked notification and resume-routing contract depend on the orchestration ownership map being populated with the same canonical `sessionKey` the parent will later pass to `subagent_resume`. For Claude-backed children, that key must be known in time for blocked-state routing.

**Problem:**
The new pane-Claude mechanism is concrete, but it is not actually timing-safe as written. Task 9.5b Part B says pane Claude fires `onSessionKey` from `watchSubagent`'s `pollForExit.onTick` the first time the `.transcript` pointer file appears, and the same section describes that polling loop as running every 1000ms. A Claude child can plausibly hit `caller_ping` well before the next poll tick.

That leaves a race:
1. Claude session id becomes available.
2. Child quickly exits via `caller_ping`.
3. `BackendResult.ping` arrives and blocked routing runs.
4. The 1000ms polling callback has not yet fired, so `registry.updateSessionKey(...)` has not populated ownership.

In that case, the plan's own invariants are violated: the blocked event is not guaranteed to carry the canonical Claude `sessionKey`, and `subagent_resume({ sessionId })` cannot reliably route back into the owning orchestration.

**Why this matters:**
This is the load-bearing Phase 2 guarantee for pane-backed Claude children. The plan now has a seam, but it still has a hidden timing assumption that can break blocked/resume behavior.

**What to change in the plan:**
Either replace the polling-based pane-Claude discovery with a callback that fires immediately when the session id becomes known, or explicitly narrow scope before execution. As written, the plan over-claims correctness for pane-Claude blocked routing.

### 2) Warning — The new `subagent_resume({ sessionId })` public API path is not directly tested at the tool boundary
**Implicated plan areas:** Task 12.2, Task 14.2, self-review invariant on `sessionPath` XOR `sessionId`

**Problem:**
Task 12.2 adds a meaningful public API change: `subagent_resume` now accepts exactly one of `sessionPath` or `sessionId`, and both should funnel through the same ownership lookup. But the listed tests do not directly verify that tool-level contract. The Claude coverage in Task 12.1 is registry-level only, and the real resume-routing tests in Task 14.2 are described around the existing session-path-driven flow.

I do not see a concrete test that asserts:
- `subagent_resume({ sessionId, ... })` is accepted and routed correctly, or
- passing both/neither is rejected as specified.

**Why this matters:**
This is a public API boundary, and it is easy to regress even if the registry internals are correct. Missing this coverage is not necessarily execution-blocking, but it weakens confidence in one of the spec's new external contracts.

**What to change in the plan:**
Add an explicit tool-level test for the `sessionId` path and for the XOR validation (`sessionPath` vs `sessionId`).

## Strengths

- v7 clearly responds to the major v6 issues instead of hand-waving them away.
- Task 2.7 is a meaningful fix: it makes the sync path actually honor the shared public result envelope.
- Moving `sessionKey`/`ping`/`index` typing into Task 1.3 materially improves dependency ordering and buildability.
- Task 8b and Tasks 14.2b/14.2c give the plan much better backend-real coverage than prior versions.
- The self-review checklist is substantially sharper and now captures many of the tricky lifecycle invariants explicitly.

## Recommended next steps

1. Fix or narrow the pane-Claude late-binding design so ownership registration is guaranteed before blocked routing, rather than relying on a 1000ms polling race.
2. Add tool-boundary tests for `subagent_resume({ sessionId })` and the `sessionPath`/`sessionId` mutual-exclusion contract.

## Reviewer note for future reviews

Do **not** flag missing migration of non-TypeScript call sites for `subagent_serial` / `subagent_parallel` in this repo. Per user clarification, these orchestration tools are only invoked from TypeScript here, so absence of separate skill/markdown/bundled-agent migration steps is not itself a plan defect.

[Issues Found]
