# Plan review: `2026-04-20-mux-free-execution-design-v10.md`

## Verdict

[Issues Found]

## What is strong

- The two v14 findings appear resolved: the plan now explicitly covers bare `subagent` in no-mux mode, and the shared-tool-map coverage test has been moved to Task 19 so Task 17 no longer lands red.
- The launch-spec extraction is much more complete and materially reduces the risk of pane/headless drift.
- The Claude-path hardening is stronger and better structured than the original spec, especially around `--tools`, shared tool mapping, and identity/task-body separation.
- The testing strategy is broad, with useful gates for no-mux reachability, transcript archival, resume, abort, and pane-regression safety.

## Findings

### Warning — Task 21 no longer verifies the Claude tool-result half of the headless transcript contract

**Spec/coverage impact:** The spec's headless tool-use integration coverage calls for validating that the parsed headless transcript contains both a `toolCall` entry and the subsequent tool result. The current plan weakens that to a `toolCall`-only assertion.

**Plan locations:**
- File Structure bullet for `test/integration/headless-tool-use.test.ts`
- Task 18 (`parseClaudeStreamEvent` only handles assistant events / `tool_use` transformation)
- Task 19 (`runClaudeHeadless` only appends transformed assistant messages plus the terminal result)
- Task 21 (`headless-tool-use.test.ts` only asserts `toolCalls.length > 0`)

**Problem:** The Task 21 test now proves only that a Claude `tool_use` block becomes a `toolCall` entry. It does **not** prove that the corresponding tool result is preserved in `transcript[]`, and the surrounding implementation text does not currently describe any Claude-path parsing that would surface a `toolResult` message.

**Why this matters:** This leaves a real coverage hole in the headless transcript contract. A regression where Claude tool results disappear from `transcript[]` — or were never captured at all — would still satisfy the current Task 21 acceptance criteria.

**Concrete fix direction:** Either:
1. add an explicit Claude-path parsing step and test assertion for the subsequent tool result message, or
2. document that Claude headless transcripts intentionally surface only assistant text + `toolCall` entries in v1 and update the spec/docs accordingly.

## Simplification opportunities

### 1. Collapse the tiny Phase 1 wiring tasks

Tasks 5, 6, 7, and 7b are individually understandable, but together they create a lot of plan overhead for a small amount of code movement. They could be shortened into one Phase 1 wiring task with one validation pass covering:
- `detectMux()` export
- `selectBackend()`
- pane adapter
- backend-aware preflight / bare-subagent branching

That would remove several commit/checkpoint blocks without losing execution clarity.

### 2. Fold Task 12b into the harness or the first integration task

`copyTestAgents(dir)` is useful, but as a standalone task it adds ceremony out of proportion to its weight. It would read more cleanly as:
- a harness subsection under the Phase 2 test setup, or
- an early step inside Task 13 before the first headless pi integration test.

### 3. Trim stale historical commentary and superseded wording inline

The plan still carries a fair amount of historical/review-era prose that no longer changes implementation decisions, plus a few stale references such as:
- `messages` wording that has already been renamed to `transcript`
- the File Structure note for `headless-tool-use.test.ts` still mentioning the repo-local `test-echo` agent, even though Task 21 now uses direct Claude fields
- the Task 13 test title still saying "usage + messages + transcript"

Cleaning those up would materially shorten the document and make the executable path easier to scan.

### 4. Consider moving some long rationale blocks to short notes or an appendix

The plan's rationale is good, but several task sections repeat detailed review-history context inline. For execution, many of those could become one-line constraints plus a pointer to the relevant review file, especially in Tasks 17, 19, and 25.

## Overall assessment

This is a strong revision. The earlier v14 blockers are addressed, the sequencing is better, and the plan is generally executable.

The remaining issue is narrower: the Claude headless transcript path is only validated for `toolCall` preservation, not the subsequent tool-result entry that the spec's tool-use coverage implies. Tightening that contract — either in implementation/tests or by explicitly narrowing the intended v1 behavior — would make the plan ready.
