# Plan Review — Orchestration Lifecycle Expansion v6

## Summary verdict

[Issues Found]

v6 is materially stronger than v5. It closes the prior gaps on explicit Phase 1 backend-real async/cancel coverage, removes the prior pi-only scope narrowing for Claude-backed resume awareness, and fixes the widget-assertion sequencing issue by deferring widget assertions until the widget machinery exists. However, I still see two execution-blocking issues and one sequencing warning before I would call the plan execution-ready.

## Prior v5 findings and disposition in v6

1. **Claude-backed `sessionKey` / resume-awareness scope mismatch**  
   **Disposition:** Addressed at the scope/planning level, but with a new concrete plumbing gap  
   v6 no longer documents Claude-backed re-ingestion as a v1 gap. It adds `updateSessionKey`, late-binding from Claude `system/init`, and `subagent_resume({ sessionId })` routing work across Tasks 3, 9.5b, 12.2, and 15.7. That resolves the original v5 issue as stated. However, I still see a new buildability problem in how that Claude late-binding is supposed to reach the registry in time for blocked routing; see Current finding 1.

2. **Missing Phase 1 backend-real `wait:false` coverage for pane/headless async orchestration and cancel**  
   **Disposition:** Addressed  
   Task 8b now adds explicit backend-real pane and headless tests for async dispatch and cancellation, matching the spec’s “both backends where applicable” requirement for Phase 1.

3. **Task 10 widget assertion depended on Task 13 widget machinery**  
   **Disposition:** Addressed  
   Task 10.7b now explicitly keeps the extension test focused on blocked steer-back emission and defers widget-state assertions to Task 13, where the virtual blocked-row map and cleanup hook are actually introduced.

No v5 finding remains open in its original form.

## Current findings

### 1) Error — The Claude `sessionKey` late-binding path is still not concretely wired from the current backend seam, especially for pane-backed Claude children
**Implicated plan areas:** Task 9.4, Task 9.5b, Task 12.2  
**Spec basis:** The spec’s session-ownership-map contract is keyed on the same `sessionKey` the parent passes to `subagent_resume`, for both pi-backed and Claude-backed children. That map is load-bearing for blocked routing and resume re-ingestion.

**Problem:**  
v6 fixes the old pi-only scope decision, but the concrete plumbing is still missing. The plan threads `onSessionKey` only through `LauncherDeps.waitForCompletion`, while the current backend seam is `Backend.watch(handle, signal, onUpdate)` with no session-key callback. More importantly, the current pane Claude path does not learn a Claude session id mid-run at all: `watchSubagent()` archives it via `copyClaudeSession(...)` only after exit. That means the plan never assigns a concrete mechanism to obtain/register a Claude session id before a `caller_ping` block on the pane backend, which is exactly when the ownership map must already be populated.

**Reality check:**  
- `pi-extension/subagents/backends/types.ts` currently exposes `watch(..., onUpdate?)`, not a session-key hook.
- `pi-extension/subagents/index.ts::watchSubagent` computes the Claude session id after sentinel exit, not during the live run.

**Why this matters:**  
This is the core Phase 2 ownership contract for Claude-backed children. As written, the plan claims full Claude support but does not yet provide a buildable path to implement it.

**What to change in the plan:**  
Add explicit backend-seam work for session-key callbacks/buffering, and either:
- assign a concrete way for the pane Claude path to surface the Claude session id before a block, or
- narrow the approved scope before execution starts.

### 2) Error — Sync `wait:true` results still never get the spec’s required `index`, so the shared result envelope is not actually implemented for sync runs
**Implicated plan areas:** Task 1.3, Task 2, Task 5.1/5.5, self-review checklist  
**Spec basis:** The spec’s shared result envelope says every orchestration result (sync or async) uses the same per-task shape, and `OrchestratedTaskResult` includes `index`.

**Problem:**  
Task 1 deliberately leaves `OrchestrationResult` as the internal core type; Task 2 only adds `state`; and the sync tool paths in Task 5 keep returning `out` from `runSerial` / `runParallel` directly. The tests added in Tasks 2 and 5 assert only `state`, never `index`. So if workers execute the plan literally, sync callers still receive the legacy shape plus `state`, not the spec’s shared `OrchestratedTaskResult` shape.

**Why this matters:**  
This is a spec-coverage gap and leaves sync/async API consumers with inconsistent result shapes despite the spec explicitly standardizing them.

**What to change in the plan:**  
Add a concrete implementation step that either:
- adds `index` to the sync runner results themselves, or
- maps sync `out.results` to the public `OrchestratedTaskResult` envelope in `tool-handlers.ts`,

and add tests that assert `index` is present on `wait:true` returns.

### 3) Warning — Task ordering still has a typecheck break: Task 5 uses `result.sessionKey` before Task 9 adds it to `OrchestrationResult`
**Implicated plan areas:** Task 5.6, Task 5.9, Task 9.6

**Problem:**  
Step 5.6 tells workers to read `result.sessionKey` when forwarding `onTerminal`, and Step 5.9 expects `npm run typecheck` to pass. But `OrchestrationResult.sessionKey` is not added until Step 9.6. A worker following the plan literally will hit a type error midway through Phase 1.

**Why this matters:**  
This is a sequencing/dependency-accuracy issue. The plan’s own verification checkpoint is not achievable in the stated order.

**What to change in the plan:**  
Either introduce `sessionKey?: string` on `OrchestrationResult` in Task 1/2/5, or move the relevant Task 9 typing work earlier so Task 5’s typecheck claim is actually satisfiable.

## Strengths

- v6 directly addresses all three findings from the v5 review in their original form.
- Task 8b is a meaningful improvement: it gives Phase 1 backend-real async/cancel coverage concrete, named files instead of relying on later generalized regression passes.
- Task 7b’s explicit `__test__` seams remain a strong structural choice; they keep later real-extension tests from inventing ad-hoc module mutation.
- The self-review checklist is much sharper than earlier versions and focuses on the actual lifecycle-risk edges.

## Recommended next steps

1. Resolve the Claude late-binding/session-ownership plumbing gap before execution starts.
2. Add a concrete sync-path step that makes `index` part of the public `wait:true` result envelope.
3. Reorder the `sessionKey` typing work so Task 5’s typecheck step is buildable.

[Issues Found]
