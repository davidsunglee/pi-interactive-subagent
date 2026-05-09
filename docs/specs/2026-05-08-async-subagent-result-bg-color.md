# Async subagent result rendering uses correct background color

Source: TODO-3a536508

## Goal

The two steer-back **message** renderers that surface async subagent completions in the main pi agent's TUI — `subagent_result` (rich/headless branch) and `orchestration_complete` — currently render their content with no background color, falling through to the terminal's default (plain black). Wrap each renderer's rich output in a `Box(... bgFn)` with `bgFn` keyed off the completion outcome so async completion blocks render against `toolSuccessBg`/`toolErrorBg`, matching the colored-background convention already used by the single-subagent legacy renderer (`subagent-result-renderer.ts:86-89`), the `subagent_ping` renderer (`subagents/index.ts:2677`), the `subagent_done` widget (`subagent-done.ts:55`), and documented in README:172 ("Completion messages render with a colored background").

## Context

Three custom message types have renderers under `pi-extension/subagents/`:

- `subagent_result` (`subagents/index.ts:2663`) — delegates to `createSubagentResultRenderer` in `subagent-result-renderer.ts`. Has two branches:
  - **Legacy / pane-shape** (`subagent-result-renderer.ts:86-89`): wraps output in `Box(1, 1, bgFn)` with `bgFn = exitCode === 0 ? bg("toolSuccessBg", ...) : bg("toolErrorBg", ...)`. Renders correctly today.
  - **Rich / headless** (`subagent-result-renderer.ts:61-83`, taken when `details.transcript && details.usage` are present): returns the bare `renderRichSubagentResult` `Container` with no `Box` wrap → black bg in TUI. This is the path exercised by the bare async (single, headless) subagent completion shown in the user's screenshot.
- `subagent_ping` (`subagents/index.ts:2668`) — already wraps in `Box(1, 1, theme.bg("toolSuccessBg", ...))`. Out of scope.
- `orchestration_complete` (`subagents/index.ts:2705-2723`) — emitted by the registry when an async (`wait: false`) `subagent_run_serial` / `subagent_run_parallel` reaches terminal aggregation. Calls `renderRichSubagentResult(...)` and prepends a blank-line spacer; no `Box` wrap → black bg.

The pi framework auto-wraps **tool-result** renders (`tool.renderResult`) in a styled container — confirmed by inspection: the bare `subagent` tool's "started" `renderResult` returns a plain `Text` (`subagents/index.ts:2169-2189`) yet appears on a colored bg in the screenshot. As a consequence, the sync (`wait: true`) orchestration `renderResult` paths in `tool-handlers.ts:131-141` and `tool-handlers.ts:287-296` (which also call `renderRichSubagentResult`) already render with a bg via the framework auto-wrap and are NOT in scope.

The structured `transcript` and `usage` data already reaches both affected renderers — `transcript` is plumbed end-to-end through the pane and headless backends (`pane.ts:148`, `headless.ts:512-513`), through `runParallel` / `runSerial`'s `onTerminal` callback (`run-parallel.ts:192-194`), through the registry's `onTaskTerminal` (`registry.ts:239-259`), and into the emitted `orchestration_complete` payload before the post-finalize stripping pass runs against `entry.tasks` (`registry.ts:185-190` strips after the `safeEmit` snapshot at `registry.ts:162-168`). The "transcript body" the todo refers to is the rendered completion block these renderers produce, not the LLM-visible `content` string. No payload composition changes are required.

## Requirements

- The `subagent_result` rich branch (`subagent-result-renderer.ts:61-83`) wraps its `renderRichSubagentResult` output in a `Box` whose `bgFn` is `theme.bg("toolSuccessBg", ...)` when `details.exitCode === 0` and `theme.bg("toolErrorBg", ...)` otherwise — matching the legacy branch's selection rule at `subagent-result-renderer.ts:86-89`.
- The `orchestration_complete` renderer (`subagents/index.ts:2705-2723`) wraps its `renderRichSubagentResult` output in a single aggregate `Box` whose `bgFn` is `theme.bg("toolSuccessBg", ...)` when `details.isError` is falsy and `theme.bg("toolErrorBg", ...)` otherwise.
- The aggregate-Box approach is used for multi-task orchestration output (no per-task inner Boxes); per-task success/failure remains conveyed by the existing in-row foreground `stateIcon` characters (`headless-render.ts:40-56`).
- The leading blank-line spacer that both renderers currently emit (`["", ...component.render(width)]`) is preserved so the colored block does not abut the prior message.
- Box padding follows the existing single-subagent legacy convention so the new wrapped blocks visually match the existing colored completion blocks. The exact padding values are an implementation detail — the planner picks values consistent with the legacy renderer rather than introducing a new visual style.

## Constraints

- Do **not** touch the legacy / non-rich `subagent_result` branch (`subagent-result-renderer.ts:86-129`) — it is already wrapped and rendering correctly.
- Do **not** touch the sync orchestration `renderResult` paths in `pi-extension/orchestration/tool-handlers.ts` (`renderResult` at line 131 for serial, line 287 for parallel). They are framework-auto-wrapped tool-result renders and would double-wrap if a `Box` were added inside.
- Do **not** touch the `subagent_ping` renderer (`subagents/index.ts:2668`) or any `BLOCKED_KIND` rendering; both are out of scope.
- Do **not** modify the `content` string, `details` payload, registry emission, or any backend / orchestration / steer-back composition. The fix is renderer-only.
- Do **not** modify `renderRichSubagentResult` itself (`headless-render.ts:143`) — it is shared with the sync orchestration `renderResult` callers and must keep returning a bare `Container`. The bg wrap belongs at the message-renderer call sites, not inside the shared rich-render helper.
- Theme keys used must remain `toolSuccessBg` and `toolErrorBg`; do not introduce new theme keys.

## Acceptance Criteria

- The completion block shown in the user's screenshot (`subagent_result` rich branch, single async/headless subagent) renders against `toolSuccessBg` when the subagent exited 0, against `toolErrorBg` otherwise — visually consistent with the legacy box-style completion block already shown for pane-mode results.
- An async (`wait: false`) `subagent_run_serial` / `subagent_run_parallel` orchestration completion (the `orchestration_complete` steer-back) renders inside one outer colored block — `toolSuccessBg` when `details.isError` is falsy, `toolErrorBg` otherwise.
- The collapsed view continues to display the existing rich content (header, last few tool-call lines, usage line, "ctrl+o to expand"); the expanded view continues to display the existing rich content (header, all tool calls + text items, usage line, task + finalMessage). Only the surrounding background changes.
- Sync (`wait: true`) `subagent_run_serial` / `subagent_run_parallel` results render unchanged: their `tool.renderResult` still returns the bare `renderRichSubagentResult` `Container` and continues to inherit the framework's tool-result auto-bg.
- Existing single-subagent legacy `subagent_result` rendering (no `transcript` / `usage` in details), `subagent_ping`, and the `subagent` tool's `renderCall` / `renderResult` produce identical output to today.
- Tests cover: (a) the `subagent_result` rich branch wraps in a `Box` with the expected `bgFn` for both `exitCode === 0` and `exitCode !== 0`; (b) the `orchestration_complete` renderer wraps in a `Box` with the expected `bgFn` for both `isError === false` and `isError === true`; (c) sync `subagent_run_*` `renderResult` continues to return an unwrapped `Container` (regression guard against double-wrapping). The existing `test/orchestration/orchestration-complete-renderer.test.ts` and any equivalent `subagent_result` rich-branch test are extended or paired with new cases rather than replaced.
- Existing test suites (`npm test`, the orchestration / integration suites) pass without regressions.

## Non-Goals

- No changes to the LLM-visible `content` string of any steer-back message. The `orchestration_complete` content remains the existing one-line summary; per-task `finalMessage` text is not woven into the steer-back content.
- No changes to the registry, backends, orchestration cores, `default-deps.ts`, or any data-flow code path.
- No changes to the shared `renderRichSubagentResult` helper signature or output structure.
- No new theme keys; no padding / typography overhaul beyond matching the existing legacy box style.
- No work on `subagent_ping`, `BLOCKED_KIND`, the legacy non-rich `subagent_result` branch, or sync orchestration `renderResult` (already correct).
- No fix for any "transcript body not delivered to the LLM" concern — the user confirmed the rendered block is what was meant by "transcript body" and the structured transcript already arrives in `details`.
- No padding / spacing redesign of the rich layout itself.
