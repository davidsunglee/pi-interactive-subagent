# Symmetric pane subagent observability

Source: TODO-08e81407

## Goal

Bring pane-mode subagent observability up to parity with headless. Today the pane backend returns `transcript: undefined` / `usage: undefined` and never fires `onUpdate` mid-run; pane callers see only the post-mortem `summary` + `transcriptPath`. After this work, pane runs populate `BackendResult.transcript[]` + `BackendResult.usage` and fire live `onUpdate` partials at the same 1Hz cadence the existing widget already polls. The rich rendering surfaces wired up in TODO-4a7c2e91 (`subagent_result`, `orchestration_complete`, `subagent_run_serial` / `_parallel` `renderResult`, persistent widget) inherit pane support automatically because they switch on data presence rather than backend identity.

## Context

**Pane backend today.** `makePaneBackend` (`pi-extension/subagents/backends/pane.ts:24`) wraps `launchSubagent` + `watchSubagent` from `pi-extension/subagents/index.ts`. Live observability is limited to (a) screen-scrape via `readScreen` against the mux pane (consumed only for crash sentinel detection, not aggregation) and (b) 1Hz polling of the pi session jsonl size in `pollForExit.onTick` (`cmux.ts:670`) which updates `RunningSubagent.entries` / `bytes` for the widget. `watchSubagent` extracts `summary` post-mortem via `findLastAssistantMessage(getNewEntries(sessionFile, 0))` for pi (`index.ts:1163-1168`) and `extractLastAssistantMessage` for Claude (`index.ts:1115`). It does NOT populate `transcript[]` or `usage`, and does NOT fire any `onUpdate`.

**Pi on-disk session format is rich enough.** A pi session jsonl entry (verified against actual files under `~/.pi/agent/sessions/`) carries the full structure needed:

- assistant entries: `{type:"message", message:{role:"assistant", content:[{type:"thinking"|"toolCall"|"text", ...}], usage:{input, output, cacheRead, cacheWrite, totalTokens, cost:{...,total}}, stopReason, model, provider, ...}}`
- toolResult entries: `{type:"message", message:{role:"toolResult", toolCallId, toolName, content:[...], isError}}`

Field names already align with `UsageStats`. Content blocks already use `type:"toolCall"` (matching `TranscriptContent`, no rename needed). `projectPiMessageToTranscript` (`backends/headless.ts:290`) already projects this exact shape — reusing it for pane is structural, not behavioral.

**Claude on-disk session format.** Claude writes to `~/.claude/projects/<slug>/<session-id>.jsonl` while running. The path is currently undiscoverable until end-of-run because the bundled plugin ships only a `Stop` hook (`pi-extension/subagents/plugin/hooks/on-stop.sh`) that writes the `<sentinel>.transcript` pointer file. The headless backend's `parseClaudeStreamEvent` (`backends/claude-stream.ts:58`) and `parseClaudeResult` (`:118`) project Claude stream events into `TranscriptMessage[]` / `UsageStats` and apply equally to file-read content.

**onUpdate plumbing already in place.** `BackendResult` declares `transcript?` and `usage?` (`backends/types.ts:30-42`). `Backend.watch` accepts `onUpdate?: (partial: BackendResult) => void` (`:78-83`). Headless emits per-`message_end` for pi (`headless.ts:430`) and per-assistant-event for Claude (`headless.ts:618`). Pane currently passes `onUpdate` into `backend.watch` but never invokes it. Orchestration's adapter at `orchestration/default-deps.ts:55-71` and the bare-subagent watch site (`index.ts:1378`) already forward partials through to the rich rendering surfaces wired in TODO-4a7c2e91 — once pane fires `onUpdate`, those surfaces light up automatically.

**Persistent widget row format today.** `renderSubagentWidgetLines` (`index.ts:475-499`) branches on `agent.backend === "headless" && agent.usage` to render `formatUsageStats` for headless rows; pane rows use `<entries> msgs (<bytes>)` from session-file polling. The previous spec (`.pi/specs/2026-05-01-headless-subagent-live-transparency.md`, lines 67-71) explicitly deferred unified row shape to TODO-08e81407 and called the transition "a pure additive rendering-function change once pane data is available, no migration needed."

**Rich rendering inheritance.** `subagent-result-renderer.ts` and the `orchestration_complete` renderer switch on **presence** of `details.transcript` + `details.usage` — not on `backend` field. The sync-orchestration `renderResult` (registered on `subagent_run_serial` / `_parallel`) reads `details.results[].transcript`/`usage` similarly. Once pane populates those fields, all three rendering surfaces light up for pane runs without per-renderer changes.

**Resume path.** `subagent_resume.execute` (`index.ts:1925`) calls `watchSubagent` (or its override) on a re-launched pane. It captures `entryCountBefore = getNewEntries(params.sessionPath!, 0).length` (`:1807`) before the resume runs, then extracts the post-resume slice via `findLastAssistantMessage(getNewEntries(...entryCountBefore))` (`:1966`). The same baseline is the natural starting offset for tail-during-resume.

**README parity statement.** README documents `usage` / `transcript` as "headless only (v1)" and notes "enriching the pane path is tracked as follow-up work" (lines 91-94). This becomes stale after the work lands.

## Requirements

1. **Pi pane file-tail.** During a pane run for pi children, incrementally read new entries from the pi session jsonl (`running.sessionFile`), project them into `TranscriptMessage[]`, accumulate `UsageStats`, and fire an `onUpdate` partial. Defended against torn writes (carry an unterminated tail across ticks, do not throw on partial JSON).

2. **Claude pane file-tail.** During a pane run for Claude children, once the `<sentinel>.transcript` pointer names the active jsonl path, tail that file: project entries via `parseClaudeStreamEvent`, populate `usage` from `parseClaudeResult` when a `result` event lands, fire `onUpdate`. Pre-discovery (before the SessionStart hook writes the pointer) the tail is a no-op.

3. **New early hook in the bundled Claude plugin.** Add a `SessionStart` (or similarly early) hook that writes `${PI_CLAUDE_SENTINEL}.transcript` as soon as Claude has the path, mirroring the existing `on-stop.sh` logic. Existing Stop hook stays as-is (idempotent re-write).

4. **Post-mortem fallback for Claude.** When the early hook misses (Claude resume sessions where it does not fire; SIGKILL'd children; hook-disabled installs), the post-mortem path must still populate `transcript[]` and `usage` from the archived jsonl (the file `copyClaudeSession` archives — projected via the same `parseClaudeStreamEvent` / `parseClaudeResult` helpers).

5. **`watchSubagent` carries the new fields.** Extend `SubagentResult` (`index.ts:310-321`) with optional `transcript?` and `usage?`. Add `onUpdate?: (partial) => void` to `watchSubagent`'s `opts`. Both pi and Claude branches populate the new fields and call `onUpdate` from inside the existing `pollForExit.onTick` loop.

6. **`pane.ts:watch()` plumbs new fields.** `pane.ts:watch()` passes its `onUpdate` parameter into `watchSubagent`'s `opts`, and copies `transcript` / `usage` from `SubagentResult` → `BackendResult`, mirroring how it already copies `claudeSessionId` → `sessionId`.

7. **Abort + manual-exit return partials.** When a pane child is aborted or manually closed, `BackendResult.transcript` / `usage` carry whatever was accumulated up to that point. Symmetric with headless's `makeAbortedResult` (`backends/headless.ts:748`).

8. **Resume path streams too.** When `subagent_resume.execute` invokes `watchSubagent` on the resumed pane, the file-tail starts from `entryCountBefore` (already tracked at `index.ts:1807`) and streams partials for the resumed slice. The resumed-watch path returns the same `transcript`/`usage` shape on the resumed `SubagentResult`.

9. **Persistent widget row converges.** `renderSubagentWidgetLines` (`index.ts:475-499`) drops the backend branch and renders both pane and headless rows the same way: `formatUsageStats(agent.usage)` when `usage` is populated, fallback "running…" / "starting…" otherwise. The `<entries> msgs (<bytes>)` format is removed. Pane rows show "running…" during the brief startup window before the first jsonl entry, then telemetry; no swap mid-run.

10. **`RunningSubagent.usage` populated for pane.** The 1Hz tick that fires `onUpdate` also writes `running.usage` (existing field, currently headless-only) so the widget repaints with telemetry.

11. **Shared pi-message projector.** Lift `projectPiMessageToTranscript` out of `backends/headless.ts:290` into a shared module so pane (`watchSubagent`) and headless (`runPiHeadless`) consume the same projector. No behavior change for headless.

12. **README update.** Update the "headless only (v1)" stance for `usage` / `transcript` to "both backends" with documented caveats: ~1s latency floor for pane, unbounded `transcript[]` growth on long-running sessions, Claude-pane resume sessions fall back to post-mortem-only.

## Constraints

- Pane TTY ergonomics must not regress: no taps on the multiplexer pane's stdin/stdout. Observability is purely via on-disk artifacts that pi/Claude already write.
- No changes to backend runner logic. The headless runners' stream parsing stays untouched. The pi binary and Claude CLI invocation surfaces are unchanged.
- No changes to `subagent_run_cancel`.
- No changes to the `subagent_ping` rendering surface.
- No changes to LLM-facing final result content (`tool-handlers.ts:summarize` is untouched).
- No changes to the `BackendResult` / `Backend` interface shape. `transcript?` / `usage?` / `onUpdate?` are already declared. We populate, not extend.
- Memory growth from unbounded `transcript[]` on long-running sessions is v1-acceptable (consistent with headless; flagged out-of-scope by the prior spec).
- The bundled plugin gains exactly one new hook entry. No other plugin restructuring (MCP server, Stop hook, .mcp.json all unchanged).
- 1Hz cadence reuses `pollForExit.onTick`; no `fs.watch` / `fs.watchFile` / tighter polling in v1.

## Approach

**Chosen approach:** Embed the file-tail inside `watchSubagent`'s existing 1Hz `pollForExit.onTick` lifecycle. Add an `onUpdate` callback to `watchSubagent`'s opts; on each tick, read new jsonl lines (with a tail-buffer for torn writes), project them through the shared `projectPiMessageToTranscript` (lifted out of `headless.ts`), accumulate `UsageStats`, fire `onUpdate`, and copy the accumulated state to `running.usage` for the widget. Extend `SubagentResult` to carry `transcript?` / `usage?`. `pane.ts:watch()` plumbs its `onUpdate` parameter through and maps the new fields onto `BackendResult`. The Claude branch tails `~/.claude/projects/<slug>/<session-id>.jsonl` once a new SessionStart hook in the bundled plugin writes the `.transcript` pointer early; pre-discovery the tail is a no-op. The post-mortem path (re-reading the archived jsonl after `copyClaudeSession`) populates `transcript[]` / `usage` as a final emission before resolve, covering hook misses and Claude resume sessions.

**Why this over alternatives:**

- One heartbeat: the existing 1Hz `pollForExit.onTick` already reads the same files. Reusing it avoids a second timer and a second loop's worth of state.
- `watchSubagent` already owns abort plumbing, sentinel detection, the bounded `.transcript`-pointer wait, and post-mortem summary extraction. Embedding the tail keeps lifecycle + observability in one transaction; no cross-loop coordination at finalization.
- Final-emission ordering is automatic: the existing post-mortem read becomes a clean "last partial before resolve," with no race against an external tailer.
- Resume support is inherited for free. `subagent_resume.execute` already invokes `watchSubagent`; the embedded tail picks up the resumed slice using the existing `entryCountBefore` offset.
- Symmetric with how `headless.ts` runners own observability inside their primary lifecycle method.

**Considered and rejected:**

- *Parallel tailer at the `pane.ts:watch()` boundary.* Two 1Hz timers competing for the same file, race at finalization between "watchSubagent done" and "tailer's last read", separate resume integration required (the tailer would need its own wiring inside `subagent_resume.execute`), and `BackendResult` assembly split across two contributors. Cleaner module boundary on paper, more orchestration code overall.
- *Fully-isolated streaming module not consumed by either site.* Pure code-organization variant of the rejected parallel-tailer; no meaningful paradigm difference.
- *Sub-second cadence via `fs.watch` / `fs.watchFile`.* Adds platform debouncing complexity (especially macOS) for marginal UX gain in a monitoring use case. 1Hz matches headless's emission cadence and the widget repaint cadence.
- *Scan `~/.claude/projects/*` at runtime to discover the active Claude jsonl.* Race-prone if the user has another Claude window open in another working directory. The SessionStart hook is structurally clean and similarly cheap.
- *Defer Claude-pane parity entirely (pi-pane only in v1).* Cuts scope but leaves a permanent asymmetry in the README and the rich-rendering surfaces; the SessionStart hook is small enough that there's no good reason to defer.

## Acceptance Criteria

1. With `PI_SUBAGENT_MODE=pane` (or auto-pane on a multiplexer-equipped host), a `subagent` call against a pi child populates `BackendResult.transcript[]` and `BackendResult.usage` on the resolved result, and the registered `onUpdate` callback fires at least once during the run with a non-empty `transcript`/`usage` payload.

2. Same as #1 against a Claude pane child where the bundled plugin's new early hook fires: live `onUpdate` partials populate `transcript`/`usage` mid-run, and the resolved `BackendResult` matches.

3. With a Claude pane child whose early hook misses (hook disabled, resume session, hook timeout): `BackendResult.transcript` / `usage` are still populated post-mortem from the archived jsonl. Live `onUpdate` partials are not required for this path; the final result carries the full accumulated state.

4. A pane child that is aborted (cancellation) or manually closed by the user returns a `BackendResult` whose `transcript[]` / `usage` reflect whatever was accumulated up to abort. Symmetric with headless's existing `makeAbortedResult` behavior.

5. `subagent_run_serial` / `subagent_run_parallel` with `PI_SUBAGENT_MODE=pane`: `renderResult` for sync runs and `orchestration_complete` for async runs render the rich pi-subagent-style component (header + tool-call list + per-task usage + Ctrl+O collapse/expand) — same UX as headless. No backend-specific code is added to the renderers; inheritance happens via existing data-presence switching.

6. A bare `subagent` call against a pane child produces a `subagent_result` message that, when rendered, shows the rich pi-subagent-style block — same UX as the headless equivalent. Inheritance happens automatically; no new branch in the renderer.

7. The persistent "Subagents — N running" widget renders pane and headless rows with the same `formatUsageStats(usage)` right-side info. The `<entries> msgs (<bytes>)` format is removed; pane rows show "running…" during the brief startup window before the first jsonl entry, then telemetry. No mid-run format swap.

8. `subagent_resume` against a pane child: the resumed-watch path streams `onUpdate` partials starting at the `entryCountBefore` baseline, and the final `SubagentResult` carries the resumed slice's `transcript[]` / `usage`.

9. A pi child whose writes straddle a tick boundary (last line is partial) is observed correctly. The next tick reads the completed line; no `JSON.parse` exception escapes; the partial-line tail is preserved and consumed.

10. README's "headless only (v1)" claim for `usage` / `transcript` is updated to reflect both-backend coverage with the documented caveats: ~1s latency floor on pane, unbounded `transcript[]` growth, Claude-pane resume sessions fall back to post-mortem.

## Non-Goals

- Sub-second pane-side responsiveness (`fs.watch`/`fs.watchFile`/tighter polling). 1Hz is sufficient for monitoring.
- Truncation or memory-bounding of long-running `transcript[]` arrays. Same v1-acceptable limitation that headless already has; addressed (if at all) as a separate todo.
- Backend selection / mux-detection logic changes. `selectBackend` and `PI_SUBAGENT_MODE` semantics are untouched.
- New `subagent_ping` rendering enrichments.
- Extending the `BackendResult` / `Backend` interface shape. Existing optional fields are populated, not added.
- Headless backend behavior changes. The shared-module refactor (lifting `projectPiMessageToTranscript`) is structural only; runtime behavior of `runPiHeadless` and `runClaudeHeadless` is unchanged.
- Replacing `watchSubagent`'s existing screen-scrape / sentinel detection paths. They remain authoritative for completion signaling; the file-tail only contributes `transcript`/`usage`.
- Stderr/stdout printing from pane backends to the parent. Pane TTY isolation is preserved.
- Plugin restructuring beyond the new early hook. The MCP server, the Stop hook, and `.mcp.json` are unchanged.

## Open Questions

- **SessionStart vs. UserPromptSubmit hook event.** Both fire early in the run and both receive `transcript_path` in their input. Either gives us the pointer before the first assistant message lands. Planner-level decision: which event Claude Code's plugin runtime fires most reliably across CLI versions, and which is simplest to mirror against `on-stop.sh`'s logic.
- **Resume-session early-hook firing.** Claude Code's resume path (`--resume`) may or may not re-fire SessionStart. If it doesn't, Claude pane resume sessions fall through to post-mortem-only — already accepted in Requirement #4. Worth a one-line README mention.
- **Test seam for the embedded tail.** `__test__.setWatchSubagentOverride` lets tests substitute `watchSubagent` wholesale; finer-grained tests of the tail-projection step would benefit from extracting the per-tick "read new entries → project → emit partial" step into a unit-testable function. Planner-level decision.
- **Pane row "running…" gap during the first poll interval.** Pane rows show "running…" until the first tick reads a jsonl entry (~1s for pi, indeterminate for Claude pre-pointer). Acceptable per the design choice; revisit if jarring in practice.
