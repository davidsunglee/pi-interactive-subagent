# Review: Claude Pane Interactive Subagents Implementation Plan v3

## Verdict
APPROVE WITH CHANGES

v3 is substantially execution-ready and addresses the concrete findings from the v2 review. The architecture matches the approved spec: Claude pane completion moves to the plugin-bundled `subagent_done` MCP tool, the Stop hook becomes transcript-pointer-only, restrictive Claude `--tools` lists always preserve `mcp__pi-subagent__subagent_done`, and orchestration-level coverage is now planned for the real `runSerial` / `runParallel` path.

I would not start execution until the two test-plumbing issues below are fixed. They are localized, but they would either fail during Task 7 or let slow-lane integration tasks appear “verified” while actually skipped.

## Previous review coverage

All v2 review findings are addressed at the plan level:

1. **Tasks 12–13 surface discovery:** addressed. The v3 serial, parallel, and spec-designer orchestration tests use `subagents.__test__.getRunningSubagents()` instead of relying on `env.surfaces` being magically populated by `runSerial` / `runParallel`.
2. **Task 2 ESM test bug:** addressed. The proposed `test/plugin-mcp.test.ts` imports `readdirSync` instead of using CommonJS `require(...)` in this ESM repo.
3. **Task 10 fallback config parent directory:** addressed. The conditional `--mcp-config` fallback now calls `mkdirSync(artifactDir, { recursive: true })` before `writeFileSync(...)`.
4. **Stale committed `mcp/server.js`:** addressed. Task 14 starts with `npm run build:plugin` before typecheck and test execution.
5. **Task 13 `SPEC_WRITTEN: <path>` contract:** addressed. The task prompt interpolates the real `SPEC_PATH`, and the assertion checks that `finalMessage` includes that absolute path.
6. **Slow-lane gating suggestion:** addressed in the test snippets for Tasks 11–13 via `SLOW_LANE_OPT_IN`, though the per-task run commands need adjustment as described in Finding 2.

## Strengths

- The implementation order is sound: dependency/build plumbing → MCP server → plugin manifests → Stop hook simplification → launch-spec/addendum/tool injection → watcher fallback → live integration/orchestration coverage → final verification.
- The plan preserves the intended boundary: Claude pane lifecycle changes are isolated from the pi path and headless Claude backend.
- The `--tools` behavior matches the v2 spec’s stronger requirement, including the unmappable-tool case where `--tools` must still be emitted with only `mcp__pi-subagent__subagent_done`.
- The v3 orchestration tests now assert parent-facing payload shape (`state`, `finalMessage`, `exitCode`, `transcriptPath`, `sessionId`, `sessionKey`) rather than only raw pane backend behavior.
- The conditional `--mcp-config` fallback is still well placed behind the Task 9 auto-load checkpoint.

## Spec / plan conflict calls

### 1. Slow-lane gating for live Claude pane tests
- **Conflict:** The spec’s testing strategy describes live pane and orchestration tests but does not require them to be slow-lane gated. The plan gates Tasks 11–13 behind `PI_RUN_SLOW=1` / `SLOW_LANE_OPT_IN`.
- **Call:** **Plan is better**, with a command fix needed.
- **Why:** These are expensive, live Claude + mux tests. Keeping default `npm run test:integration` snappy is consistent with the repo’s existing harness conventions. However, the individual task commands must set `PI_RUN_SLOW=1`; otherwise those tests skip instead of validating the new behavior.

### 2. Explicit transcript fallback helper beyond the spec’s minimal watcher wording
- **Conflict:** The spec says `watchSubagent` stays mostly unchanged except preferring archived transcript JSONL before screen-scrape when the sentinel is empty. The plan adds an exported `extractLastAssistantMessage(jsonl)` helper and unit tests around it.
- **Call:** **Plan is better.**
- **Why:** The helper gives deterministic coverage of the new fallback behavior without requiring a live Claude pane for every edge case.

No other meaningful spec conflicts were found. The plan honors the spec’s architecture and non-goals.

## Prioritized findings

### 1. Error — Task 7’s `autoExit=true` launch-path test cannot load the `test-echo` agent fixture

**Where:** Task 7, `test/orchestration/pane-claude-completion-addendum.test.ts`, test `uses the autoExit=true wording when the agent declares auto-exit:true`.

**Problem:** The helper `captureClaudeLaunchScript(...)` creates a fresh `ctxCwd` temp directory and calls `launchSubagent(...)` with that as `ctx.cwd`. `launchSubagent` does not accept the `agentSearchDirs` test option used by the earlier `resolveLaunchSpec(...)` unit tests. Agent lookup will search:

- `<ctx.cwd>/.pi/agents/test-echo.md`,
- `$PI_CODING_AGENT_DIR/agents/test-echo.md`,
- bundled agents.

The temp `ctxCwd` has no `.pi/agents/test-echo.md`, so the planned test is not deterministic and will usually resolve `agentDefs` as `null`. With `agentDefs === null`, `autoExit` is false and `spec.claudeCompletionAddendum` uses the interactive wording, so the assertion for `/one-shot subagent/` fails.

**Why this matters:** Task 7 is meant to verify the actual launch-path fold from resolved spec to Claude command. As written, one of its core assertions will fail for test-fixture setup reasons rather than implementation behavior.

**Required change:** Seed the fixture into the temp cwd before calling `launchSubagent`, for example:

- create `<ctxCwd>/.pi/agents/test-echo.md` with `auto-exit: true` (or copy from `test/integration/agents/test-echo.md`), or
- use `createTestEnv(...)` / `copyTestAgents(...)` if you want to reuse the integration harness fixture-copying logic, or
- add a narrow launch-spec test seam if launch-path tests need explicit `agentSearchDirs`.

The simplest fix is to have `captureClaudeLaunchScript` create `.pi/agents/test-echo.md` under `ctxCwd` before the `agent: "test-echo"` case runs.

### 2. Warning — Tasks 11–13 per-task verification commands omit `PI_RUN_SLOW=1`, so the new live tests will skip instead of run

**Where:**

- Task 11 Step 3: `npm run build:plugin && node --test test/integration/pane-claude-interactive.test.ts`
- Task 12 Step 2: `npm run build:plugin && node --test test/integration/orchestration-claude-pane-serial.test.ts`
- Task 12 Step 4: `npm run build:plugin && node --test test/integration/orchestration-claude-pane-parallel.test.ts`
- Task 13 Step 3: `npm run build:plugin && node --test test/integration/orchestration-claude-pane-spec-designer-e2e.test.ts`

**Problem:** The planned test snippets all compute `SHOULD_SKIP` with `!SLOW_LANE_OPT_IN`, and `SLOW_LANE_OPT_IN` is `process.env.PI_RUN_SLOW === "1"`. The per-task run commands do not set `PI_RUN_SLOW=1`, so these commands will report skipped even on a machine with Claude and a mux backend.

**Why this matters:** The plan’s TDD/verification checkpoints for the most important live behavior will not actually execute. Final verification Step 5 uses `PI_RUN_SLOW=1 npm run test:integration`, but the individual task steps should not claim pass/fail coverage while skipped.

**Required change:** Update the per-task commands and expectations to use the slow-lane opt-in, for example:

```bash
PI_RUN_SLOW=1 npm run build:plugin && PI_RUN_SLOW=1 node --test test/integration/pane-claude-interactive.test.ts
```

or more simply:

```bash
npm run build:plugin && PI_RUN_SLOW=1 node --test test/integration/pane-claude-interactive.test.ts
```

Do the same for the Task 12 and Task 13 single-file integration commands. Keep the skip expectation only for machines without Claude or without a mux backend.

### 3. Warning — Tasks 12–13 swallow driver failures, weakening the observable multi-turn assertions

**Where:**

- Task 12 serial test: `await driver.catch(() => { /* surface may have been torn down before driver finished */ });`
- Task 12 parallel test: `await driver.catch(() => {});`
- Task 13 spec-designer e2e: `await driver.catch(() => {});`

**Problem:** The driver coroutines are where the tests actually wait for `CLARIFY?`, `CLARIFY-alpha?`, `CLARIFY-beta?`, `Q1?`, and `Q2?` before sending answers. Swallowing driver errors means a test can still proceed to final payload assertions even if it never observed the clarifying question markers.

**Why this matters:** The spec’s central acceptance criterion is true multi-turn interaction. These tests should fail if the child does not ask the expected questions before completion. As written, a model that ignores the question instruction and directly calls `subagent_done` with the expected final message could let the final assertions pass while the multi-turn behavior was never proven.

**Required change:** Make driver success part of the assertion path. Prefer `await driver` after `runSerial` / `runParallel`, or capture driver errors and fail unless the only accepted condition is a clearly documented benign post-send teardown. Since these drivers resolve immediately after sending the required replies, they should normally be safe to await directly.

### 4. Warning — The MCP sentinel can appear before the Stop hook transcript pointer in one-turn Claude sessions

**Where:** Task 8 watcher rewrite in `pi-extension/subagents/index.ts`; Task 9 and Task 11 autonomous tests assert transcript/session metadata.

**Problem:** The new MCP server writes `PI_CLAUDE_SENTINEL` during the tool call. `pollForExit(...)` returns as soon as that sentinel exists. The Stop hook writes `${PI_CLAUDE_SENTINEL}.transcript` separately after Claude turn-stop events. In a one-turn autonomous run, the watcher can observe the MCP sentinel before the Stop hook has written the transcript pointer, then call `copyClaudeSession(...)`, get `null`, and close the pane. That would make `transcriptPath` / `claudeSessionId` missing even though completion worked.

**Why this matters:** The spec acceptance criteria and planned Tasks 9, 11, 12, and 13 all expect transcript/session metadata to be populated. Multi-turn sessions often have an earlier Stop hook event, but autonomous one-turn sessions are the riskiest path.

**Recommended change:** Add a small bounded wait/retry for `${sentinel}.transcript` before `copyClaudeSession(...)` in the Claude watcher return path, or otherwise ensure the pane is not closed until the transcript pointer has had a chance to appear. This can remain outside `pollForExit` to honor the spec’s “pollForExit unchanged” constraint.

## Buildability / testability assessment

- **Buildability:** Mostly good. The package/script changes, separate plugin `tsconfig.json`, committed `server.js`, and final `npm run build:plugin` verification are coherent. Fix Finding 1 before Task 7 execution.
- **Testability:** Strong overall. The plan adds unit coverage for MCP server behavior, Stop hook regression, launch-spec addendum behavior, Claude command tool injection, transcript fallback parsing, and live pane/orchestration behavior. Fix Findings 2 and 3 so the new live tests actually run and actually prove multi-turn behavior.
- **Implementation order:** Sound. The conditional Task 10 fallback is correctly placed after the first real plugin auto-load smoke test.
- **Spec coverage:** Complete after the above fixes. Every acceptance criterion has planned coverage, including the exact parent-facing `SPEC_WRITTEN: <abs path>` workflow.

## Required changes before execution

1. Seed the `test-echo` fixture (or another `auto-exit: true` fixture) into Task 7’s `captureClaudeLaunchScript` temp cwd so the autoExit launch-path assertion is deterministic.
2. Add `PI_RUN_SLOW=1` to the single-file run commands in Tasks 11–13, or change the stated expectations to explicitly say they will skip unless the variable is set.
3. Stop swallowing driver failures in Tasks 12–13; require the marker-wait/send-answer drivers to succeed so the tests prove real multi-turn behavior.
4. Consider adding a bounded wait for `${PI_CLAUDE_SENTINEL}.transcript` before transcript archival to avoid one-turn autonomous transcript/session metadata races.

After those changes, the plan should be ready to execute.
