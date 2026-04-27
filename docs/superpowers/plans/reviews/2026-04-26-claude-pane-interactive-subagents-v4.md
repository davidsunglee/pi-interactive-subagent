# Review: Claude Pane Interactive Subagents Implementation Plan v4

## Verdict
APPROVE WITH CHANGES

v4 addresses the concrete findings from the v3 review and is much closer to execution-ready. The core architecture remains aligned with the approved v3 spec: Claude pane completion is explicit via the bundled `subagent_done` MCP tool, the Stop hook is transcript-pointer-only, Claude `--tools` restrictions preserve the lifecycle MCP tool, and the slow-lane orchestration tests now exercise the real `runSerial` / `runParallel` path.

However, one blocking execution issue remains in Task 1: the plan asks `tsc -p pi-extension/subagents/plugin` to pass before any `.ts` file exists under the plugin tsconfig include. TypeScript reports a no-inputs error in that state, so execution would fail immediately. There is also a conditional Task 10 buildability issue if the MCP-config fallback path is needed.

Do not start execution until Finding 1 is corrected. If Task 10 is executed, correct Finding 2 before implementing that conditional branch.

## Previous review coverage

The v4 plan addresses all v3 review findings:

1. **Task 7 auto-exit fixture setup:** addressed. `captureClaudeLaunchScript(...)` now accepts seeded agent fixtures and creates `<ctxCwd>/.pi/agents/test-echo.md` for the `auto-exit: true` launch-path assertion.
2. **Tasks 11-13 slow-lane commands:** addressed. The single-file live test commands now include `PI_RUN_SLOW=1`, so they execute instead of silently skipping when Claude and a mux backend are available.
3. **Tasks 12-13 driver failures:** addressed. The serial, parallel, and spec-designer drivers are awaited and no longer swallowed, so missing clarifying-question markers fail the tests.
4. **Watcher transcript-pointer race:** addressed. Task 8 adds a bounded wait for `${PI_CLAUDE_SENTINEL}.transcript` before transcript archival.

## Strengths

- The task ordering is coherent: dependency/build setup, MCP server, manifests, Stop hook, launch-spec changes, command construction, watcher fallback, live tests, final verification.
- The plan preserves the intended boundaries: pi-backed subagents and the headless Claude backend remain out of scope.
- The `--tools` behavior covers the important unmappable-tool case by emitting `--tools mcp__pi-subagent__subagent_done` rather than silently omitting the flag.
- The v4 orchestration tests now use the registry test hook to discover live pane surfaces and assert the parent-facing payload fields (`state`, `finalMessage`, `exitCode`, `transcriptPath`, `sessionId`, `sessionKey`).
- The spec-designer e2e test pins the real workflow contract by asserting `SPEC_WRITTEN: <absolute path>` and the written file side effect.

## Spec / plan conflict calls

### 1. Empty plugin build checkpoint before any plugin `.ts` input exists
- **Where:** Task 1 Step 6.
- **Conflict:** The spec requires a separate plugin `tsconfig`, committed compiled `mcp/server.js`, and final verification that runs `npm run build:plugin` so `server.js` cannot go stale. It does not require verifying the plugin build before `server.ts` exists. The plan adds that early empty-build checkpoint and expects it to pass.
- **Call:** **Spec is better / plan is incorrect.** The build should be verified after Task 2 creates `mcp/server.ts`, or Task 1 must add a real temporary/stub `.ts` input and remove it deliberately. A `.gitkeep` file does not satisfy `include: ["mcp/**/*.ts"]`.

### 2. Watcher fallback wiring test coverage
- **Where:** Task 8.
- **Conflict:** The spec’s watcher summary fallback tests include coverage that `watchSubagent` finalization reads the archived transcript before pane screen-scrape when the sentinel body is empty, plus coverage for the bounded transcript-pointer wait. The plan only adds unit tests for `extractLastAssistantMessage(jsonl)` and relies on live tests with non-empty `subagent_done` messages for the rest.
- **Call:** **Spec is better.** The helper tests are useful, but they do not prove the watcher actually calls the helper or waits for the pointer in the empty-sentinel path.

No architecture-level conflict was found. The spec has no `## Approach` section, so the special approach-honoring rule does not apply.

## Prioritized findings

### 1. Error — Task 1 Step 6 expects an empty TypeScript project to build successfully

**Where:** Task 1 Step 6: `mkdir -p pi-extension/subagents/plugin/mcp && touch pi-extension/subagents/plugin/mcp/.gitkeep && npm run build:plugin` with expected exit 0 and no JS outputs.

**Problem:** The planned plugin `tsconfig.json` includes only `mcp/**/*.ts`. At this point in the plan there are no `.ts` files under `pi-extension/subagents/plugin/mcp`; `.gitkeep` is not a TypeScript input. `tsc -p pi-extension/subagents/plugin` will fail with a no-inputs diagnostic rather than exit 0.

**Why this matters:** This is the first build verification checkpoint and would stop execution before Task 2 begins, even though nothing is wrong with the eventual MCP server implementation.

**Required change:** Remove or change Task 1 Step 6. Good options:

- Defer `npm run build:plugin` until Task 2, after `mcp/server.ts` exists; or
- In Task 1, create a real temporary/stub `.ts` input and explicitly remove it before Task 2; or
- Adjust the expected result to acknowledge the TypeScript no-inputs error and avoid treating it as a verification pass.

The cleanest fix is to delete the empty-build assertion and let Task 2’s build be the first plugin build verification.

### 2. Error — Conditional Task 10 fallback snippet uses undefined variables

**Where:** Task 10 Step 4 generated MCP config snippet:

```ts
const mcpConfigPath = join(artifactDir, `mcp-config-${name}.json`);
mkdirSync(artifactDir, { recursive: true });
```

**Problem:** In the Claude branch, the current launch code has `params.name` and `spec.artifactDir`; it does not have local variables named `artifactDir` or `name`. If plugin auto-load fails and Task 10 is executed as written, the implementation will not compile.

**Why this matters:** Task 10 is conditional, so this does not block the main path when plugin auto-load works. But it is the contingency path for the riskiest integration failure. If that contingency is needed, the plan currently leads to a build error.

**Required change:** Rewrite the snippet to use in-scope values, for example `spec.artifactDir` and a sanitized form of `params.name` (ideally the same safe-name helper/pattern used for launch scripts), then pass that `mcpConfigPath` into `buildClaudeCmdParts(...)`.

### 3. Warning — Task 8 does not test the watcher’s empty-sentinel transcript fallback wiring

**Where:** Task 8 tests and Tasks 9/11 integration coverage.

**Problem:** The plan tests `extractLastAssistantMessage(jsonl)` directly, but none of the planned tests proves that `watchSubagent` uses it when `subagent_done` writes an empty sentinel. The live tests all instruct Claude to call `subagent_done` with non-empty messages (`OK`, `AUTO`, `all done`, `SERIAL_DONE`, etc.), so the sentinel-preferred path succeeds without exercising the transcript fallback.

**Why this matters:** The optional `message` parameter is part of the completion contract. An implementation could correctly parse transcripts in the helper but forget to wire the helper into `watchSubagent`; the planned tests would still pass.

**Recommended change:** Add one focused watcher/fake-surface test, or adapt one integration test, where `subagent_done` is called with no `message` / an empty message and the expected `finalMessage` comes from the archived transcript’s last assistant message rather than the pane scrape.

### 4. Suggestion — Bound the transcript-pointer wait to the condition it is meant to address

**Where:** Task 8 Step 5.

**Observation:** The snippet waits up to two seconds whenever `running.sentinelFile` is set, not only when the sentinel file actually exists and the transcript pointer is missing. Because Claude pane runs always have a `sentinelFile` path, this can add avoidable delay to manual-exit or abort paths.

**Suggested change:** Gate the wait on the condition described by the spec, e.g. sentinel exists and `${sentinel}.transcript` does not yet exist. This is not a blocking issue, but it keeps cancellation and manual close behavior snappier.

## Correctness, completeness, risks, and test adequacy

- **Correctness:** The main design is correct and honors the spec. Fix Finding 1 before execution and Finding 2 before using the conditional fallback.
- **Completeness:** Acceptance criteria are covered at the plan level: multi-turn interaction, explicit completion, parent-facing payloads, autonomous one-shot behavior, tool-restriction injection, pi-path non-regression, and slow-lane live execution. The main completeness gap is the empty-message watcher fallback test in Finding 3.
- **Risks:** The highest runtime risk remains Claude plugin MCP auto-load. Task 9’s checkpoint and Task 10’s fallback are the right mitigation, but Task 10 needs the variable-scope fix above.
- **Test adequacy:** Strong overall. The live orchestration tests now assert observable question markers rather than only final payload shape. Add a watcher fallback wiring test to close the optional-message gap.
- **Implementability:** Mostly good after v4’s revisions. Task 1’s empty-build command is the only main-path blocker.

## Required changes before execution

1. Fix Task 1 Step 6 so the plan does not expect `tsc` to pass with zero plugin `.ts` inputs.
2. Fix Task 10’s generated-config snippet to use in-scope variables (`spec.artifactDir`, `params.name`/sanitized name) before executing that conditional task.
3. Add or adapt a test that exercises `watchSubagent` with an empty sentinel and verifies the transcript JSONL fallback is used.

Blocking issue remains: **Task 1 Step 6**. Once that is corrected, the main path should be ready to execute; Task 10 only needs correction if the conditional fallback is triggered.
