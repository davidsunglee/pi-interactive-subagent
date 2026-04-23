# Orchestration Lifecycle Expansion — Design

**Date:** 2026-04-22
**Status:** Approved design, revised in v3 to reflect the implemented `subagent_resume` API surface
**Combines todos:** P1 (`500159c1`), P4 (`79db3120`), P6 (`ab99a00b`)
**Phasing:** Two phases. Phase 1 delivers P1. Phase 2 delivers P4 and P6 together (P6 collapses into P4 after the YAGNI pass described below).

---

## Summary

Today's orchestration tools (`subagent_serial`, `subagent_parallel`) are strictly synchronous: the caller blocks until every task reaches a terminal state, and task state is binary (running → done). This spec expands the orchestration lifecycle along three related axes:

1. **Async dispatch (P1)** — `wait: false` lets an orchestration return immediately and deliver its aggregated result later via steer-back.
2. **Blocked tasks via `caller_ping` (P4)** — a child that pings its parent mid-run puts its task into a `blocked` state that the orchestration surfaces structurally; the parent can unblock by issuing a resume.
3. **Resume awareness (P6)** — the orchestration layer tracks which live orchestrations own which session keys (the same value the parent passes to `subagent_resume`), so a resume (standalone) that targets an orch-owned session feeds its result back into the original orchestration's blocked slot.

These are thematically linked because each one extends the set of lifecycle states an orchestrated task can occupy beyond today's `running → terminal`. We introduce a single unified lifecycle model that both phases extend.

## Motivation

- **P1 unlocks backgrounding.** Long-running orchestrations currently hold the caller's tool slot open for the full duration. This is fine for short fan-outs but painful for multi-hour `execute-plan` or deep review/remediation loops.
- **P4 unlocks human-in-the-loop.** Today a child that hits ambiguity either guesses, fails, or calls `caller_ping` and exits outside the orchestration layer's awareness. With this spec, `caller_ping` inside an orchestration is a first-class blocked state; the parent resumes with guidance, the task continues, the orchestration completes cleanly.
- **P6 unlocks session continuity.** Today, resuming an orch-owned session has no path to re-fold its result back into the original orchestration's aggregated output. This spec adds that bookkeeping (via the session-ownership map) and piggybacks it on P4.

## Non-goals

- **No `kind: "resume"` task type.** All resumes go through the existing standalone `subagent_resume` tool. The orchestration layer observes resume completions passively. Rationale: the three use cases for a declarative resume task (simple unblock, unblock-with-follow-up, review-loop pattern) are already served by standalone resume plus reactive chaining; the one case that isn't (declarative review loops) requires session-key substitution we're not adding either. Revisit if real usage demands it.
- **No session-key substitution in task prompts.** `{previous}` remains text-only, bound to the prior task's `finalMessage`.
- **No disk persistence of orchestration state.** Registry is in-process only. A pi crash kills live async runs and clears the ownership map. Documented limitation.
- **No status query tool.** No `subagent_run_status` / list-all in v1. Steer-back is the sole delivery mechanism.
- **No per-task intermediate notifications** other than `blocked`. No mid-run "task N completed" pings.
- **No timeouts or liveness guarantees.** A never-answered block hangs the orchestration until manually cancelled.
- **No bare-subagent cancellation.** `subagent_run_cancel` cancels orchestrations only.
- **No pane-backend `usage` / `transcript` parity work.** That's P2's scope. This spec's cumulative-on-resume rule applies only to fields the current backend already populates.
- **No orchestration grouping in the widget.** Per-pane rows with state indicators only.
- **Sync orchestrations remain fully backward-compatible** in behavior. Their results gain the new additive `state` field only.

---

## Unified Orchestration Lifecycle

### Task state machine

```
              ┌──────────────┐
              │   pending    │   (not yet launched; known from manifest)
              └──────┬───────┘
                     ▼
              ┌──────────────┐
              │   running    │   (pane/headless child is live)
              └──┬────────┬──┘
                 │        │
                 ▼        ▼
          ┌──────────┐ ┌──────────────┐
          │ blocked  │ │ terminal:    │   completed | failed | cancelled
          │ (P4)     │ │              │
          └────┬─────┘ └──────────────┘
               │ resume (standalone subagent_resume)
               ▼
          ┌──────────┐
          │ running  │
          └──────────┘
```

### Orchestration-level lifecycle

An orchestration is `running` as long as any task is non-terminal (including `blocked`). Once every task reaches a terminal state (or the run is cancelled), the orchestration enters `completed` and emits its single aggregated steer-back notification. The orchestration emits no per-task intermediate notifications in v1, with one exception: the `blocked` signal added in phase 2.

### Orchestration identity

Every async orchestration (started with `wait: false`) gets a short hex id generated on dispatch (same scheme as todo ids — e.g., `7a3f91e2`). Sync orchestrations have no id and keep today's id-less shape for backward compatibility. Ids are in-process only; no disk persistence.

### Phased introduction of states

| Phase | New states | New notifications |
|---|---|---|
| 1 (P1) | `pending`, terminal labels (`completed` / `failed` / `cancelled`) now explicit | Aggregated completion (async only) |
| 2 (P4 + P6) | `blocked` | Per-block surface notification |

### Shared result envelope

Every orchestration result (sync or async, any phase) uses the same per-task shape. Phase 1 adds the `state` field; phase 2 adds `blocked` as a value it can take *pre-terminal* (and the resume path extends usage/transcript cumulatively).

```ts
type OrchestratedTaskResult = {
  name: string;
  index: number;
  state: "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  finalMessage?: string;
  /**
   * Resume-addressable identifier for the child. For pi-backed children this
   * is the subagent session file path — the same value the parent passes to
   * `subagent_resume({ sessionPath })`. For Claude-backed children this is
   * the Claude session id — the same value the parent passes to
   * `subagent_resume({ sessionId })`. Named "sessionKey" (not "sessionId")
   * because the pi-backed form is path-shaped, not id-shaped.
   */
  sessionKey?: string;
  transcriptPath?: string | null;
  elapsedMs?: number;
  exitCode?: number;
  error?: string;
  usage?: Usage;              // headless only in v1; P2 closes pane parity
  transcript?: TranscriptMessage[];  // headless only in v1
};
```

### Usage / transcript semantics across states

- **Running → blocked.** Accumulators freeze at point-in-time. Reading a non-terminal task's `usage`/`transcript` returns the snapshot as of the block.
- **Blocked → running (via resume).** The resumed child reuses the same session; accumulators extend cumulatively.
- **Cancelled.** Whatever was captured before cancellation; stable at that snapshot.

Pane-backend parity for `usage` / `transcript` is P2's scope and is out of scope here.

---

## Phase 1 — Async Orchestration Mode

### Tool renames (breaking change; no backward-compat shim)

For naming consistency across the orchestration surface, rename:

- `subagent_serial` → `subagent_run_serial`
- `subagent_parallel` → `subagent_run_parallel`

And add:

- `subagent_run_cancel`

All three share the `subagent_run_*` prefix. `run` was chosen over `batch` because it fits both execution shapes naturally (a "serial run", a "parallel run") without the mild awkwardness `batch` carries for serial (which is really a pipeline, not a batch of independent items).

Existing callers — skills (notably those tracked by the P3 todo), `/plan` and `/iterate` command implementations, bundled agent definitions, and the README — are migrated as part of Phase 1. No compatibility shim is provided; callers of the old names receive tool-not-found errors.

### Schema change — `wait` field

Add one optional field to both orchestration tools:

```ts
wait?: boolean   // default: true (today's blocking behavior)
```

- `wait` omitted or `true` → behavior identical to today. Tool blocks until all tasks terminal; sync result shape (plus the additive `state` field on each per-task result).
- `wait: false` → immediate return with the async envelope described below.

### Immediate return (async)

```ts
{
  orchestrationId: string,                  // short hex, e.g. "7a3f91e2"
  tasks: [
    { name, index, state: "pending" },      // one entry per input task, in input order
    ...
  ],
  isError: false
}
```

### Completion notification

When every task reaches a terminal state (or the run is cancelled), a single steer-back notification is emitted:

```ts
{
  kind: "orchestration_complete",
  orchestrationId,
  results: OrchestratedTaskResult[],        // one per task, in input order
  isError: boolean                          // true if any task failed or was cancelled
}
```

No per-task intermediate notifications. Parent tracks in-flight progress via the widget.

### `subagent_run_cancel`

```ts
subagent_run_cancel({ orchestrationId: string })
  → { ok: true, alreadyTerminal?: boolean }
```

- Transitions every non-terminal task (`pending`, `running`) to `cancelled`. In-flight panes are closed; waits are aborted.
- Once all transitions land, the orchestration emits its standard aggregated completion with `isError: true` and mixed states in `results`.
- Idempotent: cancelling an already-terminal run returns `{ ok: true, alreadyTerminal: true }` without emitting a duplicate completion.
- Scope: async orchestrations only. Sync runs continue to use the tool-call `AbortSignal` path (unchanged).

### In-process state

A new module owns the orchestration registry:

```
orchestrationId → {
  config,             // original task list + options
  tasks: OrchestratedTaskResult[],
  state: "running" | "completed",
  notifier,           // steer-back emitter handle
}
```

Lives in the extension process. No disk persistence in v1. A pi restart kills live async orchestrations silently.

### Concurrency

Multiple async orchestrations run simultaneously with no shared state. Each steer-back notification carries its `orchestrationId` so the parent can disambiguate.

### Code placement

- `pi-extension/orchestration/registry.ts` — new. Owns the registry and async-run lifecycle.
- `pi-extension/orchestration/run-serial.ts`, `run-parallel.ts` — updated to branch on `wait`. Sync path unchanged; async path delegates to the registry.
- `pi-extension/orchestration/tool-handlers.ts` — updated to register the renamed tools and the new `subagent_run_cancel`.
- Callers (`pi-extension/subagents/plan-skill.md`, `/plan` and `/iterate` command impls, README examples, bundled agent definitions) — updated for renames.

### Backward compatibility

- **Within this project:** zero. Tool names change; the spec is explicit this is a breaking rename. Phase 1 migrates every in-repo caller.
- **For sync orchestration result shape:** purely additive. The new `state` field is always present, takes only `completed | failed | cancelled` in sync mode, and does not alter any existing field's semantics.

---

## Phase 2 — `caller_ping` Integration + Resume Awareness (merged P4 + P6)

### Scope

Phase 2 delivers the user-visible capability of human-in-the-loop orchestration via `caller_ping`, plus the runtime bookkeeping (session-ownership map + cross-orchestration result re-ingestion) that makes any resume — orchestration-initiated or standalone — behave correctly when it targets a session owned by a live orchestration. The second half is what P6 contributes after the YAGNI pass dropped the declarative `kind: "resume"` task type.

### Scope restriction — async only

Phase 2 activates only for `wait: false` orchestrations. In sync runs, today's behavior continues unchanged: `caller_ping` exits the child, the orchestration records the task as `completed` with the ping message as `finalMessage`. The parent's turn is architecturally unable to respond to a steer-back while its tool call is blocked, so forcing block-state semantics on sync runs would produce broken UX. Documented limitation; sync callers who need ping-aware orchestration migrate to `wait: false`.

### Session-ownership map

New registry-level index:

```
sessionKey → (orchestrationId, taskIndex)
```

The `sessionKey` is the same value the parent will pass back through `subagent_resume`. For pi-backed children that's the subagent session file path (so it maps directly to `subagent_resume({ sessionPath })`); for Claude-backed children it's the Claude session id (so it maps directly to `subagent_resume({ sessionId })`). Named `sessionKey` rather than `sessionId` because the pi-backed form is path-shaped, not id-shaped.

Populated when each task launches — the key is known to the backend at that point (pi: session file path set up pre-launch; Claude: session id from the `system/init` event). Cleared when the task reaches a terminal state. Load-bearing for both blocked-state routing and resume re-ingestion.

### Detecting a block

The existing Claude Stop-hook plugin already emits structured sentinels distinguishing `subagent_done` from `caller_ping`. Extend the completion watcher in `pi-extension/subagents/` to surface the `caller_ping` case as a distinct event rather than folding it into normal completion. On receiving the event for a child whose `sessionKey` is in the ownership map, the registry transitions the task:

1. State `running → blocked`.
2. Usage / transcript accumulators frozen at point-in-time (cumulative on eventual resume).
3. Steer-back emitted:

   ```ts
   {
     kind: "blocked",
     orchestrationId,
     taskIndex,
     taskName,
     sessionKey,   // same value the parent hands to subagent_resume
     message,      // the ping payload
   }
   ```

4. Pane closes (today's behavior); widget row flips to the `blocked` visual state (see Widget section).

### Unblock path

The parent calls the standalone `subagent_resume` tool directly with the blocked session's `sessionKey` and the answer as the follow-up prompt. For pi-backed children, pass that value as `sessionPath`. For Claude-backed children, pass that value as `sessionId`. The resume tool surface is XOR-shaped: callers provide exactly one of `sessionPath` or `sessionId`. This is the only unblock path; no orchestration-level unblock tool is introduced.

If the parent wants to chain additional steps immediately after the unblock (e.g., resume a review session, then run a follow-up worker that acts on the updated review output), it chains reactively: issue the standalone resume, wait for its steer-back, then dispatch the follow-up work in the next parent turn. A declarative "resume as step N of a pipeline" is not expressible in the task list today because we dropped `kind: "resume"`; if real demand emerges, that's an additive schema extension in a future spec.

### Cross-orch re-ingestion

When any standalone `subagent_resume` call targets a session in the ownership map:

1. The resumed child runs normally under the standalone-resume path.
2. On terminal completion (success, failure, or cancellation), the registry matches `sessionKey → (orchestrationId, taskIndex)` and updates the original orchestration's blocked slot with the resumed child's result.
3. State transitions `blocked → completed | failed | cancelled`. Usage / transcript extend cumulatively (the resumed child reuses the same session, so the accumulators continue).
4. Serial runs: the paused sequence continues from the next step, with `{previous}` substitution using the resumed task's updated `finalMessage`.
5. Parallel runs: aggregated completion check re-evaluates; if this was the last non-terminal slot, the aggregated completion fires.
6. The standalone `subagent_resume` call reports its own steer-back completion to the parent normally, exactly as any other standalone-subagent completion. The cross-orch effect is a side effect of the ownership map and is invisible at the resume tool's surface.

### Recursion

A resumed child that calls `caller_ping` again transitions `running → blocked` again, emits another blocked notification, and waits for another unblock. No depth limit in v1.

### Cancellation of blocked tasks

`subagent_run_cancel` transitions blocked tasks to `cancelled` without attempting resume. No child is alive to abort; cleanup is purely state-registry work. The cancelled state propagates through the aggregated completion as in Phase 1.

### Widget changes

Extend the per-pane row model with a post-pane `blocked` state:

- Keyed on `(orchestrationId, taskIndex)` so the row persists after the pane closes.
- Distinct visual state — different color and/or icon — making clear this is a task awaiting a parent response, not a task in progress.
- Cleared on transition to any terminal state.

No orchestration grouping, no collapsible headers. Per-pane rendering is preserved; only the state palette expands.

### Code placement

- `pi-extension/orchestration/ownership-map.ts` — new. Session-id index and result-routing logic.
- `pi-extension/subagents/` completion-watcher code — extended to surface `caller_ping` events distinctly and to notify the ownership map on any resume completion (including those originating outside orchestration).
- `pi-extension/subagents/index.ts` — widget changes for the `blocked` state.
- `pi-extension/orchestration/registry.ts` — updated to accept ownership-map events and drive blocked-state transitions + re-ingestion.

---

## API Surface Summary

After both phases ship:

| Tool | Origin | Purpose |
|---|---|---|
| `subagent` | pre-existing | Spawn one subagent (unchanged) |
| `subagents_list` | pre-existing | List agent definitions (unchanged) |
| `subagent_resume` | pre-existing, surface-expanded in Phase 2 | Resume a pi-backed session by `sessionPath` or a Claude-backed session by `sessionId`; orch-owned sessions route results back to the owning orch |
| `subagent_done` | pre-existing | Mark self done (unchanged) |
| `subagent_run_serial` | Phase 1 (renamed) | Serial orchestration; supports `wait?: boolean` |
| `subagent_run_parallel` | Phase 1 (renamed) | Parallel orchestration; supports `wait?: boolean` |
| `subagent_run_cancel` | Phase 1 (new) | Cancel an async orchestration by id |

### `subagent_resume` request shape

```ts
subagent_resume({
  sessionPath?: string;   // pi-backed session file path
  sessionId?: string;     // Claude-backed session id
  name?: string;
  message?: string;
})
```

Exactly one of `sessionPath` or `sessionId` must be provided. The `sessionKey` surfaced in blocked notifications and orchestrated task results is the value the caller plugs into one of those two fields depending on backend.

Steer-back notification kinds:

| Kind | Origin | Carries |
|---|---|---|
| (existing bare-subagent completions) | pre-existing | per-subagent completion (unchanged) |
| `orchestration_complete` | Phase 1 | aggregated orchestration result |
| `blocked` | Phase 2 | blocked task details (orchestrationId, taskIndex, taskName, sessionKey, message) |

---

## Testing Strategy

### Phase 1

- **Unit:** registry state transitions (`pending → running → terminal`); idempotent cancel on terminal runs; orchestration id uniqueness across concurrent dispatches.
- **Integration — async path:** `subagent_run_serial({ wait: false })` returns manifest immediately; steer-back fires once with aggregated results after all tasks terminal. Same for `subagent_run_parallel`.
- **Integration — sync regression:** default and explicit `wait: true` paths are byte-identical to today's behavior aside from the additive `state` field on each per-task result.
- **Cancellation:** dispatched-then-cancelled run emits a single aggregated completion with all tasks `cancelled` and panes closed; in-flight tasks abort mid-stream.
- **Concurrency:** two simultaneous async runs each complete with their own id and their own notification; no cross-talk.
- **Both backends:** headless and pane paths exercised for each of the above where applicable.
- **Rename migration:** every in-repo caller compiles and runs against the new tool names; old names error out with tool-not-found.

### Phase 2

- **Unit:** ownership-map populate/clear on task lifecycle; `sessionKey` lookup routing to the right `(orchestrationId, taskIndex)`.
- **Integration — single block/resume cycle:** serial run with `wait: false`, task 2 calls `caller_ping`, blocked steer-back fires, parent issues standalone `subagent_resume`, task 2 transitions `blocked → completed`, sequence continues to task 3, aggregated completion fires. Cover both resume-entry forms across backends: pi-backed via `sessionPath`, Claude-backed via `sessionId`.
- **Integration — parallel block:** one task blocks; siblings continue and reach terminal; aggregated completion waits for the resume; final notification includes mixed states ending all-terminal.
- **Recursion:** resumed child pings again; transitions back to `blocked`; second resume completes the task; aggregated completion fires.
- **Cancellation of blocked task:** `subagent_run_cancel` while a task is `blocked` transitions it to `cancelled` and emits aggregated completion.
- **Sync regression:** `wait: true` orchestration with a child that calls `caller_ping` continues to record the task as `completed` with the ping message as `finalMessage` (no new behavior).
- **Widget:** blocked rows render distinctly; clear on terminal transition; persist across pane closure.

### Cross-phase end-to-end

- `execute-plan`-style scenario: async parallel dispatch of 3 workers; one pings for clarification; parent resumes with answer; all three workers complete; aggregated completion delivered.

---

## Open questions & forward compatibility

- **If declarative resume chains become a real pattern**, `kind: "resume"` as a task discriminator is a backward-compatible additive schema change — we can ship it later with a concrete motivating use case.
- **If a live-status surface is needed**, a `subagent_run_status` / list-all tool is a backward-compatible addition; the registry already has the information.
- **Disk persistence** is plausible future work; the registry's internal shape is designed to serialize cleanly if/when that's needed.
- **Bare-subagent cancellation** is a larger conversation; if pursued later, the natural consolidation is to make `subagent_run_cancel` polymorphic on `{ orchestrationId? sessionKey? }`.

---

## Summary of design decisions (quick reference)

| Decision | Choice | Rationale |
|---|---|---|
| Thematic framing | Shared state model | All three features extend the orchestration lifecycle; one vocabulary avoids rework |
| Delivery of async state changes | Steer-back only | Reuses project's established idiom; YAGNI on query surface |
| Widget treatment | State indicators, no grouping | Minimum needed to make `blocked` legible; avoids widget refactor |
| `caller_ping` on block | Child exits (today's behavior) | Simpler, identical mux/headless; no child-CLI pause primitive needed |
| Phasing | P1 → (P4 + P6 merged) | P4 is architecturally dependent on P1; P6's task-type split didn't carry its weight (YAGNI collapse) |
| Serial behavior on block | Pause sequence | Preserves `{previous}` causal semantics |
| Parallel behavior on block | Siblings continue, single aggregated completion | Simpler parent reasoning; symmetric with serial |
| `kind: "resume"` task type | Dropped | Three use cases each better served by standalone resume + reactive chaining |
| Orchestration id scope | Async runs only | Sync runs have no need; YAGNI on symmetry |
| Persistence | In-process only | v1; crash recovery not justified |
| Tool naming | `subagent_run_{serial,parallel,cancel}` | Consistent family; `run` fits both serial and parallel shapes |
| Backward compat on tool renames | None | Fork state allows a clean break; all in-repo callers migrated in Phase 1 |
