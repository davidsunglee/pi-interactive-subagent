# Review: `2026-04-20-pi-interactive-subagent-fork-v4.md`

Reviewed: 2026-04-20
Plan: `.pi/plans/2026-04-20-pi-interactive-subagent-fork-v4.md`
Verdict: **Needs one small revision before implementation**

## Summary

v4 is much tighter than the earlier versions.

It fixes the main architectural gaps from v3:

- thrown `launch()` / `waitForCompletion()` errors are now handled in both orchestration cores
- the placeholder Claude integration task is framed honestly as a scaffold
- the README work is much closer to the actual implementation

So at this point the plan is very close.

I do still see one real contract gap in the proposed `transcriptPath` unification work: the success paths are updated, but the `watchSubagent()` error/cancel path is not. Since the orchestration layer is supposed to read `sub.transcriptPath` directly in all cases, I would patch that before implementation.

## Blocking finding

### 1) The new required `transcriptPath` contract is still incomplete on the `watchSubagent()` catch path

Task 7 intentionally makes `SubagentResult.transcriptPath` **required** and describes it as the uniform contract that lets orchestration read transcript location directly from `watchSubagent()`.

That is the right direction, but the proposed edits only update the two **successful** return branches:

- Claude success return
- pi success return

The existing `watchSubagent()` catch block still returns objects shaped like:

```ts
return {
  name,
  task,
  summary: "Subagent cancelled.",
  exitCode: 1,
  elapsed: ...,
  error: "cancelled",
};
```

and:

```ts
return {
  name,
  task,
  summary: `Subagent error: ...`,
  exitCode: 1,
  elapsed: ...,
  error: ...,
};
```

with **no `transcriptPath` field**.

#### Why this matters

This is not just a type-nit.

Task 13's `makeDefaultDeps()` explicitly treats `watchSubagent()` as the single source of truth:

```ts
transcriptPath: sub.transcriptPath,
```

So on real cancel / poll-error / IO-error paths, orchestration will surface:

- `transcriptPath: undefined` at runtime, or
- a broken `SubagentResult` contract if type-checking is enforced later.

That undercuts the plan's stated goal of making `transcriptPath` uniform and reliable across the production completion path.

#### Recommended fix

Extend Task 7 Step 3 (or add a tiny Step 3b) so the `watchSubagent()` catch block also returns:

```ts
transcriptPath: null,
```

for both:

- cancelled runs
- generic error runs

I would also add one focused test somewhere in the orchestration/default-deps area that exercises a failure result from `watchSubagent()` and asserts the wrapper returns `transcriptPath: null`, not `undefined`.

## Non-blocking findings

### 2) The README update step still blurs tool parameters vs frontmatter for `focus`

Task 18 Step 2 says to update the existing parameter / frontmatter reference so it includes:

- `cli`
- `thinking`
- `focus`

That is only partly true.

- `cli` and `thinking` are valid agent-frontmatter fields today
- `focus` is **not** parsed from frontmatter in the current code or the plan; it is only a per-call tool parameter

So I would tighten the wording here to avoid accidentally documenting `focus` as an agent frontmatter field.

Suggested tweak:

- add `cli` and `thinking` to the frontmatter reference
- add `focus` only to the tool-parameter reference

### 3) Task 15's `subagent_parallel` tool description still overstates detached spawning

The README text was corrected in v4 to say detach is only honored on tmux.

But the proposed `subagent_parallel` registration text in Task 15 still says:

> Panes are spawned detached by default

without the backend qualifier.

That string is user-facing tool metadata, so it should match the actual behavior too.

I would align the tool description / prompt snippet with the README wording, e.g.:

- detached by default on tmux
- other backends may still focus the new pane

### 4) `DEFAULT_SENTINEL_TIMEOUT_MS = 30_000` now looks like dead/confusing API surface

Task 8 adds:

```ts
export const DEFAULT_SENTINEL_TIMEOUT_MS = 30_000;
```

But v4 very explicitly says there is **no dedicated 30s Claude-plugin timeout** in this plan.

Since the constant is not used elsewhere in the plan, it now reads like leftover design debris and risks reintroducing the same doc confusion v4 just corrected.

I'd either:

- remove it from the plan entirely, or
- rename/comment it as reserved future work if you want to keep the placeholder.

## Recommended revisions

1. **Complete the `transcriptPath` contract on all `watchSubagent()` returns**
   - Add `transcriptPath: null` to the cancel/error returns in the catch block.
   - Optionally add one test proving orchestration surfaces `null`, not `undefined`, on error paths.

2. **Split docs ownership cleanly**
   - `cli` / `thinking`: parameters + frontmatter reference
   - `focus`: parameters only

3. **Align tool metadata with backend reality**
   - Update Task 15's `subagent_parallel` description/prompt text so detach is explicitly tmux-only.

4. **Drop or clearly defer the unused timeout constant**
   - Avoid leaving a misleading `30_000` sentinel timeout symbol in the shared types.

## Bottom line

v4 looks close to implementation-ready.

I would make one more small revision for the `watchSubagent()` error-path `transcriptPath` contract, then I'd be comfortable treating the plan as ready.