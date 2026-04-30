# Plan review: `2026-04-20-mux-free-execution-design-v18.md`

## Verdict

[Issues Found]

## What is strong

- The plan is now highly detailed and generally much more execution-ready than earlier revisions. It closes the previously-open Claude model normalization and cache-busting gaps, and the later phases are internally consistent about the shared `resolveLaunchSpec()` contract.
- The no-mux surface coverage is strong. The plan explicitly routes bare `subagent`, `subagent_serial`, and `subagent_parallel` through backend-aware preflight and adds a real registered-tool integration test for both forced-headless and auto/no-mux paths.
- Claude-specific hardening is well thought through: shared tool mapping, `--tools` plus the required `--` separator, session-id transcript discovery, transcript completeness for `tool_result`, resume coverage, and skills-warning symmetry are all present and tied to concrete tests.
- The orchestration-owned `TranscriptMessage` boundary remains a sensible strengthening of the spec, and the plan is consistent about that stronger boundary throughout implementation, tests, and docs.

## Findings

### Error — Phase 1's bare-`subagent` headless path still throws the stub error instead of returning the plan's promised actionable tool result

**Plan locations:**
- Phase 1 intro (`HeadlessBackend` stub should give a “clean, actionable error” when selected)
- Task 7b Step 4a (Phase 1 stub `makeHeadlessBackend().launch()` throws)
- Task 7b Step 4c (bare `subagent` headless branch does `const handle = await backend.launch(...)` with no surrounding catch)
- Task 9c Step 3 (release-sequencing discussion happens only after this behavior is already introduced)

**Problem:** The plan says explicit headless selection in Phase 1 should produce a clean, actionable “not implemented yet” error. But the concrete Task 7b Step 4c flow for the bare `subagent` tool awaits `backend.launch(...)` directly. With the Task 7b Step 4a stub, that call throws before the tool can return any structured result or steer message.

**Why this matters:** This is a real sequencing/buildability issue, not just a UX nit. The implementation-phasing section says each phase leaves the fork in a working state, but after Task 7b/8 the bare `subagent` entrypoint has an uncaught failure path whenever headless is selected before Task 11 lands. Task 9c's later release guard does not fix the runtime behavior on the branch; it only tries to prevent shipping it.

**Actionable fix direction:** Either:
1. make the bare `subagent` headless branch catch `backend.launch()` failures and return the same kind of actionable tool result the plan promises, or
2. move the feature-gate/deferral requirement earlier so the headless branch cannot be exercised until Task 11 replaces the stub.

### Warning — The pane-Claude callsite regression is still not directly tested end-to-end

**Plan locations:**
- Task 9b Step 1 (`resolveLaunchSpec` tests for agent-body precedence, `claudeTaskBody`, and `claudeModelArg`)
- Task 17 Step 3 (pane Claude callsite is changed to consume `spec.identity`, `spec.systemPromptMode`, `spec.claudeTaskBody`, and `spec.claudeModelArg`)
- Task 17 Step 5 (pane Claude integration coverage only checks tool restriction and skills-warning behavior)

**Problem:** The plan correctly changes the pane Claude callsite to read the shared resolved spec, but the listed tests only validate the two halves in isolation:
- `resolveLaunchSpec()` computes the right values, and
- `buildClaudeCmdParts()` behaves correctly when those values are supplied.

What is still missing is a test that exercises `launchSubagent()`'s pane-Claude branch itself with one of the formerly-problematic inputs (for example: agent body + caller `systemPrompt` conflict, or a provider-prefixed Claude model) and proves the generated command actually uses the resolved spec fields rather than recomputing from raw params.

**Why this matters:** A future regression could reintroduce exactly the old pane-Claude bug by wiring the callsite back to `params.systemPrompt ?? agentDefs?.body`, `params.task`, or raw `effectiveModel`, while all of the currently-listed tests still pass.

**Actionable fix direction:** Add one focused pane-side test that goes through `launchSubagent()`'s Claude branch and inspects the emitted launch command/script for the resolved-spec values (`spec.identity`, `spec.claudeTaskBody`, `spec.claudeModelArg`).

## Non-blocking simplification suggestions

- **Choose one Phase 1 safety strategy instead of keeping three alternatives in Task 9c.** The current checkpoint is careful but long. Picking one default path (feature branch isolation, or a temporary env gate) would make execution simpler without losing safety.
- **Move `warnClaudeSkillsDropped` into a tiny shared helper module.** That would remove the `headless.ts` ↔ `index.ts` utility coupling while keeping the single-source-of-truth warning text.
- **Fold `copyTestAgents(dir)` into the first headless integration task unless you specifically want a separate harness commit.** It is a tiny helper whose only purpose is to unblock the next tests.

## Overall assessment

This revision is close. The final-state architecture is coherent, the coverage is broad, and most of the previously-open structural issues have been resolved. The remaining blocker is phase sequencing: the Phase 1 bare-`subagent` headless path still does not behave the way the plan says it will while the backend is stubbed. After that is tightened, I would be comfortable approving this plan.
