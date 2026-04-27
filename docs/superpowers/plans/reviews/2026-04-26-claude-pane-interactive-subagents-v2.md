# Review: Claude Pane Interactive Subagents Implementation Plan v2

## Verdict
[Issues Found]

v2 is a substantial improvement over v1. It addresses all five findings from the previous review at the plan level:
- real orchestration coverage is now planned in Tasks 12–13,
- multi-turn tests now wait for observable turn markers instead of blind sleeps,
- parent-facing payload assertions now include `state` / session metadata,
- plugin auto-load now has an explicit decision checkpoint plus conditional fallback,
- source-TODO closure is now correctly optional and out of feature scope.

The architecture, task ordering, and spec coverage are mostly strong. The remaining problems are execution/buildability issues in the test plumbing and one weakened workflow assertion. These should be fixed before execution starts.

## Strengths
- The architecture summary matches the spec's chosen mechanism closely: explicit `subagent_done`, slim Stop hook, Claude-only completion addendum, and transcript-first fallback.
- Sequencing is sensible: dependency/build plumbing first, then runtime pieces, then watcher behavior, then integration/orchestration coverage, then final verification.
- The plan now protects the real orchestration use case rather than only the raw pane backend.
- The conditional `--mcp-config` fallback is a good risk-management addition.

## Spec/plan conflict calls
1. **Task 6 (`--tools` emission when no builtins map)**
   - **Conflict:** The spec only requires injecting `mcp__pi-subagent__subagent_done` whenever `--tools` is emitted. The plan goes further and emits `--tools` with only the MCP tool when `effectiveTools` is set but none of the requested tools map to Claude builtins.
   - **Call:** **Plan is better.**
   - **Why:** Without this stronger behavior, a restrictive but unmappable tool list would silently remove the completion tool and recreate a hang path. Keep the plan's stronger rule.

2. **Task 13 (`SPEC_WRITTEN: <path>` workflow contract)**
   - **Conflict:** The spec wants the parent to receive `SPEC_WRITTEN: <path>`; the plan's test code only asserts `/SPEC_WRITTEN:/` and currently tells the model the literal placeholder `${SPEC_PATH}` instead of the concrete path.
   - **Call:** **Spec is better.**
   - **Why:** The path value is part of the parent-facing workflow contract, not incidental detail.

## Issues

### 1) Error — Tasks 12 and 13 rely on surface tracking that the current harness/backend path does not provide
**Evidence:**
- Task 12 Step 1 and Task 13 Step 2 both assume `createTestEnv()` / `env.surfaces` will reveal panes launched through `runSerial` / `runParallel`.
- In `test/integration/harness.ts`, `createTestEnv()` initializes `surfaces: []` and does not auto-track panes created elsewhere.
- Existing direct-launch tests explicitly do `env.surfaces.push(running.surface)` after `launchSubagent(...)` (for example `test/integration/claude-sentinel-roundtrip.test.ts`).
- `runSerial` / `runParallel` do not expose `running.surface`, so the planned drivers have no way to discover the pane before sending replies.

**Why this matters:**
These orchestration tests will hang or time out before they ever send the clarifying-turn replies, which means the plan's most important new coverage is not currently buildable.

**Concrete fix:**
Rework Tasks 12–13 to capture launched surfaces through an actual seam. Two viable options already exist in code:
- use `subagents.__test__.getRunningSubagents()` to discover the live pane surface for the current child, or
- add/use a dedicated surface-tracking hook around the pane backend / `launchSubagent` path.

### 2) Error — Task 2's `plugin-mcp` test snippet is not executable in this repo's ESM test environment
**Evidence:**
- `package.json` sets `"type": "module"`.
- Task 2's proposed `test/plugin-mcp.test.ts` uses `require("node:fs").readdirSync(before)` inside the test body.

**Why this matters:**
Under the repo's current `node --test` ESM setup, that test will throw before it can validate the MCP server behavior.

**Concrete fix:**
Import `readdirSync` at the top of the file (or remove that check entirely) and keep the test purely ESM.

### 3) Warning — Task 10's conditional `--mcp-config` fallback writes into `artifactDir` before ensuring the directory exists
**Evidence:**
- Task 10 Step 4 writes `mcp-config-${name}.json` directly under `artifactDir`.
- In current code, `getArtifactDir()` only computes the path; directory creation happens later when other artifact writers or `sendLongCommand(...scriptPath)` run.

**Why this matters:**
If Task 10 is needed, the fallback can fail on its first execution with a filesystem error instead of rescuing the plugin auto-load failure.

**Concrete fix:**
Add `mkdirSync(dirname(mcpConfigPath), { recursive: true })` before `writeFileSync(...)`, or write the config into a directory that is guaranteed to exist already.

### 4) Warning — Final verification still allows a stale or broken committed `mcp/server.js` to slip through
**Evidence:**
- `tsconfig.json` excludes `pi-extension/subagents/plugin/**`, so `npm run typecheck` does not typecheck or compile the plugin server.
- The new plugin tests target the committed `server.js`, not a freshly built output.
- Task 14 does not require `npm run build:plugin` before `npm test` / `npm run test:integration`.

**Why this matters:**
A stale `server.js` can pass tests even if `server.ts` no longer compiles or no longer matches the shipped artifact.

**Concrete fix:**
Make `npm run build:plugin` a required Task 14 verification step before running tests, or fold it into the repo's verification path so the compiled plugin artifact is always refreshed.

### 5) Warning — Task 13 does not actually pin the `SPEC_WRITTEN: <abs path>` contract it claims to test
**Evidence:**
- The Task 13 test prompt concatenates a normal string containing ``${SPEC_PATH}``, so the model is told the literal placeholder instead of the actual absolute path.
- The assertion only checks `assert.match(r.finalMessage, /SPEC_WRITTEN:/)` rather than the expected path-bearing message.

**Why this matters:**
The workflow-level contract is specifically that the parent receives a path-bearing `SPEC_WRITTEN: <path>` summary. The current test can pass without proving that contract.

**Concrete fix:**
Interpolate the real `SPEC_PATH` into the task string and assert the exact returned message, or at minimum exact path containment.

### 6) Suggestion — Gate the new real-backend orchestration suites behind the existing slow-lane opt-in
**Evidence:**
- `test/integration/harness.ts` documents `SLOW_LANE_OPT_IN` specifically for real-backend orchestration suites.
- Existing real-backend orchestration tests such as `test/integration/orchestration-pane-async-backend.test.ts` and `...block-backend.test.ts` use that gate.
- Tasks 12–13 add comparable live Claude/mux orchestration coverage but skip only on Claude/plugin/backend availability.

**Why this matters:**
Without the gate, `npm run test:integration` becomes much heavier on machines that do have Claude configured, which cuts against the repo's current default integration-test structure.

**Concrete fix:**
Use the same `SLOW_LANE_OPT_IN` gate for Tasks 12–13. Consider doing the same for Task 11 as well if runtime proves large.

## Overall assessment
The plan is now structurally much closer to execution-ready, and it does address the previous v1 review findings. The remaining problems are not architectural; they are concrete build/test-plumbing issues. Fix the two Errors and the workflow-verification Warnings before execution.

## Required changes before execution
1. Rework Tasks 12–13 so the orchestration tests can reliably discover and drive the real pane surfaces.
2. Remove the CommonJS `require(...)` from Task 2's ESM test snippet.
3. Make Task 10's fallback config write create its destination directory.
4. Add a mandatory `npm run build:plugin` step to final verification.
5. Tighten Task 13 so it proves the exact `SPEC_WRITTEN: <path>` parent contract.
