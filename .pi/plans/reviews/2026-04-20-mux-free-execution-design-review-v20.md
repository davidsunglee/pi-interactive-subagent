# Plan review: `2026-04-20-mux-free-execution-design-v16.md`

## Verdict

[Issues Found]

## What is strong

- The plan is structurally much stronger than earlier revisions. `resolveLaunchSpec()` remains the right unifying seam, and the pane/headless split is now threaded through concrete phases instead of hand-wavy refactor notes.
- The plan now explicitly covers the previously-missing `interactive` compatibility behavior, bare-`subagent` lifecycle tracking, Claude skills warnings, and session-id-based Claude transcript discovery.
- The test strategy is broad and generally well targeted: pane regression coverage, real no-mux registered-tool coverage, Claude tool restriction, abort handling, transcript projection, and resume all have named tasks instead of “verify manually” placeholders.
- The intentional plan-strengthening around Claude tool restriction and the orchestration-owned `TranscriptMessage` boundary is sensible and consistent with the implementation direction.

## Findings

### Error — Task 19 would double-append Claude’s final assistant output into `transcript[]`

**Plan locations:** Task 19 Step 2 (`runClaudeHeadless`), especially the `event.type === "result"` branch.

**Problem:** The planned implementation already appends streamed assistant messages through `parseClaudeStreamEvent(event)`, but then the `result` event branch also does:

```ts
if (terminalResult.finalOutput) {
  transcript.push({
    role: "assistant",
    content: [{ type: "text", text: terminalResult.finalOutput }],
  });
}
```

That means a normal Claude run records the final answer twice: once from the streamed `assistant` event, then again from the terminal `result` event.

**Why this matters:** `transcript[]` is a user-facing result field in this plan. Duplicating the terminal assistant turn makes the transcript structurally wrong, can distort downstream consumers that walk conversation order, and weakens the very mid-stream/tool-roundtrip fidelity this plan is otherwise careful about.

**Actionable fix direction:** Use the `result` event only to finalize `finalMessage` / `usage` / error state. Do not append a second assistant transcript message there unless the plan first proves Claude can exit without having emitted the final assistant content as a stream event.

### Error — Task 22 weakens the Claude archival test below the spec’s required content checks

**Plan locations:** Task 22 Step 1.

**Problem:** The spec requires `headless-transcript-archival.test.ts` to read the archived jsonl and assert that it is non-empty, contains the expected `session_id`, and contains the task prompt as a user message for **both** pi and Claude paths. The pi half does a content assertion, but the Claude half only checks:

- `transcriptPath` exists
- path is under `~/.pi/agent/sessions/claude-code/`
- filename ends with `${sessionId}.jsonl`

That proves only that *some* file was copied to the expected destination, not that the archived file is the correct transcript or even that it contains the expected session/task content.

**Why this matters:** Task 19 replaces slug reconstruction with global session-id discovery. A wrong-file copy, empty file, or stale file with the same basename would still satisfy Task 22 as written. That leaves one of the plan’s load-bearing Claude acceptance criteria effectively untested.

**Actionable fix direction:** Make the Claude half mirror the spec and the pi half: open the archived file, assert non-empty content, assert it contains `result.sessionId`, and assert it includes the prompt text used for the run.

### Error — Task 23b’s shutdown-abort regression uses the wrong fixture, so it does not actually exercise a long-running headless bare-subagent

**Plan locations:** Task 23b Step 1, especially the forced-headless `session_shutdown aborts a long-running bare subagent` case.

**Problem:** The test uses agent `test-ping` with task `"Keep running until aborted"` as the supposedly long-running background subagent. But the existing fixture at `test/integration/agents/test-ping.md` does not keep running — it immediately calls `caller_ping` for any task and exits.

**Why this matters:** This is the execution-level regression guard for the lifecycle invariant introduced in Task 7b. With the current fixture, the run can finish before `session_shutdown` fires, which means the test does not reliably prove that shutdown aborts tracked headless bare-`subagent` work or that no orphaned completion arrives later.

**Actionable fix direction:** Add a dedicated long-running test fixture (or a deterministic injected runner) for the shutdown case, then use that in Task 23b instead of `test-ping`.

### Warning — Task 9 still misses the spec’s explicit `auto -> pane` / mocked-mux selector coverage

**Plan locations:** Task 9 Step 1.

**Problem:** The spec calls for selector tests that cover explicit env values, malformed values, and `auto` routing via a mocked mux detector. The planned test file covers explicit values, invalid-value warning behavior, and `auto -> headless when no mux env vars are set`, but it does not cover the positive `auto -> pane` branch or any mocked detector path.

**Why this matters:** If `selectBackend()` regressed to always returning `headless` in `auto` mode when mux is available, the current Task 9 cases would not catch it. The pane regression tests mostly exercise pane primitives directly, not the selector’s auto-mode decision surface.

**Actionable fix direction:** Add one focused case that forces `detectMux()` true (or an equivalent test hook) and asserts `selectBackend()` returns `pane` in `auto` mode.

### Warning — Task 20 weakens the Claude smoke acceptance criterion from `usage.cost > 0` to `>= 0`

**Plan locations:** Task 20 Step 1.

**Problem:** The spec’s headless-Claude smoke test requires `usage.cost > 0`. The plan changes that to `assert.ok(result.usage!.cost >= 0, "usage.cost must be set (may be 0 for cached)")`.

**Why this matters:** This is a real reduction in coverage relative to the spec. A zero-valued or never-populated cost field would now pass the smoke test, even though one stated goal of the headless path is trustworthy usage aggregation.

**Actionable fix direction:** Either restore the spec’s stronger check, or explicitly document in the plan why the spec should be amended and add another assertion that still proves cost parsing happened (for example, a dedicated unit case plus a non-zero integration expectation when the run is known uncached).

## Possible simplifications (non-blocking)

- **Fold Task 12b into Task 13.** `copyTestAgents(dir)` is a tiny harness helper whose only purpose is to unblock the first headless-pi integration tests. Keeping it as a standalone task/commit is probably more ceremony than value.
- **Choose one phase for the `OrchestrationResult` type addition.** Task 8 Step 6 and Task 25 both talk about landing `usage` / `transcript` early vs. later. Picking one canonical point would shorten the plan and reduce branchy “if typecheck complains, do Phase 4 early” instructions.
- **Group the Claude warning/tool-map test work a little more tightly.** Task 17 Step 3a, Task 17 Step 5’s warning block, and Task 19 Step 2b all orbit the same Claude-arg/skills/tool-map surface. They could be expressed as one tighter sub-block without losing clarity.

## Overall assessment

This is close, but not yet approval-ready. The main remaining problems are all concrete: one planned Claude implementation detail would corrupt `transcript[]`, one load-bearing Claude archival test no longer checks the file contents the spec requires, and the key shutdown-abort regression test currently uses a fixture that exits immediately instead of staying alive long enough to validate the lifecycle guarantee. Once those are corrected, the plan should be in good shape.
