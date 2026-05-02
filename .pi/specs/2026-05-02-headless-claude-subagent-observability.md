# Headless Claude Subagent Observability

Source: TODO-099e7269

## Goal

Fix headless Claude CLI subagent observability so orchestration status and telemetry are coherent across the subagent widget and Pi tool-call/TUI rendering. During serial or parallel orchestration, each task should have a stable lifecycle, should remain visible while running, and should show the best telemetry actually emitted by the backend without fabricated metrics.

## Context

The project provides subagent orchestration through `subagent_run_serial` and `subagent_run_parallel`, with backend selection between pane and headless execution. The headless backend is implemented in `pi-extension/subagents/backends/headless.ts`, with Claude stream parsing in `pi-extension/subagents/backends/claude-stream.ts`. Orchestration lifecycle state is maintained by `pi-extension/orchestration/run-serial.ts`, `pi-extension/orchestration/run-parallel.ts`, `pi-extension/orchestration/registry.ts`, and the registered tool handlers in `pi-extension/orchestration/tool-handlers.ts`.

Widget state currently flows through `runningSubagents` in `pi-extension/subagents/index.ts`, with headless helpers such as `registerHeadlessSubagent`, `updateHeadlessSubagentUsage`, and `unregisterHeadlessSubagent`. Tool-call/TUI rendering uses orchestration partial updates and final results rendered by `pi-extension/subagents/ui/headless-render.ts` and `pi-extension/subagents/ui/subagent-result-renderer.ts`.

Reported failures are specific to headless Claude orchestration: Claude CLI subagents do not reliably update turns, token counts, or cost in the widget or Pi TUI; parallel orchestration rows can disappear from the widget and not return; and parallel task status lines can flip between `pending` and their actual state. Existing tests around headless update replay, widget lifecycle, orchestration rendering, and parallel state annotation provide nearby regression coverage.

## Requirements

- Headless Claude orchestration tasks must follow a stable user-visible lifecycle: `pending` only before launch, `running` once launched, and a terminal state (`completed`, `failed`, or `cancelled`) when finished.
- After a task reaches `running`, neither the widget nor live tool-call/TUI rendering may regress that task back to `pending`.
- Parallel orchestration must keep each launched headless Claude task represented until it reaches a terminal state; rows must not disappear and stay gone while the task is still running.
- The subagent widget must show a row for each active headless Claude task. Before telemetry is available, the row should show `running…`; once usage telemetry is available, the row should show usage stats instead of the placeholder status.
- Pi tool-call/TUI rendering for `subagent_run_serial` and `subagent_run_parallel` must use the same per-task lifecycle and telemetry snapshot as the widget, so both surfaces agree on each task’s state.
- Headless Claude stream events must update available live transcript/turn information where the CLI exposes it.
- Headless Claude token and cost metrics must update only when the Claude stream actually provides them, including at terminal result time if that is the first time they are available.
- The implementation must support both blocking `wait:true` orchestration and background `wait:false` orchestration.
- Final orchestration results and steer-back payloads must continue to include correct terminal state, final message, transcript path, session key, usage, and transcript data where available.
- Regression tests must cover headless Claude partial/update behavior, parallel lifecycle stability, widget visibility, and TUI/tool-call state consistency.

## Constraints

- Never fabricate, estimate, or interpolate telemetry. Missing metrics should remain absent until the backend provides real values.
- Preserve existing pane-backend behavior unless a change is required to keep the shared lifecycle contract consistent.
- Preserve existing public tool parameters and result shapes except for adding or stabilizing already-supported lifecycle/telemetry fields.
- Avoid duplicate widget rows or duplicate task rows when tasks transition between `pending`, `running`, blocked/resumed states, and terminal states.
- Keep cancellation and failure behavior explicit: cancelled or failed tasks should transition terminally rather than being hidden or reset to pending.

## Approach

**Chosen approach:** Use a unified orchestration lifecycle snapshot as the source of truth for both widget state and live tool-call/TUI updates. Each task’s state and real backend telemetry should feed one coherent per-task snapshot that all surfaces render.

**Why this over alternatives:** The reported symptoms cross multiple surfaces, but they describe one underlying consistency problem: task lifecycle and telemetry are not being propagated uniformly. A single lifecycle snapshot avoids patching the widget and TUI separately and prevents future drift.

**Considered and rejected:**

- Surface-specific patches — smaller local edits, but likely to fix one symptom while leaving another inconsistent or reintroducing drift.
- Backend-only telemetry enrichment — improves Claude metrics but does not address status flicker, disappearing rows, or mismatched lifecycle rendering.

## Acceptance Criteria

- In a headless Claude `subagent_run_parallel` run, each task is `pending` only before launch, changes to `running` once launched, and never flips back to `pending` before terminal completion.
- In the same parallel run, the widget keeps a visible row for every active headless Claude task until that task completes, fails, or is cancelled.
- A headless Claude task with no usage yet renders as `running…` in the widget; after real usage is received, the same row renders the received usage stats.
- Live tool-call/TUI rendering for blocking orchestration shows the same task states and available usage as the widget for headless Claude tasks.
- Background `wait:false` orchestration preserves stable widget state while running and emits final steer-back results with correct terminal states and telemetry.
- Token and cost fields are absent or zero until Claude emits real values; tests must fail if fabricated nonzero metrics are introduced.
- Existing pane orchestration, pi headless orchestration, cancellation, and final result rendering tests continue to pass.

## Non-Goals

- Adding continuous token or cost estimates when the Claude CLI does not provide them.
- Changing Claude CLI behavior or relying on undocumented telemetry not present in its stream output.
- Redesigning the subagent public API, adding new orchestration tools, or changing model/tool resolution behavior.
- Expanding Claude `caller_ping`/blocked semantics beyond the current documented v1 behavior.
