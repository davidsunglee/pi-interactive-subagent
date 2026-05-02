# Headless Claude Subagent Observability

**Source:** `TODO-099e7269`
**Spec:** `.pi/specs/2026-05-02-headless-claude-subagent-observability.md`

## Goal

Stabilize headless Claude subagent observability so each task's lifecycle is consistent across the subagent widget and the Pi tool-call/TUI rendering during serial and parallel orchestration. Each task must follow `pending → running → terminal` deterministically, parallel rows must remain visible until terminal, and headless telemetry must reflect only real backend values without fabricated zeros.

## Architecture summary

The reported symptoms cross multiple surfaces but reduce to one root: per-task lifecycle and telemetry are not propagated uniformly between the widget (`runningSubagents` map) and the in-flight tool-call rendering (`results[]` array passed through `onUpdate`). The fix keeps each surface's existing data carrier but drives both from the same backend lifecycle events:

1. `runParallel` now pre-populates `results[]` with per-task placeholder `OrchestrationResult` entries (`state: "pending"`) at run start, transitions slot state to `running` after `deps.launch` resolves, merges backend partials into `results[i]` while preserving the explicit state/index, and emits a fully-populated inflight snapshot from every UI update site. The post-loop abort sweep now uses explicit state checks instead of array-hole semantics.
2. `runSerial` stamps `state: "running"` and `index: i` on each in-flight partial inside `stepOnUpdate`, so the active step is never rendered as `pending` while it is running.
3. `runClaudeHeadless` increments `usage.turns` on each assistant stream event and emits the `usage` field on partials only when at least one telemetry value (turns, tokens, or cost) is real. Token and cost remain absent until the terminal `result` event provides them. This eliminates the all-zero usage object that today blanks out the widget's right column.
4. `toTaskRows` is hardened to render a `pending` placeholder for sparse / undefined slots, so even if a future caller forwards holes the rendering layer never silently drops rows.

The existing widget pipeline (`registerHeadlessSubagent` / `updateHeadlessSubagentUsage` / `unregisterHeadlessSubagent`) and the existing registry (for `wait: false`) are unchanged in shape — they continue to drive widget visibility from real backend events, which after this plan are also the only source of telemetry written into the widget.

## Tech stack

- TypeScript (Node ESM, target ES2022)
- Test runner: `node --test`
- pi-tui rendering primitives (`Container`, `Text`, `Markdown`)
- Existing orchestration registry (`pi-extension/orchestration/registry.ts`)
- Headless backend infrastructure (`pi-extension/subagents/backends/headless.ts`) with `__test__.makeHeadlessBackendWithRunner` and `__test__.setSpawn` test seams

## File Structure

- `pi-extension/orchestration/run-parallel.ts` (Modify) — pre-populate inflight snapshot at run start; transition slots `pending → running` after launch resolves; merge backend partials into `results[i]` preserving state/index; update post-loop abort sweep to use explicit state checks; emit fully-populated inflight snapshots from every UI update site; update `summarizeInflightParallel`'s `done` count to count terminal slots only.
- `pi-extension/orchestration/run-serial.ts` (Modify) — stamp `state: "running"` and `index: i` on each in-flight partial inside `stepOnUpdate` before forwarding through `onUpdate`, so the active step never renders as `pending`.
- `pi-extension/subagents/backends/headless.ts` (Modify) — `runClaudeHeadless` increments `usage.turns` on each Claude assistant stream event; emits `usage` on partials only when `hasRealUsage` is true; the close-handler keeps emitting the terminal payload exactly as today.
- `pi-extension/subagents/ui/headless-render.ts` (Modify) — `toTaskRows` returns a `pending` placeholder `TaskRow` (default name `task-${index+1}`) for any `undefined` entry instead of crashing on `r.name`; existing terminal-row mapping is unchanged.
- `test/orchestration/run-parallel-inflight-lifecycle.test.ts` (Create) — covers pre-population, `pending → running` transition after launch, partial merge, terminal annotation, and post-loop abort sweep using fake `LauncherDeps`.
- `test/orchestration/run-serial-inflight-state.test.ts` (Create) — verifies `state: "running"` is stamped on the in-flight partial and that the in-flight step never renders as `pending`.
- `test/orchestration/headless-claude-truthful-usage.test.ts` (Create) — uses `__test__.makeHeadlessBackendWithRunner` to simulate Claude stream events; verifies live `turns` updates without fabricated token/cost, and full usage after the `result` event.
- `test/orchestration/totaskrows-sparse.test.ts` (Create) — verifies `toTaskRows` is robust to sparse / undefined slots and yields placeholder rows.
- `test/orchestration/headless-observability-regression.test.ts` (Create) — integration-style regression test driving `runParallel` with a Claude-shaped fake runner end-to-end and asserting the spec acceptance criteria for parallel lifecycle stability, widget visibility, and telemetry truth.

## Tasks

### 1. runParallel: stabilize inflight lifecycle snapshot

**Files:**
- Modify: `pi-extension/orchestration/run-parallel.ts`
- Test: `test/orchestration/run-parallel-inflight-lifecycle.test.ts`

**Steps:**
- [ ] **Step 1.1: Read current state** — open `pi-extension/orchestration/run-parallel.ts` and confirm the worker structure: `const results: OrchestrationResult[] = new Array(tasks.length);`, the `stepOnUpdate` closure that does `const inflight = results.slice(); inflight[i] = partial;`, and the post-loop abort sweep guarded by `if (!results[i])`.
- [ ] **Step 1.2: Pre-populate the snapshot** — immediately after `const results: OrchestrationResult[] = new Array(tasks.length);`, insert a loop that initializes each slot with a placeholder. Use `tasks[i].name ?? \`task-${i + 1}\`` for the name, set `index: i, state: "pending", finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 0`.
- [ ] **Step 1.3: Add a local `emitInflight` helper** inside `runParallel` that, when `opts.onUpdate` is set, builds `{ content: [{ type: "text", text: summarizeInflightParallel(results) }], details: { results: results.map((r) => ({ ...r })), isError: false, inflight: true } }` and forwards it through `opts.onUpdate`. This becomes the single source of inflight envelope construction.
- [ ] **Step 1.4: Transition state to `running` after `deps.launch`** — inside the worker, after the existing `opts.onLaunched?.(i, { sessionKey: handle.sessionKey });` call, mutate the slot: `results[i] = { ...results[i], state: "running", ...(handle.sessionKey ? { sessionKey: handle.sessionKey } : {}) };` and call `emitInflight()`.
- [ ] **Step 1.5: Update `stepOnUpdate` to merge into `results[i]`** — replace the old `const inflight = results.slice(); inflight[i] = partial; opts.onUpdate!({...})` body with a merge that preserves explicit state/index: `results[i] = { ...results[i], ...partial, state: "running", index: i }; emitInflight();`. Do not slice — mutate the live `results` array.
- [ ] **Step 1.6: Preserve snapshot fields on terminal annotation** — replace the existing `result.index = i; result.state = ...; results[i] = result;` block with `result.index = i; result.state = result.exitCode === 0 && !result.error ? "completed" : "failed"; results[i] = { ...results[i], ...result, index: i, name: result.name ?? results[i].name };`. Keep the existing `opts.onTerminal?.(i, { ... })` call intact. After the assignment, call `emitInflight()` so the inflight UI sees the terminal state immediately.
- [ ] **Step 1.7: Update the post-loop abort sweep** — replace the existing `if (!results[i]) { ... }` guard so the cancellation body runs only for slots whose state is exactly `"pending"`. Concretely, change the guard to `if (results[i].state !== "pending") continue;` (skip already-running/terminal slots), then keep the existing async-mode skip `if (opts.onBlocked) continue;` immediately after so the orchestration registry retains lifecycle ownership of registered blocked slots. For the remaining sync-mode pending slots, overwrite the slot with `{ ...results[i], state: "cancelled", finalMessage: "", transcriptPath: null, exitCode: 1, elapsedMs: 0, error: "cancelled", index: i }`, then call `opts.onTerminal?.(i, { ... })` and set `isError = true` exactly as before. Net effect: pending slots get cancelled; running/completed/failed/cancelled slots are left untouched.
- [ ] **Step 1.8: Update `summarizeInflightParallel`** — change the `done` calculation to `results.filter((r) => r && (r.state === "completed" || r.state === "failed" || r.state === "cancelled")).length`. The existing `if (!r) { lines.push(\`- [${i + 1}]: pending\`); continue; }` branch becomes dead code after Step 1.2 but stays as a defensive guard.
- [ ] **Step 1.9: Write the test file** at `test/orchestration/run-parallel-inflight-lifecycle.test.ts`. Use a fake `LauncherDeps` whose `launch` resolves immediately and whose `waitForCompletion` accepts a manually-resolved `Promise<OrchestrationResult>`. Capture every `onUpdate` envelope. Assert:
  - The first envelope captured (after the first `deps.launch`) has `details.results.length === tasks.length`, no `undefined` slots, the launched slot at `state: "running"`, and other slots at `state: "pending"`.
  - After a partial fires (test seam emits an `OrchestrationResult` with `usage: { turns: 1, ... }`), the slot's state remains `"running"` and `index === i`.
  - After all tasks resolve terminal, every captured envelope's terminal slot has `state` ∈ `{"completed", "failed"}`, never `"pending"` once that slot has reached `running`.
  - With `signal.aborted` fired before any slot is launched (sync mode, no `onBlocked`), the post-loop sweep transitions every slot to `state: "cancelled"` with `error: "cancelled"`, and `out.results.length === tasks.length`.
- [ ] **Step 1.10: Run the suite** with `node --test test/orchestration/run-parallel-inflight-lifecycle.test.ts test/orchestration/run-parallel.test.ts test/orchestration/block-resume.test.ts` and confirm all green.

**Acceptance criteria:**

- Every `details.results` array emitted by `runParallel`'s `onUpdate` callback contains exactly `tasks.length` entries with no `undefined` slots and an explicit `state` field on each entry.
  Verify: run `node --test test/orchestration/run-parallel-inflight-lifecycle.test.ts` and confirm the test that asserts `inflight.details.results.length === tasks.length && inflight.details.results.every((r) => r != null && typeof r.state === "string")` for every captured update passes.
- A task that has been launched but has not yet emitted any partial appears with `state: "running"` in the inflight snapshot, never `pending`.
  Verify: run `node --test test/orchestration/run-parallel-inflight-lifecycle.test.ts` and confirm the assertion that captures the inflight snapshot in the gap between `deps.launch` resolving and the first partial, expecting `inflight.details.results[i].state === "running"` for that index, passes.
- The post-loop abort sweep transitions only `pending` slots to `cancelled` and leaves already-terminal slots untouched.
  Verify: run `node --test test/orchestration/run-parallel-inflight-lifecycle.test.ts` and confirm the abort-sweep test that mixes one already-completed slot with one never-launched slot, asserting the completed slot's state is preserved while the never-launched slot becomes `cancelled`, passes.
- Existing parallel and block-resume tests continue to pass without changes.
  Verify: run `node --test test/orchestration/run-parallel.test.ts test/orchestration/block-resume.test.ts` and confirm exit code 0 with zero `FAIL` lines.

**Model recommendation:** standard

### 2. runSerial: stamp explicit state on inflight partial

**Files:**
- Modify: `pi-extension/orchestration/run-serial.ts`
- Test: `test/orchestration/run-serial-inflight-state.test.ts`

**Steps:**
- [ ] **Step 2.1: Locate the `stepOnUpdate` definition** — open `pi-extension/orchestration/run-serial.ts` and find the assignment `const stepOnUpdate = opts.onUpdate ? (partial: OrchestrationResult) => { const inflight = [...results, partial]; opts.onUpdate!({ ... }) } : undefined;`.
- [ ] **Step 2.2: Stamp `state` and `index` on the in-flight partial** — replace the body with:
  ```ts
  const liveStep: OrchestrationResult = { ...partial, state: "running", index: i };
  const inflight = [...results, liveStep];
  opts.onUpdate!({
    content: [{ type: "text", text: summarizeInflight("serial", inflight) }],
    details: { results: inflight, isError: false, inflight: true },
  });
  ```
- [ ] **Step 2.3: Confirm `summarizeInflight` honors the explicit state** — read the existing `summarizeInflight` function and verify the `r.state ?? deriveInflightState(r)` chain: with `state: "running"` set explicitly, the `??` short-circuits and the line renders `step-N: running`, not `pending`.
- [ ] **Step 2.4: Write the test file** at `test/orchestration/run-serial-inflight-state.test.ts`. Use a fake `LauncherDeps` whose `waitForCompletion` calls `onUpdate` once with a partial that has `usage: { turns: 1, ... }` and no `state` field, then resolves with a completed result. Capture every `onUpdate` envelope. Assert:
  - The captured inflight snapshot's last entry has `state === "running"` and `index === i`.
  - The summary text emitted via `onUpdate` contains `step-1: running` and does NOT contain `step-1: pending` for the active step.
  - When the second step starts, the first step's terminal snapshot is preserved in `results[0]` with `state === "completed"` and the active step's state remains `running`.
- [ ] **Step 2.5: Run the suite** with `node --test test/orchestration/run-serial-inflight-state.test.ts test/orchestration/run-serial.test.ts test/orchestration/inflight-text-slim.test.ts` and confirm all green.

**Acceptance criteria:**

- The in-flight step's slot in every captured inflight `details.results` array has `state === "running"`.
  Verify: run `node --test test/orchestration/run-serial-inflight-state.test.ts` and confirm the assertion `inflight.details.results[inflight.details.results.length - 1].state === "running"` for every captured update passes.
- The summary text emitted via `onUpdate` contains `step-N: running` for the active step and never `step-N: pending` while that step is in flight.
  Verify: run `node --test test/orchestration/run-serial-inflight-state.test.ts` and confirm the test that scans the captured `text` for the regex `/step-1: running/` and the negative assertion `text.includes("step-1: pending") === false` passes.
- Existing serial and inflight-text-slim tests continue to pass.
  Verify: run `node --test test/orchestration/run-serial.test.ts test/orchestration/inflight-text-slim.test.ts` and confirm exit code 0 with zero `FAIL` lines.

**Model recommendation:** cheap

### 3. Headless Claude backend: truthful usage with live turn updates

**Files:**
- Modify: `pi-extension/subagents/backends/headless.ts`
- Test: `test/orchestration/headless-claude-truthful-usage.test.ts`

**Steps:**
- [ ] **Step 3.1: Read `runClaudeHeadless`** — confirm the current shape: `usage` starts as `emptyUsage()` (all zeros), assistant events emit a partial that always includes `usage` (with all-zero values until the terminal result event), the result event replaces `usage` via `parseClaudeResult` and emits.
- [ ] **Step 3.2: Add a `hasRealUsage` flag** in `runClaudeHeadless`, initialized `let hasRealUsage = false;` near the existing `let terminalResult: ReturnType<typeof parseClaudeResult> | null = null;` declaration.
- [ ] **Step 3.3: Increment `usage.turns` on each assistant event** — inside the existing `if (sawAssistant) { ... emit({...}) }` branch, before the `emit({...})` call, add `usage.turns += 1; hasRealUsage = true;`.
- [ ] **Step 3.4: Set `hasRealUsage = true` on the result event** — inside the existing `if (event.type === "result") { ... }` branch, after `usage = terminalResult.usage;` and before the `emit({...})`, set `hasRealUsage = true;`.
- [ ] **Step 3.5: Gate the `usage` field on every emit call** — change the assistant-event `emit({ ..., usage, transcript })` and the result-event `emit({ ..., usage, transcript })` calls so they conditionally include `usage` only when `hasRealUsage` is true. Use `...(hasRealUsage ? { usage } : {})` so the partial type stays compatible (`BackendResult.usage` is optional).
- [ ] **Step 3.6: Leave the close-handler unchanged** — the close-handler's terminal `BackendResult` already carries `usage` (which by close time has either real result-event values or accumulated turn counters from assistant events). Confirm by re-reading the `proc.on("close", ...)` handler — no edits needed.
- [ ] **Step 3.7: Write the test file** at `test/orchestration/headless-claude-truthful-usage.test.ts`. Use `__test__.makeHeadlessBackendWithRunner` to inject a runner that emits via `emitPartial`. Drive the runner through this sequence and capture every emitted partial:
  1. Emit a partial with no usage (initial empty state) — assert `partial.usage === undefined`.
  2. Emit three partials simulating Claude assistant events: each partial passes the `usage` value the production runner would carry after `usage.turns += 1`. Assert `partial.usage.turns === N` and `partial.usage.input === 0 && partial.usage.cost === 0` after each.
  3. Emit a final partial simulating the Claude `result` event with full token/cost — assert `partial.usage.input > 0 && partial.usage.cost > 0`.
- [ ] **Step 3.8: Add a second test** in the same file that exercises `makeHeadlessBackend` (the production code path) end-to-end via `__test__.setSpawn`. Inject a fake child process that streams JSONL lines representing three Claude assistant events followed by one `result` event with usage `{input: 100, output: 50, ...}`. Assert:
  - The first captured partial after the first assistant event has `usage.turns === 1` and `usage.input === 0`.
  - The captured partial after the result event has `usage.input === 100`.
  - The final terminal `BackendResult` has `usage.input === 100 && usage.turns >= 1`.
- [ ] **Step 3.9: Run the suite** with `node --test test/orchestration/headless-claude-truthful-usage.test.ts test/orchestration/headless-onupdate-replay.test.ts test/orchestration/widget-headless.test.ts test/orchestration/widget-pane-uniform.test.ts` and confirm all green.

**Acceptance criteria:**

- A partial emitted by `runClaudeHeadless` before any Claude assistant or `result` event carries no `usage` field.
  Verify: run `node --test test/orchestration/headless-claude-truthful-usage.test.ts` and confirm the test that emits a no-usage placeholder partial first, asserting `partial.usage === undefined`, passes.
- After each Claude assistant stream event, the partial emitted via `emitPartial` includes `usage` whose `turns` reflects the live assistant event count and whose `input`, `output`, `cost`, `cacheRead`, `cacheWrite` are still `0` (Claude does not provide them mid-stream).
  Verify: run `node --test test/orchestration/headless-claude-truthful-usage.test.ts` and confirm the test that captures the post-assistant partial and asserts `partial.usage.turns === N && partial.usage.input === 0 && partial.usage.cost === 0` for each of N ∈ {1, 2, 3} passes.
- After the terminal `result` event lands, the partial emitted carries the full parsed Claude usage (`input`, `output`, and `cost` all from the parsed JSON, never fabricated).
  Verify: run `node --test test/orchestration/headless-claude-truthful-usage.test.ts` and confirm the assertion `partial.usage.input === 100 && partial.usage.cost > 0` for the post-result capture passes.
- Existing headless backend tests continue to pass.
  Verify: run `node --test test/orchestration/headless-onupdate-replay.test.ts test/orchestration/widget-headless.test.ts test/orchestration/widget-pane-uniform.test.ts` and confirm exit code 0 with zero `FAIL` lines.

**Model recommendation:** standard

### 4. Defensive `toTaskRows` for sparse arrays

**Files:**
- Modify: `pi-extension/subagents/ui/headless-render.ts`
- Test: `test/orchestration/totaskrows-sparse.test.ts`

**Steps:**
- [ ] **Step 4.1: Open `pi-extension/subagents/ui/headless-render.ts`** and locate the `export function toTaskRows(...)` block near the end of the file.
- [ ] **Step 4.2: Replace the `.map((r) => ({ ... }))` body** with an index-aware mapper that handles `undefined`. The new body returns this for `undefined` slots: `{ name: \`task-${i + 1}\`, agent: undefined, state: "pending", task: undefined, index: i }`. For non-undefined slots, return the existing shape unchanged. Use the second `.map` callback parameter (`(r, i) => ...`) to access the slot index.
- [ ] **Step 4.3: Write the test file** at `test/orchestration/totaskrows-sparse.test.ts` that asserts:
  - `toTaskRows([undefined, completedRow])` returns an array of length 2 where `rows[0].state === "pending" && rows[0].name === "task-1"` and `rows[1]` preserves `completedRow.name` and `completedRow.state`.
  - `toTaskRows(new Array(3))` (real holes, `length === 3` but no assigned slots) returns an array of length 3 with every entry having `state === "pending"`. Use `Array.from({ length: 3 }, () => undefined)` if `.map` skips holes; the new body must produce three entries either way — if needed, the implementation should iterate with a `for` loop instead of `.map` to handle real holes.
- [ ] **Step 4.4: Run the suite** with `node --test test/orchestration/totaskrows-sparse.test.ts test/orchestration/render-result-orchestration.test.ts test/orchestration/orchestration-complete-renderer.test.ts` and confirm all green.

**Acceptance criteria:**

- `toTaskRows([undefined, completedRow])` returns two rows where the first is a `pending` placeholder and the second preserves `completedRow`'s fields.
  Verify: run `node --test test/orchestration/totaskrows-sparse.test.ts` and confirm the assertion `rows.length === 2 && rows[0].state === "pending" && rows[0].name === "task-1" && rows[1].state === completedRow.state` passes.
- `toTaskRows` does not throw on sparse arrays and produces a row per index of the input length.
  Verify: run `node --test test/orchestration/totaskrows-sparse.test.ts` and confirm the test invoking `toTaskRows(Array.from({ length: 3 }, () => undefined))` returns three entries (`rows.length === 3`) with each `rows[i].state === "pending"` and no thrown error.
- Existing rendering tests continue to pass.
  Verify: run `node --test test/orchestration/render-result-orchestration.test.ts test/orchestration/orchestration-complete-renderer.test.ts` and confirm exit code 0 with zero `FAIL` lines.

**Model recommendation:** cheap

### 5. End-to-end regression coverage for spec acceptance criteria

**Files:**
- Test: `test/orchestration/headless-observability-regression.test.ts`

**Steps:**
- [ ] **Step 5.1: Build a per-task fake runner** using `__test__.makeHeadlessBackendWithRunner` from `pi-extension/subagents/backends/headless.ts`. The runner accepts `({ emitPartial, signal })` and returns a `Promise<BackendResult>` that the test resolves manually. The runner should emit Claude-shaped partials: optionally one assistant event (turns=1, no token/cost), then a result-event partial (turns=N, real token/cost), then resolve. The runner MUST also subscribe to the provided `AbortSignal` (via `signal.addEventListener("abort", ...)`) and, on abort, immediately resolve its outstanding promise with a `BackendResult` shaped `{ state: "cancelled", finalMessage: "", transcriptPath: null, exitCode: 1, elapsedMs: 0, error: "cancelled", usage: emptyUsage() }`. Track each runner's resolve handle in a per-task record (`{ resolve, reject, aborted }`) so the test can deterministically settle still-running tasks after abort.
- [ ] **Step 5.2: Wrap the test backend in a `LauncherDeps`** whose `launch` registers via `registerHeadlessSubagent` and whose `waitForCompletion` finalizes via `unregisterHeadlessSubagent`. Mirror `pi-extension/orchestration/default-deps.ts`'s adapter shape so the widget map (`__test__.getRunningSubagents()`) is updated by real lifecycle events. Forward `partial.usage` updates through `updateHeadlessSubagentUsage` exactly as `default-deps.ts` does.
- [ ] **Step 5.3: Drive `runParallel` with three tasks** via the wrapped LauncherDeps. Capture every `onUpdate` envelope in an array and snapshot `__test__.getRunningSubagents()` keys after each update.
- [ ] **Step 5.4: Assert lifecycle stability** — for every captured envelope, `details.results.length === 3` and every entry has a string `state`. Track per-slot transitions: once a slot has been observed at `running`, it must never appear at `pending` in any later envelope.
- [ ] **Step 5.5: Assert widget visibility** — after each task is launched (its runner has been invoked), the widget map must contain a row whose `name` matches the task's name, until the matching `unregisterHeadlessSubagent` has fired. The test confirms the row remains in the map across the entire `running` lifecycle.
- [ ] **Step 5.6: Assert telemetry truth** — for every captured partial whose runner has not yet emitted the simulated `result` event, the partial's `usage` (if present) must have `usage.input === 0 && usage.output === 0 && usage.cost === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0`. Once the `result` event is emitted, the partial's `usage` must reflect the values supplied by the test runner (e.g., `usage.input === 100`).
- [ ] **Step 5.7: Assert cancellation** — manually resolve the first task's runner promise with a completed `BackendResult`, await its terminal `onUpdate`, then fire `controller.abort()` on the `AbortController` whose `signal` was passed to `runParallel`. Because each fake runner subscribes to the abort signal (Step 5.1), the still-running runners will resolve with `{ state: "cancelled", ..., error: "cancelled" }` as soon as the abort fires; the test does NOT need to manually resolve them. After firing abort, `await` the `runParallel` promise. Verify `out.results.length === 3`, the first task's entry has `state === "completed"`, the remaining entries have `state === "cancelled"` with `error === "cancelled"`, every entry has a terminal `state` (`completed`, `failed`, or `cancelled`), and no entry returned to `pending` between abort and resolution.
- [ ] **Step 5.8: Run the suite** with `node --test test/orchestration/headless-observability-regression.test.ts` and confirm all green; then run the full default suite with `npm test` to confirm no regression elsewhere.

**Acceptance criteria:**

- Across the simulated parallel run, no captured envelope ever shows a `state` of `pending` for a task whose runner has been invoked.
  Verify: run `node --test test/orchestration/headless-observability-regression.test.ts` and confirm the test that scans every captured envelope for the no-pending-after-running invariant — using a per-slot bitmask of "has been running" — passes.
- The widget map (`__test__.getRunningSubagents()`) contains a row for each launched task continuously until the matching `unregisterHeadlessSubagent` runs.
  Verify: run `node --test test/orchestration/headless-observability-regression.test.ts` and confirm the assertion that polls `__test__.getRunningSubagents()` after each captured envelope and verifies all currently-launched-but-not-terminal task names are present passes.
- A captured partial whose underlying runner has not yet emitted a Claude `result` event must have `usage` either absent or carrying only `turns` (with `input`, `output`, `cost`, `cacheRead`, `cacheWrite` all `0`).
  Verify: run `node --test test/orchestration/headless-observability-regression.test.ts` and confirm the assertion that filters captured partials by pre-result-event runner phase and asserts `partial.usage === undefined || (partial.usage.input === 0 && partial.usage.cost === 0)` passes.
- After cancellation via `signal.abort()`, the final aggregated `runParallel` results have terminal states (`completed`, `failed`, or `cancelled`) for every task and never reset to `pending`.
  Verify: run `node --test test/orchestration/headless-observability-regression.test.ts` and confirm the cancellation test asserting `out.results.every((r) => r.state === "completed" || r.state === "failed" || r.state === "cancelled")` after `signal.abort()` passes.
- The full default test suite is green after the change.
  Verify: run `npm test` and confirm exit code 0 with zero `FAIL` lines across all test files.

**Model recommendation:** standard

## Dependencies

- Task 5 depends on: Task 1, Task 2, Task 3, Task 4
- Tasks 1, 2, 3, and 4 are independent and can run in parallel

## Risk Assessment

- **Risk:** Pre-populating `results[]` in `runParallel` changes the post-loop abort sweep semantics; if the new state-based sweep mishandles the async-mode (`onBlocked`) skip, already-passing block-resume tests could fail.
  **Mitigation:** Step 1.7 explicitly preserves the `if (opts.onBlocked) continue;` async-mode skip and only transitions slots whose state is exactly `"pending"`. Existing tests in `test/orchestration/block-resume.test.ts` and `test/orchestration/run-parallel.test.ts` provide regression coverage; Step 1.10 runs them as a gate.
- **Risk:** Gating Claude `usage` on `hasRealUsage` may affect downstream consumers that assumed `partial.usage` was always present.
  **Mitigation:** `BackendResult.usage` is already typed as optional (`pi-extension/subagents/backends/types.ts:38`). The `default-deps.ts` adapter already guards with `if (isHeadless && partial.usage)` (`pi-extension/orchestration/default-deps.ts:73`), so the widget pipeline tolerates a missing `usage`. Step 3.9 runs the widget-headless tests as a gate.
- **Risk:** The terminal annotation merge in Step 1.6 (`{ ...results[i], ...result, index: i }`) could overwrite a backend-provided `name` if the pre-populated placeholder name differs.
  **Mitigation:** Step 1.6 explicitly sets `name: result.name ?? results[i].name` so the backend's name takes precedence when present and the placeholder name is only used as a fallback. The behavior matches the pre-change semantics, where the backend result's name was used directly.
- **Risk:** Adding `emitInflight()` calls at multiple points in `runParallel` (post-launch, post-partial, post-terminal) increases UI update frequency and could spam the renderer.
  **Mitigation:** The increment is bounded — at most one extra emit per task per lifecycle event (launch, terminal). The existing per-partial emission cadence is unchanged. Visual flicker is what this plan targets, so a small increase in update frequency is desirable.
- **Risk:** Sparse-array handling in `toTaskRows` could mask future bugs by silently filling missing slots with placeholder rows that look benign.
  **Mitigation:** The default fill (`pending` placeholder named `task-${index+1}`) is deliberately distinguishable so a future bug producing sparse arrays still shows visibly as a `pending` row. Step 4.3's tests pin this contract so the placeholder shape cannot drift.

## Test Command

```bash
npm test
```
