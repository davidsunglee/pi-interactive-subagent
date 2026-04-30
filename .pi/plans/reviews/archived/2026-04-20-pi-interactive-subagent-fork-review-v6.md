# Review: `2026-04-20-pi-interactive-subagent-fork-v6.md`

Reviewed: 2026-04-20
Plan: `.pi/plans/2026-04-20-pi-interactive-subagent-fork-v6.md`
Verdict: **Needs one more revision before implementation**

## Summary

v6 fixes the concrete v5 blocker:

- orchestration now preserves the bare tool's self-spawn guard
- the README wording no longer claims tool-call abort cancels orchestration waits
- the final sweep now includes `default-deps.test.ts`

So this is materially better.

I do still see two issues worth fixing before implementation:

1. the orchestration task schema silently drops several already-supported `subagent` inputs while claiming only `interactive` / `permissionMode` are omitted
2. the new README/plugin guidance still points users to a widget-level cancel path that does not actually exist in the current codebase or task list

## Blocking findings

### 1) `subagent_serial` / `subagent_parallel` are still not true wrappers over the existing `subagent` surface

The plan describes orchestration handlers as thin wrappers around the existing launch/watch primitives, but the proposed task schema is much narrower than the real `subagent` parameter surface.

#### Current reality in the repo

`pi-extension/subagents/index.ts` already accepts these per-call inputs on `SubagentParams`:

- `systemPrompt`
- `skills`
- `tools`
- `cwd`
- `fork`
- `resumeSessionId`
- plus the new `cli` / `thinking` / `focus`

And `launchSubagent(params, ctx)` consumes that full param bag.

#### What v6 proposes instead

**Task 8** defines `OrchestrationTaskSchema` with only:

- `name`
- `agent`
- `task`
- `cli`
- `model`
- `thinking`
- `cwd`
- `focus`

Then **Task 13** forwards only that same subset into `launchSubagent(...)`.

The comment in Task 8 says:

> `interactive` and `permissionMode` are intentionally omitted — `launchSubagent()` does not currently accept them.

But that is no longer the full story. The wrappers are also omitting several fields that `launchSubagent()` **does** already accept today.

#### Why this matters

This would create an avoidable capability regression for the new tools:

- no per-step `skills` override in serial/parallel pipelines
- no per-step `tools` override
- no per-step `systemPrompt`
- no per-step `fork`
- no per-step `resumeSessionId`

So the wrappers would not actually be “thin wrappers” over the existing tool; they would be a reduced API surface with no explicit design callout.

#### Recommended fix

Either:

1. **add the already-supported fields to `OrchestrationTaskSchema` and plumb them through `makeDefaultDeps.launch()`**, or
2. **explicitly scope orchestration to a reduced task shape** and update the architecture/docs to say that loss of parity is intentional

Given the current plan text, I would recommend option 1.

### 2) Task 18 still documents a cancellation path that does not exist

v6 fixed the earlier overclaim about aborting the surrounding tool call, but the replacement wording still says a missing Claude plugin can be cancelled:

> through the widget

and even describes:

> the widget's per-subagent cancel action aborts the running wait

#### Why this is still incorrect

I do not see any widget cancel action in the current codebase, nor any task in this plan that adds one.

What I do see is:

- `RunningSubagent.abortController` exists
- bare `subagent` and `subagent_resume` set it
- `makeDefaultDeps.waitForCompletion` would set it for orchestration waits
- **but the only code path that actually aborts those controllers today is `session_shutdown`**

I do **not** see:

- a widget action
- a shortcut
- a tool
- or any other user-triggerable UI path

that aborts an individual running wait.

So in the missing-plugin scenario, the README would still tell users to use an escape hatch that is not actually implemented.

#### Recommended fix

Either:

1. **add a real cancel action** for running subagents/orchestration waits, or
2. **rewrite the README section to describe the actual recovery path honestly**

Until such a cancel path exists, I would avoid mentioning widget cancellation at all.

## Non-blocking finding

### 3) The new `cli` / `thinking` fields are documented as enums but implemented as free-form strings

In Task 4 and Task 8, both schemas use `Type.String()` for:

- `cli`
- `thinking`

But the plan text documents them as having a constrained set of supported values.

That means typos will be accepted silently:

- bad `cli` values fall back to the pi path
- bad `thinking` values are dropped on Claude (`thinkingToEffort(...) => undefined`) but still pass through into the pi model suffix

This is probably survivable for v1, but it is worth deciding explicitly whether the wrappers should:

- validate these values at the schema boundary, or
- continue accepting arbitrary strings and document the fallback behavior

## Recommended revisions

1. **Restore full `subagent`-parameter parity for orchestration tasks**
   - add/pass through the already-supported fields (`systemPrompt`, `skills`, `tools`, `fork`, `resumeSessionId`), or explicitly scope them out in docs/architecture

2. **Fix the missing-plugin cancellation docs**
   - do not reference a widget cancel action unless the plan actually implements one

3. **Optionally tighten `cli` / `thinking` validation**
   - use enums or document the current fallback behavior

## Bottom line

v6 is close, and the major v5 runtime-safety issue is fixed.

I would make one more revision for orchestration parameter parity and the missing-plugin cancellation docs, then I'd be comfortable calling the plan implementation-ready.
