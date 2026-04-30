# Review: 2026-04-20-mux-free-execution-design-v9.md

Reviewed: 2026-04-21  
Plan: `.pi/plans/2026-04-20-mux-free-execution-design-v9.md`  
Verdict: **v9 closes the direct pi-ai import gap and adds the missing pane-Claude warning path, but the plan still has one real launch-contract inconsistency and one test-validity gap**  
Ready to merge: **With fixes**

## Summary

v9 materially improves on v8:

- it removes the lingering direct `@mariozechner/pi-ai` type import from the proposed headless pi backend (`.pi/plans/2026-04-20-mux-free-execution-design-v9.md:7-10,53,1859-1888,2067-2096`)
- it adds a shared `warnClaudeSkillsDropped(...)` helper and threads it into the pane-Claude path as well as headless (`.pi/plans/2026-04-20-mux-free-execution-design-v9.md:11,51,96,3242-3287,4066-4098`)

Those address the two moderate findings from review-v10 at the design level.

However, I do not think the plan is implementation-ready yet. Two issues remain:

1. the Claude side of the shared launch-spec contract is internally inconsistent about **where identity/system-prompt text comes from and whether it belongs in the task body vs. a Claude `--system-prompt` flag**
2. the new pane-Claude warning “integration” coverage does **not** actually exercise the pane launch path, even though the plan claims it does

## Strengths

- **The v10 dependency fragility is actually fixed.** Replacing the proposed pi-ai `Message` import with a local parser-boundary type is the right direction for a fork that does not declare `@mariozechner/pi-ai` directly (`.pi/plans/2026-04-20-mux-free-execution-design-v9.md:9-10,53,1880-1888,2067-2096`).
- **The warning behavior is better centralized now.** Moving the Claude-skills warning wording into one helper is cleaner than keeping inline strings in two code paths (`.pi/plans/2026-04-20-mux-free-execution-design-v9.md:11,96,3246-3287,4066-4098`).
- **The review history is being incorporated concretely.** v9 keeps the earlier test-oracle and auto/no-mux fixes rather than regressing them (`.pi/plans/2026-04-20-mux-free-execution-design-v9.md:15-17,83-86,4774-4895`).

## Prioritized findings

### 1) The shared launch-spec contract is still inconsistent for Claude system-prompt handling, so headless Claude can diverge from pane behavior and from the spec’s own semantics

**Severity: Moderate**

Task 9b says `resolveLaunchSpec()` should lift the current identity/system-prompt logic from `launchSubagent()` (`.pi/plans/2026-04-20-mux-free-execution-design-v9.md:1654-1669`). In the current code, that logic is:

- `identity = agentDefs?.body ?? params.systemPrompt ?? null`
- `identityInSystemPrompt = systemPromptMode && identity`
- when `identityInSystemPrompt` is false, the identity text is placed into `fullTask`

That is what the current implementation does at `pi-extension/subagents/index.ts:823-829`, and the new `resolveLaunchSpec` test in the plan explicitly asserts the same behavior for a direct `systemPrompt`: `identityInSystemPrompt === false` and `fullTask` contains the text (`.pi/plans/2026-04-20-mux-free-execution-design-v9.md:1559-1569`).

But the Claude steps then describe and implement something different:

- the pane-Claude path still uses `appendSystemPrompt: params.systemPrompt ?? agentDefs?.body` (`.pi/plans/2026-04-20-mux-free-execution-design-v9.md:1669,3230-3235`) — **opposite precedence** from the lifted `identity = agentDefs?.body ?? params.systemPrompt`
- the headless Claude arg builder emits a Claude system-prompt flag whenever `spec.identity` is present (`.pi/plans/2026-04-20-mux-free-execution-design-v9.md:3796,3859-3863`), without checking `spec.identityInSystemPrompt`

That leaves the plan in an internally inconsistent state:

- the shared spec/test says a plain per-call `systemPrompt` with no mode belongs in `fullTask`
- the headless Claude builder would still force it into `--append-system-prompt`
- the pane Claude path uses caller `systemPrompt` before agent body, while the spec lift uses agent body before caller `systemPrompt`

So a launch that combines an agent body and a per-call `systemPrompt` can pick different text on pane vs. headless Claude, and even a plain direct `systemPrompt` case is not aligned with the spec’s own `identityInSystemPrompt` flag.

#### Recommended fix

Pick one authoritative Claude contract and thread it all the way through:

1. decide whether Claude should honor the **shared spec semantics** (`identityInSystemPrompt` governs flag vs. task-body placement), or intentionally preserve the current pane-Claude behavior as a separate contract
2. use the **same precedence rule** on both backends for agent body vs. per-call `systemPrompt`
3. add a focused test covering the mixed case: agent body present **and** caller `systemPrompt` provided, for both pane and headless Claude

Right now the plan says “shared launch normalization” but still encodes two competing rules.

### 2) The new pane-Claude warning “integration” test does not exercise the pane launch path, so it cannot catch the regression it claims to guard against

**Severity: Moderate**

The new second describe block in `pane-claude-tool-restriction.test.ts` is described as proving that “the pane-path call site still calls” the shared warning helper (`.pi/plans/2026-04-20-mux-free-execution-design-v9.md:3488-3495`). But the test body does not call `launchSubagent()` or any pane launch flow. It only dynamically imports the helper and invokes `warnClaudeSkillsDropped(...)` directly (`.pi/plans/2026-04-20-mux-free-execution-design-v9.md:3499-3516`).

That means the following regression would still pass every new v9 warning test:

- someone removes `warnClaudeSkillsDropped(...)` from `launchSubagent()`’s Claude branch
- the unit test still passes because the helper itself still works
- this “integration” test still passes because it also calls the helper directly

So the plan claims to have added pane-path regression coverage, but the proposed test does not actually cover that behavior.

#### Recommended fix

Keep the helper unit test, but replace the pane “integration” test with one that actually traverses the pane launch path without needing a real Claude invocation. For example:

- stub `createSurface` / `sendLongCommand` and call `launchSubagent({ cli: "claude", skills: "..." })`, then assert stderr contains the warning before any child launch, or
- expose a smaller pane-Claude launch seam that includes the warning call and command-build step, and test that seam directly

What matters is that the test fails if the **pane-Claude call site** is removed, not merely if the helper function itself changes.

### 3) The plan still says both backends use a shared `PI_TO_CLAUDE_TOOLS` map, but the tasks define two separate copies

**Severity: Minor**

Task 17 adds `PI_TO_CLAUDE_TOOLS` in `pi-extension/subagents/index.ts` (`.pi/plans/2026-04-20-mux-free-execution-design-v9.md:3160-3178`). Task 19 then defines another `PI_TO_CLAUDE_TOOLS` constant in `pi-extension/subagents/backends/claude-stream.ts` (`.pi/plans/2026-04-20-mux-free-execution-design-v9.md:3795,3811-3820`).

But the plan text says both backends “call the same map” (`.pi/plans/2026-04-20-mux-free-execution-design-v9.md:3795`). As written, they do not.

This is not a v1 correctness break by itself because the two copies currently match, but it does leave a quiet drift hazard in a security-sensitive area: pane and headless Claude restriction behavior can diverge if one copy is updated and the other is not.

#### Recommended fix

Move the tool-name mapping to one shared module and import it from both builders, or explicitly downgrade the claim from “same map” to “duplicated but kept in sync.” The first option is better.

## Assessment

**Ready to merge: With fixes**

v9 is close, and it does address the two issues called out in review-v10. But I would still want the plan tightened before implementation starts because:

1. the Claude launch-spec contract is still internally inconsistent on system-prompt precedence and placement
2. the new pane-warning regression coverage does not actually test the pane path it claims to protect
3. the “shared” Claude tool map is still duplicated across backends

Once those are corrected, this looks ready to implement.
