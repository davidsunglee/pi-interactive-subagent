# Restore live transparency for headless subagent runs

**Source:** `TODO-4a7c2e91`
**Spec:** `.pi/specs/2026-05-01-headless-subagent-live-transparency.md`

## Goal

When `PI_SUBAGENT_MODE=headless` (or auto-fallback when no mux is available), restore the live transparency that pi-subagent's `formatToolCall` + `formatUsageStats` provided. Route per-task `transcript` + `usage` (already accumulated by the headless backend) through the tool framework's `renderResult` (orchestration sync) and the custom-message renderer surfaces (orchestration async + bare-subagent headless completion) so the framework's built-in `{ expanded }` flag drives Ctrl+O collapse/expand. Unify the persistent "Subagents — N running" widget so headless launches appear with one row per running child, matching today's pane behavior, with a backend-natural right-side info segment (`<turns>t ↑<in> ↓<out> $<cost>`).

## Architecture summary

Three rendering surfaces share a single component-layout module so headless and async paths stay visually consistent:

- **Orchestration sync (`wait: true`):** `subagent_run_serial` / `subagent_run_parallel` register a `renderResult` that consumes the existing tool-framework `details: { results, isError, inflight }` payload (already populated by `run-serial.ts:111-119` / `run-parallel.ts:97-108` with full `transcript` + `usage`).
- **Orchestration async (`wait: false`):** the `orchestration_complete` message renderer reads `details.results[].transcript` + `details.results[].usage` from the registry's emitted aggregated event. The registry passes the orchestration mode (`serial` / `parallel`) on the event so the renderer chooses the correct layout.
- **Bare-subagent headless completion:** the `subagent_result` message renderer detects headless completions (presence of `details.transcript` + `details.usage`) and renders the rich block; pane completions (no `transcript` / `usage` in details) keep today's simple rendering.

A small port (`pi-extension/subagents/ui/format.ts`) carries `formatTokens`, `formatToolCall`, and `formatUsageStats` from pi-subagent. A second module (`pi-extension/subagents/ui/headless-render.ts`) owns the shared component layout (`Container` + `Text` + `Markdown`) used by all three surfaces.

The persistent above-editor widget is unchanged in concept — it still produces strings via `renderSubagentWidgetLines` — but `RunningSubagent` gains an optional `usage` field, and the row formatter renders headless rows with `<elapsed>  <name>(<agent>)  <turns>t ↑<in> ↓<out> $<cost>` instead of the pane row's `<entries> msgs (<bytes>)`. Headless lifecycle hooks (register on launch, update on `onUpdate`, unregister on settle) live in the orchestration adapter (`default-deps.ts`) and at the bare-subagent call site, with `startWidgetRefresh()` triggered idempotently on first registration.

The orchestration in-flight `text` content (the LLM-facing partial) loses its per-task `firstLine(finalMessage)` preview — only mode + count + per-task `name` + state remains.

## Tech stack

- **Languages/runtime:** TypeScript (Node 18+, ES modules)
- **Frameworks:** `@mariozechner/pi-coding-agent` (extension API: `registerTool`, `registerMessageRenderer`, `setWidget`), `@mariozechner/pi-tui` (`Container`, `Text`, `Spacer`, `Markdown`, `Box`, `truncateToWidth`, `visibleWidth`), `@mariozechner/pi-coding-agent` `getMarkdownTheme`
- **Test runner:** `node --test` (`test/orchestration/*.test.ts`)
- **Schema:** `typebox`

## File Structure

- `pi-extension/subagents/ui/format.ts` (Create) — Port of `formatTokens`, `formatToolCall`, `formatUsageStats` from `/Users/david/Code/pi-subagent/index.ts:35-135`. Replaces `themeFg(color, text)` callable with `Theme.fg(color, text)`. Adopts pi-subagent constants verbatim: `COLLAPSED_ITEM_COUNT = 10`, bash truncation 60 chars, default-tool JSON.stringify truncation 50 chars.
- `pi-extension/subagents/ui/headless-render.ts` (Create) — Shared `renderRichSubagentResult({ mode, results, expanded, theme }): Component` returning a `Container` of `Text` / `Spacer` / `Markdown` children. Mode `single` produces the bare-subagent completion block (one task header + tool calls + usage + optional task-text/markdown body); modes `serial` / `parallel` produce the aggregated layout (mode header + per-task sub-blocks + total usage line). Also exports `extractDisplayItems(transcript): DisplayItem[]` (mirror of pi-subagent's `getDisplayItems`).
- `pi-extension/subagents/index.ts` (Modify) — Add `usage?: UsageStats` to `RunningSubagent`; refactor `renderSubagentWidgetLines` to branch on `agent.backend === "headless"` for the right-side info segment; replace the `subagent_result` and `orchestration_complete` message renderers with rich-aware variants that delegate to `renderRichSubagentResult`; forward `transcript` + `usage` in the bare-subagent headless `details` payload; pass an `onUpdate` to `backend.watch` in the bare-subagent headless path so the widget row updates live; call `startWidgetRefresh()` after the existing `runningSubagents.set(...)` for the bare-subagent headless launch.
- `pi-extension/orchestration/tool-handlers.ts` (Modify) — Register `renderResult` on both `subagent_run_serial` and `subagent_run_parallel` tool definitions. Both renderers read `result.details.results: OrchestratedTaskResult[]` plus `result.details.inflight?: boolean` and call `renderRichSubagentResult` with `mode = "serial" | "parallel"`.
- `pi-extension/orchestration/run-serial.ts` (Modify) — Slim `summarizeInflight`: drop the `firstLine(finalMessage)` preview line; emit `mode + count + per-task name + state` only. Derive `state` from `r.state` if set, otherwise from `r.exitCode`/`r.error`/in-flight position.
- `pi-extension/orchestration/run-parallel.ts` (Modify) — Slim `summarizeInflightParallel` symmetrically.
- `pi-extension/orchestration/default-deps.ts` (Modify) — When `selectBackend() === "headless"`, wrap the headless `launch` / `watch` adapters so that each orchestration-spawned child registers a `RunningSubagent` row, updates its `usage` from `onUpdate` partials, and is removed on settle. Pass through to `index.ts`-exported helpers (`registerHeadlessSubagent`, `updateHeadlessSubagentUsage`, `unregisterHeadlessSubagent`) rather than mutating module state directly.
- `pi-extension/orchestration/registry.ts` (Modify) — Add `mode: OrchestrationMode` to `OrchestrationCompleteEvent`; populate from `entry.config.mode` inside `tryFinalize`. Required so `orchestration_complete` renderer chooses serial vs. parallel layout. Adjust `RegistryEmission` union accordingly.
- `test/orchestration/format.test.ts` (Create) — Unit tests for `formatTokens`, `formatToolCall`, `formatUsageStats` covering every branch (bash, read, write, edit, ls, find/glob, grep, default-tool fallback) plus token/cost formatting edge cases.
- `test/orchestration/widget-headless.test.ts` (Create) — Drives `renderSubagentWidgetLines` with `RunningSubagent` rows whose `backend === "headless"` and `usage` is present; asserts the right-side info matches `<turns>t ↑<in> ↓<out> $<cost>` and that pane rows in the same call retain `<entries> msgs (<bytes>)`. Also asserts width-contract preservation.
- `test/orchestration/render-result-orchestration.test.ts` (Create) — Renders the new `renderResult` for `subagent_run_serial` and `subagent_run_parallel` with synthetic `details.results`. Expanded vs. collapsed both produce the expected number/kind of children and per-task usage strings.
- `test/orchestration/subagent-result-renderer-headless.test.ts` (Create) — Drives the `subagent_result` renderer with both pane-shaped details (no `transcript`/`usage`) and headless-shaped details (with `transcript`/`usage`); asserts that pane shape falls through to today's rendering and headless shape produces the rich layout.
- `test/orchestration/orchestration-complete-renderer.test.ts` (Create) — Drives the `orchestration_complete` renderer with synthetic registry events carrying `mode = "serial"` / `mode = "parallel"` and asserts that layout matches `renderResult` for the corresponding mode.
- `test/orchestration/inflight-text-slim.test.ts` (Create) — Calls `runSerial` and `runParallel` with a fake `LauncherDeps` that emits multiple partials via `onUpdate`; captures the `content[0].text` string and asserts it does NOT contain `firstLine` previews and DOES contain `mode + count + per-task name + state`.
- `test/orchestration/registry.test.ts` (Modify) — Extend an existing test (or add one) to assert that the `OrchestrationCompleteEvent` payload carries `mode: "serial"` / `mode: "parallel"` per the orchestration's config.
- `test/test.ts` (Modify) — Existing widget tests already cover pane row format. Extend with a small regression assertion that headless rows (when `usage` is present) get their right-hand telemetry from `formatUsageStats` rather than `${entries} msgs (...)`.

## Tasks

### Task 1: Port pi-subagent formatters into a shared module

**Files:**
- Create: `pi-extension/subagents/ui/format.ts`
- Test: `test/orchestration/format.test.ts`

**Steps:**

- [ ] **Step 1.1: Read the pi-subagent reference implementation** — open `/Users/david/Code/pi-subagent/index.ts` lines 35-135 and copy the source of `formatTokens`, `formatUsageStats`, and `formatToolCall` verbatim into a working scratch buffer for the port.
- [ ] **Step 1.2: Create the `format.ts` module** — write `pi-extension/subagents/ui/format.ts`. Export `COLLAPSED_ITEM_COUNT = 10`, `formatTokens(count: number): string`, and `formatUsageStats(usage, model?): string` ported verbatim (signatures and bodies). The `usage` parameter type matches the import from `../backends/types.ts`: `{ input, output, cacheRead, cacheWrite, cost, contextTokens?, turns? }`.
- [ ] **Step 1.3: Adapt `formatToolCall` to a `Theme` parameter** — port `formatToolCall(toolName, args, theme: Theme): string`. Replace pi-subagent's `themeFg(color, text)` callable with direct `theme.fg(color, text)` calls. Keep all branches verbatim (`bash`, `read`, `write`, `edit`, `ls`, `find`, `glob`, `grep`, default). Keep truncation thresholds verbatim: bash command 60 chars, default `JSON.stringify` 50 chars. Use `os.homedir()` for the `~` shortening — import from `node:os`.
- [ ] **Step 1.4: Add a `DisplayItem` type and helper** — export `type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> }`. Export `extractDisplayItems(transcript: TranscriptMessage[]): DisplayItem[]` — iterate `transcript`, for `role === "assistant"` walk `content[]`, push `{ type: "text", text: part.text }` for text parts and `{ type: "toolCall", name: part.name, args: part.arguments }` for `toolCall` parts. Mirrors pi-subagent's `getDisplayItems` (`/Users/david/Code/pi-subagent/index.ts:183-194`).
- [ ] **Step 1.5: Add a `getFinalOutput` helper** — export `getFinalOutput(transcript: TranscriptMessage[]): string`. Walk `transcript` from end, return the first text content of the last `role === "assistant"` message. Mirrors pi-subagent's `getFinalOutput` (`/Users/david/Code/pi-subagent/index.ts:169-179`) — but reuse the existing private `getFinalOutput` already living in `pi-extension/subagents/backends/headless.ts:150-160` if exporting from there is preferable; otherwise duplicate the eight-line body here for self-containment of `ui/`.
- [ ] **Step 1.6: Write `format.test.ts`** — `import { describe, it } from "node:test"; import assert from "node:assert/strict";`. Cover: `formatTokens(0)` → `"0"`, `formatTokens(999)` → `"999"`, `formatTokens(1500)` → `"1.5k"`, `formatTokens(15000)` → `"15k"`, `formatTokens(1_500_000)` → `"1.5M"`. Cover every `formatToolCall` branch using a fake `Theme`-shaped object that returns `text` for `fg(color, text)`. Cover `formatUsageStats({ input: 1000, output: 500, cost: 0.001234, turns: 2 })` → string contains `2 turns`, `↑1.0k`, `↓500`, `$0.0012` (cost truncates to 4 decimals).
- [ ] **Step 1.7: Run the test** — `node --test test/orchestration/format.test.ts` and confirm all cases pass.

**Acceptance criteria:**

- `format.ts` exports `formatTokens`, `formatToolCall`, `formatUsageStats`, `extractDisplayItems`, `getFinalOutput`, and `COLLAPSED_ITEM_COUNT` with the signatures and behavior described above.
  Verify: open `pi-extension/subagents/ui/format.ts` and confirm it `export`s `formatTokens`, `formatToolCall`, `formatUsageStats`, `extractDisplayItems`, `getFinalOutput`, and `COLLAPSED_ITEM_COUNT = 10`; confirm `formatToolCall` accepts `(toolName, args, theme)` and the bash branch caps the preview at 60 characters.
- The test file exercises every `formatToolCall` branch and the token/cost edge cases.
  Verify: run `node --test test/orchestration/format.test.ts` and confirm the run reports zero failures and the per-test descriptions list cases for `bash`, `read`, `write`, `edit`, `ls`, `find`/`glob`, `grep`, and the default fallback branch.
- The new module compiles with the rest of the project under `tsc --noEmit`.
  Verify: run `npm run typecheck` and confirm exit code 0 with no diagnostics referencing `pi-extension/subagents/ui/format.ts`.

**Model recommendation:** cheap

---

### Task 2: Build the shared rich-render component layout

**Files:**
- Create: `pi-extension/subagents/ui/headless-render.ts`
- Test: `test/orchestration/render-result-orchestration.test.ts` (skeleton — full assertions in Task 5)

**Steps:**

- [ ] **Step 2.1: Define the row shape** — at the top of `headless-render.ts`, declare `interface TaskRow { name: string; agent?: string; state: "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled"; finalMessage?: string; transcript?: TranscriptMessage[]; usage?: UsageStats; task?: string; error?: string; index?: number; }` and `type RichMode = "single" | "serial" | "parallel"`.
- [ ] **Step 2.2: Implement `renderRichSubagentResult`** — export `function renderRichSubagentResult(opts: { mode: RichMode; results: TaskRow[]; expanded: boolean; theme: Theme; isError?: boolean; inflight?: boolean }): Component`. Build a `Container` from `@mariozechner/pi-tui`. Inside:
  - For `mode === "single"`: pick `r = opts.results[0]`. Render the per-task block (see step 2.4). No aggregate header, no Total line.
  - For `mode === "serial"` / `mode === "parallel"`: render an aggregate header (icon + bold mode label + accent count), then for each `r` in `opts.results` render a separator (`Spacer(1)` + `Text("─── " + accent(name) + " " + stateIcon(r.state))`) then the per-task block (step 2.4), then a final aggregate `Total: <formatUsageStats(aggregate)>` line.
- [ ] **Step 2.3: Implement state-icon and aggregate helpers** — local helpers `stateIcon(state, theme)`: `completed → ✓ success`, `failed → ✗ error`, `cancelled → ○ dim`, `blocked → ⏸ warning`, `running → ⏳ warning`, `pending → · dim`. Local helper `aggregateUsage(rows)` that sums `input`, `output`, `cacheRead`, `cacheWrite`, `cost`, `turns` (skip rows with no `usage`).
- [ ] **Step 2.4: Implement the per-task block** — function `renderTaskBlock(container, r, opts)`:
  - Header: `stateIcon(r.state) + bold(r.name) + dim((r.agent ? " (" + r.agent + ")" : ""))`. Append `dim(" — " + r.state)` for non-completed tasks.
  - If `r.error`, add `Text(theme.fg("error", "Error: " + r.error))`.
  - Tool calls: `items = extractDisplayItems(r.transcript ?? [])`; collapsed view shows last `COLLAPSED_ITEM_COUNT` (10) tool-call items, expanded view shows all. For text items, collapsed shows first 3 lines; expanded shows full text. Format every `toolCall` item via `formatToolCall(item.name, item.args, theme)` prefixed by `theme.fg("muted", "→ ")`. Skip text items entirely in collapsed view (matches pi-subagent's collapsed path) — only show them in expanded.
  - Usage: if `r.usage`, append `Text(theme.fg("dim", formatUsageStats(r.usage)))`.
  - Expanded only: append `Spacer(1)` + `Text(theme.fg("muted", "─── Task ───"))` + `Text(theme.fg("dim", r.task ?? ""))` + `Spacer(1)` + `Text(theme.fg("muted", "─── Output ───"))` + `Markdown(r.finalMessage.trim(), 0, 0, getMarkdownTheme())` if `r.finalMessage` is non-empty (otherwise `Text(theme.fg("muted", "(no output)"))`).
- [ ] **Step 2.5: Add a collapsed expand-hint footer** — at the bottom of every collapsed render, append `Spacer(1)` + `Text(theme.fg("muted", keyHint("app.tools.expand", "to expand")))`. Import `keyHint` from `@mariozechner/pi-coding-agent`. Skip the footer when `expanded === true`.
- [ ] **Step 2.6: Map `OrchestratedTaskResult` to `TaskRow`** — export `function toTaskRows(results: OrchestratedTaskResult[]): TaskRow[]` that copies `name`, `agent` (read from `result.details?` if present, otherwise undefined — orchestration `OrchestratedTaskResult` does NOT carry `agent`; document this as a known gap in `headless-render.ts` and leave undefined for now), `state` (default to derived if absent), `finalMessage`, `transcript`, `usage`, `error`, `index`. The orchestration `task` text isn't in `OrchestratedTaskResult`; leave `task` undefined for orchestration callers.
- [ ] **Step 2.7: Add a stub test scaffold** — write `test/orchestration/render-result-orchestration.test.ts` with `import { renderRichSubagentResult, toTaskRows } from "../../pi-extension/subagents/ui/headless-render.ts";` and one passing smoke test that calls `renderRichSubagentResult({ mode: "serial", results: [], expanded: false, theme: fakeTheme })` and asserts the returned Component has `render(80)` callable.

**Acceptance criteria:**

- `headless-render.ts` exports `renderRichSubagentResult`, `TaskRow`, `RichMode`, and `toTaskRows`.
  Verify: `grep -nE "^export (function|type|interface) (renderRichSubagentResult|TaskRow|RichMode|toTaskRows)" pi-extension/subagents/ui/headless-render.ts` returns four matches.
- The smoke test passes.
  Verify: run `node --test test/orchestration/render-result-orchestration.test.ts` and confirm exit code 0 with one passing test.
- The module compiles under `tsc --noEmit`.
  Verify: run `npm run typecheck` and confirm exit code 0 with no diagnostics referencing `pi-extension/subagents/ui/headless-render.ts`.

**Model recommendation:** capable

---

### Task 3: Add `usage` field to `RunningSubagent` and update widget rendering

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Test: `test/orchestration/widget-headless.test.ts`

**Steps:**

- [ ] **Step 3.1: Add `usage` to the `RunningSubagent` interface** — at `pi-extension/subagents/index.ts` around line 322, add `usage?: UsageStats` to the interface. Import `UsageStats` from `./backends/types.ts` if not already.
- [ ] **Step 3.2: Refactor `renderSubagentWidgetLines`** — at `pi-extension/subagents/index.ts:431-458`, branch the right-side info string on `agent.backend === "headless"`:
  - If `agent.blocked`: keep `" blocked — awaiting parent "`.
  - Else if `agent.backend === "headless"` and `agent.usage`: build `right` from `formatUsageStats(agent.usage)` and pad with leading/trailing spaces so the existing `borderLine` width contract holds (`" ${formatUsageStats(agent.usage)} "`).
  - Else if `agent.backend === "headless"` (no `usage` yet): `" running… "` (so the row is still visible immediately on launch).
  - Else (pane backend): keep existing `entries`/`bytes`/`running…`/`starting…` cascade exactly.
- [ ] **Step 3.3: Import `formatUsageStats` into `index.ts`** — add `import { formatUsageStats } from "./ui/format.ts";` near the existing `./ui/`-adjacent imports.
- [ ] **Step 3.4: Write `test/orchestration/widget-headless.test.ts`** — exercise three rows in one `renderSubagentWidgetLines` call: a pane row with `entries`/`bytes`, a headless row with `usage = { input: 12000, output: 800, cacheRead: 5000, cacheWrite: 0, cost: 0.0042, contextTokens: 0, turns: 3 }`, and a headless row with no `usage`. Assert: pane row contains `msgs (` substring; headless-with-usage row contains `3 turns`, `↑12k`, `↓800`, `$0.0042`; headless-without-usage row contains `running…`. Fix `Date.now` so elapsed values are deterministic. Width fixed at 80.
- [ ] **Step 3.5: Run the new widget test** — `node --test test/orchestration/widget-headless.test.ts` and confirm pass.
- [ ] **Step 3.6: Run the existing widget test suite** — `node --test test/test.ts` and confirm the existing pane-row tests still pass (no regression in width contract or pane format).

**Acceptance criteria:**

- `RunningSubagent` carries an optional `usage: UsageStats` field.
  Verify: `grep -nE "^\s+usage\?:\s*UsageStats" pi-extension/subagents/index.ts` returns at least one match inside the `RunningSubagent` interface block.
- Headless rows render with the new `<turns>t ↑<in> ↓<out> $<cost>` segment when `usage` is present.
  Verify: run `node --test test/orchestration/widget-headless.test.ts` and confirm the assertions on `3 turns`, `↑12k`, `↓800`, and `$0.0042` all pass.
- Pane rows are unchanged — the `<entries> msgs (<bytes>)` format and existing widget tests continue to pass.
  Verify: run `node --test test/test.ts` and confirm the `subagents widget rendering` describe block still passes its three existing cases.

**Model recommendation:** standard

---

### Task 4: Wire headless launches into the widget lifecycle

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Modify: `pi-extension/orchestration/default-deps.ts`

**Steps:**

- [ ] **Step 4.1: Export widget hooks from `index.ts`** — add three module-level helpers:
  - `export function registerHeadlessSubagent(entry: { id: string; name: string; task: string; agent?: string; cli?: string; abortController?: AbortController; startTime?: number }): void` — sets a new `RunningSubagent` with `backend: "headless"` and the supplied fields into `runningSubagents`, then calls `startWidgetRefresh()`.
  - `export function updateHeadlessSubagentUsage(id: string, usage: UsageStats): void` — looks up the entry; if present, mutates `entry.usage` and calls `updateWidget()` so the row repaints immediately on `onUpdate` rather than waiting for the 1Hz tick.
  - `export function unregisterHeadlessSubagent(id: string): void` — `runningSubagents.delete(id); updateWidget();`.
  Locate them next to the existing `runningSubagents` Map (around `pi-extension/subagents/index.ts:354`).
- [ ] **Step 4.2: Wire the bare-subagent headless path** — at `pi-extension/subagents/index.ts:1366-1376` (the headless branch of the bare-`subagent` tool), keep the existing `runningSubagents.set(id, running)` but immediately call `startWidgetRefresh()` (currently missing on this path). Then change the existing `backend.watch(handle, effectiveWatchSignal)` (line 1378-1379) to `backend.watch(handle, effectiveWatchSignal, (partial) => { if (partial.usage) updateHeadlessSubagentUsage(id, partial.usage); })`. Add a `.finally` (or use the existing `.finally` at 1438-1440) so `runningSubagents.delete(id)` continues to fire — already in place; just confirm.
- [ ] **Step 4.3: Wire the orchestration headless path in `default-deps.ts`** — at `pi-extension/orchestration/default-deps.ts:33-34`, after the backend is selected and only when it is the headless backend, wrap the returned `LauncherDeps`:
  - In `launch`, after `backend.launch(...)` resolves, call `registerHeadlessSubagent({ id: handle.id, name: handle.name, task: task.task, agent: task.agent, cli: task.cli, startTime: handle.startTime })`. Import the helper from `../subagents/index.ts`.
  - In `waitForCompletion`, wrap the `onUpdate` callback so partials' `partial.usage` reach `updateHeadlessSubagentUsage(handle.id, partial.usage)` BEFORE forwarding the same partial to the upstream `onUpdate`.
  - In `waitForCompletion`'s try/finally, call `unregisterHeadlessSubagent(handle.id)` once the underlying `backend.watch` settles (resolution or rejection).
- [ ] **Step 4.4: Cross-check pane parity** — confirm that the pane-backend code path through `default-deps.ts` does NOT call any of the new `registerHeadlessSubagent` hooks (the wrapper only activates when `selectBackend() === "headless"`); pane launches continue to use `launchSubagent` → `runningSubagents.set` → `startWidgetRefresh` exactly as today.
- [ ] **Step 4.5: Add an integration-style unit test** — extend `test/orchestration/headless-onupdate-replay.test.ts` (or write `test/orchestration/widget-lifecycle.test.ts`) using `__test__.makeHeadlessBackendWithRunner`. Drive a fake runner that emits two partials with rising `usage`, then settles. Wrap the backend through `makeDefaultDeps` (or call the helpers directly with stub IDs). Assert `runningSubagents.get(id).usage` updates between partials and that the entry is deleted after settle. Use `__test__.getRunningSubagents()` to inspect state.
- [ ] **Step 4.6: Run the new lifecycle test** — `node --test test/orchestration/widget-lifecycle.test.ts` (or whichever file you chose) and confirm pass.

**Acceptance criteria:**

- Bare-subagent headless launches register a row in the widget and call `startWidgetRefresh()` immediately.
  Verify: read `pi-extension/subagents/index.ts` around line 1376 and confirm a `startWidgetRefresh()` call appears in the headless branch directly after `runningSubagents.set(id, running)`, and that the subsequent `backend.watch(...)` call passes a third `onUpdate` argument that invokes `updateHeadlessSubagentUsage`.
- Orchestration headless launches register, update, and unregister widget rows through the helpers from `index.ts`.
  Verify: `grep -nE "registerHeadlessSubagent|updateHeadlessSubagentUsage|unregisterHeadlessSubagent" pi-extension/orchestration/default-deps.ts` returns at least three matches, one for each helper.
- The lifecycle test passes.
  Verify: run the new `node --test test/orchestration/widget-lifecycle.test.ts` (or the extended `headless-onupdate-replay.test.ts`) and confirm exit code 0 with the lifecycle assertions reporting passed.
- Pane backend code paths are unchanged.
  Verify: read `pi-extension/orchestration/default-deps.ts` and confirm the `registerHeadlessSubagent` / `unregisterHeadlessSubagent` calls live inside a branch gated on `selectBackend() === "headless"` (or on the headless backend instance) and are not invoked on the pane path.

**Model recommendation:** standard

---

### Task 5: Register `renderResult` for orchestration tools

**Files:**
- Modify: `pi-extension/orchestration/tool-handlers.ts`
- Test: `test/orchestration/render-result-orchestration.test.ts`

**Steps:**

- [ ] **Step 5.1: Import `renderRichSubagentResult` and `toTaskRows`** — at the top of `pi-extension/orchestration/tool-handlers.ts`, add `import { renderRichSubagentResult, toTaskRows } from "../subagents/ui/headless-render.ts";` and `import type { Theme } from "@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";` (or rely on the existing pi-coding-agent types if `Theme` is re-exported).
- [ ] **Step 5.2: Add `renderResult` to `subagent_run_serial`** — inside the `pi.registerTool({ name: "subagent_run_serial", ... })` block at `pi-extension/orchestration/tool-handlers.ts:115-255`, add a `renderResult(result, { expanded }, theme)` field. The handler reads `details = result.details as { results?: any[]; isError?: boolean; inflight?: boolean }`, returns `renderRichSubagentResult({ mode: "serial", results: toTaskRows(details.results ?? []), expanded, theme, isError: details.isError ?? false, inflight: details.inflight === true })`.
- [ ] **Step 5.3: Add `renderResult` to `subagent_run_parallel`** — repeat in the `subagent_run_parallel` tool definition at `pi-extension/orchestration/tool-handlers.ts:257-393` with `mode: "parallel"`.
- [ ] **Step 5.4: Flesh out `render-result-orchestration.test.ts`** — replace the smoke test with full assertions:
  - Build a fake `Theme` with `fg(_, t) => t`, `bg(_, t) => t`, `bold(t) => t`.
  - Construct synthetic `details.results: OrchestratedTaskResult[]` with two tasks: one `state: "completed"` carrying a sample `transcript` (one assistant message with three `toolCall` parts: `bash`, `read`, `grep`) and `usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 1 }`; one `state: "running"` with empty transcript and partial usage.
  - Call `renderRichSubagentResult({ mode: "serial", results: toTaskRows(details.results), expanded: false, theme })`. Render to width 80. Assert the joined output contains: the task names, both state icons (✓ and ⏳), at least one `→ $` (bash prefix), at least one `→ read`, the per-task `↑1.0k` token count, and the `Total:` aggregate line.
  - Repeat with `expanded: true` and assert the rendered output now contains a `─── Task ───` divider for each task and the (Markdown-rendered) finalMessage if present.
- [ ] **Step 5.5: Run the renderResult test** — `node --test test/orchestration/render-result-orchestration.test.ts` and confirm pass.
- [ ] **Step 5.6: Run the existing `tool-handlers` test suite** — `node --test test/orchestration/tool-handlers.test.ts` and confirm no regression.

**Acceptance criteria:**

- Both orchestration tools register a `renderResult` that delegates to `renderRichSubagentResult`.
  Verify: `grep -nE "renderResult\s*\(" pi-extension/orchestration/tool-handlers.ts` returns at least two matches, and `grep -n "renderRichSubagentResult" pi-extension/orchestration/tool-handlers.ts` returns at least two matches inside the file.
- The renderResult test passes for both serial and parallel modes, in both collapsed and expanded views.
  Verify: run `node --test test/orchestration/render-result-orchestration.test.ts` and confirm exit code 0 with at least four `it` blocks (serial collapsed, serial expanded, parallel collapsed, parallel expanded) all reporting passed.
- The existing `tool-handlers` tests still pass.
  Verify: run `node --test test/orchestration/tool-handlers.test.ts` and confirm exit code 0 with no failures.

**Model recommendation:** standard

---

### Task 6: Forward `transcript`/`usage` and rich-render `subagent_result`

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Test: `test/orchestration/subagent-result-renderer-headless.test.ts`

**Steps:**

- [ ] **Step 6.1: Forward `transcript` + `usage` in the bare-subagent headless `details`** — at `pi-extension/subagents/index.ts:1399-1413` (the bare-subagent headless `.then(result => ...)` block), extend the `details` object literal passed to `pi.sendMessage({ customType: "subagent_result", ..., details })` so it includes `...(result.transcript ? { transcript: result.transcript } : {})` and `...(result.usage ? { usage: result.usage } : {})`. The `result` here is `BackendResult`, which already declares both fields (`pi-extension/subagents/backends/types.ts:38-39`).
- [ ] **Step 6.2: Replace the `subagent_result` renderer body** — at `pi-extension/subagents/index.ts:2037-2100`, keep the renderer registration (`pi.registerMessageRenderer("subagent_result", ...)`) but replace its `render(width)` body. New behavior:
  - If `details.transcript && details.usage` (headless completion): build a `TaskRow` from `{ name: details.name, agent: details.agent, state: details.exitCode === 0 ? "completed" : "failed", finalMessage: extractFinalMessageFromContent(message.content), transcript: details.transcript, usage: details.usage, task: details.task, error: details.error }`. Call `renderRichSubagentResult({ mode: "single", results: [row], expanded: options.expanded, theme })`. Return that component as the renderer's return value (note the existing renderer wraps in `{ invalidate, render }`; mirror that pattern, calling `component.render(width)` from within `render(width)`).
  - Else: fall through to the existing pane-shaped rendering verbatim — preserve every line of the current body when no `transcript`/`usage` are present.
- [ ] **Step 6.3: Provide a `extractFinalMessageFromContent` helper** — local to `index.ts` (or moved into `ui/format.ts` if cleaner). Inputs `message.content` (string in this codebase). Strip the `Sub-agent "${name}" completed (${elapsed}).\n\n` prefix and the `\n\nSession: ...` suffix (the existing renderer already does this at `index.ts:2059-2062`); reuse the same regexes verbatim.
- [ ] **Step 6.4: Write `test/orchestration/subagent-result-renderer-headless.test.ts`** — register the renderer via the extension factory shape (or call the renderer body directly via a small export). The test exercises two cases:
  - Pane shape: `details = { name: "X", agent: "code", exitCode: 0, elapsed: 12, sessionFile: "/tmp/x" }` (no `transcript`/`usage`). Assert the rendered output uses today's `Box` background path — assertion can grep the rendered string for the existing `keyHint("app.tools.expand", "to expand")` text.
  - Headless shape: `details = { name: "X", agent: "code", exitCode: 0, elapsed: 12, transcript: [...], usage: {...}, task: "do thing" }`. Assert the rendered output contains the rich block markers (`✓`, `↑`, `↓`, the per-task name, and at least one `→ ` tool-call prefix when `transcript` carries tool calls).
- [ ] **Step 6.5: Run the renderer test** — `node --test test/orchestration/subagent-result-renderer-headless.test.ts` and confirm pass.
- [ ] **Step 6.6: Run the existing test suite** — `npm test` and confirm no regression.

**Acceptance criteria:**

- The bare-subagent headless `details` payload now carries `transcript` and `usage` whenever the underlying `BackendResult` had them.
  Verify: open `pi-extension/subagents/index.ts` near line 1399 and confirm the `details` object literal in the headless `.then(result => pi.sendMessage(...))` block spreads both `result.transcript` and `result.usage` (under conditional spread with `...(result.transcript ? { transcript: result.transcript } : {})` and the symmetric `usage` spread).
- The `subagent_result` renderer detects headless completions and returns the rich layout for them; pane completions render exactly as today.
  Verify: run `node --test test/orchestration/subagent-result-renderer-headless.test.ts` and confirm both the pane-shape and headless-shape `it` blocks pass.
- Existing tests are not broken.
  Verify: run `npm test` and confirm exit code 0.

**Model recommendation:** standard

---

### Task 7: Plumb `mode` through the registry and rich-render `orchestration_complete`

**Files:**
- Modify: `pi-extension/orchestration/registry.ts`
- Modify: `pi-extension/subagents/index.ts`
- Test: `test/orchestration/registry.test.ts`
- Test: `test/orchestration/orchestration-complete-renderer.test.ts`

**Steps:**

- [ ] **Step 7.1: Extend `OrchestrationCompleteEvent`** — at `pi-extension/orchestration/registry.ts:20-25`, add `mode: OrchestrationMode` to the interface. Update the `RegistryEmission` union if needed (it's a union of two `interface` shapes, so no further changes required).
- [ ] **Step 7.2: Populate `mode` in `tryFinalize`** — at `pi-extension/orchestration/registry.ts:155-167`, add `mode: entry.config.mode` to the `safeEmit({ kind: ORCHESTRATION_COMPLETE_KIND, ... })` payload.
- [ ] **Step 7.3: Extend the registry test** — add a new test in `test/orchestration/registry.test.ts` that drives a serial dispatch, settles all tasks via `registry.onTaskTerminal`, and asserts the captured emission has `mode: "serial"`. Repeat with parallel and assert `mode: "parallel"`.
- [ ] **Step 7.4: Replace the `orchestration_complete` renderer body** — at `pi-extension/subagents/index.ts:2140-2165`, keep the registration but replace its `render(width)`:
  - Read `details.mode` (default to `"serial"` for backwards-compat if absent).
  - Build `rows = toTaskRows(details.results ?? [])`.
  - Return `renderRichSubagentResult({ mode: details.mode, results: rows, expanded: _options.expanded, theme, isError: details.isError })` rendered to `width`. Preserve the renderer's `{ invalidate, render }` shape and the leading blank-line spacer (`return ["", ...component.render(width)]`).
- [ ] **Step 7.5: Write `test/orchestration/orchestration-complete-renderer.test.ts`** — register the `orchestration_complete` renderer, drive it with synthetic `message.details` payloads carrying `mode: "serial"` and `mode: "parallel"` plus realistic `results: OrchestratedTaskResult[]` with `transcript` + `usage`. Assert collapsed and expanded outputs include the same markers as the renderResult tests in Task 5.
- [ ] **Step 7.6: Run the registry and renderer tests** — `node --test test/orchestration/registry.test.ts test/orchestration/orchestration-complete-renderer.test.ts` and confirm pass.
- [ ] **Step 7.7: Run the full test suite** — `npm test` and confirm no regression.

**Acceptance criteria:**

- The orchestration complete event carries `mode: OrchestrationMode`.
  Verify: open `pi-extension/orchestration/registry.ts`, find the `OrchestrationCompleteEvent` interface definition, and confirm it declares `mode: OrchestrationMode`; in `tryFinalize`'s `safeEmit({ kind: ORCHESTRATION_COMPLETE_KIND, ... })` block confirm a `mode: entry.config.mode` field is present.
- Registry tests assert `mode` is populated in both serial and parallel emissions.
  Verify: run `node --test test/orchestration/registry.test.ts` and confirm the test descriptions include `mode: "serial"` and `mode: "parallel"` cases and both pass.
- The `orchestration_complete` renderer renders the rich layout in both modes.
  Verify: run `node --test test/orchestration/orchestration-complete-renderer.test.ts` and confirm both `mode: "serial"` and `mode: "parallel"` `it` blocks pass with assertions on the per-task tool-call lines and the aggregate `Total:` line.
- The full test suite remains green.
  Verify: run `npm test` and confirm exit code 0 with no failures.

**Model recommendation:** standard

---

### Task 8: Slim the in-flight orchestration text content

**Files:**
- Modify: `pi-extension/orchestration/run-serial.ts`
- Modify: `pi-extension/orchestration/run-parallel.ts`
- Test: `test/orchestration/inflight-text-slim.test.ts`

**Steps:**

- [ ] **Step 8.1: Rewrite `summarizeInflight` in `run-serial.ts`** — at `pi-extension/orchestration/run-serial.ts:196-207`, change to:
  ```ts
  function summarizeInflight(mode, results) {
    const lines = [`${mode} orchestration (in-flight): ${results.length} task(s)`];
    for (const r of results) {
      const state = r.state ?? deriveInflightState(r);
      lines.push(`- ${r.name}: ${state}`);
    }
    return lines.join("\n");
  }
  function deriveInflightState(r) {
    if (r.error) return "failed";
    if (r.exitCode !== 0 && r.exitCode !== undefined) return "failed";
    return "running";
  }
  ```
  Drop the `firstLine(finalMessage)` slice + 200-char truncation entirely.
- [ ] **Step 8.2: Rewrite `summarizeInflightParallel` in `run-parallel.ts`** — at `pi-extension/orchestration/run-parallel.ts:217-234`, change so each row prints `name: pending` for `r === undefined` (already handled) and `name: <state>` otherwise via the same `deriveInflightState` helper (duplicate the helper or inline it). Drop the `firstLine` preview.
- [ ] **Step 8.3: Write `test/orchestration/inflight-text-slim.test.ts`** — drive `runSerial` with a fake `LauncherDeps` that:
  - `launch` resolves immediately.
  - `waitForCompletion` calls the supplied `onUpdate` once with a `{ name, finalMessage: "this is a long message that should NOT appear in the inflight text", exitCode: 0, ... }`, then resolves with the same.
  Capture the `onUpdate` argument that the orchestration tool's `onUpdate` callback receives. Assert `text = capture.content[0].text` contains `serial orchestration (in-flight): 2 task(s)`, `step-1: running` or `step-1: completed`, and does NOT contain the substring `"long message"`. Repeat with `runParallel`.
- [ ] **Step 8.4: Run the test** — `node --test test/orchestration/inflight-text-slim.test.ts` and confirm pass.
- [ ] **Step 8.5: Run the existing run-serial / run-parallel tests** — `node --test test/orchestration/run-serial.test.ts test/orchestration/run-parallel.test.ts` and confirm no regression. The existing tests assert on result counts, not on inflight text — but check.

**Acceptance criteria:**

- `summarizeInflight` and `summarizeInflightParallel` no longer emit `firstLine(finalMessage)` previews.
  Verify: `grep -n "firstLine\|finalMessage.*split.*find" pi-extension/orchestration/run-serial.ts pi-extension/orchestration/run-parallel.ts` returns zero matches inside the `summarizeInflight*` function bodies (a top-of-file `firstLine` import or unrelated reference can remain).
- The in-flight text test passes for both serial and parallel modes.
  Verify: run `node --test test/orchestration/inflight-text-slim.test.ts` and confirm both `it` blocks pass with the assertions on the absent `long message` substring and the present `running`/`completed` state tokens.
- Existing run-serial / run-parallel tests remain green.
  Verify: run `node --test test/orchestration/run-serial.test.ts test/orchestration/run-parallel.test.ts` and confirm exit code 0.

**Model recommendation:** cheap

---

### Task 9: Final integration check

**Files:**
- Test: full `npm test` + `npm run typecheck`

**Steps:**

- [ ] **Step 9.1: Typecheck** — run `npm run typecheck`. Confirm exit code 0 with no diagnostics.
- [ ] **Step 9.2: Lint** — run `npm run lint`. Confirm exit code 0.
- [ ] **Step 9.3: Full unit-test suite** — run `npm test`. Confirm exit code 0 with all suites passing.
- [ ] **Step 9.4: Spot-check that the headless integration tests still run** — run `node --test test/integration/headless-pi-smoke.test.ts test/integration/headless-tool-use.test.ts` (slow, but they validate the full headless pipeline). Confirm exit code 0.
- [ ] **Step 9.5: Manual verification (documented for the operator, NOT automated)** — note in the task body that to fully verify visual output, the operator should: run pi with `PI_SUBAGENT_MODE=headless`; invoke `subagent_run_serial` with two tasks each calling several tools; confirm tool calls stream live in the renderResult, Ctrl+O toggles between collapsed (header + last 10 tool calls + usage + Total line) and expanded (adds task text + final-message markdown); repeat with `wait: false` and confirm `orchestration_complete` renders the same layout; repeat with a bare `subagent` call and confirm `subagent_result` renders the rich block. The widget shows one row per running child with live `<turns>t ↑in ↓out $cost` telemetry that updates as work progresses. (This step is a documentation reminder — no automated verification.)

**Acceptance criteria:**

- Typecheck, lint, and the full test suite all pass.
  Verify: run `npm run typecheck && npm run lint && npm test` and confirm the combined command exits 0 with no failures reported in any of the three stages.
- The headless integration smoke tests still pass.
  Verify: run `node --test test/integration/headless-pi-smoke.test.ts test/integration/headless-tool-use.test.ts` and confirm exit code 0.
- The plan documents the manual-verification protocol for the operator.
  Verify: open `.pi/plans/2026-05-01-2026-05-01-headless-subagent-live-transparency.md`, locate Task 9 Step 9.5, and confirm it lists the four manual checks (sync renderResult Ctrl+O, async `orchestration_complete`, bare-subagent `subagent_result`, widget live telemetry) the operator must perform.

**Model recommendation:** standard

---

## Dependencies

```
- Task 2 depends on: Task 1
- Task 3 depends on: Task 1
- Task 4 depends on: Task 3
- Task 5 depends on: Task 2
- Task 6 depends on: Task 2, Task 4
- Task 7 depends on: Task 2, Task 5
- Task 8 depends on: (none — can run in parallel with Tasks 1-7)
- Task 9 depends on: Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8
```

## Risk Assessment

- **Risk: `Theme.fg(color, text)` color tokens differ between pi-tui and pi-subagent's reference.** The pi-subagent code uses `themeFg("toolOutput", ...)`, `"accent"`, `"muted"`, `"dim"`, `"warning"`, `"error"`, `"success"`, `"toolTitle"`. All of these are declared in `node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.d.ts:3` `ThemeColor` union. Mitigation: tests in Task 1 use a fake theme that returns the text verbatim; visual verification in Task 9.5 confirms the production theme actually renders distinguishable colors.
- **Risk: `OrchestratedTaskResult` does not carry `agent`, only the orchestration `OrchestrationTask` does.** The renderResult and orchestration_complete renderers map from `OrchestratedTaskResult[]` and so cannot show the agent badge per task. Mitigation: `toTaskRows` leaves `agent` undefined for orchestration callers; the per-task header degrades gracefully (no `(agent)` segment). For bare-subagent (`mode: "single"`), `agent` is available in the `details` payload and is propagated.
- **Risk: `updateWidget()` from `onUpdate` causes excessive repainting under high tool-call cadence.** Pi children emit on every `message_end` (assistant turn); Claude children emit on every assistant event. At a few events per second, the cost is negligible; under pathological transcripts it could matter. Mitigation: the existing 1Hz `widgetInterval` already throttles by-default repainting; `updateWidget()` is idempotent. If profiling reveals a problem, debounce inside `updateHeadlessSubagentUsage` — out of scope for v1 but easy to add.
- **Risk: Rich renderResult competes with the LLM-facing `summarize` text and may bloat token counts.** The LLM-facing text is `summarize` (`tool-handlers.ts:437-443`), which is unchanged. The `details` payload carries `transcript` + `usage`, which the LLM does NOT see (only `content[0].text` is sent to the model). Confirmed by inspection of `tool-handlers.ts:235-251` (only `content` is the user-facing string; `details` is renderer-only).
- **Risk: pane backend's `subagent_result` renderer regression.** The new renderer falls through to today's behavior when `transcript`/`usage` are absent. The pane backend never populates these (TODO-08e81407), so pane completions take the fallback path verbatim. Mitigation: explicit test case in Task 6 covers the pane shape.
- **Risk: Existing widget-related tests in `test/test.ts` assert exact widths.** New headless-row format must keep the `borderLine` width contract. Mitigation: Task 3 Step 3.2 routes the new content through the same `borderLine` helper; Task 3 Step 3.6 re-runs `node --test test/test.ts` to catch any regression.
- **Risk: `keyHint("app.tools.expand", "to expand")` requires a registered keybinding.** Already present in pi today (the existing `subagent_result` renderer uses it at `pi-extension/subagents/index.ts:2091`). Mitigation: reuse the same call site exactly.
- **Risk: `Markdown` from `@mariozechner/pi-tui` may behave differently inside a `Container` vs. a string-based renderer.** Confirmed: pi-subagent uses `Markdown` inside `Container` (`/Users/david/Code/pi-subagent/index.ts:1057,1142,1227`). Mitigation: copy the construction pattern verbatim.

## Test Command

```bash
npm test
```

## Self-Review

**Spec coverage (each requirement → task):**

1. New `renderResult` for `subagent_run_serial` and `subagent_run_parallel` (collapsed/expanded with Ctrl+O). → Tasks 2 + 5.
2. Extend `subagent_result` renderer for headless completions (rich block); pane shape unchanged. → Tasks 2 + 6.
3. Extend `orchestration_complete` renderer to share component layout. → Tasks 2 + 7.
4. Forward `transcript` + `usage` in bare-subagent `details` payload. → Task 6 Step 6.1.
5. Widget shows row per headless child; 1Hz refresh; live `onUpdate` partial updates. → Tasks 3 + 4.
6. `renderSubagentWidgetLines` headless row format (`<turns>t ↑in ↓out $cost`); pane row unchanged; `usage?` field on `RunningSubagent`. → Task 3.
7. Slim in-flight orchestration `text` content (drop firstLine preview; keep mode + count + per-task name + state). → Task 8.
8. Port `formatToolCall` and `formatUsageStats` from pi-subagent. → Task 1.

All eight requirements have at least one task. AC1 → Tasks 2+5; AC2 → Tasks 2+7; AC3 → Tasks 2+6; AC4 → Tasks 3+4; AC5 → Task 8; AC6 (no regressions) → Task 9 + per-task test runs.

**Placeholder scan:** No "TBD", "TODO", "implement later", or "similar to Task N" appearing in any task body. Every step describes a concrete action with a file path or a command. Every acceptance criterion is followed by an immediately-following `Verify:` line that names the artifact and the success condition.

**Type consistency check:**
- `RunningSubagent` adds `usage?: UsageStats` (Task 3); `UsageStats` imported from `./backends/types.ts`. Same shape used in `renderSubagentWidgetLines` (Task 3) and `updateHeadlessSubagentUsage` (Task 4).
- `TaskRow` introduced in `headless-render.ts` (Task 2); `toTaskRows` consumes `OrchestratedTaskResult[]` (defined in `pi-extension/orchestration/types.ts:70-82` with `usage`, `transcript`, `state`, `name`, `index`, `error`, `finalMessage`, `transcriptPath`, `elapsedMs`, `exitCode`, `sessionKey`).
- `OrchestrationCompleteEvent` gains `mode: OrchestrationMode` (Task 7); `OrchestrationMode = "serial" | "parallel"` already exists at `registry.ts:12`.
- `BackendResult.usage` and `.transcript` already declared (`backends/types.ts:38-39`); the `details` payload extension in Task 6 simply forwards them.
- `formatToolCall(toolName, args, theme)` signature uses `Theme` from `@mariozechner/pi-coding-agent`; the same theme parameter feeds `formatUsageStats(usage, model?)` and `renderRichSubagentResult({ ..., theme })`.
- The `renderResult` callback signature `(result, options, theme, context) => Component` matches the `ToolDefinition.renderResult` declaration at `node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:353`.
- The `MessageRenderer` callback signature `(message, options, theme) => Component | undefined` matches `types.d.ts:752`.

No type mismatches identified.

**Format constraint check:** No new files require YAML frontmatter or specific schema constraints. Markdown plan content uses ASCII-only headers and fenced code blocks where required. The `renderResult` field is added to existing `pi.registerTool` calls — no new tool definitions are introduced, so the existing schema parameters remain authoritative.

## Review Notes

_Added by plan reviewer — informational, not blocking._

### Warnings

- **Task 2**: `TaskRow`/`RichMode` export instructions conflict with acceptance criteria
  - **What:** Step 2.1 says to declare `interface TaskRow` and `type RichMode` locally, while the acceptance criterion requires `headless-render.ts` to export `renderRichSubagentResult`, `TaskRow`, `RichMode`, and `toTaskRows` and verifies with a grep for `^export (function|type|interface) ...`.
  - **Why it matters:** An implementer following the step literally could create non-exported types and then fail the task's own verify recipe even though the implementation otherwise works.
  - **Recommendation:** Make the Task 2 step language match the acceptance criterion by explicitly requiring `export interface TaskRow` and `export type RichMode`.

- **Task 2**: Collapsed text-item rendering instructions are internally contradictory
  - **What:** Step 2.4 first says, "For text items, collapsed shows first 3 lines; expanded shows full text," but later in the same bullet says, "Skip text items entirely in collapsed view (matches pi-subagent's collapsed path)."
  - **Why it matters:** This gives two different collapsed-rendering behaviors for the same content, which could lead different workers to implement different UI output and cause tests or manual parity checks to disagree.
  - **Recommendation:** Choose one collapsed behavior in Task 2.4. Based on the spec's collapsed-view requirement and the parenthetical parity note, the plan should state only the intended tool-call-only collapsed behavior if that is the target.

### Suggestions

- **Task 1**: `extractDisplayItems` export location is inconsistent between the file structure and task body
  - **What:** The File Structure section says `pi-extension/subagents/ui/headless-render.ts` also exports `extractDisplayItems`, while Task 1 Step 1.4 and Task 1 acceptance criteria require `extractDisplayItems` to be exported from `pi-extension/subagents/ui/format.ts`. Task 2 then uses `extractDisplayItems` without explicitly saying it imports it from `format.ts`.
  - **Why it matters:** This is unlikely to block implementation, but it may cause churn over which module owns the helper or whether it should be re-exported.
  - **Recommendation:** Clarify whether `extractDisplayItems` lives only in `format.ts`, is re-exported from `headless-render.ts`, or should be moved to `headless-render.ts`.
