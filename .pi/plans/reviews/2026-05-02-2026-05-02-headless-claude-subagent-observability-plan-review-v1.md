**Reviewer:** openai-codex/gpt-5.5 via pi

### Status

**[Issues Found]**

### Issues

**[Error] — Task 1: Post-loop abort sweep condition is reversed/ambiguous**
- **What:** Step 1.7 says to “change `if (!results[i])` to `if (results[i].state !== "pending")`,” but the same step and acceptance criteria say only `pending` slots should be transitioned to `cancelled` while already-terminal slots are preserved.
- **Why it matters:** Implementing the condition literally in the existing `if` block would run the cancellation body for non-pending slots and skip pending slots, which would overwrite completed/failed work and leave never-launched pending slots uncancelled. That directly violates the lifecycle and cancellation requirements.
- **Recommendation:** Clarify the control flow so non-pending slots are skipped, e.g. `if (results[i].state !== "pending") continue;`, then apply the existing async-mode `if (opts.onBlocked) continue;` skip before cancelling the remaining pending sync-mode slots.

**[Error] — Task 5: Background `wait:false` steer-back coverage from the spec is missing**
- **What:** The spec requires background `wait:false` orchestration to preserve stable widget state and emit final steer-back results with correct terminal states and telemetry. Task 5 drives `runParallel` with custom `LauncherDeps` and registry-like widget updates, but it does not invoke the actual `wait:false` tool-handler/registry dispatch path or assert the final steer-back payload.
- **Why it matters:** The plan can pass its end-to-end regression while leaving a spec acceptance criterion untested, especially the asynchronous return/steer-back behavior that differs from blocking `runParallel` updates.
- **Recommendation:** Add a Task 5 step and acceptance criterion that runs `subagent_run_parallel` (and/or serial if intended) with `wait:false` through the registered tool/registry path, then asserts continuous widget rows and final steer-back results containing terminal state, usage, transcript/session fields as applicable.

**[Warning] — Task 4: Sparse-array verification does not actually require a sparse array**
- **What:** Step 4.3 correctly calls out `toTaskRows(new Array(3))`, but the acceptance criterion verify recipe says to invoke `toTaskRows(Array.from({ length: 3 }, () => undefined))`, which creates a dense array of `undefined` values rather than real holes.
- **Why it matters:** An implementation that keeps using `.map` would handle the dense `Array.from` case but still skip holes in `new Array(3)`, leaving the actual sparse-array regression uncovered.
- **Recommendation:** Make the test and verify recipe explicitly call `toTaskRows(new Array(3))` or another genuinely sparse array and assert one pending row per input index.

**[Warning] — Task 3: Injected-runner test does not exercise `runClaudeHeadless` usage gating**
- **What:** Step 3.7 uses `__test__.makeHeadlessBackendWithRunner` and emits partials directly from the test runner, but that seam bypasses `runClaudeHeadless`, Claude stream parsing, `hasRealUsage`, and the assistant/result event branches being modified.
- **Why it matters:** The first acceptance criterion could pass by having the fake runner omit `usage`, without proving that production Claude partials avoid fabricated all-zero usage before real telemetry. Step 3.8 covers the production spawn path for assistant/result events, but the injected-runner test should not be treated as proof of `runClaudeHeadless` behavior.
- **Recommendation:** Either reframe Step 3.7 as a buffering/adapter test, or move the no-fabricated-usage assertion into the `__test__.setSpawn` production-path test by streaming pre-assistant Claude events and asserting no emitted partial contains all-zero fabricated usage.

### Summary

The plan is generally well structured and maps the main lifecycle/telemetry changes to the relevant files with concrete tests and verify recipes. However, it has 2 errors and 2 warnings: the Task 1 abort-sweep instruction would be wrong if implemented literally, and the plan omits direct coverage for the spec’s background `wait:false` steer-back acceptance criterion. The sparse-array and Claude injected-runner tests also need tightening to verify the intended behavior. The plan is not ready for execution until the blocking issues are corrected.
