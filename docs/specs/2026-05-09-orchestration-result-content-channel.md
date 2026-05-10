# Orchestration result content channel carries full per-task finalMessage

Source: TODO-314cc60e

## Goal

Make `subagent_run_serial` and `subagent_run_parallel` deliver each child task's full structured `finalMessage` through the parent agent's LLM-visible content channel, for both blocking (`wait: true`) and async (`wait: false`) paths and for both pi-CLI and Claude-CLI children. Today the orchestration tools preserve the full report only in the side-channel `details.results[i].finalMessage`, while the LLM-visible `content` text uses `firstLine(finalMessage)` (sync) or a one-line orchestration summary (async). Downstream parser-driven workflows that depend on the full structured report cannot reach `details` reliably from a tool-result/steer payload, breaking strict-parser flows. Closing this gap aligns the orchestration tools with the bare `subagent` tool, which already inlines the full `finalMessage` in its steer-back content.

## Context

**Sync path — `subagent_run_serial` / `subagent_run_parallel` with `wait: true`:**

- `pi-extension/orchestration/tool-handlers.ts:247-258` and `:389-400` build the tool result as `{ content: [{ type: "text", text: summarize(...) }], details: { ...out, results: toPublicResults(out.results) } }`.
- `summarize()` (`tool-handlers.ts:460-466`) builds one line per task using `firstLine(r.finalMessage)` (`tool-handlers.ts:468-471`), capping at 200 chars and dropping multi-line structured reports.
- `details.results[i].finalMessage` carries the full content but is not part of the LLM-visible MCP `content` payload.

**Async path — `subagent_run_serial` / `subagent_run_parallel` with `wait: false`:**

- The tool returns immediately with a dispatch envelope (`tool-handlers.ts:220-238`, `:358-376`).
- The registry's `tryFinalize()` (`pi-extension/orchestration/registry.ts:156-168`) emits an `ORCHESTRATION_COMPLETE` payload carrying the full per-task results.
- The extension-side emitter (`pi-extension/subagents/index.ts:1787-1796`) sends a steer message whose `content` is one line: `Orchestration "X" completed (N task(s), isError=Y).`. The full per-task `finalMessage` rides along in `details.payload.results[]` only.

**Reference shape — the bare `subagent` tool already delivers the full `finalMessage` to the parent's LLM-visible channel:**

- Pane mode steer-back (`subagents/index.ts:2082-2086`) builds `content` as `Sub-agent "X" {completed|failed} (...).\n\n${result.summary}${sessionRef}` — `result.summary` is the bare-tool field equivalent to orchestration's `finalMessage`.
- Headless mode steer-back (`subagents/index.ts:1958-1971`) builds the same shape with `${result.finalMessage}` and a fallback to `result.error`.

**Existing surfaces that must remain unchanged:**

- The structured `details` payload — already complete; used by UI renderers (`pi-extension/subagents/ui/headless-render.ts`, `pi-extension/subagents/ui/subagent-result-renderer.ts`) and the `details`-driven sync `renderResult` paths (`tool-handlers.ts:131-141`, `:287-296`).
- The bare `subagent` tool's content composition.
- The `subagent_ping` and `BLOCKED_KIND` (`subagent_run_blocked`) steer-back content — both already inline their full payloads (`subagents/index.ts:2059-2076`, `:1816-1823`).
- The intermediate `onUpdate` partial-result channel used for UI streaming.

## Requirements

- The sync `summarize()` output that becomes the LLM-visible `content[].text` for `subagent_run_serial` (`wait: true`) and `subagent_run_parallel` (`wait: true`) MUST include each task's full `finalMessage` verbatim. The truncating `firstLine()` helper is no longer used to compose this content.
- The async `orchestration_complete` steer-back's `content` field for `wait: false` orchestrations MUST also include each task's full `finalMessage` verbatim, in addition to the existing one-line orchestration header.
- The aggregate one-line header (mode, task count, `isError`) is preserved in both sync and async content so the LLM still has a fast top-level summary at the head of the payload.
- Per-task entries are emitted in input-task order (matching the order preserved by `toPublicResults()` and the orchestration runners).
- The same content shape applies regardless of the child's CLI (`pi` or `claude`) — the change lives downstream of the pane and headless backends, which already populate `finalMessage` uniformly.
- `details.results[i].finalMessage` continues to carry the full content unchanged — the new behavior is additive on the LLM-visible channel, not a substitution.
- Tests added at this repo's existing test boundaries assert that, for both sync and async paths, the LLM-visible `content[].text` (or steer-back `content` string) contains each child task's full structured `finalMessage`. At least one test case uses a multi-line structured `finalMessage` (e.g., a `STATUS:` header followed by `## Completed` / `## Tests` sections, mirroring the coder-report shape from the failing run) so that a regression to `firstLine()`-style truncation would fail the suite.

## Constraints

- Do NOT modify the orchestration `details` payload shape (`tool-handlers.ts:254-258`, `:396-400`; `registry.ts:160-168`). UI renderers and tests depend on it.
- Do NOT modify the bare `subagent` tool's content composition (`subagents/index.ts:1958-1971`, `:2082-2086`). It is already correct.
- Do NOT touch UI renderers (`subagent-result-renderer.ts`, `headless-render.ts`, sync `tool.renderResult` callbacks at `tool-handlers.ts:131-141`, `:287-296`). The contract is content-channel only.
- Do NOT modify the `BLOCKED_KIND` steer-back content (`subagents/index.ts:1816-1823`) or the `subagent_ping` content (`subagents/index.ts:2059-2076`); both already inline their full payloads.
- Do NOT introduce per-task report files on disk, new artifact markers (`ORCHESTRATION_RESULT:` or otherwise), or any cross-repo coupling. The fix is a pure content-string change in two call sites.
- Do NOT change `OrchestrationResult` / `OrchestratedTaskResult` / `OrchestrationCompleteEvent` types, registry emission types, or the `_onUpdate` partial-result shape.
- Do NOT alter cross-CLI plumbing (pi vs claude backend `finalMessage` population).
- Stay entirely within the `pi-interactive-subagent` repo. No changes to `pi-config`'s skills, parser scripts, or contract documentation — those move with the todo when it transfers downstream.

## Approach

**Chosen approach:** Push — inline each task's full `finalMessage` directly into the LLM-visible content channel for both the sync `summarize()` output and the async `orchestration_complete` steer-back content. The aggregate one-line header is retained as a head-of-payload summary; per-task sections follow in input-task order, each carrying that task's full `finalMessage` body.

**Why this over alternatives:**

- Mirrors the bare `subagent` tool's already-working steer-back shape (`subagents/index.ts:2085`, `:1971`) — no new contract to invent.
- Stays entirely within `pi-interactive-subagent`, matching the explicit scope constraint.
- Implementation is concentrated in two existing call sites (`tool-handlers.ts:summarize`, `subagents/index.ts:registryEmitter`); the per-wave content payload grows by a few KB at most given `MAX_PARALLEL_HARD_CAP = 8` and bounded structured-report length — well within typical context budgets.

**Considered and rejected:**

- **Pull — write per-task report files and emit `ORCHESTRATION_RESULT: <path>` markers in content.** Cleaner long-term shape, mirrors `test-runner`'s artifact-handoff pattern, and avoids per-wave context bloat. Rejected because the marker enum (`parse-artifact-handoff.py:25`) and the parent-side parser convention live in `pi-config`, so the contract would necessarily span repos — violating the explicit "pi-interactive-subagent only" scope.
- **Hybrid — short inline header + path-to-full-file.** Carries the cross-repo coupling cost of the pull approach with extra inline content. Same scope conflict; no upside over plain push given push's simplicity advantage.

## Acceptance Criteria

- `subagent_run_serial` with `wait: true` and `subagent_run_parallel` with `wait: true` return a tool result whose `content[0].text` contains each task's full `finalMessage` body, verbatim. A multi-line structured report (e.g., `STATUS: DONE\n\n## Completed\n...\n\n## Tests\n...`) survives end-to-end without truncation.
- `subagent_run_serial` with `wait: false` and `subagent_run_parallel` with `wait: false` produce an `orchestration_complete` steer-back whose `content` string contains each task's full `finalMessage` body, verbatim.
- The aggregate one-line header (mode, count, `isError`) remains present in both sync and async content as the head-of-payload summary.
- For both sync and async, per-task entries appear in input-task order.
- The behavior holds identically when child tasks were launched against pi-CLI and against claude-CLI (no per-CLI special-casing is required because the change is downstream of where the backends populate `finalMessage`).
- `details.results[i].finalMessage` continues to carry full per-task content unchanged.
- The bare `subagent` tool's pane and headless steer-back content, the `subagent_ping` content, and the `BLOCKED_KIND` content are byte-identical to today.
- Sync `renderResult` UI output (the rich/headless and legacy branches under `subagent-result-renderer.ts` and `headless-render.ts`) is unchanged.
- Tests:
  - At least one test asserts the new sync `summarize()` content shape directly with a fixture whose `finalMessage` includes a multi-line structured report.
  - At least one test asserts the new async `orchestration_complete` steer-back `content` shape with the same multi-line fixture.
  - Existing orchestration test suites continue to pass; no regression in `details` shape, registry payloads, or UI rendering tests.

## Non-Goals

- No changes to `pi-config`'s skills (`execute-plan`, parser scripts, `_shared/` contract documentation). The downstream contract documentation, `parse-coder-report.py` / `parse-verifier-report.py` integration, and SKILL.md updates are addressed when this todo transfers to that repo.
- No new on-disk artifact files, no new artifact markers, no changes to `parse-artifact-handoff.py`.
- No changes to `OrchestrationResult` / `OrchestratedTaskResult` / `OrchestrationCompleteEvent` data types, registry payload shape, or the `_onUpdate` partial-result channel.
- No changes to UI renderers (`renderRichSubagentResult`, `subagent-result-renderer`, sync `tool.renderResult` callbacks).
- No changes to the bare `subagent` tool content composition, `subagent_ping`, or `BLOCKED_KIND` steer-back content.
- No unification refactor that factors a shared content composer between the bare `subagent` tool and the orchestration tools. A future cleanup may consolidate them; this spec only makes orchestration include the full `finalMessage`.
- No removal of the `firstLine()` helper unless it becomes wholly unused after the change; the spec does not mandate its deletion.
