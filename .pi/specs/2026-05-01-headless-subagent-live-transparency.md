# Restore live transparency for headless subagent runs

Source: TODO-4a7c2e91

## Goal

When `PI_SUBAGENT_MODE=headless` (or auto-fallback when no mux is available), restore the live transparency that pi-subagent's `formatToolCall` + `formatUsageStats` provided when invoked from inside pi. Today the pi-tui surface receives no live feedback for headless children — partials accumulate `transcript`/`usage` data that gets flattened into a single line. This spec routes rich detail through the tool framework's `renderResult` and custom-message renderer surfaces (where Ctrl+O collapse/expand is built in) and unifies the existing persistent widget so headless and pane launches both appear consistently.

## Context

**Existing widget surface.** The persistent "Subagents — N running" widget mounts via `latestCtx.ui.setWidget("subagent-status", ...)` from `pi-extension/subagents/index.ts:473-484`, polling at 1Hz, reading from a module-scope `runningSubagents: Map<string, RunningSubagent>`. Hand-rolled ANSI strings (`borderTop` / `borderLine` / `borderBottom` at `:378-429`). `renderSubagentWidgetLines` (`:431-458`) renders one row per agent. Pane rows show `entries (bytes)` from session-file polling; headless rows fall through to "running…".

**Visibility gap by backend.** The pane backend (`makePaneBackend.launch`) routes through `launchSubagent` (`:670`) which inserts into `runningSubagents` and starts the widget refresh (`:759, 877`). The headless backend (`makeHeadlessBackend.launch` in `backends/headless.ts:169-223`) does NOT touch `runningSubagents`. The bare-subagent headless tool branch at `index.ts:1366-1376` manually inserts a sparse entry but does NOT call `startWidgetRefresh`. Net: orchestration-spawned children running headless are invisible in the widget today.

**Existing tool/message rendering.** Bare `subagent` defines `renderCall` and `renderResult` (`:1563-1608`) — the latter shows a basic "started" line. Orchestration tools (`subagent_run_serial` / `_parallel`) have NO `renderResult` registered in `tool-handlers.ts`. Custom message renderers exist for `subagent_result` (`:2037`), `subagent_ping` (`:2103`), and `orchestration_complete` (`:2140`); the `subagent_result` and `orchestration_complete` renderers currently produce simple completion text.

**Data flow already in place.** The headless backend accumulates `transcript` (`headless.ts:310, 536`) and `usage` (`:311, 537`); per-event partials emit via `onUpdate` from the runners (`:430` for pi children, `:618` for Claude children). Orchestration `onUpdate` flow forwards partials through `default-deps.ts:55-71` and `runSerial` / `runParallel` wraps them as `details: { results, isError, inflight }` with full per-task `transcript` + `usage` (`run-serial.ts:117`, `run-parallel.ts:103`). Bare-subagent headless (`index.ts:1378-1379`) calls `backend.watch(handle, signal)` with NO `onUpdate` — partials are dropped. `BackendResult` already declares `transcript?` and `usage?` (`backends/types.ts:30-42`).

**Predecessor pi-subagent UX.** `formatToolCall` and `formatUsageStats` at `/Users/david/Code/pi-subagent/index.ts:42-135` render themed tool-call lines and metrics summaries. pi-subagent's `renderResult` (`:998-`) implements collapsed-with-metrics-header default + Ctrl+O expansion via the framework's `{ expanded }` flag. `COLLAPSED_ITEM_COUNT = 10` (`:33`) caps the tool-call list in collapsed view.

**Framework constraints.** Components mounted via `setWidget` do NOT receive keyboard focus per `pi-tui/dist/tui.d.ts:9-30` — `handleInput` only fires when a component has focus, which widgets never do. Pi-subagent's per-result Ctrl+O comes for free in `renderResult` because the framework manages an `expanded` flag per result.

## Requirements

1. New `renderResult` for `subagent_run_serial` and `subagent_run_parallel` that uses `details.results[].transcript` + `details.results[].usage` to render a pi-subagent-style component:
   - Collapsed view: per-task header (✓/✗/⏳ + name + agent + status) + last-`COLLAPSED_ITEM_COUNT` tool calls (formatted via ported `formatToolCall`) + per-task usage line (ported `formatUsageStats`) + aggregated total for parallel/serial.
   - Expanded view: adds the task text block + final-output markdown per task.
   - Ctrl+O toggling driven by the framework's built-in `{ expanded }` flag.
2. Extend the `subagent_result` custom message renderer (`index.ts:2037`) to detect headless completions (by presence of `details.transcript` + `details.usage`, or equivalent) and render the rich pi-subagent-style component (single-task variant of #1's component). Pane completions (no `transcript` / `usage` in details) retain today's simple rendering. Backwards-compatible: when those fields are absent, fall through to current behavior.
3. Extend the `orchestration_complete` custom message renderer (`index.ts:2140`) to use the same component layout as #1 for async-mode aggregated results. Render layout shared with #1 (no divergence in the rich-rendering code path).
4. Extend the `details` payload at `index.ts:1399-1413` (the bare-subagent headless `.then()` block) to forward `transcript` and `usage` from `BackendResult`. Required for #2.
5. Make the persistent "Subagents — N running" widget show one row per running child for headless backends, matching today's pane visibility:
   - All headless launches (bare-subagent and orchestration-spawned) appear as rows in the widget.
   - The 1Hz refresh starts when the first headless child registers and stops when the last child settles.
   - Live `onUpdate` partials update the row's `usage` in place.
6. Extend `renderSubagentWidgetLines` to render headless rows with backend-natural telemetry:
   - Headless row right-side info: `<turns> turn(s) ↑<in> ↓<out> $<cost>` using `formatTokens`-style abbreviation ported from pi-subagent.
   - Pane row format unchanged.
   - Add a `usage?: UsageStats` field to `RunningSubagent` to drive headless rendering.
7. Slim the in-flight orchestration `text` content emitted by `onUpdate` (`run-serial.ts:200-207`, `run-parallel.ts:222-`):
   - Drop the per-task `firstLine(finalMessage)` preview.
   - Keep mode + count + per-task name + state.
8. Port `formatToolCall` and `formatUsageStats` from `/Users/david/Code/pi-subagent/index.ts:42-135` and adapt them to pi-tui `Box` / `Text` / `Container` rendering (replacing pi-subagent's ANSI-string concatenation). Used by #1, #2, and #3.

## Constraints

- No changes to backend runner logic. The `headless.ts` runners already accumulate `transcript` / `usage`; the widget-row registration in #5 is a side-effect addition outside the runner data flow.
- No changes to the pane backend's data tracking. TODO-08e81407 owns pane usage / transcript parity. The headless widget row format must NOT depend on data the pane backend doesn't have today.
- The widget remains string-based. `setWidget` accepts `string[]`; `renderSubagentWidgetLines` continues to return strings. ANSI-string formatters suffice for the one-line headless row format.
- No changes to `subagent_run_cancel`.
- No changes to the `subagent_ping` message renderer.
- No changes to the LLM-facing final result content (`tool-handlers.ts:437-443` `summarize` is untouched).
- Pane bare-subagent's `subagent_result` rendering is not made rich in v1 (Q6b decision; pane already has a visible terminal, and the parse work belongs in TODO-08e81407).

## Approach

**Chosen approach:** Render rich detail via the tool framework's `renderResult` (orchestration sync) and custom-message renderer (orchestration async + bare-subagent headless completion) surfaces, where the framework manages collapse/expand and Ctrl+O natively. Keep the persistent above-editor widget compact (one line per running child) but unify it across backends so visibility parity matches the existing pane behavior. The headless and async paths share a single component-layout module so they stay visually consistent and evolve together.

**Why this over alternatives:**
- The framework already manages `expanded` per result — we get pi-subagent's exact "Ctrl+O to expand" UX with no custom keypress plumbing.
- `details` already carries rich data through the `onUpdate` flow; `renderResult` has direct access. Same data shape on the async path via `orchestration_complete` lets the renderers share a component module.
- A widget-only detail approach would require a global shortcut hack (widgets don't receive focus per the pi-tui Component contract) and at best supports all-rows-toggle-together — strictly worse UX than per-result expansion.
- Routing rich content through `renderResult` matches pi-subagent's actual implementation pattern, which is the brief's stated parity target.

**Considered and rejected:**
- *Extend the existing string-based widget with multi-line expanded body.* Widgets don't receive keyboard focus, so per-row Ctrl+O is not available; only an app-level shortcut for "expand all rows" would work. Coarser UX than the `renderResult` path.
- *Replace the existing widget with a pi-tui `Box` / `Text` component tree.* Bigger blast radius (rewrite of working code), no UX gain over the string-based widget for a one-line summary, and still doesn't solve the focus problem for in-widget expansion.
- *Mount a separate parallel widget for headless only.* Two coexisting widgets where one suffices; double the state to keep in sync.
- *Use a focused-overlay detail view via `ctx.ui.custom`.* Modal interaction is jarring for a long-running monitoring use case; the inline-result pattern stays in the user's reading flow.
- *Pane parity for rich `subagent_result` rendering in v1.* Requires post-mortem transcript-parse work the pane backend doesn't do today; deferred to TODO-08e81407, the natural home for pane observability.
- *Unified row shape across backends in v1.* Requires pane to track `usage`, also TODO-08e81407 territory. The chosen "different shapes per backend" approach is forward-compatible: A → B is a pure additive rendering-function change once pane data is available, no migration needed.

## Acceptance Criteria

1. Running `subagent_run_serial` or `subagent_run_parallel` with `wait: true` and `PI_SUBAGENT_MODE=headless` displays live progress in the transcript: tool-call lines stream as the underlying agents make calls, per-task usage updates throughout, Ctrl+O on the result toggles between collapsed (header + last 10 tool calls + usage) and expanded (adds task text + final-output markdown).
2. Same as #1 with `wait: false`: when the orchestration completes, the `orchestration_complete` message renders with the same component layout and Ctrl+O behavior as the sync `renderResult`.
3. A bare `subagent` call in headless mode produces a `subagent_result` message that, when rendered, shows the rich pi-subagent-style block (collapsed = header + tool-call list + usage; expanded = adds task text + final-output markdown). Ctrl+O toggles. Pane bare-subagent's `subagent_result` rendering is unchanged.
4. The "Subagents — N running" widget shows one row per running headless child (from both bare-subagent and orchestration callers). The headless row format displays elapsed, name, agent tag, and live token / turn / cost telemetry derived from `usage`. The pane row format is unchanged.
5. The in-flight orchestration `text` content (`summarizeInflight`) no longer includes per-task first-line previews; it lists mode, count, and per-task name + state only.
6. No regression in: pane backend's existing widget rows, pane bare-subagent `subagent_result` rendering, `subagent_ping` rendering, `subagent_run_cancel`, the orchestration final result text content (`summarize`).

## Non-Goals

- Pane-backend transcript / usage tracking and unified-shape widget rendering (TODO-08e81407).
- Post-mortem rich rendering for pane bare-subagent's `subagent_result` (TODO-08e81407).
- Backend runner-logic changes (headless or pane).
- Non-pi parents (Claude Code, etc.) consuming this framework.
- Stderr / stdout printing from backends to the parent.
- Rich rendering of `subagent_ping` messages.
- Async ping signaling for Claude headless children (deferred to phase-2.5 per `headless.ts:526-533`).
- New widget interaction features beyond what the existing widget offers — no per-row expansion, no overlay drilldown.

## Open Questions

- **Mounting site for the headless widget hook.** Should `runningSubagents.set(...)` + `startWidgetRefresh()` live inside `makeHeadlessBackend` (`backends/headless.ts`), in the orchestration adapter at `default-deps.ts`, in a shared helper invoked by both, or at each call site (matching the current bare-subagent pattern at `index.ts:1366-1376`)? Same question for cleanup-on-settle. Affects whether `RunningSubagent` becomes the canonical "what's running across both backends" registry.
- **Refresh cadence for headless rows.** The widget polls at 1Hz for elapsed-time updates; usage updates arrive via `onUpdate` whenever `message_end` fires. Is the 1Hz repaint sufficient, or should headless rows repaint immediately on every `onUpdate` (call `updateWidget()` from the row-update path)?
- **Transcript history bounds for very long-running headless subagents.** `transcript: TranscriptMessage[]` grows unbounded for the lifetime of a launch. The renderResult collapsed view shows last-N (10) tool calls so display is bounded; memory retention is a backend concern that surfaces during sustained use. Out of scope for this spec but worth flagging.
- **Truncation thresholds in `formatToolCall`.** pi-subagent caps preview to 60 chars for `bash` and 50 for default `JSON.stringify`. Adopt the existing constants verbatim, or recalibrate now that we render via pi-tui `Box` / `Text` instead of ANSI strings? Default: match exactly to minimize divergence from the parity reference.
- **Tests and snapshot pattern.** The brief notes there's no existing snapshot/golden-test pattern in `test/orchestration/`. The new `__test__.makeHeadlessBackendWithRunner` harness (`headless.ts:60-144`) is purpose-built for driving deterministic emit sequences and is the right seam for testing the renderResult sequence; a planner-level decision is whether to introduce a snapshot pattern for the rendered Box/Text component output or assert on structural shape.
