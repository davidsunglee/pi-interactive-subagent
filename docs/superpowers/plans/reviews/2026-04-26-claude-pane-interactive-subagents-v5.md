# Review: Claude Pane Interactive Subagents Implementation Plan v5

## Verdict
APPROVED WITH NON-BLOCKING WARNINGS

v5 addresses the blocking and high-priority findings from the v4 review. The main implementation path is structurally coherent, honors the approved v3 spec architecture, and no build-blocking task-order or variable-scope issue remains. The remaining findings are test/operational-quality warnings rather than execution blockers.

Conclusion: [Approved]

## v4 review findings disposition

1. **Task 1 empty plugin build checkpoint:** fixed. Task 1 now explicitly avoids running `npm run build:plugin` until Task 2 has created `mcp/server.ts`, so `tsc` is not asked to compile a no-input project.
2. **Conditional Task 10 undefined variables:** fixed. The fallback snippet now uses in-scope values (`spec.artifactDir`, `params.name` via `safeScriptName`, `id`, and `pluginDir`) and creates the artifact subdirectory before writing the generated config.
3. **Watcher empty-sentinel fallback wiring coverage:** addressed. v5 adds the Task 11 `empty-message` live integration test that calls `subagent_done` with no arguments and asserts `watchSubagent` returns the transcript-derived last assistant message.
4. **Over-broad transcript-pointer wait:** fixed. Task 8 now gates the bounded wait on the sentinel file actually existing while the `${sentinel}.transcript` pointer is still absent, avoiding avoidable delay on manual-exit and abort paths.

## Strengths

- The architecture remains aligned with the spec: Claude pane completion moves to the bundled `pi-subagent` MCP server, the Stop hook is transcript-pointer-only, and the user-message-count sentinel heuristic is removed.
- Task ordering is sound: dependency setup precedes the MCP server, manifests precede live Claude smoke tests, launch-spec changes precede launch-path folding, and integration coverage comes after the core completion path.
- The v4 buildability blockers are corrected without adding new main-path blockers.
- The plan covers the restrictive `--tools` edge case, including the unmappable-tool case where `--tools` must still contain only `mcp__pi-subagent__subagent_done`.
- The orchestration tests exercise real `runSerial` / `runParallel` through `makeDefaultDeps` and assert parent-facing payload fields (`state`, `finalMessage`, `exitCode`, `transcriptPath`, `sessionId`, `sessionKey`).
- The spec-designer-style e2e test pins the motivating workflow with two observed clarifying turns and `SPEC_WRITTEN: <absolute path>` as the parent-visible final message.

## Spec / plan conflict calls

### 1. Task 11 cancellation test does not deterministically abort “mid-question”
- **Where:** Task 11, `cancellation mid-question: pane closes cleanly and BackendResult reflects abort`.
- **Conflict:** The spec’s pane integration strategy says the cancellation case should abort while the model is between turns, and the v3 testing guidance emphasizes waiting for observable assistant-turn markers instead of fixed sleeps. The plan starts a timer and aborts after 6 seconds without first observing a question/marker.
- **Call:** **Spec is better.** Waiting for an observable marker before aborting would prove the intended state. The planned test still checks the abort path, but it may abort before Claude asks anything, so it does not fully cover the “mid-question” acceptance scenario.
- **Severity:** Warning.

### 2. Task 11 manual `/exit` driver is not awaited
- **Where:** Task 11, `user closes pane manually: watcher returns via __SUBAGENT_DONE__ marker`.
- **Conflict:** The spec says driver coroutines must wait for observable markers and driver failures must be test failures, not ignored background noise. The plan launches `void waitForScreen(...).then(() => sendCommand(...))` and never awaits that driver promise.
- **Call:** **Spec is better.** The test should retain and await the driver promise (or otherwise propagate rejection) so failure to observe `READY` or send `/exit` is attributed directly, not left as a timeout or unhandled background rejection.
- **Severity:** Warning.

### 3. Task 9 plugin auto-load evidence checkpoint has inaccurate artifact instructions
- **Where:** Task 9 Step 4.
- **Conflict:** The spec requires empirical verification of plugin-MCP auto-load before deciding whether to implement the `--mcp-config` fallback. The plan’s checkpoint says to inspect `${env.dir}` after the test and says the test prints its tmpdir / that the sentinel file should still contain `OK`. The current harness does not print `env.dir`, cleanup removes the temp dir, and `watchSubagent` unlinks the sentinel and pointer files after finalization.
- **Call:** **Spec is better.** The smoke test itself is the right gate, but the evidence instructions should point to durable artifacts (for example `result.transcriptPath` / the archive under `~/.pi/agent/sessions/claude-code`) or add an explicit assertion/log that the archived transcript contains a `tool_use` for `subagent_done`.
- **Severity:** Warning.

No architecture-level spec conflict was found. The spec has no `## Approach` section, so the special approach-honoring rule does not apply.

## Structural correctness, dependencies, and buildability

- **No blocking buildability errors found.** The Task 1 no-input `tsc` issue from v4 is gone, and the Task 10 fallback snippet now uses variables that exist in the Claude branch.
- **Dependency order is correct.** `@modelcontextprotocol/sdk` is installed before MCP tests/server code import it; the first real plugin build occurs after `mcp/server.ts` exists.
- **Conditional fallback is isolated.** Task 10 is only executed after a failed live auto-load smoke, and its planned `mcpConfigPath` plumbing is internally consistent.
- **Root/plugin TypeScript separation is coherent.** The plugin gets its own tsconfig and committed compiled `mcp/server.js`; root typecheck continues excluding plugin source.
- **Minor documentation inconsistency:** the final “Execution Handoff” still says the plan was saved to the v4 path. This is not a build blocker, but it should be updated to the v5 path to avoid confusing an executor.

## Acceptance criteria coverage

- **Interactive multi-turn Claude pane:** covered by Task 11 and reinforced by Task 12/13 orchestration tests that wait for question markers before sending replies.
- **Explicit MCP completion:** covered by Task 2 MCP tests, Task 9 roundtrip adaptation, and Task 11/12/13 live flows.
- **Parent-facing payload fields:** covered in Task 12 and Task 13 (`finalMessage`, `exitCode`, `state`, `transcriptPath`, `sessionId`, `sessionKey`).
- **One-turn autonomous metadata:** covered by Task 9 and Task 11 autonomous-with-MCP assertions for `transcriptPath` and Claude session id.
- **Restrictive tools do not disable completion:** covered by Task 6 unit tests and Task 13’s tools-restricted spec-designer fixture.
- **User-msg-count regression:** covered by Task 4 Stop hook regression test and Task 11’s first-turn sentinel absence assertion.
- **Pi/headless non-regression:** covered by unchanged out-of-scope boundaries plus final `npm test` / integration verification.

## Recommended non-blocking changes

1. In Task 11’s cancellation test, wait for an observable question/marker before aborting so the test truly covers “mid-question” cancellation.
2. In Task 11’s manual `/exit` test, store and await the driver promise so marker/send failures fail the test directly.
3. In Task 9 Step 4, replace the stale post-test inspection instructions with durable evidence: assert/log `result.transcriptPath` and inspect the archived transcript for a `subagent_done` tool call, or preserve/print the temp directory deliberately.
4. Update the final handoff line from the v4 plan path to `docs/superpowers/plans/2026-04-26-claude-pane-interactive-subagents-v5.md`.

## Final review conclusion

The v5 plan is ready to execute. The remaining findings are non-blocking warnings around deterministic live-test evidence and stale handoff text, not architecture or buildability blockers.

[Approved]
