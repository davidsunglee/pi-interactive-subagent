**Reviewer:** openai-codex/gpt-5.5 via pi

### Status

**[Issues Found]**

### Issues

**[Warning] — Task 5: Chosen approach deviation is not explicitly resolved**
- **What:** The spec's chosen approach says to use "a unified orchestration lifecycle snapshot as the source of truth for both widget state and live tool-call/TUI updates." The plan's architecture instead says it will keep the widget `runningSubagents` map and the tool-call `results[]` array as separate carriers, driven from the same backend lifecycle events.
- **Why it matters:** This may still fix the observed symptoms, but it is a visible deviation from the spec's chosen paradigm. If the two carriers drift again, the implementation could miss the intended single-source-of-truth guarantee.
- **Recommendation:** Either update the plan to make the shared snapshot the actual source for both surfaces, or explicitly document why the two-carrier/event-driven compromise is intentional and how Task 5 proves the carriers cannot diverge.

**[Warning] — Task 3: Acceptance/test plan for pre-usage Claude partial does not exercise production `runClaudeHeadless`**
- **What:** The acceptance criterion says "A partial emitted by `runClaudeHeadless` before any Claude assistant or `result` event carries no `usage` field," but Step 3.7 verifies this with `__test__.makeHeadlessBackendWithRunner`, which bypasses `runClaudeHeadless`. Step 3.8 exercises the production spawn path, but only after assistant/result events.
- **Why it matters:** A regression in production Claude stream handling that emits fabricated zero usage before real telemetry could be missed by the named acceptance test.
- **Recommendation:** Adjust the Task 3 test plan so the production `__test__.setSpawn` path verifies the no-fabricated-usage behavior, or reword the criterion to match what the injected-runner test actually proves.

**[Warning] — Task 4: Sparse-array acceptance verify recipe uses a dense array**
- **What:** The acceptance criterion says `toTaskRows` must handle sparse arrays, but its `Verify:` recipe invokes `toTaskRows(Array.from({ length: 3 }, () => undefined))`, which creates a dense array of explicit `undefined` values rather than a sparse array with holes.
- **Why it matters:** An implementation that still uses `.map` would handle dense `undefined` differently from real holes; the verify recipe alone may not catch the exact bug the task is meant to prevent.
- **Recommendation:** Make the verify recipe name `toTaskRows(new Array(3))` (or another true sparse array) as the success condition, matching Step 4.3.

### Summary

The plan is detailed, mostly buildable, and covers the major spec requirements for parallel lifecycle stability, serial inflight state, truthful Claude usage, sparse rendering robustness, and end-to-end regression coverage. I found 0 errors, 3 warnings, and 0 suggestions. There are no blocking verify-recipe omissions, but the plan should address the chosen-approach deviation and tighten two verification mismatches before execution for best confidence.
