# Plan review: `2026-04-20-mux-free-execution-design-v17.md`

## Verdict

[Issues Found]

## What is strong

- The plan is materially stronger and more execution-ready than earlier revisions. The previously-open gaps around Claude final-message duplication, Claude archival content checks, the long-running shutdown fixture, selector auto-mode coverage, and Claude `usage.cost > 0` have all been tightened.
- The no-mux story is now concretely exercised across all three entrypoints: bare `subagent`, `subagent_serial`, and `subagent_parallel`, with explicit shutdown tracking for bare headless runs.
- Claude-specific hardening is generally strong: shared tool mapping, `--tools` plus the required `--` separator, session-id transcript discovery, symmetric skills warnings, `tool_result` projection, and `resumeSessionId` coverage are all called out with named implementation steps and tests.
- The orchestration-owned `TranscriptMessage` boundary remains a sensible strengthening over the spec's older `Message[]` shape, and the plan is consistent about that boundary throughout the later phases.

## Findings

### Error — Claude model normalization still diverges between pane and headless backends

**Plan locations:**
- Task 17 Step 3 (`buildClaudeCmdParts` call site still passes `model: effectiveModel` to the pane builder with no new normalization step)
- Task 19 Step 1 (`buildClaudeHeadlessArgs` strips provider prefixes via `slashIdx >= 0 ? spec.effectiveModel.slice(slashIdx + 1) : spec.effectiveModel` and adds a dedicated `"strips provider prefix on the model arg"` test)

**Problem:** The plan now makes the headless Claude argv normalize provider-prefixed model names (for example `anthropic/claude-haiku-4-5` → `claude-haiku-4-5`), but it never applies the same normalization to the pane Claude path. Task 17 explicitly threads `effectiveModel` straight into `buildClaudeCmdParts`, while Task 19 explicitly strips the prefix only in `buildClaudeHeadlessArgs`.

**Why this matters:** The plan's own architecture leans hard on one shared launch contract for pane and headless, but this leaves the two Claude backends with different model-resolution behavior for the same resolved spec. That is not a theoretical edge case: the repo's own agent/docs examples use provider-prefixed models such as `anthropic/claude-sonnet-4-6`. Under this plan, a provider-prefixed Claude model can work on headless while still being passed differently on pane, which violates the stated backend-parity goal and risks a user-visible pane/headless mismatch.

**Actionable fix direction:** Normalize Claude model names in one shared place and use that in **both** builders, or add the same provider-prefix stripping to `buildClaudeCmdParts` plus a pane-side regression test that uses a provider-prefixed model input.

### Warning — Task 20's `usage.cost > 0` smoke gate is not actually made non-cached, so it can fail spuriously

**Plan locations:** Task 20 Step 1 (`headless-claude-smoke.test.ts`)

**Problem:** The test asserts:

```ts
assert.ok(result.usage!.cost > 0, ...)
```

and explains that this must hold for a "non-cached, freshly-run Claude task", but the task prompt is still the static string `Reply with exactly: OK`. Nothing in the plan makes that run unique or cache-busting.

**Why this matters:** A correct implementation can still legitimately report zero cost on a cache hit or reused accounting path, which would make this phase gate fail for the wrong reason. That turns a load-bearing smoke test into a flaky false-negative source instead of a reliable parser regression check.

**Actionable fix direction:** Keep the stronger `> 0` assertion, but make the run genuinely fresh — for example by embedding a per-test unique marker in the prompt so the smoke run is not cache-reused.

## Non-blocking simplification suggestions

- **Simplify Task 9c's release-sequencing branch logic.** The current "pick one of three strategies" checkpoint is careful, but long. Choosing one default strategy (feature branch isolation or one explicit feature gate) would make execution simpler without losing safety.
- **Fold Task 12b into the first headless-pi integration task.** `copyTestAgents(dir)` is a tiny harness helper whose only purpose is to unblock the next tests; keeping it as its own task/commit is more ceremony than value.
- **Move `warnClaudeSkillsDropped` into a tiny shared helper module.** That would shorten the Task 17/19 explanation and avoid the `index.ts` ↔ `headless.ts` utility coupling, while preserving the single-source-of-truth warning text.

## Overall assessment

This revision is close. The plan has resolved the earlier high-value structural gaps and now reads like something an implementer could execute phase by phase. The one remaining blocking issue is a backend-parity hole on Claude model handling: the headless path now normalizes provider-prefixed models, but the pane path still does not, which breaks the plan's own shared-launch-contract story for a very common input shape. Fix that, and the remaining concern is mostly test hygiene around making the non-zero-cost Claude smoke truly uncached.
