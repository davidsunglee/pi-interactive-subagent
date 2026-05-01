# Code Review — Orchestration Lifecycle Expansion

Review scope:
- Diff: `b88d10..61881b`
- Requirements: `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md`

## Summary

This is a substantial, well-structured expansion of the orchestration surface. The split between orchestration core, backend seam, registry, and extension wiring is thoughtful, and the test matrix is much deeper than average for work of this size.

That said, I do **not** think the change is production-ready yet. The biggest gaps are all in the new block/resume lifecycle:
1. pane-backed Claude tasks publish the wrong `sessionKey`, so the documented resume flow cannot work there,
2. cancelling an orchestration does not actually stop a task that is already running under a standalone `subagent_resume`, and
3. resume re-ingestion drops transcript metadata that the orchestration result contract is supposed to preserve.

### Strengths

- The lifecycle model is cleanly isolated in `pi-extension/orchestration/registry.ts`, which makes the async/block/resume behavior understandable and testable.
- The backend seam is a good design choice. `LauncherDeps` + backend-specific `launch/watch` plumbing keeps orchestration logic from depending directly on pane/headless details.
- The test coverage is strong and broad: unit tests for registry/state transitions plus integration coverage for async, block/resume, pane/headless, and tool-boundary behavior.
- Sync behavior was kept mostly additive, which matches the spec’s backward-compatibility goal for `wait: true`.
- The widget handling for blocked tasks is minimal and pragmatic; preserving per-task rows without introducing orchestration grouping keeps the UI change small.

### Issues

#### Critical (Must Fix)

- None.

#### Important (Should Fix)

1. **Pane-backed Claude tasks record the wrong resume key, so blocked Claude orchestration steps cannot be resumed via the documented API.**  
   **Refs:** `pi-extension/subagents/index.ts:709-721`, `pi-extension/subagents/backends/pane.ts:47`, `pi-extension/subagents/backends/pane.ts:86-95`, `pi-extension/orchestration/registry.ts:198-204`  
   **What is wrong:** Claude pane launches still carry `sessionFile: spec.subagentSessionFile`, and `makePaneBackend.launch()` immediately publishes that file path as the task’s `sessionKey`. Later, when `watchSubagent()` discovers the real Claude session id, `registry.updateSessionKey()` cannot replace the already-recorded key because it is explicitly a no-op once a key exists. `makePaneBackend.watch()` then also prefers `running.sessionFile` over `sub.claudeSessionId`, reinforcing the wrong value.  
   **Why it matters:** The spec requires Claude-backed tasks to surface the Claude session id as `sessionKey`, because that is what the parent must pass back through `subagent_resume({ sessionId })`. On the default pane backend, a blocked Claude task will instead advertise a path-shaped key that the resume tool cannot use for Claude. This breaks the core block/resume workflow for Claude tasks on the most common backend.  
   **How to fix:** Do not assign a launch-time `sessionKey` for Claude pane children. Let the late-bound `onSessionKey` hook populate ownership when the actual Claude session id is known, and return `sub.claudeSessionId` from the pane watch result instead of `running.sessionFile`.

2. **`subagent_run_cancel` does not actually stop a task that is already running under `subagent_resume`.**  
   **Refs:** `pi-extension/orchestration/registry.ts:323-346`, `pi-extension/subagents/index.ts:1748-1757`  
   **What is wrong:** Once a blocked task is resumed, `subagent_resume` creates its own detached `watcherAbort`/pane lifecycle. `registry.cancel()` only aborts the orchestration’s original controller and flips registry state to `cancelled`; it has no handle to the resumed pane/session.  
   **Why it matters:** The spec says cancellation should transition non-terminal tasks to `cancelled` and abort in-flight work. Today, if a user cancels after `blocked -> running`, the orchestration completes as cancelled, but the resumed child keeps running in the background and can still mutate files or emit later steer-backs. That is a misleading and potentially dangerous cancellation contract.  
   **How to fix:** Track active resume executions in the registry (or another shared map keyed by `sessionKey`) and let `subagent_run_cancel` abort/close those resumed sessions too. Alternatively, route resumed execution back through an orchestration-owned launcher path instead of a detached standalone watcher.

3. **Resume re-ingestion drops transcript metadata, so resumed tasks lose `transcriptPath` in the final orchestration result.**  
   **Refs:** `pi-extension/subagents/index.ts:991-999`, `pi-extension/subagents/index.ts:1021-1029`, `pi-extension/subagents/index.ts:1825-1834`  
   **What is wrong:** `watchSubagent()` already computes and returns a real `transcriptPath` for both Claude and pi pane runs, but `subagent_resume.execute()` throws that away and hard-codes `transcriptPath: null` when it calls `registry.onResumeTerminal()`.  
   **Why it matters:** After any resume, the final `orchestration_complete` payload loses the transcript/session pointer for that task — including the archived Claude transcript path that was just created. That weakens the shared result envelope and makes follow-up inspection/debugging harder than the spec promises.  
   **How to fix:** Pass the watched result’s actual transcript path through to `registry.onResumeTerminal()`. For pi resumes, preserving the session path is sufficient; for Claude resumes, preserve the archived transcript path returned by `watchSubagent()`.

#### Minor (Nice to Have)

1. **Completed async orchestrations are retained indefinitely in memory, including full task payloads.**  
   **Refs:** `pi-extension/orchestration/registry.ts:123-158`  
   **What is wrong:** The registry never evicts completed entries from `entries`. `tryFinalize()` marks them completed and clears ownership, but the full task arrays remain resident for the life of the extension process.  
   **Why it matters:** Headless results can include full transcripts and usage arrays, so a long-lived parent session that runs many async orchestrations will accumulate unnecessary memory. There is no status-query feature in v1 that needs this full retention after the completion steer-back has already been emitted.  
   **How to fix:** Delete completed entries after emission, or retain only a tiny tombstone (e.g. `{ completed: true }`) if idempotent cancel-on-terminal semantics still need to distinguish known ids from unknown ids.

### Spec Alignment and Divergences

1. **Claude `sessionKey` on pane backend**
   - **Spec requirement / section:** Phase 2 → *Session-ownership map*, *Detecting a block*, *Unblock path*. For Claude-backed children, `sessionKey` must be the Claude session id — the same value the parent passes to `subagent_resume`.
   - **Current code behavior:** Pane Claude launches seed ownership with `spec.subagentSessionFile` and never let the later-discovered Claude id replace it (`pi-extension/subagents/index.ts:709-721`, `pi-extension/subagents/backends/pane.ts:47,93`, `pi-extension/orchestration/registry.ts:198-204`).
   - **Recommendation:** `change code`
   - **Rationale:** This is a direct mismatch with the spec and breaks the advertised block/resume API for Claude pane tasks.

2. **Cancellation semantics after `blocked -> running` via standalone resume**
   - **Spec requirement / section:** Phase 1 → *`subagent_run_cancel`* and Phase 2 → lifecycle model. Cancelling an orchestration should abort non-terminal running work and close in-flight panes.
   - **Current code behavior:** After `subagent_resume` starts, the resumed child runs under a detached watcher/controller that `registry.cancel()` cannot reach (`pi-extension/subagents/index.ts:1748-1757`, `pi-extension/orchestration/registry.ts:323-346`).
   - **Recommendation:** `change code`
   - **Rationale:** The user-visible orchestration state says “cancelled”, but the resumed child can keep executing. That is not compliant with the spec’s cancellation semantics.

3. **Transcript/usage semantics across resume**
   - **Spec requirement / section:** *Usage / transcript semantics across states*. Data should remain available across `running -> blocked -> running`, extending cumulatively where supported.
   - **Current code behavior:** Resume re-ingestion hard-codes `transcriptPath: null`, and the resume boundary does not feed post-resume usage/transcript information back into the registry (`pi-extension/subagents/index.ts:1825-1834`).
   - **Recommendation:** `change code`
   - **Rationale:** Even where the resume path already has transcript metadata available, the orchestration result loses it. At minimum the code should preserve `transcriptPath`; ideally it should also define/implement the intended accumulation behavior explicitly.

4. **No-mux headless blocked runs are not actually resumable**
   - **Spec requirement / section:** Phase 2 scope/testing describes block/resume behavior across backends, but does not call out a mux-only limitation for resume.
   - **Current code behavior:** `subagent_resume` still hard-requires mux for both `sessionPath` and `sessionId` paths (`pi-extension/subagents/index.ts:1625-1629`). The README documents this as a v1 limitation, so headless/no-mux parents can block a task but cannot continue it.
   - **Recommendation:** `update spec`
   - **Rationale:** The implementation and README are internally consistent, but the approved spec should explicitly narrow the feature if that limitation is intentional for v1. If the product goal is true human-in-the-loop support on no-mux hosts, then this should become a code change instead.

### Recommendations

- Fix the pane-Claude `sessionKey` plumbing before merge and add a real regression test that exercises `cli: "claude"` through the orchestration block/resume path on the pane backend.
- Teach orchestration cancellation how to abort work that is currently executing under `subagent_resume`, not just the original launcher signal.
- Preserve resume transcript metadata in `registry.onResumeTerminal()` and add a test that asserts `transcriptPath` survives a resume for both pi and Claude paths.
- Add an eviction/tombstone strategy for completed registry entries so async orchestration state does not grow without bound.
- Decide explicitly whether no-mux headless block/resume is in or out for v1; then make the spec and README match that decision.

### Assessment

- **Ready to merge:** With fixes
- **Why:** The architecture and test coverage are strong, but the remaining gaps are in the core advertised lifecycle: Claude pane resume routing is broken, cancellation is incomplete after resume, and resumed results lose metadata. I would fix those before shipping this as production-ready.
