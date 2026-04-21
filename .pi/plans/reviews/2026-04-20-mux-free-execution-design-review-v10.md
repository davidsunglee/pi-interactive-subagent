# Review: 2026-04-20-mux-free-execution-design-v8.md

Reviewed: 2026-04-21  
Plan: `.pi/plans/2026-04-20-mux-free-execution-design-v8.md`  
Verdict: **v8 closes the prior test-validity gaps, but two production-facing design issues remain**  
Ready to merge: **With fixes**

## Summary

v8 is materially better than v7. The two issues called out in review-v9 are actually addressed:

- the pane-Claude restriction test now uses a real filesystem side effect instead of assistant prose as the oracle (`.pi/plans/2026-04-20-mux-free-execution-design-v8.md:9-11`)
- the no-mux orchestration gate now covers both forced headless and the default auto/no-mux fallback (`.pi/plans/2026-04-20-mux-free-execution-design-v8.md:11,69,4521-4526`)

The remaining concerns are narrower, but still worth fixing before implementation starts:

1. the plan removes `@mariozechner/pi-ai` from `package.json` while still directly importing `Message` from that package in the proposed headless implementation
2. the Claude-skills warning is only added on the headless path, even though the plan says the limitation applies to both Claude backends and the existing pane-Claude path still silently drops skills

## Strengths

- **The launch-spec seam is still the right refactor.** Extracting normalization out of `launchSubagent()` continues to line up with the actual concentration of behavior in the current code (`.pi/plans/2026-04-20-mux-free-execution-design-v8.md:39-41`; `pi-extension/subagents/index.ts:697-965`).
- **The validation story is much stronger now.** v8’s new no-mux auto fallback gate and the side-effect-based Claude restriction test materially improve confidence in the security-sensitive and user-default paths (`.pi/plans/2026-04-20-mux-free-execution-design-v8.md:9-11,69,4521-4526`).
- **The transcript boundary is described more honestly than earlier revisions.** The plan no longer tries to pass pi messages through as if they were the public transcript contract; the projection language is the right direction (`.pi/plans/2026-04-20-mux-free-execution-design-v8.md:15,40,2057-2063`).

## Prioritized findings

### 1) Removing `@mariozechner/pi-ai` from `package.json` is inconsistent with the proposed direct imports and creates package-resolution fragility

**Severity: Moderate**

The plan explicitly says the direct dependency is no longer required and should be removed from `package.json` (`.pi/plans/2026-04-20-mux-free-execution-design-v8.md:47,91`). But Task 11 still adds a direct import from that package in the proposed implementation:

- `import type { Message } from "@mariozechner/pi-ai"` (`.pi/plans/2026-04-20-mux-free-execution-design-v8.md:1873`)
- `projectPiMessageToTranscript(msg: Message)` (`.pi/plans/2026-04-20-mux-free-execution-design-v8.md:2057`)
- `event.message as Message` at the stream parse sites (`.pi/plans/2026-04-20-mux-free-execution-design-v8.md:2198,2226`)

Current `package.json` does **not** declare `@mariozechner/pi-ai` directly in either peers or devDependencies (`package.json:22-35`). The review text argues this is fine because the package is reachable via transitive resolution through `@mariozechner/pi-coding-agent`, but that is not a stable contract. Direct imports of transitive packages only work when the package manager happens to hoist them to a resolvable top-level location; that can break under different installers, version skew, or future dependency layout changes.

So the plan currently says both:

- “remove the direct dependency because it is no longer needed”
- “import a type directly from that package in the new implementation”

Those are in tension.

#### Recommended fix

Pick one of these and make the plan consistent:

1. **Keep `@mariozechner/pi-ai` as a direct dependency** (at least a devDependency, and possibly a peer if you want to make the contract explicit), or
2. **Stop importing it directly** by defining a local minimal raw-stream message type for the headless parser boundary, or by using an exported type from `@mariozechner/pi-coding-agent` if one is available for the needed shape.

I would prefer option 2 if the goal is truly to avoid leaking a new public dependency, but either approach is better than relying on transitive hoisting.

### 2) The Claude-skills warning remains headless-only, so pane-Claude still silently drops skills despite the plan framing this as a Claude-backend limitation

**Severity: Moderate**

The architecture section says the Claude backend — pane **and** headless — does not consume `skillPrompts` in v1 (`.pi/plans/2026-04-20-mux-free-execution-design-v8.md:39,45`). It also justifies adding a warning specifically to avoid silently dropping user-declared skills (`.pi/plans/2026-04-20-mux-free-execution-design-v8.md:45,3554-3555`).

But the concrete implementation and tests only add that warning on the **headless** path:

- the warning is described at `runClaudeHeadless` / Task 19 (`.pi/plans/2026-04-20-mux-free-execution-design-v8.md:3554-3555`)
- the dedicated test file is `test/integration/headless-claude-skills-warning.test.ts` (`.pi/plans/2026-04-20-mux-free-execution-design-v8.md:78`)

Meanwhile, the current pane-Claude path still has no place for skills and no warning surface:

- `ClaudeCmdInputs` has no skills field (`pi-extension/subagents/index.ts:656-664`)
- `buildClaudeCmdParts(...)` accepts model/system-prompt/resume/thinking/task only (`pi-extension/subagents/index.ts:666-688`)
- the Claude launch branch passes exactly those values and nothing related to skills (`pi-extension/subagents/index.ts:741-756`)

So after this plan, a user running `cli: "claude"` through the existing pane path would still get a silent drop of `skills:` — precisely the confusing behavior the plan says it wants to avoid.

#### Recommended fix

Make the behavior consistent across Claude backends:

- add the same one-line warning on the pane-Claude launch path in `launchSubagent()` when effective Claude skills are non-empty, and test it, **or**
- narrow the plan text/docs so they explicitly say the warning is headless-only and that pane-Claude still silently ignores skills in v1

The first option is much better. If the limitation is truly “Claude backend cannot consume pi-style skills,” users should get the same warning regardless of whether orchestration selected pane or headless.

## Assessment

**Ready to merge: With fixes**

I do not see a new blocker in the v8 fixes themselves; the prior review findings appear addressed. But I would not treat the plan as implementation-ready yet because:

1. the dependency story around `@mariozechner/pi-ai` is internally inconsistent and brittle
2. the Claude-skills warning is only designed/tested for headless, while pane-Claude keeps the same silent-drop behavior the plan is trying to eliminate

Once those are tightened, this plan looks close to implementation-ready.