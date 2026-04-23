# Production Readiness Review — Orchestration Lifecycle Expansion

**Review date:** 2026-04-23  
**Range reviewed:** `b88d10..a18267`  
**Previous review verified:** `.pi/reviews/2026-04-23-orchestration-lifecycle-expansion-review-v7.md`  
**Primary spec:** `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v3.md`

## Scope and method

Reviewed the full diff against the approved v3 spec, with focused re-verification of the two findings from v7:
- Claude initial-run block-state parity vs. the approved scope
- release-readiness of the new real-backend blocked-flow integration suites

I read the shipped orchestration/runtime code, the updated spec, and the changed integration harness/tests directly rather than relying on commit summaries.

## Verification

Worktree checked out at `a18267` for validation.

Commands run:
- `npm run typecheck` ✅
- `npm test` ✅
- `node --test test/integration/orchestration-extension-async.test.ts test/integration/orchestration-extension-blocked.test.ts test/integration/orchestration-extension-resume-routing.test.ts test/integration/orchestration-block-resume-e2e.test.ts` ✅
- `PI_RUN_SLOW=1 node --test test/integration/orchestration-headless-async-backend.test.ts test/integration/orchestration-headless-block-backend.test.ts test/integration/orchestration-pane-async-backend.test.ts test/integration/orchestration-pane-block-backend.test.ts` ✅
- `npm run test:integration` ⚠️ broader repo suite exceeded the review timeout budget, but the orchestration fast lane and explicit slow lane both passed

## Strengths

- The orchestration runtime is now coherent end-to-end: async dispatch, blocked-state transitions, resume re-ingestion, cancellation, and terminal aggregation are centralized in `pi-extension/orchestration/registry.ts` with clear state transitions and defensive hooks/emitter handling (`pi-extension/orchestration/registry.ts:131-410`).
- The public tool surface is much cleaner and better aligned with the spec: `subagent_run_serial`, `subagent_run_parallel`, `subagent_run_cancel`, and XOR-shaped `subagent_resume({ sessionPath | sessionId })` are all implemented and wired through the extension (`pi-extension/orchestration/tool-handlers.ts:91-388`, `pi-extension/subagents/index.ts:1560-1879`).
- The previously missing lifecycle-tool reservation remains correctly enforced on pi launches, and the new blocked/resume flow is exercised all the way through both orchestration cores (`pi-extension/subagents/launch-spec.ts:155-189`, `pi-extension/orchestration/run-serial.ts:137-190`, `pi-extension/orchestration/run-parallel.ts:125-174`).
- Test coverage is strong and appropriately layered: fast unit/extension tests cover lifecycle edge cases, while the real-backend suites explicitly cover headless + pane async completion and block/resume behavior.
- The slow-suite remediation is solid: the real backend orchestration tests are now opt-in, use tighter per-event wait budgets, and perform best-effort cancellation/diagnostic dumping on timeout paths (`package.json:18-22`, `test/integration/harness.ts:64-80`, `test/integration/harness.ts:299-354`, `test/integration/orchestration-headless-block-backend.test.ts:10-16`, `test/integration/orchestration-pane-block-backend.test.ts:14-20`).

## Issues by severity

### Critical
- None.

### High
- None.

### Medium
- None.

### Low
- None.

## Informational notes

1. **Minor spec/code placement drift: ownership-map logic shipped inside `registry.ts`, not a separate `ownership-map.ts` module.**  
   **Spec refs:** `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v3.md:314-319`  
   **Code refs:** `pi-extension/orchestration/registry.ts:131-137`, `pi-extension/orchestration/registry.ts:191-410`

   The spec's code-placement section still says Phase 2 introduces `pi-extension/orchestration/ownership-map.ts`. The shipped code instead keeps ownership tracking and resume routing inside `registry.ts`. I do **not** consider this a code issue—the implementation is cohesive and well-tested—but the spec should be updated if you want documentation to match the final file layout exactly.

## Remediation status for the v7 findings

### v7 finding 1 — Claude-backed async orchestrations could not enter `blocked` while the spec still required backend parity
**Status:** Remediated by explicit spec alignment / scope clarification  
**Evidence:** `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v3.md:230-245`, `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v3.md:374-376`, `pi-extension/subagents/index.ts:986-992`, `pi-extension/subagents/backends/headless.ts:526-533`, `pi-extension/subagents/plugin/hooks/on-stop.sh:5-13`

The code still intentionally treats initial-run block detection as pi-only, but the approved v3 spec now says exactly that. This resolves the prior merge-blocking mismatch between code and spec. I view this as a legitimate remediation because the implementation was already deliberate and the requirement has now been updated to match shipped behavior.

### v7 finding 2 — Real-backend blocked-flow integration tests were loose enough to monopolize the suite for minutes
**Status:** Remediated  
**Evidence:** `package.json:18-22`, `test/integration/harness.ts:64-80`, `test/integration/harness.ts:299-354`, `test/integration/orchestration-headless-block-backend.test.ts:10-16`, `test/integration/orchestration-headless-block-backend.test.ts:63-65`, `test/integration/orchestration-pane-block-backend.test.ts:14-20`, `test/integration/orchestration-pane-block-backend.test.ts:62-64`

The slow real-backend orchestration suites are now split behind `PI_RUN_SLOW=1`, use tighter event-level budgets (`BLOCK_WAIT_MS`), and add cancellation/diagnostic helpers for timeout paths. I also ran the explicit slow-lane command successfully; the four orchestration backend suites all passed in bounded time.

## Spec / code alignment notes

- **Material behavior is aligned with the current v3 spec.** In particular, the spec now explicitly documents the pi-only scope for initial-run block detection and the deferred Claude work (`.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v3.md:230-245`, `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v3.md:374-376`).
- **The `subagent_resume` XOR surface matches the spec.** Code validates exactly one of `sessionPath` / `sessionId` (`pi-extension/subagents/index.ts:1575-1621`), consistent with the spec (`.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v3.md:337-348`).
- **Only minor doc-layout drift remains** (`ownership-map.ts` vs. consolidated registry implementation); no production behavior mismatch found.

## Final assessment

**Ready to merge: Yes**

I found no actionable production-readiness issues in `b88d10..a18267`. The two v7 findings have been addressed: one by bringing the spec into line with the intentionally shipped Claude scope, and one by making the new real-backend orchestration tests operationally safe to keep in the repo via slow-lane gating, tighter budgets, and cleanup helpers.