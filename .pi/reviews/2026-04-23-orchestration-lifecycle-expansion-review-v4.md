# Orchestration Lifecycle Expansion Review v4

## Git range reviewed
`7845af..1460ecf`

## Spec used
`.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md`

## Prior review verified
`.pi/reviews/2026-04-23-orchestration-lifecycle-expansion-review-v3.md`

## Strengths
- The parallel blocked-worker bug from v3 is fixed with the right minimal change. `pi-extension/orchestration/run-parallel.ts:125-149` now `continue`s after reporting a blocked slot instead of returning from the worker, which preserves the registry-owned blocked slot while still allowing the worker pool to claim later siblings.
- The remediation is well covered. I verified the new targeted tests in `test/orchestration/run-parallel.test.ts:357-390`, `test/orchestration/block-resume.test.ts:269-332`, and `test/orchestration/tool-handlers.test.ts:440-479`, and I also ran `npm test` and `npm run typecheck` in a detached worktree at `1460ecf`; both passed.
- The backward-compat fix for Claude result payloads is correct for the sync public surface: `pi-extension/orchestration/tool-handlers.ts:406-424` now preserves `sessionId` alongside `sessionKey`, and `pi-extension/orchestration/types.ts:70-89` documents that intent clearly.
- The Claude `caller_ping` scope reduction is now explicit rather than implicit. The implementation, README, and design doc now say the same thing: initial-run blocked-state detection is pi-CLI only in v1 (`pi-extension/subagents/backends/headless.ts:529-534`, `pi-extension/subagents/index.ts:991-997`, `pi-extension/subagents/plugin/hooks/on-stop.sh:1-12`, `README.md:316-329`, `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md:36-37,244-246`).

## Issues

### Critical (Must Fix)
- None.

### Important (Should Fix)
- None.

### Minor (Nice to Have)
- None in the remediation diff itself.

## Spec divergences
1. **`subagent_resume` is still documented as "unchanged" even though the implementation exposes a new XOR surface.**
   - **Where:** `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md:319`, `pi-extension/subagents/index.ts:1579-1585,1622-1630`
   - **What differs:** The spec still says `subagent_resume` is pre-existing with unchanged behavior, but the code still requires exactly one of `sessionPath` or `sessionId`.
   - **Should change:** **Spec should change.**
   - **Why:** This was already called out in v3 and remains true after the remediation. The code surface is deliberate and tested; the design doc is the stale artifact.

2. **The spec still calls for a separate `ownership-map.ts`, while the implementation continues to keep ownership inside `registry.ts`.**
   - **Where:** `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md:304-307`, `pi-extension/orchestration/registry.ts:131-137,211-235,259-347`
   - **What differs:** The runtime behavior is implemented, but the module split described by the spec did not happen.
   - **Should change:** **Spec should change.**
   - **Why:** This is still an internal organization difference, not a product behavior problem.

## Remediation status of prior findings
1. **V3 Important #1 — parallel blocked task could strand later siblings:** **Fixed.**
   - `pi-extension/orchestration/run-parallel.ts:125-149` now continues claiming work after a block.
   - Covered by `test/orchestration/run-parallel.test.ts:357-390` and the end-to-end orchestration regression in `test/orchestration/block-resume.test.ts:269-332`.

2. **V3 Important #2 — Claude-backed `caller_ping` not implemented end-to-end:** **Remediated by scope reduction / spec clarification, not by adding the feature.**
   - The implementer's claim is **correct after this diff**. I verified that Claude CLI children still do not expose `caller_ping`, and the code now documents that intentionally rather than accidentally:
     - the tool itself is registered only by pi's subagent extension (`pi-extension/subagents/subagent-done.ts:152-181`),
     - the Claude stop hook still emits only terminal sentinels (`pi-extension/subagents/plugin/hooks/on-stop.sh:1-12,65-76`),
     - the Claude pane/headless result paths intentionally do not populate `ping` (`pi-extension/subagents/index.ts:991-997`, `pi-extension/subagents/backends/headless.ts:529-534`).
   - This is now consistent with the revised design doc and README (`.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md:36-37,244-246`; `README.md:316-329`).
   - Important nuance: this is a **spec change**, not a latent feature completion. If Claude blocked-state support is still desired later, it remains follow-up work.

3. **V3 Minor #1 — README still documented `sessionId` instead of `sessionKey`:** **Fixed.**
   - `README.md:76-95` now documents `sessionKey` and preserves `sessionId` as Claude-only backward compatibility.

4. **V3 Spec divergence #1 — `subagent_resume` API no longer unchanged:** **Not fixed.**
   - Still diverges; spec should change.

5. **V3 Spec divergence #2 — ownership map folded into registry:** **Not fixed.**
   - Still diverges; spec should change.

6. **V3 Spec divergence #3 — sync results dropped Claude `sessionId`:** **Fixed.**
   - `pi-extension/orchestration/tool-handlers.ts:406-424` now preserves `sessionId` in the public sync payload.

7. **V3 Spec divergence #4 — Claude blocked/resume promised by spec but not implemented:** **Remediated by spec change.**
   - The revised spec now explicitly excludes initial-run Claude `caller_ping` signaling in v1, which matches the actual code.

## Assessment
- **Ready to merge:** Yes
- **Reasoning:** The two substantive production-readiness problems from v3 are resolved: the parallel blocked-worker scheduling bug is fixed, and the Claude `caller_ping` gap is no longer a silent mismatch because the design and docs now explicitly scope it out of v1. I did not find any new runtime regressions in the remediation diff, and the detached-worktree verification for `1460ecf` passed (`npm test`, `npm run typecheck`). The only remaining mismatches I found are documentation/spec-shape issues that were already identified in v3 and should still be cleaned up, but they are not blockers for this remediation branch.
