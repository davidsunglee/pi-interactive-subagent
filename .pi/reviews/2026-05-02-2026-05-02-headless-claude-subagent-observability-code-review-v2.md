**Reviewer:** openai-codex/gpt-5.5 via pi

### Strengths
- `runParallel` now emits dense, input-indexed inflight snapshots with explicit lifecycle states, and the post-launch/partial/terminal update points are centralized through `emitInflight` (`pi-extension/orchestration/run-parallel.ts:86-92`, `pi-extension/orchestration/run-parallel.ts:110-121`, `pi-extension/orchestration/run-parallel.ts:165-166`).
- The serial inflight path correctly stamps the active partial as `running` with its input index, avoiding derived `pending` rendering for live work (`pi-extension/orchestration/run-serial.ts:92-101`).
- Claude headless usage now avoids fabricated token/cost telemetry before real events while still surfacing live assistant turn counts (`pi-extension/subagents/backends/headless.ts:516-517`, `pi-extension/subagents/backends/headless.ts:570-586`, `pi-extension/subagents/backends/headless.ts:596-609`).
- `toTaskRows` defensively handles sparse/undefined result slots by iterating all indexes and producing visible pending placeholders (`pi-extension/subagents/ui/headless-render.ts:192-215`).
- Regression coverage is broad: focused lifecycle tests, serial inflight tests, truthful usage tests, sparse rendering tests, and an integration-style observability regression were added. I also ran `npm test`, which passed (436 tests, 0 failures).

### Issues

#### Critical (Must Fix)
None.

#### Important (Should Fix)
None.

#### Minor (Nice to Have)
None.

### Recommendations
- Keep the end-to-end observability regression in the default suite; it provides useful protection against future drift between widget lifecycle state and tool-call rendering.

### Assessment

**Ready to merge: Yes**

**Reasoning:** The implementation satisfies the lifecycle, rendering, and truthful telemetry requirements, includes targeted and integration regression coverage, and the full test suite passes without failures.
