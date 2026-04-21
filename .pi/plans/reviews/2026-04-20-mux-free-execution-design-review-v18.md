# Plan review: `2026-04-20-mux-free-execution-design-v14.md`

## Verdict

[Issues Found]

## What is strong

- The plan now clearly covers the spec's three no-mux entrypoints: `subagent`, `subagent_serial`, and `subagent_parallel`.
- The extracted `resolveLaunchSpec()` boundary is a strong improvement: it materially reduces pane/headless drift and makes the backend seam much more credible.
- Claude-path hardening is stronger than the original spec in the right places: shared tool mapping, `--tools`, explicit `--` separator handling, session-id transcript discovery, and explicit Claude-skills warning behavior.
- The regression story is broad and generally well sequenced, especially around pane-baseline protection, abort behavior, transcript archival, resume, and no-mux registered-tool coverage.

## Findings

### Error — Task 7b depends on `backends/headless.ts` before the plan creates it

**Plan locations:**
- Task 7b Step 4b
- Task 7b Step 5
- Task 8 Step 3

**Problem:** Task 7b Step 4b tells the implementer to import `makeHeadlessBackend` from `./backends/headless.ts` and wire the bare `subagent` tool through it, but the plan does not create `pi-extension/subagents/backends/headless.ts` until Task 8 Step 3.

**Why this matters:** As written, the Task 7b checkpoint is not buildable: `index.ts` would import a module that does not exist yet. That means the Task 7b unit-test pass and commit boundary cannot actually stay green in the order the plan prescribes.

**Actionable fix direction:** Either create the Phase 1 headless stub before Task 7b rewires the bare `subagent` path, or move the relevant part of Step 4b to Task 8 so the import target exists before the plan asks implementers to compile and test it.

### Warning — The Claude headless path no longer actually preserves the plan's shared artifact-delivery contract

**Plan locations:**
- Goal / Architecture bullet 1 (`Shared launch contract`)
- Task 9b Step 4
- Task 11 preserved-launch-surface bullet for artifact-backed task delivery
- Task 19 Step 2

**Problem:** The plan repeatedly frames `resolveLaunchSpec()` as a single launch contract, including `taskDelivery: "direct" | "artifact"` and shared task-artifact helpers. But Task 19 Step 2's Claude implementation writes the artifact, immediately reads it back into memory, and passes the raw text to `buildClaudeHeadlessArgs(...)`.

That means the Claude headless path is not really honoring artifact delivery anymore; it collapses back to direct text delivery after a temporary file round-trip.

**Why this matters:** This is an internal consistency gap in a load-bearing part of the design. The plan claims pane and headless backends consume one normalized launch contract, but for Claude headless the artifact/direct distinction stops being semantically real. That weakens parity around large task bodies, quoting behavior, and provenance expectations.

**Actionable fix direction:** Either explicitly narrow the contract and document Claude headless as direct-only even when `taskDelivery === "artifact"`, or preserve true artifact-based delivery semantics on the Claude path and test that behavior directly.

### Warning — The no-loss `onUpdate` invariant is not pinned to a concrete regression test

**Plan locations:**
- Key decisions and invariants (`Headless progress streaming`)
- Task 26 Step 2
- Task 26 Step 5
- File Structure / New tests list (no dedicated `onUpdate` buffering test named)

**Problem:** The plan correctly identifies a real race: headless work starts in `launch()`, so partials emitted before `waitForCompletion()` attaches must be buffered/replayed. Task 26 gives implementation direction for that, but the verification step only says to "add or update at least one focused test" without naming a file, concrete fixture, or exact acceptance condition.

**Why this matters:** This is the only regression guard for a specifically-called-out concurrency invariant. Because the test is not concretely planned the way most other load-bearing behaviors are, execution could easily land the API plumbing without ever proving that early partials are actually replayed.

**Actionable fix direction:** Add an explicit test task/file for this invariant — for example a focused orchestration/backend unit test that launches headless work, emits a partial before `watch()` attaches, then asserts the first attached `onUpdate` callback receives the buffered snapshot.

## Spec updates recommended

These are **not** findings against the plan. They are places where the plan appears stronger than the current spec and the spec should be updated to match.

### `transcript?: TranscriptMessage[]` is better than the spec's `messages?: Message[]`

The plan's orchestration-owned transcript boundary is a more truthful contract than exporting pi-ai `Message[]` for data reconstructed from stream-json events.

### Claude `--tools` + shared mapping is better than the spec's older Claude restriction wording

The plan's `--tools` approach, backed by one shared `PI_TO_CLAUDE_TOOLS` module, is stronger and more security-relevant than the older spec wording around Claude tool restriction.

## Overall assessment

This is a strong plan revision and substantially closer to execution-ready than earlier versions. The main remaining problem is sequencing: Task 7b currently asks implementers to wire a module that the plan does not create until Task 8, so that checkpoint cannot stay green as written. Beyond that, two important architectural promises still need tightening: the shared artifact-delivery contract is not actually preserved on the Claude headless path, and the no-loss `onUpdate` invariant needs a concrete regression test rather than a generic note.
