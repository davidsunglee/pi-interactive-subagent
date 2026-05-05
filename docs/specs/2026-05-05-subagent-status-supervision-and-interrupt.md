# Subagent activity supervision, interactive suppression, and turn-only interrupt

Source: TODO-8c06b75d

## Goal

Port upstream's child-written activity model + parent-side status supervision + turn-only Escape interrupt (upstream commits `9f10962`, `269b485`, `b4b0287`) into this fork, adapted around the local headless backend, Claude pane/headless paths, orchestration registry + blocked virtual rows, and the live transcript/usage tracking the local widget already exposes. Pi-backed children gain real `starting`/`active`/`waiting`/`stalled`/`recovered` states; the parent emits stall/recovery steer messages only for non-`interactive` subagents; and `subagent_interrupt` cancels the active turn of a pane-Pi child without tearing it down. The local fork's auto-exit lifecycle, `caller_ping`, completion semantics, orchestration cancel + blocked-row machinery, transcript/usage observability, and Claude paths must remain intact.

## Context

The upstream feature is contained in three files in `.pi/git/github.com/HazAT/pi-interactive-subagents/pi-extension/subagents/`:

- `activity.ts` — types + a child-side `SubagentActivityRecorder` that mirrors lifecycle events into a JSONL snapshot file at `<artifactDir>/subagent-activity/<runningChildId>.json`. ~17 events drive a four-phase state machine (`starting`/`active`/`waiting`/`done`) with sub-scope tracking (`agent`/`turn`/`provider`/`streaming`/`tool`).
- `status.ts` — parent-side `SubagentStatusState`, `observeStatus`, `classifyStatus`, `advanceStatusState`, `forceStatusAfterInterrupt`, `formatStatusLine`/`formatTransitionLine`, `formatStatusAggregate`, plus `loadStatusConfig` reading `<package>/config.json` (or `config.json.example` fallback).
- `index.ts` (upstream) — `observeRunningSubagent`, `startStatusRefresh` 1-second loop, `subagent_interrupt` tool wired to `sendEscape` from `cmux.ts`, `formatWidgetRightLabel`, the `interactive` resolution chain (`param > frontmatter > !autoExit`), and the `agentDefs.interactive` frontmatter parsing.

The local fork already has overlapping infrastructure that has to coexist:

- `pi-extension/subagents/index.ts` — pane launch + watch + widget. The widget right slot today renders `blocked > usage > running…/starting…`; the supervision loop and any rich status are absent. `RunningSubagent` carries `usage` and `blocked` (orchestration virtual rows) but not `statusState`/`activity`/`activityFile`/`interactive`.
- `pi-extension/subagents/launch-spec.ts` — `SubagentParams` already declares `interactive` as an optional boolean documented as **"Vestigial compat field … no runtime effect in v1"**; `AgentDefaults` does not parse `interactive:` from frontmatter; `resolveLaunchSpec` does not surface `interactive` on the `ResolvedLaunchSpec`. The local resume helper `resolveResumeLaunchBehavior` already returns `interactive: !autoExit` but is not consumed.
- `pi-extension/subagents/cmux.ts` — exports `pollForExit`, `createSurface`, `closeSurface`, `sendLongCommand`, `sendCommand`, `readScreen`, `shellEscape`, `getMuxBackend`. **Does not export `sendEscape`.** Upstream `cmux.ts` contains a portable `sendEscape(surface)` that handles cmux/tmux/wezterm/zellij branches.
- `pi-extension/subagents/subagent-done.ts` — child-side extension loaded into both pane-pi and headless-pi children. Wires `agent_start`/`agent_end`/`input` for auto-exit only; does not currently bind a `SubagentActivityRecorder` or read `PI_SUBAGENT_ID`/`PI_SUBAGENT_ACTIVITY_FILE`.
- `pi-extension/subagents/backends/headless.ts` — headless launches set `PI_SUBAGENT_NAME`/`PI_SUBAGENT_SESSION`/`PI_SUBAGENT_AGENT`/`PI_SUBAGENT_AUTO_EXIT`/`PI_DENY_TOOLS` plus `configRootEnv`, but not `PI_SUBAGENT_ID`/`PI_SUBAGENT_ACTIVITY_FILE`/`PI_SUBAGENT_SURFACE`. The pane launch site sets the activity-file env (in upstream parity) only conditionally because the local fork hasn't ported activity yet.
- `pi-extension/orchestration/types.ts` — `OrchestrationTaskSchema.interactive` carries the same vestigial wording.
- `test/orchestration/interactive-compat.test.ts` — explicitly asserts `interactive` validates and is **ignored**: "resolveLaunchSpec must not surface `interactive` on the resolved spec". Half of its assertions will need to flip when the field gains real meaning.
- `pi-extension/orchestration/registry.ts` (referenced via index.ts) — orchestration-owned slots are tracked via `lookupOwner(sessionKey)`. `BLOCKED_KIND` virtual rows install synthetic `RunningSubagent` entries with `blocked: { … }` and no real surface — the supervision loop must never read an activity file for these.

The upstream `config.json.example` ships a single boolean `{ "status": { "enabled": true } }`; `parseStatusConfig` actively rejects any other key under `status`. `lineLimit` is hardcoded at 4 (`DEFAULT_STATUS_LINE_LIMIT`).

## Requirements

### Activity recording (child side)

- A `SubagentActivityRecorder` (ported from upstream `activity.ts`) writes a JSONL snapshot at `<artifactDir>/subagent-activity/<runningChildId>.json` whenever the child fires a lifecycle event. Snapshot validation rules (sequence monotonicity, known phases/scopes/events, finite numbers, optional-string sanitization) match upstream verbatim.
- The recorder is bound inside `subagent-done.ts` and reads `PI_SUBAGENT_ID` + `PI_SUBAGENT_ACTIVITY_FILE` from env. When either is missing it must degrade to a no-op recorder so the existing test fixtures and ad-hoc invocations of pi-without-supervision keep working.
- The recorder consumes the upstream event surface: `session_start`, `input`, `before_agent_start`, `agent_start`, `agent_end` (waiting/done variants), `turn_start`, `turn_end`, `before_provider_request`, `after_provider_response`, `message_update`, `tool_execution_start`, `tool_call`, `tool_execution_update`, `tool_result`, `tool_execution_end`, `caller_ping`, `subagent_done`, `session_shutdown`. `caller_ping` and `subagent_done` mark the child as `done` and disable further writes.
- Activity recording is enabled for both pane-pi **and** headless-pi children. Pane-pi already sets `PI_SUBAGENT_ID`/`PI_SUBAGENT_ACTIVITY_FILE` in upstream; the headless-pi launch site (`backends/headless.ts`) must add the same two env vars, pointing at a path computed from the same `getArtifactDir(...)` + `getSubagentActivityFile(...)` helpers used by pane.
- Claude-backed children (pane and headless) do not write activity files. The recorder is not loaded into Claude children.

### Status supervision (parent side)

- Port `status.ts` verbatim: `SubagentStatusState`, `createStatusState`, `observeStatus`, `forceStatusAfterInterrupt`, `classifyStatus`, `advanceStatusState`, `formatStatusLine`, `formatTransitionLine`, `capStatusLines`, `formatStatusAggregate`, `loadStatusConfig`, `parseStatusConfig`. Include `config.json.example` at the package root with `{ "status": { "enabled": true } }`. `loadStatusConfig` falls back to the example when no `config.json` is present (matches upstream contract).
- `RunningSubagent` gains `statusState: SubagentStatusState`, `activity?: SubagentActivityState`, `activityFile?: string`, and `interactive: boolean`. `statusState.source` is `"pi"` for pi-backed children (pane and headless) and `"claude"` for Claude-backed children. Synthetic blocked virtual rows do **not** require a `statusState` (they continue to render the `blocked — awaiting parent` label and never participate in status supervision).
- A 1-second `startStatusRefresh` interval runs alongside the existing `widgetInterval` whenever there is at least one tracked subagent and `statusConfig.enabled === true`. Each tick: read each running child's activity file, call `observeStatus` to fold in the snapshot, advance state, refresh the widget on kind change, and emit a `subagent_status` steer message containing only `stalled`/`recovered` transition lines for **non-`interactive`** children. The steer is delivered via `pi.sendMessage({ customType: "subagent_status", ... }, { triggerTurn: true, deliverAs: "steer" })`. Capped at `lineLimit` (hardcoded 4) plus an overflow count.
- Status supervision skips synthetic blocked virtual rows entirely (no activity file read, no `statusState` access, no transition emission).
- Claude-backed children's status state is observed but never reads an activity file — `classifyStatus` returns `kind: "running"` for `source === "claude"`, and the widget right-label degrades accordingly. This matches upstream behavior and avoids requiring a transcript-based synthesis layer.

### Widget integration

- Per-row right-label precedence becomes `blocked > status > "running…" / "starting…" fallback`. Live `usage` no longer renders in the right-label slot for pi-backed children when status supervision is enabled — usage continues to flow through `subagent_result` rendering, transcripts, and the orchestration result-aggregation paths.
- Widget refresh and status refresh remain independent intervals (mirrors upstream); both clean up on `session_shutdown` and `/reload` via the existing `globalThis` keyed symbols.
- The widget renderer does not crash when a synthetic blocked virtual row lacks `statusState` — branch on `agent.blocked` first.

### `interactive` resolution and frontmatter parsing

- `interactive` is resolved as `params.interactive ?? agentDefs?.interactive ?? !(agentDefs?.autoExit ?? false)`. All four `(autoExit, interactive)` combinations are reachable via explicit override; the resolution function does not coerce or normalize.
- `AgentDefaults` (in `launch-spec.ts`) gains an `interactive?: boolean` field parsed from frontmatter via the existing `parseOptionalBoolean(getFrontmatterValue(..., "interactive"))` helper. Both `parseAgentDefinition` (in `index.ts`) and `parseAgentDefaultsFromContent` (in `launch-spec.ts`) must read the field consistently.
- `interactive` only suppresses parent-side `subagent_status` steer messages on `stalled`/`recovered` transitions. It must not affect: pane focus, auto-exit lifecycle, completion (`subagent_result`/`subagent_done`), failure paths, `caller_ping`, orchestration registry transitions, blocked rows, or `subagent_run_cancel`.
- The `SubagentParams.interactive` and `OrchestrationTaskSchema.interactive` field descriptions are rewritten to describe the actual semantics (replacing the "Vestigial compat field" wording).

### `subagent_interrupt` tool

- Register a new `subagent_interrupt` tool on the parent extension. Parameters: `id?: string`, `name?: string`. Resolves the target by exact id first, then exact name; reports ambiguity errors when multiple children share a name.
- Allowed against any pane-pi child (`backend === "pane"` and `cli === "pi"` — not `cli === "claude"`). Allowed against orchestration-owned slots: returns the same local ack and does **not** emit a registry transition, completion, or blocked event. The orchestration registry remains unaware of the interrupt.
- Returns a structured error for non-pane-pi targets ("Turn-only Escape interrupt is currently supported only for pane-Pi subagents."). Returns a structured error for failed Escape delivery, leaving `RunningSubagent.statusState` unchanged so the supervision loop continues observing reality.
- On success: refreshes the activity snapshot via `observeRunningSubagent(running, now)` so `forceStatusAfterInterrupt` has a fresh `lastActivitySequence` to override against, then flips `statusState` to `waiting` with `activityLabel: "interrupted"` and triggers a widget refresh. Returns a non-error result with `details: { id, name, status: "interrupt_requested" }`. The pane, session file, watcher, and `RunningSubagent` entry stay alive.
- `subagent_interrupt` is included in `SPAWNING_TOOLS` (denied when `spawning: false`), matching upstream.

### `cmux.ts` extension

- Add `sendEscape(surface: string)` to `pi-extension/subagents/cmux.ts` covering all four mux backends (cmux, tmux, wezterm, zellij), ported from upstream. cmux uses ``, tmux uses the `Escape` keysym, wezterm uses ``, zellij uses `write 27`.

### Headless backend env-var wiring

- `backends/headless.ts` adds `PI_SUBAGENT_ID` and `PI_SUBAGENT_ACTIVITY_FILE` to `childEnv`, computed from `getArtifactDir(...)` + `getSubagentActivityFile(...)` against a parent-side id (the same id used to register the `RunningSubagent` entry). The parent records `running.activityFile` so the supervision loop reads from the same path.
- Headless still does not set `PI_SUBAGENT_SURFACE` (no surface — Escape is unsupported here).
- Headless backend behavior, result shape, and `BackendResult` contract are otherwise unchanged.

### Test surface

- `test/orchestration/interactive-compat.test.ts` is rewritten: schema validation assertions stay; the assertion that `resolveLaunchSpec` ignores `interactive` flips into the inverse — the resolved spec or downstream `RunningSubagent` reflects an `interactive` boolean derived per the resolution chain.
- New unit tests cover: `activity.ts` recorder events, validation, and JSONL roundtrip; `status.ts` `observeStatus`/`classifyStatus`/`advanceStatusState` transitions including `forceStatusAfterInterrupt` and stale-snapshot behavior; `formatStatusLine`/`formatTransitionLine`/`capStatusLines`/`formatStatusAggregate` formatting; `parseStatusConfig` validation; `subagent_interrupt` resolve-by-id/name with ambiguity, deny-Claude branch, deny-headless branch, Escape-failure branch, success branch with activity-snapshot refresh; `resolveEffectiveInteractive` for all four combinations including explicit overrides; widget right-label precedence (`blocked > status > fallback`).
- Integration coverage: a real pane-pi child writes an activity file consumed by the parent supervision loop through to a `stalled` transition; a real headless-pi child writes an activity file the parent supervision loop reads; orchestration-owned children continue to surface `blocked` rows and complete normally even when supervision is enabled.

## Constraints

- The upstream files (`activity.ts`, `status.ts`, plus the `sendEscape` helper) are ported with as little local divergence as possible. Local divergence is acceptable only for: (i) headless-pi activity wiring (no upstream reference), (ii) widget right-label precedence ordering with `blocked` (no upstream reference), (iii) the `cli === "claude"` and `backend === "headless"` branches inside `subagent_interrupt`'s target validator.
- Headless backend `BackendResult` shape, `subagent_result` shape, and orchestration registry transition vocabulary are unchanged.
- `transcript`/`usage` observability is preserved end-to-end: `RunningSubagent.usage` is still updated by `drainPiTail` and the headless onUpdate path; `subagent_result` payloads still carry `transcript` and `usage`. Only the **live widget right-label slot** trades the usage view for status; every other surface where usage was rendered is unchanged.
- Claude pane and Claude headless paths must not gain activity recording or interrupt support.
- `subagent_run_cancel`, blocked virtual rows, ping → re-block routing, and the registry's resume controller bookkeeping behave identically before and after the port.
- The status supervision loop is gated by `statusConfig.enabled` only; orchestration semantics never depend on it. Disabling supervision via `config.json` must not break orchestration completion.
- The `subagent_status` steer message uses `triggerTurn: true` (upstream parity) — the parent agent will be woken by these transitions. The `interactive` flag is the only suppression knob.
- All four `(autoExit, interactive)` combinations remain reachable via explicit override; resolution does not coerce them.
- `caller_ping` continues to terminate the child cleanly and steer a `subagent_ping` message to the parent. `subagent_done` continues to terminate cleanly and steer `subagent_result`.
- TDD discipline: per the TODO and umbrella, build the supervision and interrupt code with red→green→refactor.

## Acceptance Criteria

- A pane-Pi child that idles after `agent_end` shows `waiting` with a duration on the parent widget; if it remains idle past the `SNAPSHOT_STALLED_AFTER_MS` threshold (60 s, upstream constant), the widget flips to `stalled` and (for non-`interactive` children) the parent receives one `subagent_status` steer with that transition.
- A headless-pi child shows the same status progression on the parent's widget as a pane-pi child for the same agent — `starting`/`active`/`waiting`/`stalled` — driven by the same activity file format.
- A Claude-backed child (pane or headless) renders `running …` on the widget and never produces a `subagent_status` steer.
- Calling `subagent_interrupt` against a running pane-Pi child sends a single Escape to that pane; the child's pane, session, watcher, and `RunningSubagent` entry remain alive; the parent widget shows `waiting · interrupted`; no `subagent_result` or registry transition is emitted as a result of the interrupt alone.
- Calling `subagent_interrupt` against a Claude or headless child returns a structured error and changes no state.
- Calling `subagent_interrupt` against an orchestration-owned pane-Pi slot succeeds with the same local ack; the registry's view of that slot is unchanged.
- An agent declared with `auto-exit: true` and no explicit `interactive` resolves to `interactive: false` (gets stall pings). An agent declared with `auto-exit: false` and no explicit `interactive` resolves to `interactive: true` (no stall pings). All four combinations are also reachable via explicit `interactive:` frontmatter or `interactive` tool param.
- `interactive: true` does not change pane focus, child auto-exit timing, completion semantics, `caller_ping`, `subagent_run_cancel`, or blocked-row rendering. Only stall/recovered steer suppression flips.
- Setting `{ "status": { "enabled": false } }` in `config.json` disables the supervision interval and falls the widget back to `running…`/`starting…` labels; `subagent_interrupt` and child activity recording continue to function (children still write activity, parent simply does not consume it).
- `npm run build` passes. `npm test` passes. The full integration suite (per `.pi/skills/run-integration-tests/SKILL.md`) passes, including pane-pi and headless-pi smoke flows.
- The ledger entries for `9f10962`, `269b485`, and `b4b0287` in `docs/analysis/upstream-sync-ledger-pi.md` move to `PROCESSED` (or are explicitly reclassified with rationale if scope shifts during implementation).

## Non-Goals

- Status supervision for Claude pane or Claude headless children beyond the `running` fallback.
- `subagent_interrupt` for Claude-backed or headless-backed children.
- Synthesizing activity state from the existing live transcript / usage stream for any backend.
- Exposing `lineLimit` (or any beyond `enabled`) as a `config.json` knob — `parseStatusConfig` continues to reject unknown keys.
- Restructuring the registry, orchestration cancel routing, or blocked-row lifecycle.
- Combining live usage with status in the widget right-label (single-slot precedence is the chosen design).
- New default normalization that suppresses the `auto-exit:true + interactive:true` combination — it remains reachable.
- Bringing back any package-bundled `planner` / `spec` agent surface (the umbrella explicitly out-scopes that).
- A Windows-specific validation pass — the existing Windows-best-effort posture from `TODO-d779e69b` carries over.

## Open Questions

- Whether the headless-pi activity file should live under the parent session's `<artifactDir>` (matches pane-pi) or under the headless child's own working directory. The spec assumes the parent's `artifactDir` for symmetry; the planner can confirm against `selectBackend()`'s context-passing once it surveys the headless launch path.
- Whether the `subagent_interrupt` tool's deny-Claude error wording should leave the door open for a later Claude-pane port, or pin the limitation more firmly. Defaulting to upstream wording (which already implies "not yet verified") is the safe choice.
