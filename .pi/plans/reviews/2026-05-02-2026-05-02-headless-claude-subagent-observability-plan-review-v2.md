**Reviewer:** openai-codex/gpt-5.5 via pi

### Status

**[Issues Found]**

### Issues

**[Error] — Task 5: Fake runner uses the wrong test seam argument name**
- **What:** Step 5.1 says the `__test__.makeHeadlessBackendWithRunner` runner accepts `({ emitPartial, signal })` and must subscribe with `signal.addEventListener("abort", ...)`. The actual seam passes the abort signal as `abort`, not `signal`.
- **Why it matters:** An executor following the plan will destructure `signal` as `undefined`, so the abort subscription in the end-to-end regression test will fail or silently not test cancellation. This blocks the planned cancellation acceptance criterion.
- **Recommendation:** Update Task 5 to use the actual runner argument (`abort`) consistently, or explicitly adapt it to a local `signal` variable before subscribing.

**[Error] — Task 4: Sparse-array implementation direction conflicts with the sparse-array requirement**
- **What:** Step 4.2 directs replacing the existing `.map((r) => ...)` body with another `.map((r, i) => ...)` mapper. That does not visit holes in `new Array(3)`, even though Step 4.3 and the task goal require `toTaskRows` to produce a placeholder row for every sparse-array index.
- **Why it matters:** The implementation can still return an array with holes, so `rows[0]` remains `undefined` and rendering can still drop/crash on sparse slots. This fails the stated defensive-rendering requirement.
- **Recommendation:** Change the task instructions to require an iteration strategy that visits every index (`Array.from({ length: results.length }, (_, i) => ...)` or a `for` loop), and ensure the test uses a real sparse array such as `new Array(3)`.

**[Warning] — Task 4: Acceptance verify recipe does not actually verify real sparse arrays**
- **What:** The second acceptance criterion says `toTaskRows` must not throw on sparse arrays and must produce a row per input index, but its `Verify:` line checks `Array.from({ length: 3 }, () => undefined)`, which is a dense array of explicit `undefined` values rather than a holey/sparse array.
- **Why it matters:** The plan could pass the acceptance check while leaving the real sparse-array case broken, especially if the implementation keeps using `.map`.
- **Recommendation:** Make the verify recipe assert against `toTaskRows(new Array(3) as any)` (or another true holey array) and check that each index contains a pending placeholder row.

### Summary

The plan is generally well structured and maps closely to the spec’s lifecycle, telemetry, widget, and rendering goals, with one-to-one `Verify:` lines present for the acceptance criteria. However, there are 2 errors and 1 warning: Task 5 references a non-existent `signal` argument from the headless backend test seam, and Task 4’s implementation/testing instructions do not reliably handle true sparse arrays. The plan is not ready for execution until those structural issues are corrected.
