# Plan review: `2026-04-20-mux-free-execution-design-v15.md`

## Verdict

[Issues Found]

## What is strong

- The plan is much more execution-ready than earlier revisions: the phase ordering is clearer, the pane baseline is well protected, and the no-mux goal is now exercised through all three entrypoints (`subagent`, `subagent_serial`, `subagent_parallel`).
- `resolveLaunchSpec()` is the right structural seam. It materially reduces pane/headless drift and gives the backend split a believable single normalization boundary.
- The Claude-path hardening is strong. The shared tool mapping, `--tools` emission, required `--` separator, session-id transcript discovery, and explicit Claude-skills warning behavior all tighten the design in useful ways.
- The regression strategy is broad and concrete: abort timing, transcript projection, resume, transcript archival, and registered-tool no-mux coverage are all called out with named tests instead of hand-wavy “verify manually” language.
- The intentional strengthening over the spec around `--tools` and `TranscriptMessage` is sensible and well justified.

## Findings

### Error — The bare `subagent` headless lifecycle is still only a requirement, not an implementation task

**Plan locations:**
- Goal / Architecture bullet 3
- Key decision: **Headless bare-subagent lifecycle**
- Task 7b Step 4b and the lifecycle note immediately after it
- Task 23b

**Problem:** The plan correctly says that headless bare-`subagent` launches must remain tracked by shutdown/reload cleanup, and it even adds a shutdown regression test in Task 23b. But there is still no concrete implementation step that actually makes that true.

Task 7b Step 4b's sketch launches a headless backend instance locally inside the tool callback and keeps only a local `watcherAbort`. Meanwhile the existing cleanup path in `pi-extension/subagents/index.ts` is still pane-oriented: `session_shutdown` aborts `runningSubagents` and the module-level poll abort controller. The plan never adds a shared registry for headless bare-subagent runs, never extends the existing cleanup handler to abort them, and never specifies how `/reload` finds them.

**Why this matters:** As written, the plan's own lifecycle invariant is not buildable. A no-mux bare subagent can still become orphaned across `session_shutdown` or `/reload`, and Task 23b's shutdown-abort assertion has no earlier implementation step that would make it pass.

**Actionable fix direction:** Add an explicit implementation task that registers bare headless launches in a module-level tracked set/map (or extends the existing `runningSubagents` tracking with a headless variant), and wire both `session_shutdown` and reload cleanup to abort and remove those entries.

### Warning — The plan still misses the spec’s “accept but ignore” `interactive` compatibility

**Plan locations:**
- Task 4 (`BackendLaunchParams`)
- Task 9b (`resolveLaunchSpec()` extraction)
- Task 25 (`OrchestrationResult` shape work)
- `## Out of scope reminders`

**Problem:** The spec explicitly says the `interactive` field remains vestigial but should still be **accepted in schema and ignored at runtime**. This plan never adds `interactive?: boolean` to the public schemas (`SubagentParams` / `OrchestrationTaskSchema`) and never adds a compatibility test for it. The only place `interactive` appears is the final out-of-scope reminder about not turning it into a real behavioral switch.

**Why this matters:** After this plan lands, callers that still send the legacy `interactive` field will continue to fail validation instead of being tolerated as the spec describes. That is a spec-coverage gap, even if the runtime intentionally ignores the field.

**Actionable fix direction:** Add a small compatibility task that accepts `interactive` on the public tool schemas, threads it through launch-resolution types as an ignored field, and adds one focused test proving that the field is tolerated but has no behavioral effect.

## Possible simplifications (non-blocking)

- **Collapse the duplicated `OrchestrationResult` timing note.** Task 8 Step 6 and Task 25 both discuss when `usage` / `transcript` land. Picking one canonical phase for the type addition would make the plan easier to execute without changing scope.
- **Group the headless pi integration work.** Tasks 12b–15 are all one small helper plus three tightly-related pi integration tests. They could be executed as one “headless pi test harness + smoke/ENOENT/archival” block without losing clarity.
- **Move `warnClaudeSkillsDropped` into a tiny shared utility module.** The current plan puts the helper in `index.ts` and later imports it back into `headless.ts`. A small shared module would shorten the explanation and reduce coupling without changing behavior.

## Overall assessment

This is a strong revision and is close to execution-ready. The main remaining blocker is lifecycle correctness for bare headless `subagent` runs: the plan states the invariant and tests for it, but it still does not contain the implementation step that would actually hook those runs into shutdown/reload cleanup. Beyond that, there is one remaining spec-coverage gap around the vestigial `interactive` field.
