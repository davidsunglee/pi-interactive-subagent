# Review: `2026-04-20-pi-interactive-subagent-fork-v5.md`

Reviewed: 2026-04-20
Plan: `.pi/plans/2026-04-20-pi-interactive-subagent-fork-v5.md`
Verdict: **Needs one more small revision before implementation**

## Summary

v5 fixes the concrete issues from the v4 review:

- `transcriptPath` is now described consistently across all `watchSubagent()` return paths
- the docs split `cli` / `thinking` vs `focus` ownership correctly
- tmux-only detach behavior is called out in the tool metadata
- the dead timeout constant is gone

So this is very close.

I do still see one real runtime safety gap in the orchestration path: the new spawning tools bypass the existing self-spawn protection that the bare `subagent` tool already enforces. Since `subagent_serial` / `subagent_parallel` are explicitly being added to the spawning-tool family, I would patch that before implementation.

## Blocking finding

### 1) `subagent_serial` / `subagent_parallel` bypass the existing self-spawn guard

Today the bare `subagent` tool has an explicit recursion guard in `pi-extension/subagents/index.ts`:

```ts
const currentAgent = process.env.PI_SUBAGENT_AGENT;
if (params.agent && currentAgent && params.agent === currentAgent) {
  return {
    ...,
    details: { error: "self-spawn blocked" },
  };
}
```

That matters because it prevents things like:

- `planner` spawning another `planner`
- `worker` spawning another `worker`
- accidental recursive delegation loops inside subagent contexts

In v5, the orchestration path is wired like this:

- **Task 13**: `makeDefaultDeps.launch()` calls `launchSubagent(...)` directly
- **Task 15**: tool handlers only run `preflight(...)`
- **Task 16**: the new tools are registered as part of the same spawning extension surface

But `launchSubagent()` itself does **not** contain the self-spawn check today; that check lives only in `subagent.execute`.

#### Why this matters

That means a subagent that is allowed to spawn can call:

```json
{
  "tasks": [
    { "agent": "planner", "task": "..." }
  ]
}
```

from inside a `planner` session, and the orchestration wrapper will happily launch another `planner` because it bypasses the bare tool's execute-layer guard.

So this is not just a missing nicety. It changes an existing runtime safety invariant for the new tools.

#### Recommended fix

Add a shared spawn-target validation helper and use it in both places:

- bare `subagent.execute`
- orchestration handlers before building deps / launching anything

Concretely, either:

1. **reject the whole orchestration call early** if any task targets `process.env.PI_SUBAGENT_AGENT`, or
2. **record a synthetic per-task failure** at the offending index

I would lean toward the early reject for v1 because it matches the existing simple behavior of the bare tool.

I would also add one test in `test/orchestration/tool-handlers.test.ts` proving that a current `planner` cannot launch a `planner` via `subagent_serial` or `subagent_parallel`.

## Non-blocking findings

### 2) Task 18 still overstates cancellation behavior for missing Claude plugin installs

Task 18 Step 3 currently says that if the Claude plugin is missing, polling continues until the caller cancels the subagent:

> through the widget or by aborting the tool call

But the deferred section later says tool-signal cancellation propagation is still out of scope:

- `runSerial` / `runParallel` do not thread the tool `AbortSignal` into `waitForCompletion`
- `default-deps` creates its own local `AbortController`

So, in this plan, **aborting the tool call is not yet a real cancellation path** for orchestration waits.

I would tighten that README wording to say widget/manual cancellation only, until signal propagation is actually implemented.

### 3) Task 19's expected test-file listing is now missing `default-deps.test.ts`

Task 13 adds:

- `test/orchestration/default-deps.test.ts`

But Task 19 Step 3's expected output still lists only:

- `run-parallel.test.ts`
- `run-serial.test.ts`
- `thinking-effort.test.ts`
- `tool-handlers.test.ts`

So the final verification checklist no longer matches the plan's own produced file layout. Small fix, but worth cleaning up so the last sweep is mechanically accurate.

## Recommended revisions

1. **Restore self-spawn protection for orchestration tools**
   - Extract a shared helper for the existing `PI_SUBAGENT_AGENT` recursion check.
   - Apply it to `subagent_serial` / `subagent_parallel` before any launch occurs.
   - Add a focused test for the blocked self-spawn case.

2. **Fix the README/plugin wording around cancellation**
   - Remove the claim that aborting the tool call cancels the wait until that plumbing exists.

3. **Update the final sweep file-layout expectation**
   - Include `test/orchestration/default-deps.test.ts` in Task 19.

## Bottom line

v5 is close and resolves the earlier review's real gaps.

I would make one more revision for orchestration self-spawn protection, then I'd be comfortable calling the plan implementation-ready.