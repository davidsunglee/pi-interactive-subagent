# Orchestration result content channel carries full per-task finalMessage

**Source:** TODO-314cc60e
**Spec:** docs/specs/2026-05-09-orchestration-result-content-channel.md

## Goal

Make `subagent_run_serial` and `subagent_run_parallel` deliver each child task's full structured `finalMessage` through the parent agent's LLM-visible content channel, in both blocking (`wait: true`) and async (`wait: false`) paths. Today the orchestration tools preserve the full report only in the side-channel `details.results[i].finalMessage`, while the LLM-visible `content` text uses `firstLine(finalMessage)` (sync) or a one-line orchestration summary (async). Two surgical edits — `summarize()` in `pi-extension/orchestration/tool-handlers.ts` and the `registryEmitter` for `ORCHESTRATION_COMPLETE_KIND` in `pi-extension/subagents/index.ts` — close the gap. The aggregate one-line header (mode, task count, `isError`) is preserved as the head of payload; per-task entries follow in input-task order, each carrying the task's full `finalMessage` body verbatim.

## Architecture summary

There are two LLM-visible content compose-points for orchestration completion:

1. **Sync path** — `subagent_run_serial` / `subagent_run_parallel` with `wait: true` return a tool result `{ content: [{ text: summarize(...) }], details: {...} }`. The `summarize()` helper (private to `tool-handlers.ts`) is the single source of truth for the sync content text.
2. **Async path** — `wait: false` returns a dispatch envelope, then later the registry's `tryFinalize()` emits `ORCHESTRATION_COMPLETE_KIND` to the registry emitter installed at module load in `pi-extension/subagents/index.ts`. The emitter calls `pi.sendMessage({ customType: "orchestration_complete", content: ..., details: payload }, { triggerTurn: true, deliverAs: "steer" })`. The `content` string is the LLM-visible payload.

Both compose-points get the same shape:

```
<aggregate header>

Task "<name>" (<state>, exit=<n>, <ms>ms):

<full finalMessage verbatim>

Task "<name-2>" (<state>, exit=<n>, <ms>ms):

<full finalMessage verbatim>
```

For sync, the aggregate header is `<mode> orchestration: <N> task(s), isError=<bool>` (matching the existing one-line header in `summarize()`).

For async, the aggregate header is `Orchestration "<id>" completed (<N> task(s), isError=<bool>).` (matching the existing one-line header in the registry emitter).

The `details` payload is unchanged on both paths — UI renderers (`subagent-result-renderer`, `headless-render`, sync `tool.renderResult` callbacks) read from `details.results[i].finalMessage` and continue to work without modification. The bare `subagent` tool, `subagent_ping`, and `BLOCKED_KIND` content compositions are also untouched.

## Tech stack

- TypeScript, Node 25+ ESM (`type: "module"`), `--test` runner via `node --test`.
- `@mariozechner/pi-coding-agent` peer dep for `ExtensionAPI`, `Theme` typings.
- `typebox` for tool parameter schemas (no schema changes here).
- No new dependencies. No new files. Pure content-string change in two existing call sites.

## File Structure

- `pi-extension/orchestration/tool-handlers.ts` (Modify) — Replace `summarize()`'s one-line-per-task body with a multi-block layout that emits each task's full `finalMessage` verbatim under a per-task header; remove the now-unused `firstLine()` helper.
- `pi-extension/subagents/index.ts` (Modify) — Replace the `ORCHESTRATION_COMPLETE_KIND` branch's single-line `content` string with a multi-block string that mirrors the sync layout: existing one-line header, then per-task blocks with full `finalMessage` verbatim. Only the `content` field changes; `customType`, `display`, `details`, and `sendMessage` options are byte-identical.
- `test/orchestration/tool-handlers.test.ts` (Modify) — Add two new test cases asserting that `subagent_run_serial.execute({ wait: true, ... })` and `subagent_run_parallel.execute({ wait: true, ... })` return a content text that contains a multi-line structured `finalMessage` (e.g., `STATUS: DONE_WITH_CONCERNS\n\n## Completed\n...`) verbatim, plus the aggregate header and per-task names in input order.
- `test/integration/orchestration-extension-async.test.ts` (Modify) — Add two new test cases asserting that `wait: false` `subagent_run_serial` and `subagent_run_parallel` deliver an `orchestration_complete` `pi.sendMessage` whose `content` string contains each task's full multi-line `finalMessage` verbatim, plus the aggregate header.

## Tasks

### Task 1: Sync path — full `finalMessage` in `summarize()`

**Files:**
- Modify: `pi-extension/orchestration/tool-handlers.ts`
- Test: `test/orchestration/tool-handlers.test.ts`

**Steps:**
- [ ] **Step 1: Add a failing sync-content test for `subagent_run_serial`** — In `test/orchestration/tool-handlers.test.ts`, append a new `it(...)` inside the existing `describe("registerOrchestrationTools", ...)` block. Build a `LauncherDeps` whose `waitForCompletion` returns `finalMessage` set to a multi-line fixture exactly equal to:

  ```
  STATUS: DONE_WITH_CONCERNS

  ## Completed
  - Implemented foo
  - Added tests for bar

  ## Tests
  - 12 new test cases
  - All passing

  ## Concerns
  - Memory usage may be elevated
  ```

  Drive `serial.execute("call-content-sync", { tasks: [{ name: "task-one", agent: "x", task: "t1" }, { name: "task-two", agent: "x", task: "t2" }] }, ...)` and assert:
  - `out.content[0].text` includes the literal substring `STATUS: DONE_WITH_CONCERNS`.
  - `out.content[0].text` includes the literal substring `## Completed\n- Implemented foo` (multi-line survives without truncation).
  - `out.content[0].text` includes the aggregate header `serial orchestration: 2 task(s), isError=false`.
  - `out.content[0].text` includes both `task-one` and `task-two` substrings, with `task-one` appearing before `task-two` in input-task order (`indexOf("task-one") < indexOf("task-two")`).
  - `out.details.results.length === 2` (regression guard for the unchanged `details` shape).

- [ ] **Step 2: Add a failing sync-content test for `subagent_run_parallel`** — In the same `describe` block, append a parallel-mode case with the same multi-line fixture. Drive `parallel.execute("call-content-sync-p", { tasks: [{ name: "p-one", agent: "x", task: "t1" }, { name: "p-two", agent: "x", task: "t2" }] }, ...)` and assert:
  - `out.content[0].text` includes the multi-line fixture verbatim (same substring assertions as Step 1).
  - `out.content[0].text` includes the aggregate header `parallel orchestration: 2 task(s), isError=false`.
  - `out.content[0].text` mentions both `p-one` and `p-two` in input order.

- [ ] **Step 3: Run the failing tests** — `npm test -- --test-name-pattern="run_serial|run_parallel"` (or `npm test` and observe the new cases failing). Confirm both new cases fail because today's `summarize()` truncates to `firstLine()`. Capture the failure messages to verify the assertions are well-formed before implementing.

- [ ] **Step 4: Replace `summarize()` body in `tool-handlers.ts`** — At `pi-extension/orchestration/tool-handlers.ts:460`, replace the function body so it emits the aggregate header followed by one block per task. The exact replacement:

  ```ts
  function summarize(mode: "serial" | "parallel", results: any[], isError: boolean): string {
    const lines: string[] = [`${mode} orchestration: ${results.length} task(s), isError=${isError}`];
    for (const r of results) {
      lines.push("");
      lines.push(`Task "${r.name}" (${r.state}, exit=${r.exitCode}, ${r.elapsedMs}ms):`);
      lines.push("");
      lines.push(r.finalMessage ?? "");
    }
    return lines.join("\n");
  }
  ```

  Constraints to preserve:
  - The first line must remain the existing aggregate-header form `${mode} orchestration: ${results.length} task(s), isError=${isError}` (the spec mandates this head-of-payload summary).
  - Per-task entries iterate `results` in input order — the source array is already input-ordered by `runSerial` / `runParallel` and `toPublicResults`.
  - Use `r.finalMessage ?? ""` to handle the (rare) undefined case without throwing; do NOT substitute with `r.error` or any other fallback.
  - Do NOT call `firstLine()`. Do NOT introduce truncation, ellipsis, or character caps anywhere in the per-task body.

- [ ] **Step 5: Remove the now-unused `firstLine()` helper** — Delete the helper at `pi-extension/orchestration/tool-handlers.ts:468-471`. Before deleting, run `grep -n "firstLine" pi-extension/orchestration/tool-handlers.ts` to confirm it has zero remaining references in the file. (The local-variable `firstLine` in `pi-extension/subagents/index.ts:2155` is a different identifier inside `renderCall` and is unrelated.)

- [ ] **Step 6: Re-run sync tests** — `npm test`. Confirm both new cases pass and every previously-passing case in `test/orchestration/tool-handlers.test.ts`, `test/orchestration/run-serial.test.ts`, `test/orchestration/run-parallel.test.ts`, `test/orchestration/async-dispatch.test.ts`, and `test/orchestration/cancel.test.ts` still passes. No `details`-shape, `OrchestrationResult`-type, or registry-payload assertion should regress.

- [ ] **Step 7: Typecheck** — `npm run typecheck`. The summarize signature is unchanged (`(mode, results, isError) => string`); typecheck must remain clean.

**Acceptance criteria:**
- `summarize()` returns a string whose first line is `<mode> orchestration: <N> task(s), isError=<bool>` and whose body contains each input task's `finalMessage` verbatim, with no truncation.
  Verify: open `pi-extension/orchestration/tool-handlers.ts` and confirm the function body at line 460 matches the replacement in Step 4 exactly (no `firstLine` call, no `200`/`…` truncation literal, `lines.push(r.finalMessage ?? "")` present).
- The `firstLine()` helper has been deleted.
  Verify: run `grep -n "firstLine" pi-extension/orchestration/tool-handlers.ts` — must produce zero matches.
- The new test cases for `subagent_run_serial` (`wait: true`) and `subagent_run_parallel` (`wait: true`) pass with the multi-line `STATUS: DONE_WITH_CONCERNS` fixture surviving verbatim.
  Verify: run `npm test` and confirm exit code 0 with no `FAIL` lines, and that the test runner output includes test names matching `subagent_run_serial.*content` and `subagent_run_parallel.*content` (the names you give the new `it(...)` blocks in Steps 1-2) as passing.
- The existing `details`-shape and `renderResult` assertions in `test/orchestration/tool-handlers.test.ts` still pass — no regression to `details.results`, `index`, `state`, or `renderResult` output.
  Verify: read `test/orchestration/tool-handlers.test.ts` after edits and confirm every existing `it("...")` block is preserved unchanged; run `npm test` and confirm the previously-passing test names in that file all still report passing.

**Model recommendation:** cheap

---

### Task 2: Async path — full `finalMessage` in `orchestration_complete` steer-back content

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Test: `test/integration/orchestration-extension-async.test.ts`

**Steps:**
- [ ] **Step 1: Add a failing async-content test for `subagent_run_serial`** — In `test/integration/orchestration-extension-async.test.ts`, append a new `it(...)` inside the existing `describe("async orchestration — real subagentsExtension wiring", ...)` block. Replace the test's `okDeps` for this case with a `multilineDeps: LauncherDeps` whose `waitForCompletion` returns `finalMessage` equal to:

  ```
  STATUS: DONE_WITH_CONCERNS

  ## Completed
  - Implemented foo
  - Added tests for bar

  ## Tests
  - 12 new test cases
  - All passing

  ## Concerns
  - Memory usage may be elevated
  ```

  In the test body, `subagentsTest.setLauncherDepsOverride(multilineDeps)` before invoking `subagent_run_serial.execute({ wait: false, tasks: [{ name: "task-one", agent: "x", task: "t1" }, { name: "task-two", agent: "x", task: "t2" }] }, ...)`. After awaiting `setTimeout(100)`, find the `orchestration_complete` `sendMessage` call and assert:
  - `completion.msg.content` (a string) includes the literal substring `STATUS: DONE_WITH_CONCERNS`.
  - `completion.msg.content` includes the literal substring `## Completed\n- Implemented foo` (multi-line survives without truncation).
  - `completion.msg.content` starts with the literal `Orchestration "${env.details.orchestrationId}" completed (2 task(s), isError=false).` head-of-payload header (use `assert.ok(completion.msg.content.startsWith(...))`).
  - `completion.msg.content.indexOf("task-one") < completion.msg.content.indexOf("task-two")` — input-task order is preserved.
  - `completion.msg.details.results.length === 2` and `completion.msg.details.results[0].finalMessage` equals the full multi-line fixture (regression guard for the unchanged `details` payload).
  - The existing assertions in the file (single completion, `deliverAs: "steer"`, `triggerTurn: true`, results state map) continue to hold for this case.

  Reset the launcher deps override in `before` / use a fresh `subagentsTest.resetRegistry()` per test so the new case is isolated from the existing one. Follow the existing `before/after` pattern in this file: register the multi-line deps inside the new `it` body (or in a nested `describe` with its own `before/after`) so the existing `it` keeps its `okDeps` wiring intact.

- [ ] **Step 2: Add a failing async-content test for `subagent_run_parallel`** — In the same file, append a parallel-mode case mirroring Step 1. Drive `parallel.execute({ wait: false, tasks: [{ name: "p-one", agent: "x", task: "t1" }, { name: "p-two", agent: "x", task: "t2" }] }, ...)`. Assert:
  - `completion.msg.content` includes the multi-line fixture verbatim (same substring assertions as Step 1).
  - `completion.msg.content` starts with `Orchestration "${env.details.orchestrationId}" completed (2 task(s), isError=false).`.
  - `completion.msg.content.indexOf("p-one") < completion.msg.content.indexOf("p-two")` — input-task order preserved.

- [ ] **Step 3: Run the failing tests** — `npm run test:integration -- --test-name-pattern="async orchestration"` (or simply `npm run test:integration` and look for the new cases). Confirm both new async cases fail because today's emitter sends only the one-line summary in `content`. Verify the assertions are well-formed via the failure messages.

- [ ] **Step 4: Replace the `ORCHESTRATION_COMPLETE_KIND` `content` payload in `subagents/index.ts`** — At `pi-extension/subagents/index.ts:1785-1796`, replace the `content` field of the `pi.sendMessage` call so it includes each task's full `finalMessage`. The exact replacement for the `ORCHESTRATION_COMPLETE_KIND` branch:

  ```ts
  if (payload.kind === ORCHESTRATION_COMPLETE_KIND) {
    updateWidget();
    const lines: string[] = [
      `Orchestration "${payload.orchestrationId}" completed ` +
        `(${payload.results.length} task(s), isError=${payload.isError}).`,
    ];
    for (const r of payload.results) {
      lines.push("");
      lines.push(`Task "${r.name}" (${r.state}, exit=${r.exitCode}, ${r.elapsedMs}ms):`);
      lines.push("");
      lines.push(r.finalMessage ?? "");
    }
    piForRegistry.sendMessage({
      customType: "orchestration_complete",
      content: lines.join("\n"),
      display: true,
      details: payload,
    }, { triggerTurn: true, deliverAs: "steer" });
  } else if (payload.kind === BLOCKED_KIND) {
  ```

  Constraints to preserve:
  - The first line of `content` must remain the existing one-line aggregate header form `Orchestration "${id}" completed (${N} task(s), isError=${bool}).` byte-for-byte (the spec mandates this).
  - `customType`, `display`, `details: payload`, and the `sendMessage` options object `{ triggerTurn: true, deliverAs: "steer" }` are byte-identical to today.
  - The `BLOCKED_KIND` branch immediately after must remain byte-identical (do not change its `content` string, `customType`, `display`, or `details` — see `subagents/index.ts:1797-1823`).
  - Use `r.finalMessage ?? ""` exactly as in Task 1 — no error fallback, no truncation.
  - Iterate `payload.results` directly — it is already input-ordered by registry construction (see `registry.ts:196-200, 245-250`).

- [ ] **Step 5: Re-run integration tests** — `npm run test:integration -- --test-name-pattern="async orchestration"` for the targeted cases, then `npm run test:integration` to confirm no regression in `orchestration-extension-async.test.ts`, `orchestration-extension-blocked.test.ts`, `orchestration-extension-resume-routing.test.ts`, or `orchestration-async.test.ts`. The `BLOCKED_KIND` content (asserted in `orchestration-extension-blocked.test.ts:71-91`) must remain unchanged.

- [ ] **Step 6: Re-run unit tests** — `npm test`. Confirm `test/orchestration/registry.test.ts` (which inspects emitted payloads' `kind`, `results`, `mode`, `isError` fields), `test/orchestration/orchestration-complete-renderer.test.ts` (which exercises the renderer registered for `customType: "orchestration_complete"` reading from `details`), and all other orchestration unit tests still pass with no regression. The renderer-test assertions on `details.results[i].finalMessage` must still hold because we have not altered the `details` payload.

- [ ] **Step 7: Typecheck** — `npm run typecheck`. The emitter's local `lines` array is straightforward `string[]`; the `payload` is typed as `OrchestrationCompleteEvent | OrchestrationBlockedEvent` via the discriminated union and the existing `payload.kind === ORCHESTRATION_COMPLETE_KIND` narrows to the complete event.

**Acceptance criteria:**
- The `ORCHESTRATION_COMPLETE_KIND` branch of `registryEmitter` sends a `content` string that begins with the existing one-line aggregate header and contains each task's full `finalMessage` verbatim, in input order.
  Verify: open `pi-extension/subagents/index.ts` and confirm the block at line ~1787 matches the replacement in Step 4 (the first element of `lines` is the existing `Orchestration "${id}" completed (...)` header, the for-loop iterates `payload.results`, and `lines.push(r.finalMessage ?? "")` is present without truncation).
- The `BLOCKED_KIND` branch is byte-identical to today.
  Verify: open `pi-extension/subagents/index.ts` at line ~1797-1823 and confirm `customType: BLOCKED_KIND`, the `content` template `\`Task "${payload.taskName}" in orchestration "${payload.orchestrationId}" is blocked:\\n\\n${payload.message}\``, `display: true`, `details: payload`, and `{ triggerTurn: true, deliverAs: "steer" }` are unchanged.
- The new async test cases for `subagent_run_serial` (`wait: false`) and `subagent_run_parallel` (`wait: false`) pass with the multi-line `STATUS: DONE_WITH_CONCERNS` fixture surviving verbatim.
  Verify: run `npm run test:integration -- test/integration/orchestration-extension-async.test.ts` and confirm exit code 0 with no `FAIL` lines, and that the test runner output includes the new `it(...)` names from Steps 1-2 reporting as passing.
- The `orchestration-extension-blocked.test.ts` integration suite continues to pass — the `BLOCKED_KIND` content shape is unchanged.
  Verify: run `npm run test:integration -- test/integration/orchestration-extension-blocked.test.ts` and confirm exit code 0 with no `FAIL` lines.
- The orchestration-complete renderer test continues to pass — the `details` payload is unchanged, so the renderer's read of `details.results[i].finalMessage` and `details.mode` keeps working.
  Verify: run `npm test -- test/orchestration/orchestration-complete-renderer.test.ts` (or equivalent `node --test test/orchestration/orchestration-complete-renderer.test.ts`) and confirm exit code 0.
- The bare `subagent` tool's content composition (`subagents/index.ts:1958-1971` and `:2082-2086`) is byte-identical.
  Verify: open `pi-extension/subagents/index.ts` at lines 1958-1971 and 2082-2086 and confirm the `content` string templates are unchanged from today (specifically the `Sub-agent "${...}" {completed|failed} (...)` shapes are intact and not refactored to share helpers with the orchestration emitter).

**Model recommendation:** cheap

---

## Dependencies

- Task 2 depends on: Task 1 (only loosely — both can be implemented independently, but completing Task 1 first reduces test-output noise during Task 2's iteration since both touch the same conceptual contract).

In practice both tasks are self-contained and can be done in either order, but the suggested order is Task 1 → Task 2 because Task 1 is fully covered by `npm test` (faster feedback cycle) and Task 2 requires `npm run test:integration` (slower).

## Risk Assessment

**Risk: Sync content text now includes multi-KB structured reports.**
Each per-wave content payload grows from ~200 chars/task (firstLine cap) to whatever the child writes (typically a few hundred to a few thousand chars). With `MAX_PARALLEL_HARD_CAP = 8` (`pi-extension/orchestration/types.ts:143`) and bounded coder-report length, total payload grows by ~16-64 KB at most per wave — well within typical context budgets and matching what the bare `subagent` tool already returns per call. **Mitigation:** spec explicitly accepted this trade-off ("a few KB at most given `MAX_PARALLEL_HARD_CAP = 8` and bounded structured-report length — well within typical context budgets"). No code change needed.

**Risk: Async `OrchestrationCompleteEvent.results[i]` fields (`exitCode`, `elapsedMs`, `finalMessage`) are typed as optional in `OrchestratedTaskResult`.**
The new emitter formats them directly (`${r.exitCode}`, `${r.elapsedMs}ms`, `r.finalMessage ?? ""`). For `exitCode`/`elapsedMs`, the existing `summarize()` already does the same; in practice the registry's `onTaskTerminal` hook always populates them via `runSerial` / `runParallel`'s `onTerminal` callbacks (see `run-serial.ts:174-186` and `run-parallel.ts:182-194`). The cancellation path also sets `exitCode: t.exitCode ?? 1` (`registry.ts:402`). Empty `finalMessage` is handled with `?? ""`. **Mitigation:** no change — accept the same level of trust as the existing `summarize()` already operates under. If a reviewer pushes back, the simplest fix is `${r.exitCode ?? "?"}` and `${r.elapsedMs ?? 0}ms`, but that adds noise without buying real coverage.

**Risk: Removing `firstLine()` could break a future caller that imports it.**
The helper is module-private to `tool-handlers.ts` (no `export`), and grep confirms zero call sites in the repo after Task 1 Step 4. **Mitigation:** Step 5's grep check — if it ever returns matches, do not delete the helper.

**Risk: Tests rely on the existing one-line content format (e.g., assertions on `text === "..."` equality, regex matching `^serial orchestration:`, or specific firstLine output).**
A search of the repo shows no existing test asserts on `content[0].text` content for the orchestration sync path or on the async `customType: "orchestration_complete"` `content` string — assertions are on `details.results`, `details.orchestrationId`, `customType`, and `options.deliverAs`/`triggerTurn` only. **Mitigation:** Step 6 of each task re-runs the full suite to catch any unanticipated assertion. If a test breaks, prefer updating the test expectation to use a substring match (`assert.ok(content.includes(...))`) rather than reverting the implementation, since the spec explicitly mandates the new behavior.

**Risk: A test seam (e.g., a fake `pi.sendMessage` that asserts `content` has bounded length) somewhere in the integration suite enforces the old single-line shape.**
None found in `test/integration/`. **Mitigation:** if Step 5 of Task 2 surfaces such a test, propagate the substring-match update.

## Test Command

```bash
npm test
```

Run `npm run test:integration` to additionally exercise the async-path test added in Task 2 (Task 1's tests are covered by `npm test` alone).

## Self-Review

**Spec coverage** — Walking each spec requirement:

- "Sync `summarize()` output MUST include each task's full `finalMessage` verbatim. The truncating `firstLine()` helper is no longer used to compose this content." → Task 1, Steps 4-5.
- "The async `orchestration_complete` steer-back's `content` field MUST include each task's full `finalMessage` verbatim, in addition to the existing one-line orchestration header." → Task 2, Step 4.
- "The aggregate one-line header (mode, task count, `isError`) is preserved in both sync and async content as the head-of-payload summary." → Task 1 Step 4 keeps `${mode} orchestration: ${results.length} task(s), isError=${isError}` as `lines[0]`; Task 2 Step 4 keeps `Orchestration "${id}" completed (${N} task(s), isError=${bool}).` as `lines[0]`.
- "Per-task entries are emitted in input-task order." → both tasks iterate `results` / `payload.results` directly; both arrays are already input-ordered. Asserted in Task 1 Steps 1-2 and Task 2 Steps 1-2 via `indexOf("task-one") < indexOf("task-two")`.
- "The same content shape applies regardless of the child's CLI (`pi` or `claude`)." → no per-CLI special-casing introduced; the change lives downstream of the pane and headless backends, both of which populate `finalMessage` uniformly. Validated implicitly by both backends already emitting equivalent `finalMessage` (the existing tests in `test/orchestration/headless-*` and `test/orchestration/pane-*` exercise this contract).
- "`details.results[i].finalMessage` continues to carry the full content unchanged." → neither task modifies `details`. Acceptance verifies via the renderer-test suite still passing (Task 2 Step 6) and the existing `details` assertions in `tool-handlers.test.ts` still passing (Task 1 Step 6).
- "Tests added at this repo's existing test boundaries assert that, for both sync and async paths, the LLM-visible content contains each child task's full structured `finalMessage`. At least one test case uses a multi-line structured `finalMessage` (e.g., a `STATUS:` header followed by `## Completed` / `## Tests` sections)." → Task 1 Steps 1-2 and Task 2 Steps 1-2 use the exact `STATUS: DONE_WITH_CONCERNS` / `## Completed` / `## Tests` / `## Concerns` fixture from the spec example.

**Constraint compliance:**

- "Do NOT modify the orchestration `details` payload shape." — verified: neither task changes the second argument to the result envelope or the `details: payload` field of the steer-back.
- "Do NOT modify the bare `subagent` tool's content composition (`subagents/index.ts:1958-1971`, `:2082-2086`)." — verified: Task 2's edit is scoped to the `ORCHESTRATION_COMPLETE_KIND` branch only.
- "Do NOT touch UI renderers." — verified: no edit to `subagent-result-renderer.ts`, `headless-render.ts`, or the `tool.renderResult` callbacks at `tool-handlers.ts:131-141, 287-296`.
- "Do NOT modify the `BLOCKED_KIND` steer-back content or the `subagent_ping` content." — verified: Task 2 Step 4 explicitly preserves `BLOCKED_KIND` byte-identical; `subagent_ping` is at `subagents/index.ts:2059-2076`, untouched.
- "Do NOT introduce per-task report files on disk, new artifact markers, or any cross-repo coupling." — verified: no file writes, no marker enums, no `pi-config` changes.
- "Do NOT change `OrchestrationResult` / `OrchestratedTaskResult` / `OrchestrationCompleteEvent` types, registry emission types, or the `_onUpdate` partial-result shape." — verified: no edits to `pi-extension/orchestration/types.ts`, `pi-extension/orchestration/registry.ts`, or the `onUpdate` plumbing in `run-serial.ts` / `run-parallel.ts`.
- "Do NOT alter cross-CLI plumbing (pi vs claude backend `finalMessage` population)." — verified: no edits to backend code.
- "Stay entirely within the `pi-interactive-subagent` repo." — verified: all changes in `pi-extension/` and `test/`.

**Approach compliance:** Spec's `## Approach` selects "Push — inline each task's full `finalMessage` directly into the LLM-visible content channel for both the sync `summarize()` output and the async `orchestration_complete` steer-back content. The aggregate one-line header is retained as a head-of-payload summary; per-task sections follow in input-task order, each carrying that task's full `finalMessage` body." Both Task 1 and Task 2 implement exactly this — no deviation. No `## Risk Assessment` deviation entry needed.

**Placeholder scan** — no "TBD", "TODO", "implement later", or "similar to Task N" text in the plan. Every step has concrete actions. Every acceptance criterion has its own immediately-following `Verify:` line. Every `Verify:` recipe names the artifact, the check, and the success condition.

**Type consistency** — `summarize()` signature unchanged (`(mode: "serial" | "parallel", results: any[], isError: boolean) => string`). `registryEmitter` type unchanged (`(payload: { kind: string; [k: string]: any }) => void`). The `payload.kind === ORCHESTRATION_COMPLETE_KIND` discriminated-union narrows `payload` to `OrchestrationCompleteEvent` whose `results: OrchestratedTaskResult[]` and `orchestrationId: string` fields are read by the new `lines.push` calls — typecheck-clean.
