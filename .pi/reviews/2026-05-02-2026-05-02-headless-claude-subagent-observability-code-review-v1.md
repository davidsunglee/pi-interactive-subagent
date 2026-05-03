**Reviewer:** openai-codex/gpt-5.5 via pi

### Strengths
- `runParallel` now emits dense in-flight snapshots with explicit per-slot lifecycle states and defensive cloning, which addresses the UI row-drop/flicker class of bugs (`pi-extension/orchestration/run-parallel.ts:72-89`, `pi-extension/orchestration/run-parallel.ts:113-125`).
- Serial in-flight updates now stamp the active step as `running`, preventing the summary renderer from deriving a misleading pending state (`pi-extension/orchestration/run-serial.ts:94-102`).
- Claude headless telemetry no longer fabricates all-zero usage before real stream events, and assistant events increment live turn counts (`pi-extension/subagents/backends/headless.ts:511-555`).
- `toTaskRows` now handles both explicit `undefined` entries and real sparse holes without dropping rows (`pi-extension/subagents/ui/headless-render.ts:193-214`).
- The new tests cover the main lifecycle, rendering, telemetry, and regression paths, and `npm test` passes locally: 435 tests passed, 0 failed.

### Issues

#### Critical (Must Fix)
None.

#### Important (Should Fix)
1. **Running tasks cancelled by abort are normalized to `failed` instead of preserving `cancelled`**
   - File: `pi-extension/orchestration/run-parallel.ts:167-169`
   - What's wrong: terminal annotation unconditionally overwrites any backend-supplied `result.state` with `completed` or `failed`. If an in-flight task resolves due to the orchestration abort with `{ state: "cancelled" }` or `{ error: "cancelled", exitCode: 1 }`, the final public result becomes `failed`.
   - Why it matters: the plan requires cancelled siblings after `signal.abort()` to remain `state: "cancelled"` with `error: "cancelled"`. The regression test was weakened to accept `failed || cancelled`, so it does not enforce the stated cancellation contract.
   - How to fix: preserve explicit terminal states from the backend, or special-case cancellation before deriving failure, e.g. derive `cancelled` when `result.state === "cancelled"` or `result.error === "cancelled"`; then update the abort regression tests to assert `state === "cancelled"` for in-flight aborted tasks.

#### Minor (Nice to Have)
None.

### Recommendations
- Tighten the cancellation assertions in `test/orchestration/headless-observability-regression.test.ts` and the existing mid-run abort test so they match the spec rather than allowing `failed` for expected cancellations.

### Assessment

**Ready to merge: With fixes**

**Reasoning:** The observability fixes are largely well-implemented and the full test suite passes, but the abort path still misclassifies in-flight cancellations as failures, which violates the stated lifecycle contract and should be corrected before merge.
