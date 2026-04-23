# Code Review — Orchestration Lifecycle Expansion (v2)

Review scope:
- Mode: Hybrid Re-Review
- Remediation diff: `61881b..7845af`
- Prior review: `.pi/reviews/2026-04-23-orchestration-lifecycle-expansion-review-v1.md`
- Spec: `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md`

## Summary

I reviewed the remediation diff only, verified the v1 findings against the updated code, and checked the changed behavior against the approved spec. The remediation is solid: all four v1 findings are addressed in code, each has regression coverage, and I did not find any new remediation-only issues in `61881b..7845af`.

I also ran verification on the remediated revision:
- `npm test`
- `npm run typecheck`

Both passed on a detached worktree at `7845af`.

## Strengths

- The Claude pane `sessionKey` fix is narrowly scoped and preserves pi behavior unchanged.
- Cancellation now reaches detached resume watchers without complicating the orchestration surface API.
- Transcript preservation is implemented at the actual re-ingestion boundary, which is the correct place to fix it.
- The added tests are good regression tests: they exercise the exact failure modes called out in v1 rather than only happy-path behavior.

## V1 Findings Tracking

### 1. Pane-backed Claude tasks recorded the wrong `sessionKey`
**Status:** Remediated

**Evidence:**
- `pi-extension/subagents/backends/pane.ts:61-72` now omits `sessionKey` at launch time for Claude pane runs, avoiding publication of the pi session-file placeholder.
- `pi-extension/subagents/backends/pane.ts:111-126` now returns `sub.claudeSessionId` as the Claude `sessionKey` on watch completion.
- Regression coverage: `test/orchestration/pane-backend-claude-session-key.test.ts:25-156`.

**Assessment:** This now matches the spec's requirement that Claude-backed tasks expose the same resume-addressable key the parent passes back through `subagent_resume`.

### 2. `subagent_run_cancel` did not stop tasks already running under `subagent_resume`
**Status:** Remediated

**Evidence:**
- `pi-extension/subagents/index.ts:1752-1759` registers the resume watcher's `AbortController` with the registry.
- `pi-extension/subagents/index.ts:1766-1769` and `pi-extension/subagents/index.ts:1856-1858` unregister it on both success and error paths.
- `pi-extension/orchestration/registry.ts:354-377` stores those controllers and aborts owned in-flight resumes during `cancel(orchestrationId)`.
- Regression coverage: `test/orchestration/cancel-after-resume.test.ts:24-125`.

**Assessment:** The orchestration cancel path can now reach detached resume execution, which closes the main lifecycle gap from v1.

### 3. Resume re-ingestion dropped `transcriptPath`
**Status:** Remediated

**Evidence:**
- `pi-extension/subagents/index.ts:1835-1849` now preserves `result.transcriptPath`, with the pi resume path falling back to `params.sessionPath` when needed.
- Regression coverage: `test/orchestration/resume-transcript-preservation.test.ts:27-146` covers both Claude and pi resume flows.

**Assessment:** The resumed task's transcript pointer now survives into the owning orchestration result as intended.

### 4. Completed async orchestrations retained heavy payloads indefinitely
**Status:** Remediated

**Evidence:**
- `pi-extension/orchestration/registry.ts:171-188` now strips `transcript` and `usage` from completed entries after emitting the aggregated completion, while preserving lightweight tombstone metadata.
- Regression coverage: `test/orchestration/registry-eviction.test.ts:31-83` verifies both payload shedding and idempotent cancel-after-completion behavior.

**Assessment:** This is a reasonable implementation of the v1 recommendation and does not change the public result envelope.

## New Findings from `61881b..7845af`

No new findings.

## Spec Alignment and Divergences

### Claude pane `sessionKey`
- **Spec area:** Phase 2 session-ownership map / unblock path
- **Current behavior:** Aligned. Claude pane tasks no longer advertise the pi session-file placeholder and instead surface the Claude session id once known (`pi-extension/subagents/backends/pane.ts:61-72`, `pi-extension/subagents/backends/pane.ts:111-126`).
- **Recommendation:** None

### Cancellation after `blocked -> running` via standalone resume
- **Spec area:** Phase 1 `subagent_run_cancel`; Phase 2 lifecycle model
- **Current behavior:** Aligned in the reviewed remediation scope. Cancelling an orchestration now aborts owned detached resume watchers (`pi-extension/orchestration/registry.ts:362-395`, `pi-extension/subagents/index.ts:1752-1759`).
- **Recommendation:** None

### Transcript semantics across resume
- **Spec area:** Usage / transcript semantics across states
- **Current behavior:** Aligned for the fields the pane backend currently populates. The resume path now preserves `transcriptPath` into the orchestration result (`pi-extension/subagents/index.ts:1835-1849`).
- **Recommendation:** None

### Post-completion registry retention
- **Spec area:** Not explicitly specified
- **Current behavior:** Completed entries keep a lightweight tombstone while dropping heavy `transcript`/`usage` payloads (`pi-extension/orchestration/registry.ts:171-188`).
- **Recommendation:** No spec update needed for v1. This is an internal memory optimization and does not conflict with the approved API surface.

## Assessment

- **Ready to merge:** Yes
- **Why:** All four v1 findings are remediated in code, the changes are covered by focused regression tests, the remediated revision passed `npm test` and `npm run typecheck`, and I did not identify any new issues in the remediation diff.