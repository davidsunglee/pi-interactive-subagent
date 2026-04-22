# Plan Review — Orchestration Lifecycle Expansion v8

## Summary verdict

[Issues Found]

v8 is a meaningful improvement over v7. It directly addresses the two explicit v7 findings: the pane-Claude late-binding design now includes a synchronous pre-return race-closer plus a seam-level contract test, and the plan now adds dedicated `subagent_resume({ sessionId | sessionPath })` tool-boundary coverage. The plan is also stronger on backend-real integration coverage, registry invariants, and sync-envelope consistency.

I do not think it is execution-ready yet, though. Two execution-relevant problems remain: Task 9 currently rewrites a live seam in a way that drops or obscures the existing abort/partial-update contract, and Task 12.2a's no-mux resume-boundary tests cannot actually reach the code they are supposed to verify. I also recommend tightening one implementation detail around the new Claude `sessionId` resume branch before execution begins.

## Prior review v7 findings and disposition

### 1) Pane-Claude `sessionKey` late-binding race versus fast `caller_ping`
**Disposition:** Addressed

v8 adds the missing race-closer. Task 9.5b Part B now requires two fire sites for Claude `onSessionKey`: a best-effort polling-time read and a load-bearing synchronous final read immediately before `watchSubagent` resolves. Part G also adds a seam-level contract test that explicitly pins the synchronous-before-blocked ordering. That is the concrete fix v7 was missing.

### 2) Missing tool-boundary coverage for `subagent_resume({ sessionId })`
**Disposition:** Addressed

Task 12.2a now adds dedicated boundary tests for the XOR contract (`sessionPath` vs `sessionId`), the `sessionId` terminal path, the `sessionId` ping-during-resume recursion path, and unowned fallthrough. That closes the public-API test gap called out in v7.

## Current findings

### 1) Error — Task 9 rewrites the `waitForCompletion` / `Backend.watch` seam in a way that drops the existing abort + partial-update contract
**Implicated plan areas:** Task 9.5b Part A, Task 9.5b Part D, Task 9.5b Part E

**Codebase reality checked:**
- `pi-extension/orchestration/types.ts` currently defines `LauncherDeps.waitForCompletion(handle, signal?, onUpdate?)`
- `pi-extension/subagents/backends/types.ts` currently defines `Backend.watch(handle, signal?, onUpdate?)`
- Existing behavior/tests already rely on both abort propagation and partial updates (for example `test/orchestration/headless-onupdate-replay.test.ts`, plus the abort-focused run-serial/run-parallel tests)

**Problem:**
The plan's Task 9 examples redefine `LauncherDeps.waitForCompletion` to:

```ts
waitForCompletion(handle, hooks?: { onSessionKey?: ... })
```

and then show runner call sites like:

```ts
const result = await deps.waitForCompletion(handle, {
  onSessionKey: ...,
});
```

That drops the already-live `signal` and `onUpdate` parameters from the orchestration seam. Part A is careful about not clobbering `Backend.watch`'s existing third argument if it is still used, but Part D/E do not carry that same discipline through `LauncherDeps.waitForCompletion`, and the surrounding tasks do not add any regression coverage for preserving live partials or abort behavior after the signature change.

**Why this matters:**
This is not just a stylistic inconsistency. It is a dependency/buildability issue across the plan itself:
- Task 7's cancel plumbing depends on abort still flowing through this seam.
- The current codebase already supports partial updates through this seam.
- As written, Task 9 either will not typecheck cleanly against earlier tasks, or it will silently regress existing live-update behavior.

**What to change in the plan:**
Make `onSessionKey` an additive extension of the existing contract, not a replacement for it. The plan should explicitly preserve `signal` and `onUpdate` at both the `LauncherDeps.waitForCompletion` and `Backend.watch` layers, and add/update tests that pin that preservation.

### 2) Error — Task 12.2a's “no mux required” resume-boundary tests are not reachable with the current handler shape
**Implicated plan areas:** Task 12.2a, Task 7b

**Codebase reality checked:**
`pi-extension/subagents/index.ts` currently enters `subagent_resume.execute` by checking `isMuxAvailable()` and returning `muxUnavailableResult()` before the watcher/registry routing logic runs.

**Problem:**
Task 12.2a explicitly says the new `resume-tool-boundary.test.ts` should:
- exercise the real registered `subagent_resume` tool,
- use `__test__.setWatchSubagentOverride(...)`,
- and **not** require `pi` or a mux backend.

But the only new seams introduced earlier in the plan are:
- launcher-deps override,
- watchSubagent override,
- registry access/reset.

There is no seam or setup step that bypasses the existing `isMuxAvailable()` gate. On a no-mux machine, cases 3–6 in Task 12.2a never reach the overridden watcher or the registry assertions; they exit early with the mux-unavailable result.

**Why this matters:**
This makes a named verification step in the plan impossible as written. It is an execution-blocking test-plan defect, not just a wording nit.

**What to change in the plan:**
Either:
- add an explicit test seam / environment setup for mux availability in `subagent_resume`, or
- restate Task 12.2a as mux-required coverage and move the no-mux claim out of the plan.

### 3) Warning — The new Claude `sessionId` resume path still needs a more concrete implementation recipe
**Implicated plan areas:** Task 12.2, Task 14.2

**Codebase reality checked:**
The current `subagent_resume` implementation is pi-session-path-specific, while the Claude pane path today is driven through Claude-specific launch/watch state (`cli: "claude"`, sentinel/plugin setup, transcript-pointer/session-id handling inside `watchSubagent`).

**Problem:**
Task 12.2 says the new `sessionId` branch should "open a mux pane running `claude --resume <sessionId>`" and reuse the existing mux-pane plumbing, but it does not spell out how that branch becomes a Claude-shaped running subagent that the existing watcher can actually observe correctly. In particular, the plan does not explicitly cover the Claude-specific launch/watch ingredients that the current codebase relies on for completion and ping handling.

I think an implementer can infer a path here, so I am not elevating this to an error. But for a new public API path, the plan is thinner than the rest of v8.

**Why this matters:**
This is exactly the kind of branch that can "compile" while still being wrong operationally, especially for recursive ping-during-resume behavior.

**What to change in the plan:**
Add one concrete implementation step that explains how the `sessionId` branch is launched and watched as a Claude resume in the existing architecture, and preferably add one non-seamed test that hits the actual `sessionId` branch rather than only the watcher override path.

## Strengths

- v8 clearly and directly addresses both explicit v7 findings.
- The Task 9.5b race-closer is much more convincing than the v7 polling-only design.
- Task 2.7 plus the self-review invariants now make the sync shared-envelope contract much clearer.
- The plan's backend-real coverage is materially stronger than earlier versions, especially with the added Phase 1 pane/headless async tests and Phase 2 pane/headless blocked-path tests.
- The registry invariants around blocked-state cleanup, serial continuation gating, and failed/cancelled resume handling are significantly sharper now.

## Recommended next steps

1. Fix Task 9's seam definitions so `onSessionKey` is additive and existing abort/partial-update behavior is explicitly preserved.
2. Make Task 12.2a executable by adding a mux-availability seam or by changing the test's stated environment requirements.
3. Tighten the concrete implementation instructions for the new Claude `sessionId` resume branch before execution starts.

[Issues Found]
