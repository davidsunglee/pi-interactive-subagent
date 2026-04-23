# Production Readiness Review — Orchestration Lifecycle Expansion

**Review date:** 2026-04-23  
**Range reviewed:** `b88d10..0a2e2f`  
**Primary spec:** `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md`

## Scope and method

Reviewed the full diff against the approved spec, with special attention to lifecycle/orchestration correctness, state ownership, resume routing, API shape, and test coverage. I also independently re-checked the two findings from `.pi/reviews/2026-04-23-orchestration-lifecycle-expansion-review-v5.md` against the current code rather than treating the earlier review as ground truth.

## Verification

I verified the implementation in a detached worktree at `0a2e2f` and ran:

- `npm run typecheck` ✅
- `npm test` ✅
- `node --test test/integration/orchestration-headless-block-backend.test.ts` ❌

I also reproduced the headless blocked-flow failure with a real `subagent_run_serial({ wait: false })` launch of `test-ping-resumable`: the child completed normally instead of emitting `blocked`, and its final message explicitly reported that `caller_ping` was unavailable.

## Strengths

- The registry split is solid. `pi-extension/orchestration/registry.ts` cleanly centralizes async orchestration state, ownership mapping, cancellation, and resume re-ingestion.
- The v5 telemetry fix is implemented carefully: resumed results now overwrite stale block-time `usage` / `transcript` snapshots instead of silently preserving incomplete data.
- The redundant public `sessionId` field was removed from orchestration results, which leaves `sessionKey` as the single resume-addressable identifier and matches the intended API shape.
- Test coverage is broadly strong. The new unit suite around async dispatch, blocked transitions, cancel-after-resume, Claude session-key late binding, and resume-tool boundaries materially improves confidence.

## Issues by severity

### High

1. **Real headless pi-backed tasks still cannot enter the `blocked` lifecycle because `caller_ping`/`subagent_done` are not actually available under restricted tool launches.**  
   **References:** `pi-extension/subagents/backends/headless.ts:339-356`, `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md:245-252`, `test/integration/orchestration-headless-block-backend.test.ts:80-125`

   The spec explicitly requires pi-backed children to surface `caller_ping` as a first-class blocked state, and it calls out both pane and headless coverage for the lifecycle expansion. The real headless backend does not currently satisfy that contract.

   In `runPiHeadless()`, the launch command passes `--tools` using a hard-coded builtin-only allowlist (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) and never reserves the orchestration lifecycle tools injected by `subagent-done.ts`. In a real headless run of `test-ping-resumable`, the child surfaced only `Read` and `Bash`, reported that `caller_ping` was unavailable, and the orchestration emitted `orchestration_complete` instead of `blocked`. The dedicated integration test for this path fails with exactly that symptom.

   This is a production issue, not just a test problem:
   - headless async orchestrations cannot perform the spec's human-in-the-loop block/resume flow,
   - the failure is silent at the orchestration layer (the run looks successfully `completed`), and
   - one of the explicitly targeted backend scenarios is therefore broken end-to-end.

   **Recommended fix:** ensure pi-backed headless launches always retain the internal lifecycle tools required for orchestration (`caller_ping` and `subagent_done`) even when the agent declares a restrictive `tools:` list, then rerun the real headless blocked-flow integration test.

## Remediation status for the v5 findings

### v5 finding 1 — stale block-time `usage` / `transcript` surviving resume re-ingestion
**Status:** Fixed  
**Evidence:** `pi-extension/orchestration/registry.ts:311-324`, `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md:111-113`

`onResumeTerminal()` now materializes `usage` and `transcript` on the incoming resumed result before merging it into the blocked snapshot, which clears stale pre-resume telemetry when the pane-based resume leg omits those fields. The spec was updated accordingly to document the v1 behavior.

### v5 finding 2 — redundant public `sessionId` alongside `sessionKey`
**Status:** Fixed  
**Evidence:** `pi-extension/orchestration/types.ts:70-81`, `pi-extension/orchestration/tool-handlers.ts:406-419`, `README.md:80-94`

`OrchestratedTaskResult` no longer exposes `sessionId`, and `toPublicResults()` now emits only `sessionKey`. The README was updated to describe `sessionKey` as the single public resume identifier.

## Spec / code divergences

1. **`subagent_resume` now has a new Claude-specific `sessionId` parameter, but the spec still describes the tool as essentially unchanged and only examples the pi-shaped `sessionPath` form.**  
   **Spec refs:** `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md:239-270, 318-326`  
   **Code refs:** `pi-extension/subagents/index.ts:1579-1630`

   This code change makes sense: once `sessionKey` can be a Claude session id, the resume tool needs a way to accept that value directly. I do **not** think the code should be reverted. The right move is to update the spec/API summary so it explicitly documents the XOR surface:
   - `sessionPath` for pi-backed sessions
   - `sessionId` for Claude-backed sessions

## Recommendations

1. Fix the headless pi tool-surface bug so `caller_ping`/`subagent_done` are always available for lifecycle-aware subagents under headless orchestration.
2. Rerun `test/integration/orchestration-headless-block-backend.test.ts` and the surrounding orchestration integration suite after that fix.
3. Update the spec/docs to reflect the new `subagent_resume({ sessionId })` entry point for Claude session keys.

## Final assessment

**Ready to merge: No**

The architecture is in good shape and the two v5 findings are remediated, but a core phase-2 requirement is still broken on the real headless pi backend: pi-backed headless children cannot actually emit `blocked`, so the documented block/resume lifecycle does not work end-to-end across both supported backends yet.