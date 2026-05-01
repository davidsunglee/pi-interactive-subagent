# Production Readiness Review — Orchestration Lifecycle Expansion

**Review date:** 2026-04-23  
**Range reviewed:** `b88d10..932192`  
**Primary spec:** `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v3.md`

## Scope and method

Reviewed the full diff against the v3 spec, with emphasis on:
- async orchestration lifecycle correctness
- blocked/resume routing
- session ownership and `sessionKey` handling
- backend parity claims
- test coverage and release-readiness of the new integration suite

I also independently re-verified the finding from the prior v6 review using the current code and current tests rather than assuming the prior conclusion remained true.

## Verification

Environment/setup:
- `npm install` (worktree prep)

Commands run:
- `npm run typecheck` ✅
- `node --test test/orchestration/*.test.ts` ✅
- `node --test test/integration/orchestration-headless-async-backend.test.ts` ✅
- `node --test test/integration/orchestration-headless-block-backend.test.ts test/integration/orchestration-pane-block-backend.test.ts test/integration/orchestration-async.test.ts test/integration/orchestration-headless-async-backend.test.ts` ⚠️ one transient failure on the first pass in `orchestration-headless-async-backend`, then the isolated rerun passed
- `npm run test:integration` ⚠️ did not complete within the review budget; it was still stuck in `orchestration-headless-block-backend` after >250s

## Strengths

- The registry split is strong. `pi-extension/orchestration/registry.ts` cleanly centralizes async dispatch, ownership tracking, blocked transitions, resume re-ingestion, cancellation, and completion emission.
- The v6 blocker around restricted pi tool allowlists is fixed in both launch paths. Lifecycle tools are now explicitly reserved by `resolvePiToolsArg()` and exercised by dedicated tests (`pi-extension/subagents/launch-spec.ts:165-192`, `pi-extension/subagents/backends/headless.ts:352-354`, `pi-extension/subagents/index.ts:764-766`, `test/orchestration/headless-pi-tools-reservation.test.ts:51-74`).
- The `subagent_resume` surface is materially cleaner now that it uses explicit XOR input fields for pi vs Claude sessions (`pi-extension/subagents/index.ts:1574-1583`).
- Test coverage is much broader than in earlier revisions: async dispatch, cancel-after-resume, registry eviction, transcript preservation, Claude session-key late binding, and real backend orchestration paths all have coverage.
- The memory-shedding cleanup after orchestration completion is a good production hardening touch (`pi-extension/orchestration/registry.ts:164-177`).

## Issues by severity

### High

1. **Claude-backed async orchestrations still cannot enter the spec’s `blocked` lifecycle from an initial run.**  
   **References:** `pi-extension/subagents/index.ts:986-992`, `pi-extension/subagents/backends/headless.ts:526-533`, `pi-extension/subagents/plugin/hooks/on-stop.sh:5-13`, `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v3.md:240-265`, `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v3.md:358-361`

   The approved v3 spec says Phase 2 block detection should work by surfacing `caller_ping` distinctly and explicitly calls for coverage of both resume-entry forms across backends. The shipped code intentionally narrows that scope instead:
   - pane watcher comments say Claude initial runs never surface `ping`
   - headless Claude backend says it never populates `BackendResult.ping`
   - the bundled Claude stop hook explicitly documents that it emits terminal completion only

   This means a Claude-backed task launched inside async orchestration cannot produce the spec’s `blocked` state from an initial run; it only runs to terminal. The codebase and README now document that limitation, so this looks like an intentional scope reduction rather than an accidental defect, but it is still a blocking mismatch against the authoritative spec used for this review.

   **Why it matters:** the change set exposes Claude-specific `sessionId` resume plumbing and backend-aware session-key handling, so backend parity is part of the intended surface. Shipping with one backend silently excluded from Phase 2 behavior would leave the implementation materially short of the approved design.

   **Recommended resolution:** either implement Claude-side blocked signaling for initial runs, or explicitly amend the v3 spec and acceptance matrix to state that Phase 2 blocked-state support is pi-only in v1.

### Medium

2. **The new backend-real blocked-flow integration tests are configured so loosely that a single stuck run can monopolize the full suite for minutes.**  
   **References:** `test/integration/harness.ts:61-62`, `test/integration/orchestration-headless-block-backend.test.ts:59-60`, `test/integration/orchestration-headless-block-backend.test.ts:108-132`, `test/integration/orchestration-pane-block-backend.test.ts:64-65`, `test/integration/orchestration-pane-block-backend.test.ts:106-120`

   The default integration timeout is 120s, and these blocked-flow suites multiply that to `PI_TIMEOUT * 3`, i.e. a 6-minute suite budget. Inside each test, both the initial blocked wait and the post-resume completion wait are allowed to consume `PI_TIMEOUT * 2` each. In practice, a mux/model stall can therefore tie up local verification or CI for several minutes before producing a useful signal. During this review, `npm run test:integration` was still stuck in `orchestration-headless-block-backend` after >250 seconds.

   **Why it matters:** this does not directly break production behavior, but it does degrade release confidence. A test suite that is this easy to strand becomes hard to trust and expensive to run on every branch.

   **Recommended resolution:** tighten per-step budgets, add deterministic teardown/cancellation on timeout paths, and split the slow real-backend cases out of the default integration gate.

## Remediation status for the v6 findings

### v6 finding 1 — pi-backed restricted tool launches stripped `caller_ping` / `subagent_done`
**Status:** Fixed  
**Evidence:** `pi-extension/subagents/launch-spec.ts:165-192`, `pi-extension/subagents/backends/headless.ts:352-354`, `pi-extension/subagents/index.ts:764-766`, `test/orchestration/headless-pi-tools-reservation.test.ts:51-74`, `test/integration/orchestration-headless-block-backend.test.ts:80-135`

The launch paths now reserve lifecycle tools whenever a restrictive pi `--tools` allowlist is emitted. I also verified the real headless blocked-flow integration path in isolation, and it now reaches `BLOCKED` and completes after resume.

## Spec / code divergences

1. **Claude initial-run blocked support is missing from code but still present in the v3 spec.**  
   **Spec refs:** `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v3.md:240-265`, `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v3.md:358-361`  
   **Code refs:** `pi-extension/subagents/index.ts:986-992`, `pi-extension/subagents/backends/headless.ts:526-533`, `pi-extension/subagents/plugin/hooks/on-stop.sh:5-13`, `README.md:324-329`

   **Assessment:** This is not just documentation drift; it is a behavioral scope reduction. Given the explicit comments and README note, I think the team has intentionally implemented a narrower v1 than the spec describes. If that narrower scope is acceptable, the spec should be updated. If the v3 spec remains authoritative, the code should change.

2. **`subagent_resume({ sessionPath | sessionId })` now matches the spec.**  
   **Spec refs:** `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v3.md:315-332`  
   **Code refs:** `pi-extension/subagents/index.ts:1574-1583`

   **Assessment:** This previously lagged behind the implementation in earlier review rounds, but v3 now matches the code. No action needed.

## Recommendations

1. **Resolve the Claude Phase 2 scope mismatch before merge.** Either implement initial-run Claude `caller_ping` → `blocked`, or amend v3 so the approved requirement matches the shipped behavior.
2. **Prevent runaway integration tests with concrete changes:**
   - lower default blocked-flow wait budgets from multi-minute suite-wide ceilings to per-event budgets
   - call `subagent_run_cancel` / surface cleanup in timeout/failure paths so stalled child sessions do not linger
   - split the real-backend orchestration tests into a separate slow lane (`test:integration:slow`) instead of making them part of the default long-running integration pass
   - enhance timeout diagnostics so a failed `waitForMessage()` captures recent `sentMessages`, orchestration id, session key, and surface/session artifacts instead of just returning `null`
3. **Stabilize the new async/backend integration gate.** The targeted tests are valuable, but the current runtime and occasional transient behavior make them better suited to a quarantined or separately budgeted CI lane until they are consistently bounded.

## Final assessment

**Ready to merge: No**

The v6 blocker around lifecycle tool reservation is fixed, and most of the orchestration architecture looks solid. However, the implementation still diverges from the approved v3 spec in a material way: Claude-backed async orchestrations cannot enter the `blocked` lifecycle from an initial run. In addition, the newly added real-backend blocked-flow tests currently have enough slack to become runaway verifiers, which undermines release confidence.
