# Plan review: `2026-04-20-mux-free-execution-design-v10.md`

## Verdict

[Issues Found]

## What is strong

- The plan is thorough about sequencing, validation gates, and regression safety.
- The backend split is well-motivated and generally consistent with the spec’s intended direction.
- The testing story is stronger than the spec minimum, especially around abort handling, transcript archival, and no-mux orchestration coverage.
- The plan improves some technical details beyond the current spec, particularly around result typing and Claude tool restriction semantics.

## Findings

### Error — The plan no longer covers the spec’s bare `subagent` no-mux goal

**Spec impact:** The spec summary explicitly says the headless backend should make `subagent`, `subagent_serial`, and `subagent_parallel` work in environments without a supported multiplexer.

**Plan locations:**
- Architecture section, backend-aware preflight item
- Phase 1 intro
- Task 7b

**Problem:** The plan explicitly keeps the bare `subagent` tool on `preflightSubagent` and says it remains mux-required in v1, while only `subagent_serial` / `subagent_parallel` become backend-aware.

**Why this matters:** Executing this plan would still leave one of the three spec-named entrypoints unusable in CI/headless/IDE-terminal environments. That is a direct spec-coverage gap, not just a staging detail.

**Concrete impact relative to the spec:** Users would get the promised no-mux behavior for orchestration tools, but **not** for the base `subagent` tool, even though the spec states all three surfaces should work.

### Warning — Task 17 introduces a test that the plan itself says will not pass until Task 19

**Plan locations:**
- Task 17 Step 3b
- Task 17 Step 7
- Task 19 Step 1

**Problem:** Task 17 adds `test/orchestration/pi-to-claude-tools.test.ts`, but the step text says it passes only once Task 19 also imports the shared tool map into `claude-stream.ts`.

**Why this matters:** That makes Task 17’s named commit non-self-contained and temporarily red, even though the plan otherwise presents these commits as discrete, portable checkpoints.

**Concrete impact relative to the plan:** Execution becomes less reliable and less bisectable. Either the test should move to Task 19, or Task 17 should include the corresponding `claude-stream.ts` import so the commit stays green.

## Spec updates recommended

These are **not** findings against the plan. They are places where the plan appears to improve on the current spec and the spec should be updated to match.

### The `transcript?: TranscriptMessage[]` contract is an improvement over spec’d `messages?: Message[]`

The plan’s shift away from `messages?: Message[]` to an orchestration-owned `transcript?: TranscriptMessage[]` appears directionally correct.

**Why this is better:**
- It is a more truthful contract for data reconstructed from stream-json events.
- It avoids exporting a richer message type than the headless backends can honestly and consistently produce.
- It reduces pressure to rely on unsafe casts or fabricate metadata just to satisfy a borrowed type.

**Recommendation:** Update the spec to match the plan’s more accurate transcript contract, or explicitly define a compatibility strategy if preserving `messages` is still desired for callers.

### The Claude `--tools` restriction design is stronger than the spec’s `--allowedTools` patch

The plan’s change from `--allowedTools` to `--tools`, along with a single shared `PI_TO_CLAUDE_TOOLS` source of truth, appears to be an improvement over the current spec.

**Why this is better:**
- `--tools` is the better fit for controlling the available built-in Claude tool set.
- That makes it a stronger match for the plan’s stated goal of fixing a tool-restriction security regression.
- Centralizing `PI_TO_CLAUDE_TOOLS` avoids pane/headless drift in a security-sensitive path.

**Recommendation:** Update the spec to reflect the stronger `--tools`-based design and the shared mapping module, rather than treating the plan’s change here as a defect.

## Simplification opportunities

### Strong recommendation — remove the embedded v2–v10 changelog from the plan

The internal plan changelog materially increases the plan’s length without adding commensurate execution value. It is historical commentary, not implementation guidance.

**Recommendation:** Remove the changelog sections from the plan entirely.

**Why this should be removed, not merely trimmed:**
- It makes the plan substantially longer and harder to review.
- It buries the actual executable work beneath historical iteration notes.
- It duplicates information that already exists in versioned review files and plan history.
- It does not help an implementer execute the current plan; it mostly explains how the document evolved.

If any history truly needs to be preserved, keep it out of the main plan body — for example in review files, commit history, or a brief one-paragraph note. The plan itself should focus on the current intended design and implementation steps.

### Additional simplifications

- Merge the tiny Phase 1 wiring tasks (`detectMux`, `selectBackend`, and orchestration preflight wiring) into one implementation task with one validation pass.
- Fold Task 12b into Task 13 or the shared harness section unless the separate commit is essential.
- Move the shared-tool-map coverage test to Task 19 so it lands in the same commit wave as both imports and stays green.

## Overall assessment

The plan is generally strong and in some places better than the current spec. In particular, the transcript contract and the Claude tool-restriction design look like objective improvements that should be reflected back into the spec rather than treated as plan defects.

However, the plan is **not yet fully sound against the provided spec** because it still drops the spec’s no-mux promise for the bare `subagent` tool, and it contains at least one sequencing issue that weakens the quality of its commit boundaries. Tightening those areas — and removing the long internal changelog — would make the plan materially better and easier to execute.
