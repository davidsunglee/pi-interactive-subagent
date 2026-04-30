# Plan review: `2026-04-20-mux-free-execution-design-v10.md`

## Verdict

[Issues Found]

## What is strong

- The plan is very thorough about task sequencing, test coverage, and regression gates.
- The phase structure is clear, and most tasks have concrete validation steps plus commit boundaries.
- The plan does a good job preserving pane-path safety while introducing the new backend seam.
- The testing story is significantly stronger than the spec minimum, especially around abort handling, transcript archival, and no-mux orchestration coverage.

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

### Error — The plan changes the `OrchestrationResult` contract from spec’d `messages?: Message[]` to `transcript?: TranscriptMessage[]`

**Spec impact:** The spec repeatedly defines the new headless result shape as optional `usage?: UsageStats` plus `messages?: Message[]`.

**Plan locations:**
- Goal / architecture text
- Task 4
- Task 8
- Task 11
- Task 20
- Task 21
- Task 25
- Task 27

**Problem:** The plan systematically replaces the spec’d `messages` field with a different field name and type: `transcript?: TranscriptMessage[]`.

**Why this matters:** This is a public contract change, not an internal refactor. A team implementing this plan would ship a different API than the one the spec author approved.

**Concrete impact relative to the spec:** Any downstream work, tests, docs, or callers written against the spec’s `messages` field would not match the delivered behavior. If the contract change is desired, the spec should be revised first; the plan should not silently supersede it.

### Error — The Claude restriction patch no longer matches the spec’s requested patch shape

**Spec impact:** The spec’s in-scope patch is specific: add `PI_TO_CLAUDE_TOOLS` and emit `--allowedTools` from `buildClaudeCmdParts` in `pi-extension/subagents/index.ts`.

**Plan locations:**
- Goal / architecture text
- Task 17
- Task 19

**Problem:** The plan replaces that spec’d patch with a materially different contract: emit `--tools`, centralize the mapping in a new shared module, and wire the same mapping into the headless Claude builder.

**Why this matters:** Even if the new approach is intentional, it is no longer the same change the spec describes. The plan is effectively implementing a revised spec without first updating the source spec.

**Concrete impact relative to the spec:** The resulting implementation and commit structure would differ from the requested “small named-commit patch in `index.ts`” and from the exact CLI flag named in the spec. If this change is intended, the spec should be amended before execution.

### Warning — Task 17 introduces a test that the plan itself says will not pass until Task 19

**Plan locations:**
- Task 17 Step 3b
- Task 17 Step 7
- Task 19 Step 1

**Problem:** Task 17 adds `test/orchestration/pi-to-claude-tools.test.ts`, but the step text says it passes only once Task 19 also imports the shared tool map into `claude-stream.ts`.

**Why this matters:** That makes Task 17’s named commit non-self-contained and temporarily red, even though the plan otherwise presents these commits as discrete, portable checkpoints.

**Concrete impact relative to the plan:** Execution becomes less reliable and less bisectable. Either the test should move to Task 19, or Task 17 should include the corresponding `claude-stream.ts` import so the commit stays green.

## Simplification opportunities

- **Remove or drastically shrink the v2–v10 changelog appendix.** It adds a large amount of historical context but very little forward execution value. A short “differences from spec” note would keep the plan much easier to execute.
- **Merge the tiny Phase 1 wiring tasks** (`detectMux`, `selectBackend`, and orchestration preflight wiring) into one implementation task with one validation pass.
- **Fold Task 12b into Task 13 or the shared harness section** unless the separate commit is important for upstreaming. On its own it is very small bookkeeping.
- **Move the shared-tool-map coverage test to Task 19** so the pane and headless imports are both present when the test lands.

## Overall assessment

The plan is detailed and executable in many respects, but it is **not yet sound against the provided spec** because it has drifted into a revised design on multiple core contracts: bare `subagent` no-mux behavior, `OrchestrationResult` field naming/type, and the Claude restriction patch shape. Those need to be reconciled with the spec before execution starts.
