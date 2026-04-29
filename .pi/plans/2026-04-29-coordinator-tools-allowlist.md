# Coordinator Tools Allowlist Implementation Plan

**Source:** TODO-2524bd1c
**Spec:** `.pi/specs/2026-04-29-coordinator-tools-allowlist.md`

**Goal:** Allow coordinator agents (e.g. pi-config's `plan-refiner`, `code-refiner`) to retain orchestration tool tokens (`subagent`, `subagents_list`, `subagent_resume`, `subagent_run_serial`, `subagent_run_parallel`, `subagent_run_cancel`) when running under a tightened `tools:` allowlist. Today the launch-time tool resolver (`resolvePiToolsArg`) filters `effectiveTools` down to `PI_BUILTIN_TOOLS`, dropping any orchestration name before pi receives `--tools`. We extend the resolver to also pass through tokens listed in the existing `SPAWNING_TOOLS` constant, add a launch-time validator that rejects the misconfiguration where `spawning: false` collides with explicit orchestration listings, and document the new "Coordinator agents" contract in the README.

**Architecture summary:**

`pi-extension/subagents/launch-spec.ts` is the single source of truth for both the deny-set expansion (`resolveDenyTools`) and the allowlist filter (`resolvePiToolsArg`). The same `SPAWNING_TOOLS` constant drives both halves, so coordinator orchestration tokens survive `--tools` resolution iff the agent explicitly listed them — no parallel `ORCHESTRATION_TOOLS` constant is introduced. A new helper `validateSpawningToolsConflict()` is invoked from inside `resolveLaunchSpec()` so the throw propagates symmetrically through the pane backend (`pi-extension/subagents/index.ts:681`) and the headless backend (`pi-extension/subagents/backends/headless.ts:182`); both paths fail with the same error shape. `PI_DENY_TOOLS` semantics, lifecycle-tool reservation (`caller_ping`, `subagent_done`), and Claude pane/headless paths are untouched.

**Tech stack:** TypeScript with Node's native `--test` runner and `node:assert/strict`, TypeBox for tool schemas, `@mariozechner/pi-coding-agent` for the extension API. No new external dependencies.

---

## File Structure

- `pi-extension/subagents/launch-spec.ts` (Modify) — extend `resolvePiToolsArg()` so its allowlist filter accepts tokens from both `PI_BUILTIN_TOOLS` and `SPAWNING_TOOLS`; add an internal `validateSpawningToolsConflict()` helper; invoke it from `resolveLaunchSpec()` immediately after `effectiveTools` is computed so both backends throw before any side effects (surface creation, spawn, etc.).
- `test/orchestration/pi-tools-arg.test.ts` (Modify) — add unit tests pinning the new orchestration-token allowlist semantics: orchestration-only declarations now survive resolution, mixed builtin+orchestration declarations preserve both, unknown-only declarations still resolve to `undefined`.
- `test/orchestration/launch-spec.test.ts` (Modify) — add tests for the conflict throw (named tool surfaces in the error) plus a regression test pinning that `spawning: false` with no orchestration listing still produces the full SPAWNING_TOOLS deny set.
- `test/orchestration/pane-pi-tools-reservation.test.ts` (Modify) — add a pane test capturing the launch script and asserting `--tools` includes the orchestration token; add a pane conflict-rejection test that writes a temp agent fixture and asserts `launchSubagent` rejects with the expected error.
- `test/orchestration/headless-pi-tools-reservation.test.ts` (Modify) — add a headless test capturing the spawn argv and asserting `--tools` includes the orchestration token; add a headless conflict-rejection test that mirrors the pane case so both backends prove symmetric error propagation.
- `test/integration/agents/test-coordinator.md` (Create) — fixture agent for the e2e integration test: `cli: pi`, `tools: read, bash, subagent_run_serial`, `disable-model-invocation: true`, prompts the model to dispatch one child via `subagent_run_serial` and exit.
- `test/integration/coordinator-orchestration-tools.test.ts` (Create) — end-to-end integration test that launches the `test-coordinator` headless and verifies the child dispatched via `subagent_run_serial` completes successfully. Slow lane only — gated on `which pi` and `PI_RUN_SLOW=1`, mirroring `headless-pi-smoke.test.ts`.
- `package.json` (Modify) — add the new e2e test path to the `test:integration:slow` script glob so it runs in the slow lane and stays out of the default test gate.
- `README.md` (Modify) — add a "Coordinator agents" subsection beneath "Tool restriction" documenting both prongs of the contract (must run on `cli: "pi"`; must explicitly list required orchestration tools when using restrictive `tools:`) plus the conflict-rejection rule, with a minimal frontmatter example.

---

## Tasks

### Task 1: Extend `resolvePiToolsArg()` to retain orchestration-tool tokens

**Files:**
- Modify: `pi-extension/subagents/launch-spec.ts`
- Test: `test/orchestration/pi-tools-arg.test.ts`

**Steps:**

- [ ] **Step 1: Add failing tests for orchestration-token retention** — In `test/orchestration/pi-tools-arg.test.ts`, append the following `it(...)` blocks to the existing `describe("resolvePiToolsArg", ...)` block:
  - `"keeps orchestration tokens listed in tools alongside builtins"` — call `resolvePiToolsArg("read, subagent_run_serial")`, parse the result as a `Set` split on commas, assert it contains exactly `read`, `subagent_run_serial`, `caller_ping`, `subagent_done`. Include all four `assert.ok(set.has("..."))` checks individually so a regression names the missing token.
  - `"emits a tools list when only an orchestration token is requested"` — call `resolvePiToolsArg("subagent_run_serial")`, assert the return is not `undefined` and the resulting set contains `subagent_run_serial`, `caller_ping`, and `subagent_done` (no other tokens). The current behavior is `undefined` because the resolver short-circuits when no PI_BUILTIN_TOOLS match.
  - `"keeps every SPAWNING_TOOLS member when listed individually"` — call `resolvePiToolsArg("subagent, subagents_list, subagent_resume, subagent_run_serial, subagent_run_parallel, subagent_run_cancel")` and assert all six orchestration tokens plus `caller_ping` and `subagent_done` are present.
- [ ] **Step 2: Confirm the new tests fail** — run `npm test -- test/orchestration/pi-tools-arg.test.ts`. Expected: the three new tests fail because the current resolver returns `undefined` (case 2) or filters orchestration tokens out (cases 1 and 3). The existing four tests must still pass — leave them untouched.
- [ ] **Step 3: Update `resolvePiToolsArg()` in `pi-extension/subagents/launch-spec.ts`** — Change the body so the filter accepts tokens from both sets, and the empty-result short-circuit triggers only when no allowed token survived:
  ```ts
  export function resolvePiToolsArg(effectiveTools: string | undefined): string | undefined {
    if (!effectiveTools) return undefined;
    const allowed = effectiveTools
      .split(",")
      .map((t) => t.trim())
      .filter((t) => PI_BUILTIN_TOOLS.has(t) || SPAWNING_TOOLS.has(t));
    if (allowed.length === 0) return undefined;
    const merged = new Set<string>([...allowed, ...PI_LIFECYCLE_TOOLS]);
    return [...merged].join(",");
  }
  ```
  Update the JSDoc comment on `resolvePiToolsArg` so it states "Tokens from `PI_BUILTIN_TOOLS` and `SPAWNING_TOOLS` survive the filter; `PI_BUILTIN_TOOLS` carries pi's native tool surface and `SPAWNING_TOOLS` carries the orchestration tools that coordinator agents must explicitly opt into."
- [ ] **Step 4: Confirm the new tests pass** — re-run `npm test -- test/orchestration/pi-tools-arg.test.ts`. Expected: all seven tests (four pre-existing, three new) green.
- [ ] **Step 5: Confirm no regression in the wider orchestration suite** — run `npm test`. Expected: every test in the suite passes; specifically the existing `pane-pi-tools-reservation.test.ts` and `headless-pi-tools-reservation.test.ts` cases continue to pass because their `tools: read, bash` input still produces a builtin-only allowlist plus lifecycle tools.

**Acceptance criteria:**

- `resolvePiToolsArg("read, subagent_run_serial")` returns a string containing all four of `read`, `subagent_run_serial`, `caller_ping`, `subagent_done` (commas separating; order unspecified).
  Verify: run `npm test -- test/orchestration/pi-tools-arg.test.ts` and confirm exit code 0; confirm the test named `"keeps orchestration tokens listed in tools alongside builtins"` is present and green.
- `resolvePiToolsArg("subagent_run_serial")` returns a non-undefined value containing the three tokens `subagent_run_serial`, `caller_ping`, `subagent_done`.
  Verify: run `npm test -- test/orchestration/pi-tools-arg.test.ts` and confirm the test named `"emits a tools list when only an orchestration token is requested"` is present and green.
- `resolvePiToolsArg("weird, nonexistent")` still returns `undefined` (no regression on the existing case).
  Verify: run `npm test -- test/orchestration/pi-tools-arg.test.ts` and confirm the existing test `"returns undefined when every effectiveTools entry is unmapped (avoids emitting an empty --tools)"` continues to pass.
- The single-source-of-truth invariant holds: only `SPAWNING_TOOLS` drives both deny-set expansion and the new allowlist filter.
  Verify: `grep -n "ORCHESTRATION_TOOLS" pi-extension/subagents/launch-spec.ts` returns no matches, and `grep -n "SPAWNING_TOOLS" pi-extension/subagents/launch-spec.ts` shows the constant referenced from at least both `resolvePiToolsArg` (Task 1 site) and `resolveDenyTools` (existing site).

**Model recommendation:** standard

---

### Task 2: Add launch-time validator for `spawning: false` × orchestration-tools conflict

**Files:**
- Modify: `pi-extension/subagents/launch-spec.ts`
- Test: `test/orchestration/launch-spec.test.ts`

**Steps:**

- [ ] **Step 1: Add a failing test for the conflict** — In `test/orchestration/launch-spec.test.ts`, inside the existing `describe("resolveLaunchSpec", ...)` block, add a test named `"throws when spawning: false collides with an orchestration token in tools:"`. The test:
  - `mkdtempSync` a temp project root.
  - Write `<root>/.pi/agents/bad-coord.md` with frontmatter `name: bad-coord`, `tools: read, subagent_run_serial`, `spawning: false`, and a one-line body.
  - Call `resolveLaunchSpec({ name: "X", task: "t", agent: "bad-coord", cwd: <root> }, baseCtx)` inside an `assert.throws` whose expected error matches `/spawning: false/` AND `/subagent_run_serial/` (both substrings present in the message).
  - `rmSync` the temp root in a `finally`.
- [ ] **Step 2: Add a passing-path regression test** — Add a sibling test named `"keeps spawning: false → SPAWNING_TOOLS deny-set when no orchestration token is listed"`. The test writes `<root>/.pi/agents/strict-worker.md` with `tools: read, bash`, `spawning: false`, calls `resolveLaunchSpec`, and asserts the resolved `denySet` contains every member of the orchestration tool name list (literal strings: `subagent`, `subagents_list`, `subagent_resume`, `subagent_run_serial`, `subagent_run_parallel`, `subagent_run_cancel`).
- [ ] **Step 3: Confirm test 1 fails and test 2 passes already** — run `npm test -- test/orchestration/launch-spec.test.ts`. Expected: the conflict test fails because `resolveLaunchSpec` does not yet throw; the regression test passes because `resolveDenyTools` already covers this case.
- [ ] **Step 4: Add the `validateSpawningToolsConflict` helper** — In `pi-extension/subagents/launch-spec.ts`, add an internal (non-exported) helper above `resolveLaunchSpec`:
  ```ts
  function validateSpawningToolsConflict(
    agentDefs: AgentDefaults | null,
    effectiveTools: string | undefined,
  ): void {
    if (agentDefs?.spawning !== false) return;
    if (!effectiveTools) return;
    const conflicting = effectiveTools
      .split(",")
      .map((t) => t.trim())
      .filter((t) => SPAWNING_TOOLS.has(t));
    if (conflicting.length === 0) return;
    throw new Error(
      `Agent declares \`spawning: false\` but \`tools:\` includes orchestration tool(s): ${conflicting.join(", ")}. ` +
        `Remove the conflicting token(s) from \`tools:\` or remove \`spawning: false\` so the coordinator can dispatch children.`,
    );
  }
  ```
- [ ] **Step 5: Wire the helper into `resolveLaunchSpec()`** — In `pi-extension/subagents/launch-spec.ts`, immediately after `const effectiveTools = params.tools ?? agentDefs?.tools;` (around line 530, before any session-mode work or session-file path computation), add a single line:
  ```ts
  validateSpawningToolsConflict(agentDefs, effectiveTools);
  ```
  This placement guarantees both backends throw before they touch the filesystem (pane: surface creation, headless: child spawn).
- [ ] **Step 6: Confirm both tests pass** — re-run `npm test -- test/orchestration/launch-spec.test.ts`. Expected: both new tests green; all pre-existing tests in the file untouched.

**Acceptance criteria:**

- `resolveLaunchSpec({ agent: "bad-coord", ... })` throws an `Error` whose message contains both the literal text `spawning: false` and the literal text `subagent_run_serial` when the loaded agent has `spawning: false` and `tools: read, subagent_run_serial`.
  Verify: run `npm test -- test/orchestration/launch-spec.test.ts` and confirm the test `"throws when spawning: false collides with an orchestration token in tools:"` is present and green.
- A `spawning: false` agent without any orchestration listing in `tools:` resolves successfully and `denySet` covers every member of the orchestration tool family.
  Verify: run `npm test -- test/orchestration/launch-spec.test.ts` and confirm the test `"keeps spawning: false → SPAWNING_TOOLS deny-set when no orchestration token is listed"` is present and green; the test must include explicit `assert.ok(spec.denySet.has("..."))` lines for all six SPAWNING_TOOLS members.
- The validator is invoked from `resolveLaunchSpec`, not from a backend-specific call site.
  Verify: open `pi-extension/subagents/launch-spec.ts`, locate the body of `resolveLaunchSpec`, and confirm a single `validateSpawningToolsConflict(agentDefs, effectiveTools);` line appears between the `effectiveTools` definition and the session-file/path computation. Then `grep -n "validateSpawningToolsConflict" pi-extension/subagents/index.ts pi-extension/subagents/backends/headless.ts` returns no matches (the backends do not call the validator directly — they go through `resolveLaunchSpec`).

**Model recommendation:** standard

---

### Task 3: Pane backend coverage — orchestration-token allowlist and conflict rejection

**Files:**
- Modify: `test/orchestration/pane-pi-tools-reservation.test.ts`

**Steps:**

- [ ] **Step 1: Add a pane orchestration-token positive test** — In `test/orchestration/pane-pi-tools-reservation.test.ts`, inside the existing `describe(...)` block, add a test named `"pane Pi command includes orchestration token in --tools when the agent restricts its tool set with one"`. Its body reuses the existing `captureLaunchScript` helper:
  ```ts
  const script = await captureLaunchScript({
    name: "pane-coord", task: "hello", tools: "read, subagent_run_serial",
  });
  const m = script.match(/--tools '([^']+)'/);
  assert.ok(m, `expected --tools in pane pi script; got:\n${script}`);
  const tools = new Set(m![1].split(","));
  assert.ok(tools.has("read"));
  assert.ok(tools.has("subagent_run_serial"));
  assert.ok(tools.has("caller_ping"));
  assert.ok(tools.has("subagent_done"));
  ```
- [ ] **Step 2: Add a pane conflict-rejection test** — Add a sibling test named `"pane Pi launch rejects when spawning: false collides with an orchestration token in tools:"`. The test:
  - `mkdtempSync(join(tmpdir(), "pane-tools-conflict-root-"))` for the project root, and a separate `mkdtempSync(...)` for the session dir (mirrors the existing `captureLaunchScript` helper's two-temp-dir layout in the same file).
  - `mkdirSync(join(root, ".pi", "agents"), { recursive: true })` and `writeFileSync(join(root, ".pi", "agents", "bad-coord.md"), "---\nname: bad-coord\ntools: subagent_run_serial\nspawning: false\n---\nbad coord body\n", "utf8")`.
  - Build `ctx` with `sessionManager.getSessionFile: () => join(sessionDir, "parent.jsonl")`, `getSessionId: () => "parent"`, `getSessionDir: () => sessionDir`, `cwd: sessionDir`.
  - Wrap `launchSubagent({ cli: "pi", name: "pane-bad", task: "hi", agent: "bad-coord", cwd: root }, ctx, { surface: "pi-test-fake-surface" })` in `await assert.rejects(..., /subagent_run_serial/)` so the test pins both the throw and the conflicting token name.
  - After the rejection, walk `<sessionDir>/artifacts/` recursively and assert that no `.sh` file was written (the throw must fire before `sendLongCommand`). Reuse the same `walk(...)` shape used by `captureLaunchScript` in the same file.
  - `rmSync(root, { recursive: true, force: true })` and `rmSync(sessionDir, { recursive: true, force: true })` in a `finally`.
- [ ] **Step 3: Confirm pane tests pass** — run `npm test -- test/orchestration/pane-pi-tools-reservation.test.ts`. Expected: all four tests green (two pre-existing, two new). The conflict test must observe that the throw fires before `createSurface` is called (no dangling surface under the test's session dir).

**Acceptance criteria:**

- The pane Pi launch script for `tools: read, subagent_run_serial` contains a `--tools '<list>'` argv whose comma-separated value includes all four of `read`, `subagent_run_serial`, `caller_ping`, `subagent_done`.
  Verify: run `npm test -- test/orchestration/pane-pi-tools-reservation.test.ts` and confirm the new test named `"pane Pi command includes orchestration token in --tools when the agent restricts its tool set with one"` is present and green.
- `launchSubagent({ agent: "bad-coord", ... })` rejects with an error whose message contains the literal `subagent_run_serial` when the loaded agent has `spawning: false` and `tools: subagent_run_serial`.
  Verify: run `npm test -- test/orchestration/pane-pi-tools-reservation.test.ts` and confirm the new test `"pane Pi launch rejects when spawning: false collides with an orchestration token in tools:"` is present and green; that test uses `assert.rejects(..., /subagent_run_serial/)`.
- The pane conflict path does NOT leave behind a launch script artifact.
  Verify: open `test/orchestration/pane-pi-tools-reservation.test.ts`, locate the new conflict test, and confirm its `finally` block walks the artifact dir under the temp session and asserts no `.sh` launch script was written (the throw beats `sendLongCommand`).

**Model recommendation:** standard

---

### Task 4: Headless backend coverage — orchestration-token allowlist and conflict rejection

**Files:**
- Modify: `test/orchestration/headless-pi-tools-reservation.test.ts`

**Steps:**

- [ ] **Step 1: Add a headless orchestration-token positive test** — In `test/orchestration/headless-pi-tools-reservation.test.ts`, inside the existing `describe(...)` block, add a test named `"argv includes orchestration token in the --tools allowlist when tools requests one"`. Its body matches the existing pattern:
  ```ts
  lastSpawn = null;
  const backend = backendModule.makeHeadlessBackend(ctx);
  const handle = await backend.launch(
    { name: "t", task: "hello", cli: "pi", tools: "read, subagent_run_serial" },
    false,
  );
  await backend.watch(handle);
  assert.ok(lastSpawn);
  const idx = lastSpawn!.args.indexOf("--tools");
  assert.notEqual(idx, -1);
  const tools = new Set(lastSpawn!.args[idx + 1].split(","));
  assert.ok(tools.has("read"));
  assert.ok(tools.has("subagent_run_serial"));
  assert.ok(tools.has("caller_ping"));
  assert.ok(tools.has("subagent_done"));
  ```
- [ ] **Step 2: Add a headless conflict-rejection test** — Add a sibling test named `"headless launch rejects when spawning: false collides with an orchestration token in tools:"`. The test:
  - `mkdtempSync(join(tmpdir(), "headless-tools-conflict-"))` for the project root.
  - `mkdirSync(join(root, ".pi", "agents"), { recursive: true })` and `writeFileSync(join(root, ".pi", "agents", "bad-coord.md"), "---\nname: bad-coord\ntools: subagent_run_serial\nspawning: false\n---\nbad coord body\n", "utf8")`.
  - Reset `lastSpawn = null` so a stale capture from the prior test does not hide a regression.
  - Wrap `backend.launch({ name: "t", task: "hi", cli: "pi", agent: "bad-coord", cwd: root }, false)` in `await assert.rejects(..., /subagent_run_serial/)` so the test pins both the throw AND the conflicting token name in the message.
  - After the `assert.rejects` returns, `assert.equal(lastSpawn, null)` to prove pi was never spawned (the throw must fire before `spawnImpl`).
  - `rmSync(root, { recursive: true, force: true })` in a `finally`.
- [ ] **Step 3: Confirm headless tests pass** — run `npm test -- test/orchestration/headless-pi-tools-reservation.test.ts`. Expected: all four tests green.
- [ ] **Step 4: Confirm pane and headless conflict errors share wording** — read both new conflict tests (`pane-pi-tools-reservation.test.ts` and `headless-pi-tools-reservation.test.ts`) and confirm they both `assert.rejects(..., /subagent_run_serial/)`. The shared regex anchors that the error originates from the same shared site (`validateSpawningToolsConflict`) and not from two divergent backend-side checks.

**Acceptance criteria:**

- The headless argv contains `--tools <list>` whose comma-separated value includes all four of `read`, `subagent_run_serial`, `caller_ping`, `subagent_done`.
  Verify: run `npm test -- test/orchestration/headless-pi-tools-reservation.test.ts` and confirm the new test `"argv includes orchestration token in the --tools allowlist when tools requests one"` is present and green.
- `backend.launch({ agent: "bad-coord", ... })` rejects with an error whose message contains the literal `subagent_run_serial` when the loaded agent has `spawning: false` and `tools: subagent_run_serial`.
  Verify: run `npm test -- test/orchestration/headless-pi-tools-reservation.test.ts` and confirm the new test `"headless launch rejects when spawning: false collides with an orchestration token in tools:"` is present and green.
- pi is never spawned on the headless conflict path (`lastSpawn === null` after the rejected call).
  Verify: open `test/orchestration/headless-pi-tools-reservation.test.ts`, locate the new conflict test, and confirm it asserts `assert.equal(lastSpawn, null)` after the `assert.rejects` call.
- Pane and headless conflict-rejection assertions both use a regex containing `subagent_run_serial` (proves shared-error invariant).
  Verify: `grep -n "subagent_run_serial" test/orchestration/pane-pi-tools-reservation.test.ts test/orchestration/headless-pi-tools-reservation.test.ts` returns at least one match in each file inside an `assert.rejects(...)` call.

**Model recommendation:** standard

---

### Task 5: End-to-end coordinator integration test

**Files:**
- Create: `test/integration/agents/test-coordinator.md`
- Create: `test/integration/coordinator-orchestration-tools.test.ts`
- Modify: `package.json`

**Steps:**

- [ ] **Step 1: Create the coordinator fixture** — Write `test/integration/agents/test-coordinator.md` with the following exact content:
  ```markdown
  ---
  name: test-coordinator
  description: Integration test agent — dispatches a single child via subagent_run_serial under a restrictive tools allowlist
  model: anthropic/claude-haiku-4-5
  cli: pi
  tools: read, bash, subagent_run_serial
  auto-exit: true
  disable-model-invocation: true
  ---

  You are a test coordinator. Your only job is to call `subagent_run_serial` exactly once with a single task that runs the `test-echo` agent and asks it to reply with exactly `COORD-CHILD-OK`. After `subagent_run_serial` returns, write the child's `finalMessage` verbatim as your final assistant message and stop. Do not call any other tool. Do not retry. Do not ask questions.
  ```
- [ ] **Step 2: Create the integration test file** — Write `test/integration/coordinator-orchestration-tools.test.ts` modeled after `test/integration/headless-pi-smoke.test.ts`. The test must:
  - `import { describe, it, before, after } from "node:test";`
  - `import assert from "node:assert/strict";`
  - `import { execSync } from "node:child_process";`
  - `import { mkdtempSync, rmSync } from "node:fs";`
  - `import { tmpdir } from "node:os";`
  - `import { join } from "node:path";`
  - `import { copyTestAgents, SLOW_LANE_OPT_IN } from "./harness.ts";`
  - `import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";`
  - Detect pi availability with `const PI_AVAILABLE = (() => { try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; } })();`
  - Compute `const SHOULD_SKIP = !PI_AVAILABLE || !SLOW_LANE_OPT_IN;`
  - Wrap the test in `describe("coordinator-orchestration-tools", { skip: SHOULD_SKIP, timeout: 120_000 }, () => { ... })`.
  - In `before`, save `process.env.PI_SUBAGENT_MODE`, set it to `"headless"`, `mkdtempSync` a `dir`, call `copyTestAgents(dir)` (this seeds `test-echo` and `test-coordinator` because `copyTestAgents` copies every `.md` from `test/integration/agents/`), and `process.chdir(dir)` (with the prior cwd saved for restore).
  - In `after`, restore `PI_SUBAGENT_MODE`, `process.chdir(origCwd)`, `rmSync(dir, { recursive: true, force: true })`.
  - Write a single `it("coordinator with restrictive tools dispatches child via subagent_run_serial and surfaces COORD-CHILD-OK", async () => { ... })` whose body:
    - Constructs a `makeHeadlessBackend({ sessionManager: { getSessionFile: () => join(dir, "parent.jsonl"), getSessionId: () => "parent", getSessionDir: () => dir }, cwd: dir });`
    - Calls `await backend.launch({ name: "coord", agent: "test-coordinator", task: "Run the coordination workflow now." }, false)`.
    - Calls `await backend.watch(handle)`.
    - Asserts `result.exitCode === 0` (failure message shows `result.error`).
    - Asserts `result.finalMessage` includes the literal substring `COORD-CHILD-OK`.
    - Asserts `result.transcript` contains at least one `toolCall` content block whose `name === "subagent_run_serial"` (iterate over `result.transcript`, look at each message's `content`, for blocks `b` with `b.type === "toolCall"` check `b.name`).
- [ ] **Step 3: Add the test to the slow-lane glob in `package.json`** — In `package.json`'s `test:integration:slow` script value, append `test/integration/coordinator-orchestration-tools.test.ts` to the existing space-separated list of paths after `test/integration/orchestration-claude-pane-spec-designer-e2e.test.ts`. Do NOT add it to the `test:integration` glob — that script runs the default integration gate, which must stay model-free.
- [ ] **Step 4: Run the slow-lane test if pi + a model are present** — `PI_RUN_SLOW=1 npm run test:integration:slow -- test/integration/coordinator-orchestration-tools.test.ts`. Expected: pass when pi and a working model are present; auto-skipped otherwise. (CI without `PI_RUN_SLOW` and without pi installed will report skipped.)

**Acceptance criteria:**

- The coordinator fixture exists with the exact frontmatter listed above.
  Verify: run `grep -nE "^(name|cli|tools|spawning|auto-exit|disable-model-invocation):" test/integration/agents/test-coordinator.md`; confirm output includes `name: test-coordinator`, `cli: pi`, `tools: read, bash, subagent_run_serial`, `auto-exit: true`, `disable-model-invocation: true` (and no `spawning:` line, since omitting it leaves spawning at the default `true`).
- The integration test file exists and self-skips outside the slow lane.
  Verify: open `test/integration/coordinator-orchestration-tools.test.ts` and confirm the `describe(...)` invocation passes `{ skip: SHOULD_SKIP, timeout: 120_000 }` where `SHOULD_SKIP` is computed from `!PI_AVAILABLE || !SLOW_LANE_OPT_IN` (same shape as `headless-pi-smoke.test.ts` minus the slow-lane flag).
- The test asserts that `subagent_run_serial` was actually invoked by the coordinator.
  Verify: `grep -n "subagent_run_serial" test/integration/coordinator-orchestration-tools.test.ts` returns at least one match inside an `assert.ok(...)` or `assert.equal(...)` call that walks `result.transcript`.
- The slow-lane script in `package.json` includes the new test path.
  Verify: `grep -n "coordinator-orchestration-tools" package.json` returns at least one match, inside the `test:integration:slow` script line.
- The default test gates remain free of the new test.
  Verify: open `package.json` and confirm the `test` script (line ~20) does NOT mention `coordinator-orchestration-tools`, and the `test:integration` script (line ~21) does NOT mention `coordinator-orchestration-tools` — only `test:integration:slow` does.

**Model recommendation:** standard

---

### Task 6: Document the coordinator contract in README

**Files:**
- Modify: `README.md`

**Steps:**

- [ ] **Step 1: Locate the existing "Tool restriction" section** — open `README.md` and find the H2 heading `## Tool restriction` (currently around line 96). The single paragraph beneath it (~line 98) describes worker-side allowlist behavior.
- [ ] **Step 2: Insert a "Coordinator agents" subsection immediately after that paragraph** — Add the following block before the next H2 heading (`## Skills`):

  ```markdown
  ### Coordinator agents

  An agent that dispatches children must:

  1. Run on `cli: pi` (the default). The Claude CLI does not expose pi's orchestration tools (`subagent`, `subagents_list`, `subagent_resume`, `subagent_run_serial`, `subagent_run_parallel`, `subagent_run_cancel`); a Claude-CLI coordinator cannot dispatch children via these tools.
  2. Explicitly list the orchestration tools it needs in its `tools:` frontmatter when using a restrictive allowlist. Tokens not listed are dropped at launch — even though `spawning: true` (the default) leaves them ungated, the `--tools` filter only emits names the agent named.

  Example minimal coordinator frontmatter:

  ```yaml
  ---
  name: plan-refiner
  cli: pi
  tools: read, bash, subagent_run_serial
  ---
  ```

  An agent declaring **both** `spawning: false` **and** any orchestration tool in `tools:` is rejected at launch with an error naming the conflicting token. Pick one: either omit `spawning: false` so the coordinator can dispatch children, or remove the orchestration token(s) from `tools:` and keep the worker-style restriction.
  ```

- [ ] **Step 3: Confirm header levels and surrounding flow** — read the file from the start of the "Tool restriction" H2 down through the new subsection and onward to "## Skills". Confirm the new subsection is at H3 (`### Coordinator agents`), nests under "Tool restriction", and is followed by the existing "## Skills" H2 heading without spurious blank-line breakage.

**Acceptance criteria:**

- README contains an H3 `### Coordinator agents` subsection located between the existing "Tool restriction" paragraph and the "## Skills" H2 heading.
  Verify: `grep -n "^### Coordinator agents$" README.md` returns exactly one match; confirm via `grep -n "^## " README.md` that the line numbers show "Tool restriction" → "Coordinator agents" → "Skills" in document order.
- The new subsection states both prongs of the contract: `cli: pi` requirement, and explicit listing of orchestration tools under restrictive `tools:`.
  Verify: open `README.md` and read the "Coordinator agents" subsection; confirm it contains the literal text `cli: pi` AND mentions explicit listing of orchestration tools (e.g., contains the word `explicitly` near a reference to `tools:`).
- The README includes a minimal `tools:` example listing at least one orchestration tool.
  Verify: open `README.md` and confirm the new subsection contains a fenced YAML block whose `tools:` line includes one of `subagent_run_serial`, `subagent_run_parallel`, `subagent`, `subagents_list`, `subagent_resume`, `subagent_run_cancel`.
- The README documents the conflict-rejection rule.
  Verify: open `README.md` and confirm the "Coordinator agents" subsection contains a sentence stating that an agent declaring both `spawning: false` and any orchestration tool in `tools:` is rejected at launch.

**Model recommendation:** cheap

---

## Dependencies

- Task 2 depends on: Task 1 — both touch `pi-extension/subagents/launch-spec.ts` and share the `SPAWNING_TOOLS` constant; landing Task 1's resolver change first prevents a half-state where the validator forbids what the resolver also drops.
- Task 3 depends on: Task 1, Task 2 — the new pane positive test relies on the resolver allowing orchestration tokens through, and the conflict-rejection test relies on the validator throwing.
- Task 4 depends on: Task 1, Task 2 — same dependency rationale as Task 3.
- Task 5 depends on: Task 1, Task 2 — the e2e coordinator depends on `subagent_run_serial` surviving `--tools` resolution; without Task 1 the coordinator pi child has no `subagent_run_serial` available.
- Task 6 depends on: Task 1, Task 2 — the README documents the actual behavior of the resolver (Task 1) and validator (Task 2). Documenting before code lands risks describing behavior that is not yet present.

---

## Risk Assessment

- **Risk:** Adding orchestration-token retention could quietly widen the surface for `spawning: false` worker agents that happen to include an orchestration name in `tools:` (which today gets silently dropped by the resolver).
  **Mitigation:** Task 2's launch-time validator turns this into an immediate, explicit rejection at launch. Both pane and headless paths fail symmetrically because the throw originates inside `resolveLaunchSpec`, which both backends invoke before any I/O or spawn.

- **Risk:** Throwing from `resolveLaunchSpec` could surprise call sites that previously assumed pure resolution.
  **Mitigation:** `resolveLaunchSpec` is only invoked at launch time by the two backends and by the existing test suite. None of the existing tests fixture a `spawning: false` + orchestration-token agent (`test-echo` is `spawning: false` with builtin-only tools), so the new throw fires only on the new conflict cases. Task 2 Step 2's regression test pins this.

- **Risk:** The pane backend creates surfaces eagerly. If validation moved later in the launch flow, a rejected pane launch could leave a dangling surface.
  **Mitigation:** The validator is invoked from inside `resolveLaunchSpec`, which runs at line 681 of `pi-extension/subagents/index.ts` — six lines before `createSurface`. Task 3 Step 3's "no dangling launch script" check pins this invariant.

- **Risk:** The integration test (Task 5) depends on a real model and could be flaky in CI.
  **Mitigation:** The test self-skips unless `which pi` succeeds AND `PI_RUN_SLOW=1` is set. It lives only in `test:integration:slow`, not in the default test gate or `test:integration`.

- **Risk:** `loadAgentDefaults` precedence (project-local `.pi/agents/<name>.md` wins over global / bundled). A test fixture could collide with a developer's real project-local agent of the same name.
  **Mitigation:** Tests use `mkdtempSync` for the project root and unique fixture names like `bad-coord` that are unlikely to collide; the `cwd: <tempRoot>` parameter ensures lookup follows the temp root, not the test runner's working directory.

- **Risk:** README example might drift if orchestration tool names change again.
  **Mitigation:** Task 6 uses `subagent_run_serial` (the canonical post-rename name from the orchestration-lifecycle expansion). A future rename would already require coordinated README + extension updates; documenting against the current canonical name is correct for now.

---

## Test Command

```bash
npm test
```
