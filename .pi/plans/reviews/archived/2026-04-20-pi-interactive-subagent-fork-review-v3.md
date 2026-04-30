# Review: `2026-04-20-pi-interactive-subagent-fork-v3.md`

Reviewed: 2026-04-20
Plan: `.pi/plans/2026-04-20-pi-interactive-subagent-fork-v3.md`
Verdict: **Needs one more revision before implementation**

## Summary

v3 fixes the important issues from the earlier reviews:

- Claude transcript recovery is now aligned with the real execution order
- widget startup is moved into `launchSubagent()`
- `{previous}` substitution is made literal-safe
- per-tool registration/preflight is much cleaner

So this is substantially closer to implementation-ready than v2.

However, one real behavior gap is still baked into the orchestration core: the proposed failure semantics only work for subagents that return a normal `OrchestrationResult`. They do **not** hold when `launch()` / `waitForCompletion()` throw, which is still possible in the real code path. That matters because the plan and README both promise per-task reporting for failures.

## Blocking finding

### 1) `runSerial` / `runParallel` still collapse on thrown launch/wait errors, so the advertised failure semantics are incomplete

The plan's orchestration story is:

- `runSerial` stops on first failure and reports completed + failing steps
- `runParallel` allows partial failures without cancelling siblings, and reports one result per task

But the proposed implementations in Task 10 and Task 12 only handle **returned** failure states:

- `result.exitCode !== 0`
- `result.error`

They do **not** catch exceptions from:

- `deps.launch(...)`
- `deps.waitForCompletion(...)`

That is a real gap, because the production path can still throw before a result object exists. For example, `launchSubagent()` can throw from mux/surface creation or command dispatch even after the basic preflight passes.

#### Why this breaks the current plan

**Serial path** (`runSerial`):
- if `deps.launch()` or `deps.waitForCompletion()` throws on step N,
- the function rejects,
- the tool handler falls into its top-level `catch`,
- and already-completed earlier results are lost from the returned payload.

That contradicts the Task 9/10 expectation that serial mode reports prior steps plus the failing step.

**Parallel path** (`runParallel`):
- each worker does `await deps.launch(...)` then `await deps.waitForCompletion(...)` with no per-task `try/catch`
- a single thrown exception rejects that worker
- `Promise.all(workers)` then rejects the entire orchestration
- the tool handler returns one top-level error instead of the promised per-task aggregation

That contradicts Task 15 / Task 18's user-facing claim that partial failures do not cancel siblings and each task result is reported.

#### Recommended fix

Normalize exception paths into synthetic `OrchestrationResult` entries inside the orchestration cores.

Concretely:

- wrap each serial step in `try/catch`
- wrap each parallel worker task in `try/catch`
- on exception, synthesize something like:

```ts
{
  name: task.name ?? inferredName,
  finalMessage: "",
  transcriptPath: null,
  exitCode: 1,
  elapsedMs,
  error: err?.message ?? String(err),
}
```

Then:

- **serial**: append the synthetic failing result and return `{ results, isError: true }`
- **parallel**: store the synthetic failing result at that task's input index, keep other workers running, and return the full aggregated array with `isError: true`

Also add explicit tests for:

- `deps.launch()` throwing in serial mode
- `deps.waitForCompletion()` throwing in serial mode
- one task throwing in parallel while siblings still complete and remain reported in input order

## Non-blocking findings

### 2) Task 17's "integration test" is still only a placeholder

Task 17 is framed as the Claude sentinel roundtrip integration test, but the proposed body is just a skip-gated `assert.ok(true)` placeholder.

That means the highest-risk path from the earlier reviews — Claude completion + archived transcript path recovery — still has no automated end-to-end verification. The manual smoke checklist helps, but the task name overstates what the test actually proves.

I would either:

- rename/reframe it as a smoke-test scaffold, or
- add a real harness assertion when Claude/plugin prerequisites are available.

### 3) The README work is still somewhat internally inconsistent

The rebrand itself is improved, but a few planned doc statements still do not match the actual implementation being proposed:

- the current README intro says the package is **"Fully non-blocking"**, but the new orchestration tools are explicitly blocking wrappers
- Task 18 says parallel panes are **spawned detached by default**, but Task 4 documents that `focus: false` is only honored on tmux today
- Task 18 says a missing Claude plugin will **time out after ~30s** with a specific error, but this timeout/error path is not implemented anywhere in the plan
- the existing README sections for `spawning: false`, `deny-tools`, and the parameter/frontmatter reference are not updated to reflect the two new tools and the new `cli` / `thinking` / `focus` fields

None of that should block the code work, but I would tighten the README tasks before calling the docs complete.

## Recommended revisions

1. **Fix exception-path handling in `runSerial` / `runParallel`**
   - Convert thrown launch/wait errors into synthetic `OrchestrationResult` entries.
   - Preserve input-order aggregation and the advertised partial-failure behavior.

2. **Add tests for thrown orchestration failures**
   - Serial: `launch` throw and `waitForCompletion` throw.
   - Parallel: one task throws while siblings still complete and are reported.

3. **Tighten the docs/test wording**
   - Reframe the placeholder integration test honestly.
   - Update README language around blocking behavior, detach support, plugin behavior, and spawning/docs tables.

## Bottom line

v3 is much better and appears to have resolved the earlier architectural blockers.

I still would revise it once more before implementation, mainly to fix the orchestration exception path so the runtime behavior actually matches the plan's promised failure semantics.
