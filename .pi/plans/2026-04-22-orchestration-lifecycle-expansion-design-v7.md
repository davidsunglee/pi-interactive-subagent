# Orchestration Lifecycle Expansion Implementation Plan (v7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend orchestration (`subagent_serial` / `subagent_parallel`) with a unified lifecycle model covering three new capabilities: async dispatch (`wait: false`) delivered via steer-back (P1), `caller_ping`-driven `blocked` state surfaced structurally (P4), and cross-orchestration resume re-ingestion so a standalone `subagent_resume` targeting an orch-owned session folds its result back into the original aggregated run (P6). Rename the orchestration tool family to `subagent_run_{serial,parallel,cancel}` as a breaking change.

**Architecture:**

1. **Unified lifecycle state on every task result.** `OrchestratedTaskResult.state` (`pending | running | blocked | completed | failed | cancelled`) becomes the single lifecycle vocabulary for both sync and async orchestrations. Sync runs use only terminal values plus the additive `state` field; async runs use the full state machine.
2. **In-process orchestration registry.** A new `pi-extension/orchestration/registry.ts` owns every live async run keyed by a short hex `orchestrationId`, tracks per-task state transitions, and fires aggregated completion via an injected steer-back emitter. Sync runs bypass the registry.
3. **Session-ownership map (Phase 2).** The registry maintains `sessionKey → (orchestrationId, taskIndex)` for every running orch-owned task. The `sessionKey` is whatever identifier the parent uses with the existing `subagent_resume` tool — the session file path for pi-backed children (matches `subagent_resume({ sessionPath })`) and the Claude session id for Claude-backed children. `subagent_resume` consults the map on its completion path (and on re-pings) and routes the child's outcome back into the owning registry slot, unblocking paused serial sequences, driving aggregated completion, or re-blocking on recursive pings.
4. **Distinct `caller_ping` surfacing at the backend boundary, plus mid-run `sessionKey` propagation.** Both backends already detect `.exit` ping sidecars (pane path) or can be extended to detect them (headless); the backends propagate `ping?: { name, message }` plus `sessionKey` on their `BackendResult` so the registry can transition `running → blocked`, key ownership to the same value `subagent_resume` will receive, and emit a `blocked` steer-back carrying that key in the `sessionKey` field. The `Backend.watch(...)` seam itself gains an `onSessionKey` callback (Step 9.5b) so Claude children can surface their session id mid-run — pane Claude fires it from `watchSubagent`'s `onTick` the first time the `.transcript` pointer file appears; headless Claude fires it from the `system/init` event. That callback threads through `LauncherDeps.waitForCompletion` → runner → tool-handler → `registry.updateSessionKey`, closing the ownership-map gap before any `caller_ping` can block the task.
5. **Tool rename (breaking).** `subagent_serial` → `subagent_run_serial`, `subagent_parallel` → `subagent_run_parallel`, plus new `subagent_run_cancel`. No compatibility shim.

**Tech Stack:** TypeScript (Node's native `--test` runner, `node:assert/strict`), `@sinclair/typebox` for tool schemas, `@mariozechner/pi-coding-agent` for the extension API (including `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`), `node:crypto.randomUUID`/hex for orchestration ids. No new external dependencies.

## Key decisions and invariants

- **Phasing:** Phase 1 delivers P1 (async + rename + cancel). Phase 2 delivers P4+P6 (blocked state + resume re-ingestion). Phase 2 activates **only** for `wait: false` orchestrations; sync runs with a pinging child continue today's behavior (record as `completed` with ping text as `finalMessage`).
- **Shared result envelope.** Every per-task result (sync or async) includes `state` AND `index`. Sync tool handlers map the runner's internal `OrchestrationResult[]` to the public `OrchestratedTaskResult[]` envelope on return (Task 2.7), so `wait:true` and `wait:false` callers see the same shape. Pre-terminal values (`pending`, `running`, `blocked`) only ever appear in async completion notifications; sync returns always have terminal `state`.
- **Orchestration id:** generated as an 8-char hex (same scheme as `safeScriptName` id in `launchSubagent`) on every `wait: false` dispatch; sync runs have no id.
- **Ownership key (`sessionKey`):** one canonical identifier is threaded end-to-end. For pi-backed children, `sessionKey = subagentSessionFile` (a file path — identical to what `subagent_resume({ sessionPath })` accepts). For Claude-backed children, `sessionKey = claudeSessionId`. The registry's ownership map, the blocked notification's `sessionKey` payload field, and the `subagent_resume` lookup all use this same value. Claude children's `sessionKey` is not known at launch time; it is late-bound via an `onSessionKey` callback extended onto the `Backend.watch` seam itself (Task 9.5b) — pane Claude reads the `.transcript` pointer file inside `watchSubagent`'s `pollForExit.onTick` the first tick it appears; headless Claude fires the callback from the `system/init` event parser. That callback flows `backend → LauncherDeps.waitForCompletion(hooks.onSessionKey) → run-serial/run-parallel.onSessionKey → tool-handlers.onSessionKey → registry.updateSessionKey(orchestrationId, taskIndex, sessionKey)` before any `caller_ping` can route the task to blocked. `subagent_resume` accepts either `sessionPath` (pi-backed) or `sessionId` (Claude-backed); both funnel through the same ownership-map lookup so blocked routing and cross-orch re-ingestion work for both backends (Task 12).
- **Blocked notification kind matches spec.** Emitted as `customType: "blocked"` with `details.kind === "blocked"`. The `BLOCKED_KIND` constant holds the string `"blocked"`.
- **No disk persistence.** Registry + ownership map are in-process only. `/reload` / crash kills async runs silently; documented limitation.
- **No status query tool.** Steer-back is the sole delivery mechanism in v1.
- **No per-task intermediate completion pings.** Phase 2's `blocked` is the single pre-terminal user-facing notification kind. The registry does expose an internal in-process `onTaskTerminal` subscriber hook (not a notification) that the extension uses for widget cleanup on per-task terminal transitions.
- **Cancellation scope.** `subagent_run_cancel` cancels async orchestrations only; sync runs continue to use the tool-call `AbortSignal`.
- **Usage/transcript on resume.** Because the resumed child reuses the same session, accumulators extend cumulatively across `blocked → running` transitions. Pane-backend `usage` / `transcript` parity is out of scope (P2 work).
- **Async blocked pause is not a cancellation.** When a `runSerial`/`runParallel` invocation returns because a task blocked (and the registry took ownership of the slot), the async dispatcher must NOT run the generic "mark pending/running as cancelled" sweep — later steps remain launchable when the blocked slot resumes.
- **Widget per-pane rendering preserved.** Phase 2 adds a post-pane `blocked` visual state keyed on `(orchestrationId, taskIndex)` so the row persists after the pane closes; no grouping or collapsible headers. Blocked rows clear on every per-task terminal transition, not only on whole-orchestration completion.

---

## File Structure

**New files**

- `pi-extension/orchestration/registry.ts` — async orchestration registry. Owns `orchestrationId → OrchestrationEntry` (config, per-task `OrchestratedTaskResult[]`, overall state, per-orch AbortController, injected emitter) **plus** the session-ownership index `sessionKey → (orchestrationId, taskIndex)`. API: `dispatchAsync`, `cancel`, `onTaskLaunched`, `updateSessionKey` (late-bind for Claude children whose session id is only known after launch), `onTaskTerminal`, `onTaskBlocked`, `onResumeTerminal`, `lookupOwner`, `listActive`, `getAbortSignal`, `getSnapshot`. Pure module; no direct `ExtensionAPI` imports (emitter is injected). The ownership index is colocated with the registry (rather than a separate `ownership-map.ts`) because every mutation is driven by registry lifecycle events — splitting it introduces a cyclic coupling without any reuse benefit.
- `pi-extension/orchestration/notification-kinds.ts` — named string constants for steer-back `customType` and `details.kind` values (`orchestration_complete`, `blocked`). Avoids typo drift across emission sites. Values match the spec's public API surface exactly.
- `test/orchestration/registry.test.ts` — unit tests for registry state transitions, id generation, cancellation idempotency, concurrent runs, ownership-index populate/clear/lookup, cross-orch re-ingestion via `onResumeTerminal`, the `RegistryHooks.onTaskTerminal` per-task hook.
- `test/orchestration/async-dispatch.test.ts` — unit tests for `wait: false` branch in tool handlers (immediate return, completion notification wiring).
- `test/orchestration/cancel.test.ts` — unit tests for `subagent_run_cancel`.
- `test/orchestration/block-resume.test.ts` (Phase 2) — unit tests for `caller_ping` → blocked → standalone resume → aggregated completion, including the "downstream steps stay pending when a serial step blocks" invariant.
- `test/orchestration/sync-ping-regression.test.ts` (Phase 2) — unit test that `wait: true` with a pinging child still records `state: "completed"` and `finalMessage === ping.message` (spec's sync-unchanged invariant).
- `test/orchestration/backend-seam.test.ts` (Phase 2, Task 9.5b) — contract test proving that a fake backend firing `Backend.watch`'s `onSessionKey` mid-run populates `registry.updateSessionKey` via the full runner → tool-handler → registry wiring, before any blocked-state routing.
- `test/integration/orchestration-async.test.ts` (Phase 1) — registry-level e2e: async dispatch + aggregated completion delivery.
- `test/integration/orchestration-extension-async.test.ts` (Phase 1) — real `subagentsExtension(pi)` e2e: tool registration + `pi.sendMessage(..., { deliverAs: "steer" })` wiring for `orchestration_complete`.
- `test/integration/orchestration-pane-async-backend.test.ts` (Phase 1) — **backend-real** pane async/cancel test: no `LauncherDeps` or `watchSubagent` seam; exercises `wait: false` dispatch and `subagent_run_cancel` through the real pane backend (Task 8b).
- `test/integration/orchestration-headless-async-backend.test.ts` (Phase 1) — **backend-real** headless async/cancel test: exercises `runPiHeadless` end-to-end for both `wait: false` completion and `subagent_run_cancel` teardown of live child processes (Task 8b).
- `test/integration/agents/test-async-ok.md` (Phase 1) — minimal always-complete fixture used by the Task 8b pane/headless async tests (reuse an existing equivalent fixture if one exists).
- `test/integration/orchestration-extension-blocked.test.ts` (Phase 2) — real `subagentsExtension(pi)` e2e: pinging backend result → `customType: "blocked"` steer-back with spec-shaped `details`.
- `test/integration/orchestration-block-resume-e2e.test.ts` (Phase 2) — registry-level e2e for parallel-fanout block/resume/complete.
- `test/integration/orchestration-extension-resume-routing.test.ts` (Phase 2) — real `subagent_resume` tool path: terminal resume routes via `registry.onResumeTerminal`; ping-during-resume routes via `registry.onTaskBlocked` (recursion).
- `test/integration/agents/test-ping-resumable.md` (Phase 2) — fixture agent that pings once and then completes normally on resume. Distinct from the existing `test-ping.md` (which pings on every turn) because the backend-real tests need a resumable path. Created in Step 14.2a and consumed by 14.2b and 14.2c.
- `test/integration/orchestration-pane-block-backend.test.ts` (Phase 2) — **backend-real** pane async/block test: no `LauncherDeps` or `watchSubagent` seam; the `test-ping-resumable` child actually pings on first turn and completes on resume, and the pane adapter's `BackendResult.ping` / `sessionKey` propagation (Task 9.4) is exercised end-to-end.
- `test/integration/orchestration-headless-block-backend.test.ts` (Phase 2) — **backend-real** headless async/block test: exercises `runPiHeadless`'s `.exit` sidecar detection (Task 9.5) end-to-end, asserting the real session file path surfaces in the `blocked` steer-back and the sidecar is cleaned up after propagation. The resume half uses the mux-based `subagent_resume` tool, so the test skips unless both `pi` and a mux backend are present.

**Modified files**

- `pi-extension/orchestration/types.ts` — add `OrchestratedTaskResult` type with `state` field; extend the existing `OrchestrationResult` with optional `state`, `index`, `sessionKey`, `ping` (Task 1.3); extend `LauncherDeps.waitForCompletion` with a `hooks?: { onSessionKey?: (key: string) => void }` parameter (Task 9.5b Part D); add `AsyncDispatchEnvelope` type; add `OrchestrationState`.
- `pi-extension/orchestration/run-serial.ts` — annotate results with `state` and `index`; add a `onTaskLaunched` / `onTaskTerminal` / `onSessionKey` callback seam so the registry can hook without changing the sync path; (Phase 2) pause sequence on blocked, resume from the next step when the blocked slot transitions to `completed`.
- `pi-extension/orchestration/run-parallel.ts` — annotate results with `state` and `index`; add the same callback seam (including `onSessionKey`); (Phase 2) aggregated completion re-evaluates on `blocked → terminal`.
- `pi-extension/orchestration/tool-handlers.ts` — rename tool registrations; add `wait` field; map sync `out.results` into the public `OrchestratedTaskResult[]` envelope before returning (Task 2.7); branch to registry path on `wait: false` (wire `onLaunched` / `onTerminal` / `onBlocked` / `onSessionKey`); add `subagent_run_cancel` registration.
- `pi-extension/subagents/backends/types.ts` — add `ping?: { name: string; message: string }` and `sessionKey?: string` to `BackendResult`; extend `Backend.watch` with an `onSessionKey?: (key: string) => void` 4th arg (Task 9.5b Part A).
- `pi-extension/subagents/backends/pane.ts` — accept and forward `onSessionKey` into `watchSubagent`; propagate `sub.ping` into `BackendResult.ping`; populate `BackendResult.sessionKey` from `running.sessionFile` for pi children and from `sub.claudeSessionId` for Claude children; populate `LaunchedHandle.sessionKey` at launch for pi.
- `pi-extension/subagents/backends/headless.ts` — detect `${subagentSessionFile}.exit` ping sidecar on child close and set `BackendResult.ping` accordingly; populate `BackendResult.sessionKey` from `spec.subagentSessionFile` for pi and from the Claude init event for Claude; fire `onSessionKey` at the `system/init` event for `runClaudeHeadless` (Task 9.5b Part C).
- `pi-extension/subagents/index.ts` — register orchestration tools with `pi` handle wired for steer-back emission; extend `watchSubagent(running, signal, opts?)` with an `onSessionKey` opt that fires on the first `pollForExit` tick where the Claude `.transcript` pointer file exists (Task 9.5b Part B); extend widget to render `blocked` state keyed on `(orchestrationId, taskIndex)`; in `subagent_resume.execute`, route both the terminal result and any ping-during-resume into the registry (via `onResumeTerminal` for terminal, `onTaskBlocked` for re-ping) so cross-orch re-ingestion and recursion work through the real resume tool.
- `pi-extension/orchestration/default-deps.ts` — thread `hooks.onSessionKey` from `waitForCompletion` into `backend.watch(handle, signal, hooks?.onSessionKey)` (Task 9.5b Part D).
- `pi-extension/subagents/launch-spec.ts` — add `subagent_run_serial`, `subagent_run_parallel`, `subagent_run_cancel` to `SPAWNING_TOOLS`; drop old names.
- `README.md` — update tool names, add `wait`/async section, document `subagent_run_cancel`, document the `blocked` state and `caller_ping` orchestration behavior.

---

## Self-review invariants

Code review against this plan must verify:
- Every sync test file still passes without modification except for added `state` + `index` assertions (tests named `run-serial.test.ts`, `run-parallel.test.ts`, `tool-handlers.test.ts`).
- Sync `wait:true` returns from both `subagent_run_serial` and `subagent_run_parallel` carry the public `OrchestratedTaskResult` envelope (including `index` on every per-task result), matching the shape of the async `orchestration_complete` steer-back.
- `subagent_serial` / `subagent_parallel` as tool names return tool-not-found errors after Phase 1 (no compat shim).
- No disk write of registry/ownership state anywhere in the new code.
- The blocked notification kind string is exactly `"blocked"` (spec alignment). `customType`, `details.kind`, and the `BLOCKED_KIND` constant value all match.
- The registry ownership map is keyed on the canonical `sessionKey` value: the session file path for pi-backed children (same value accepted by `subagent_resume({ sessionPath })`) and the Claude session id for Claude-backed children (same value accepted by `subagent_resume({ sessionId })`). Blocked notifications carry this value in the `sessionKey` payload field, matching the spec.
- Claude children's `sessionKey` is late-bound via a concrete backend seam: `Backend.watch` carries an `onSessionKey` callback (Step 9.5b Part A) that pane Claude fires from `watchSubagent`'s `onTick` when the `.transcript` pointer file first appears (Part B) and headless Claude fires from the `system/init` event parser (Part C). That callback reaches `registry.updateSessionKey` via `LauncherDeps.waitForCompletion(hooks.onSessionKey)` → runner `onSessionKey` → tool-handler dispatcher (Parts D–F). Pi children bind at launch via `LaunchedHandle.sessionKey` / `onTaskLaunched`.
- `subagent_resume` accepts `sessionPath` XOR `sessionId`; the handler rejects calls that pass neither or both. Both paths funnel into the same `registry.lookupOwner(sessionKey)` so blocked routing and cross-orch re-ingestion work for both backends.
- A serial orchestration that blocks on step N does NOT mark steps N+1..end as cancelled. Steps remain `pending` until the resumed slot completes, then the continuation driver launches them in turn.
- Serial continuation is gated on `state === "completed"`. A resumed task that lands `failed` or `cancelled` must NOT advance the pipeline: `registry.onResumeTerminal` skips the continuation callback for non-successful resumes **and** synchronously sweeps any remaining `pending` downstream slots to `cancelled` (serial-only) before calling `tryFinalize`, so the aggregated completion reports the failed/cancelled slot plus the untouched tail as `cancelled` and the orchestration finalizes.
- Virtual blocked widget rows clear on every per-task terminal transition, not only on whole-orchestration completion.
- `subagent_resume` handles both outcomes on an orch-owned session: terminal completion calls `registry.onResumeTerminal`, and ping-during-resume calls `registry.onTaskBlocked` (recursion through the real tool path).
- Real pane and real headless backends each have at least one async/block integration test that runs without `LauncherDeps` or `watchSubagent` seams, proving that a genuine backend result carrying `ping` propagates through to the expected `blocked` steer-back and completes through the real `subagent_resume` tool path.
- `registry.onResumeTerminal` invokes the continuation callback **only when the resumed slot's `state === "completed"`**. A failed or cancelled serial resume must not advance the pipeline and must finalize the orchestration: `onResumeTerminal` sweeps all `pending` downstream tasks to `cancelled` and re-runs `tryFinalize` synchronously within the same call. Regression tests exist for both `failed` and `cancelled` resume outcomes (Step 11.5b).

---

## Phase 1 — Async Orchestration Mode

### Task 1: Extend shared types for lifecycle state

**Files:**
- Modify: `pi-extension/orchestration/types.ts`
- Test: `test/orchestration/types.test.ts` (create)

- [ ] **Step 1.1: Write the failing test**

```ts
// test/orchestration/types.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  OrchestratedTaskResult,
  OrchestrationState,
  AsyncDispatchEnvelope,
} from "../../pi-extension/orchestration/types.ts";

describe("types", () => {
  it("OrchestratedTaskResult accepts every lifecycle state value", () => {
    const states: OrchestrationState[] = [
      "pending", "running", "blocked", "completed", "failed", "cancelled",
    ];
    for (const state of states) {
      const r: OrchestratedTaskResult = {
        name: "step-1",
        index: 0,
        state,
        finalMessage: "",
        transcriptPath: null,
        exitCode: 0,
        elapsedMs: 0,
      };
      assert.equal(r.state, state);
    }
  });

  it("AsyncDispatchEnvelope carries an orchestrationId and pending task manifest", () => {
    const env: AsyncDispatchEnvelope = {
      orchestrationId: "7a3f91e2",
      tasks: [
        { name: "step-1", index: 0, state: "pending" },
        { name: "step-2", index: 1, state: "pending" },
      ],
      isError: false,
    };
    assert.equal(env.tasks.length, 2);
    assert.equal(env.tasks[0].state, "pending");
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `node --test test/orchestration/types.test.ts`
Expected: FAIL with type/import errors for `OrchestratedTaskResult`, `OrchestrationState`, `AsyncDispatchEnvelope`.

- [ ] **Step 1.3: Add the types**

Edit `pi-extension/orchestration/types.ts` — append after the existing `OrchestrationResult` interface:

```ts
export type OrchestrationState =
  | "pending"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Per-task result on any orchestration (sync or async). Sync runs only
 * populate terminal `state` values; async runs use the full machine and
 * surface pre-terminal states (`pending`, `running`, `blocked`) in
 * intermediate completion notifications.
 */
export interface OrchestratedTaskResult {
  name: string;
  index: number;
  state: OrchestrationState;
  finalMessage?: string;
  transcriptPath?: string | null;
  elapsedMs?: number;
  exitCode?: number;
  /**
   * Resume-addressable identifier for the child: the session file path for
   * pi-backed children (same value `subagent_resume({ sessionPath })`
   * accepts); the Claude session id for Claude-backed children. Named
   * `sessionKey` rather than `sessionId` because the pi form is path-shaped.
   */
  sessionKey?: string;
  error?: string;
  usage?: UsageStats;
  transcript?: TranscriptMessage[];
}

/**
 * Envelope returned immediately from `subagent_run_serial` / `subagent_run_parallel`
 * when `wait: false`. Task manifest mirrors input order with `state: "pending"`.
 */
export interface AsyncDispatchEnvelope {
  orchestrationId: string;
  tasks: Array<{ name: string; index: number; state: "pending" }>;
  isError: false;
}
```

Also extend the existing `LaunchedHandle` type in the same file with an optional `sessionKey` field. This is the stable resume-addressable identifier: the session file path for pi-backed children (matches `subagent_resume({ sessionPath })`, bound at launch time); the Claude session id for Claude-backed children (matches `subagent_resume({ sessionId })`, late-bound via the `system/init` event — see Step 9.5b). Both forms thread through to the registry's ownership map; the pi form via `registry.onTaskLaunched`, the Claude form via `registry.updateSessionKey` when the id first becomes known.

```ts
export interface LaunchedHandle {
  id: string;
  name: string;
  startTime: number;
  /**
   * The resume-addressable identifier for this child. Same value the parent
   * will pass back through `subagent_resume({ sessionPath })` for pi-backed
   * children, or the Claude session id for Claude-backed children. Used to
   * key the orchestration registry's ownership map.
   */
  sessionKey?: string;
}
```

Also extend the existing `OrchestrationResult` interface in the same file with the fields the async path will populate later. These are introduced up front (rather than in Task 9.6) so Task 5's `result.sessionKey` read typechecks. `ping` is consumed by Task 10 to route to blocked; `index` is consumed by Task 2 when annotating per-task results so the public envelope's `index` contract holds for sync and async runs alike.

```ts
export interface OrchestrationResult {
  // ...existing fields (name, finalMessage, transcriptPath, exitCode, elapsedMs, error, usage, transcript, sessionId)...
  state?: OrchestrationState;
  /** 0-based input-order index of this task, used by the shared result envelope. */
  index?: number;
  /** Canonical resume-addressable identifier (pi session file path or Claude session id). */
  sessionKey?: string;
  /** Set when the child exited via `caller_ping` rather than `subagent_done`. */
  ping?: { name: string; message: string };
}
```

Add a matching assertion in `test/orchestration/types.test.ts`:

```ts
it("OrchestrationResult exposes optional state, index, sessionKey, and ping", () => {
  const r: OrchestrationResult = {
    name: "s1", finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 0,
    state: "completed", index: 0, sessionKey: "/tmp/s.jsonl",
    ping: { name: "s1", message: "?" },
  };
  assert.equal(r.state, "completed");
  assert.equal(r.index, 0);
  assert.equal(r.sessionKey, "/tmp/s.jsonl");
  assert.equal(r.ping?.message, "?");
});
```

Add an assertion in `test/orchestration/types.test.ts`:

```ts
it("LaunchedHandle exposes an optional sessionKey", () => {
  const h: LaunchedHandle = { id: "x", name: "n", startTime: 0, sessionKey: "/tmp/s.jsonl" };
  assert.equal(h.sessionKey, "/tmp/s.jsonl");
});
```

- [ ] **Step 1.4: Run the test to verify it passes**

Run: `node --test test/orchestration/types.test.ts`
Expected: PASS.

- [ ] **Step 1.5: Run the full typecheck**

Run: `npm run typecheck`
Expected: no new errors. `OrchestrationResult` gains optional `state`, `index`, `sessionKey`, and `ping` fields — all additive, so no pre-existing caller breaks. `OrchestratedTaskResult` is the new public shape consumed by the registry and tool handlers.

- [ ] **Step 1.6: Commit**

```bash
git add pi-extension/orchestration/types.ts test/orchestration/types.test.ts
git commit -m "feat(orchestration): add OrchestratedTaskResult lifecycle types"
```

---

### Task 2: Add state annotation to sync results

**Files:**
- Modify: `pi-extension/orchestration/run-serial.ts`
- Modify: `pi-extension/orchestration/run-parallel.ts`
- Modify: `pi-extension/orchestration/tool-handlers.ts` (map `out.results` to the public `OrchestratedTaskResult[]` envelope before returning)
- Test: `test/orchestration/run-serial.test.ts` (add state + index assertions), `test/orchestration/run-parallel.test.ts` (add state + index assertions), `test/orchestration/tool-handlers.test.ts` (assert sync `wait:true` return carries `index` on every result)

- [ ] **Step 2.1: Write failing tests for run-serial state annotation**

Append to `test/orchestration/run-serial.test.ts`:

```ts
describe("runSerial state + index annotation", () => {
  it("annotates every successful step with state: 'completed' and input-order index", async () => {
    const { deps } = fakeDeps([{ finalMessage: "A" }, { finalMessage: "B" }]);
    const out = await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "t2" },
      ],
      {},
      deps,
    );
    assert.equal((out.results[0] as any).state, "completed");
    assert.equal((out.results[0] as any).index, 0);
    assert.equal((out.results[1] as any).state, "completed");
    assert.equal((out.results[1] as any).index, 1);
  });

  it("annotates failing step with state: 'failed'", async () => {
    const { deps } = fakeDeps([{ finalMessage: "A" }, { finalMessage: "bad", exitCode: 2 }]);
    const out = await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "t2" },
      ],
      {},
      deps,
    );
    assert.equal((out.results[0] as any).state, "completed");
    assert.equal((out.results[1] as any).state, "failed");
  });

  it("annotates cancelled step with state: 'cancelled'", async () => {
    const ac = new AbortController();
    ac.abort();
    const { deps } = fakeDeps([{ finalMessage: "" }]);
    const out = await runSerial(
      [{ agent: "x", task: "t1" }, { agent: "x", task: "t2" }],
      { signal: ac.signal },
      deps,
    );
    assert.equal((out.results[0] as any).state, "cancelled");
  });
});
```

- [ ] **Step 2.2: Run test to verify failures**

Run: `node --test test/orchestration/run-serial.test.ts`
Expected: FAIL — `state` is missing.

- [ ] **Step 2.3: Update run-serial.ts to set state + index**

`OrchestrationResult` was already extended with `state`, `index`, `sessionKey`, and `ping` in Task 1.3 — no additional type edits here. In `pi-extension/orchestration/run-serial.ts`, import and annotate every `results.push(...)` with both `state` and `index: i`:

```ts
// At the top of the file, import the type (state + index already on it):
import type {
  LauncherDeps,
  OrchestrationResult,
  OrchestrationState,
  OrchestrationTask,
} from "./types.ts";
```

In `run-serial.ts`, set `state` and `index` on each push:

```ts
// On abort-before-launch:
results.push({
  name: task.name!,
  index: i,
  finalMessage: "",
  transcriptPath: null,
  exitCode: 1,
  elapsedMs: 0,
  error: "cancelled",
  state: "cancelled",
});

// On thrown launch / wait:
result = {
  name: task.name!,
  index: i,
  finalMessage: "",
  transcriptPath: null,
  exitCode: 1,
  elapsedMs: Date.now() - startedAt,
  error: err?.message ?? String(err),
  state: "failed",
};

// After a successful waitForCompletion, annotate before push:
result.index = i;
result.state = result.exitCode === 0 && !result.error ? "completed" : "failed";
```

- [ ] **Step 2.4: Write failing tests for run-parallel state annotation**

Append to `test/orchestration/run-parallel.test.ts`:

```ts
describe("runParallel state + index annotation", () => {
  it("annotates successful tasks with state: 'completed' and failures with 'failed', each with its input-order index", async () => {
    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.task, name: task.name ?? "task", startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        const exit = handle.name === "bad" ? 1 : 0;
        return {
          name: handle.name, finalMessage: "", transcriptPath: null,
          exitCode: exit, elapsedMs: 1,
        };
      },
    };
    const out = await runParallel(
      [
        { name: "ok", agent: "x", task: "t1" },
        { name: "bad", agent: "x", task: "t2" },
      ],
      {},
      deps,
    );
    assert.equal((out.results[0] as any).state, "completed");
    assert.equal((out.results[0] as any).index, 0);
    assert.equal((out.results[1] as any).state, "failed");
    assert.equal((out.results[1] as any).index, 1);
  });

  it("annotates pre-aborted tasks with state: 'cancelled'", async () => {
    const ac = new AbortController();
    ac.abort();
    const deps: LauncherDeps = {
      async launch() { return { id: "x", name: "x", startTime: Date.now() }; },
      async waitForCompletion(h) {
        return { name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
      },
    };
    const out = await runParallel(
      [{ name: "t1", agent: "x", task: "t" }, { name: "t2", agent: "x", task: "t" }],
      { signal: ac.signal },
      deps,
    );
    assert.equal((out.results[0] as any).state, "cancelled");
    assert.equal((out.results[1] as any).state, "cancelled");
  });
});
```

- [ ] **Step 2.5: Run tests to verify failures**

Run: `node --test test/orchestration/run-parallel.test.ts`
Expected: FAIL.

- [ ] **Step 2.6: Update run-parallel.ts**

Mirror the run-serial changes in `run-parallel.ts` — annotate each `result = { ... }` and the post-loop cancellation fill-in with `state` AND `index: i`:

```ts
// On successful wait:
result.index = i;
result.state = result.exitCode === 0 && !result.error ? "completed" : "failed";

// On thrown launch / wait:
result = {
  name: task.name!,
  index: i,
  finalMessage: "",
  transcriptPath: null,
  exitCode: 1,
  elapsedMs: Date.now() - startedAt,
  error: err?.message ?? String(err),
  state: "failed",
};

// On post-loop abort sweep:
results[i] = {
  name: raw.name ?? `task-${i + 1}`,
  index: i,
  finalMessage: "",
  transcriptPath: null,
  exitCode: 1,
  elapsedMs: 0,
  error: "cancelled",
  state: "cancelled",
};
```

- [ ] **Step 2.7: Map sync tool returns to the public envelope (so `wait:true` carries `index`)**

The spec requires every orchestration result — sync or async — to use the `OrchestratedTaskResult` shape, including `index`. Step 2.3 / 2.6 set `index` on the internal `OrchestrationResult`, but the sync tool handler still returns the runner's output object directly. Convert it in `tool-handlers.ts` so the public contract holds.

In `pi-extension/orchestration/tool-handlers.ts`, inside each of the `subagent_run_serial` and `subagent_run_parallel` `execute` handlers, after the existing synchronous `runSerial`/`runParallel` call (i.e. on the `wait: true` / default path), wrap the runner output before returning:

```ts
import type { OrchestratedTaskResult } from "./types.ts";

function toPublicResults(results: OrchestrationResult[]): OrchestratedTaskResult[] {
  return results.map((r, i) => ({
    name: r.name,
    index: r.index ?? i,
    state: r.state ?? (r.exitCode === 0 && !r.error ? "completed" : "failed"),
    finalMessage: r.finalMessage,
    transcriptPath: r.transcriptPath ?? null,
    elapsedMs: r.elapsedMs,
    exitCode: r.exitCode,
    sessionKey: r.sessionKey,
    error: r.error,
    usage: r.usage,
    transcript: r.transcript,
  }));
}

// ...inside each sync execute handler, replacing the current `details: out`:
return {
  content: [/* unchanged */],
  details: {
    ...out,
    results: toPublicResults(out.results),
  },
};
```

This is additive to existing callers: every pre-existing field on the sync return shape is preserved; only `results[i]` is upgraded to the public envelope. The Task 4 rename tests continue to pass because the only key they sort/inspect is `name`, which is preserved.

Add a tool-handler test in `test/orchestration/tool-handlers.test.ts` that asserts `index` is populated on a `wait:true` return:

```ts
it("subagent_run_serial (wait:true) returns results with index on every task per the public envelope", async () => {
  const { api, tools } = makeApi();
  registerOrchestrationTools(api, () => fastDeps, () => true, () => null, () => null);
  const serial = tools.find((t) => t.name === "subagent_run_serial");
  const out = await serial.execute(
    "s1",
    { tasks: [{ agent: "x", task: "t1" }, { agent: "x", task: "t2" }] },
    new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" },
  );
  assert.equal(out.details.results[0].index, 0);
  assert.equal(out.details.results[1].index, 1);
  assert.equal(out.details.results[0].state, "completed");
});
```

Mirror the assertion for `subagent_run_parallel`.

- [ ] **Step 2.8: Run both test files, confirm passes**

Run: `node --test test/orchestration/run-serial.test.ts test/orchestration/run-parallel.test.ts test/orchestration/tool-handlers.test.ts`
Expected: PASS.

- [ ] **Step 2.9: Commit**

```bash
git add pi-extension/orchestration/types.ts pi-extension/orchestration/run-serial.ts pi-extension/orchestration/run-parallel.ts pi-extension/orchestration/tool-handlers.ts test/orchestration/run-serial.test.ts test/orchestration/run-parallel.test.ts test/orchestration/tool-handlers.test.ts
git commit -m "feat(orchestration): annotate sync results with lifecycle state + envelope index"
```

---

### Task 3: Build the orchestration registry core

**Files:**
- Create: `pi-extension/orchestration/registry.ts`
- Create: `pi-extension/orchestration/notification-kinds.ts`
- Create: `test/orchestration/registry.test.ts`

- [ ] **Step 3.1: Write failing tests**

```ts
// test/orchestration/registry.test.ts
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, type RegistryEmitter } from "../../pi-extension/orchestration/registry.ts";
import type { OrchestratedTaskResult } from "../../pi-extension/orchestration/types.ts";

function makeEmitterSpy(): { emitter: RegistryEmitter; emitted: any[] } {
  const emitted: any[] = [];
  return {
    emitted,
    emitter: (payload) => { emitted.push(payload); },
  };
}

describe("createRegistry", () => {
  it("generates a unique 8-char hex orchestrationId per dispatch", () => {
    const { emitter } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id1 = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ agent: "x", task: "t1" }] },
    });
    const id2 = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ agent: "x", task: "t1" }] },
    });
    assert.notEqual(id1, id2);
    assert.match(id1, /^[0-9a-f]{8}$/);
    assert.match(id2, /^[0-9a-f]{8}$/);
  });

  it("initializes tasks as pending in input order", () => {
    const { emitter } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: {
        mode: "parallel",
        tasks: [
          { name: "a", agent: "x", task: "t1" },
          { name: "b", agent: "x", task: "t2" },
        ],
      },
    });
    const snap = reg.getSnapshot(id);
    assert.ok(snap);
    assert.equal(snap.tasks.length, 2);
    assert.equal(snap.tasks[0].state, "pending");
    assert.equal(snap.tasks[0].name, "a");
    assert.equal(snap.tasks[1].name, "b");
  });

  it("emits a single aggregated completion when every task is terminal", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: {
        mode: "parallel",
        tasks: [{ name: "a", agent: "x", task: "t1" }, { name: "b", agent: "x", task: "t2" }],
      },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "s0" });
    reg.onTaskLaunched(id, 1, { sessionKey: "s1" });
    reg.onTaskTerminal(id, 0, {
      name: "a", index: 0, state: "completed", finalMessage: "ok-a", exitCode: 0, elapsedMs: 1,
    });
    assert.equal(emitted.length, 0, "should not fire until every task terminal");
    reg.onTaskTerminal(id, 1, {
      name: "b", index: 1, state: "completed", finalMessage: "ok-b", exitCode: 0, elapsedMs: 1,
    });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].kind, "orchestration_complete");
    assert.equal(emitted[0].orchestrationId, id);
    assert.equal(emitted[0].isError, false);
    assert.deepEqual(emitted[0].results.map((r: any) => r.state), ["completed", "completed"]);
  });

  it("reports isError:true when any task is non-completed at aggregation", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: {
        mode: "parallel",
        tasks: [{ name: "a", agent: "x", task: "t1" }, { name: "b", agent: "x", task: "t2" }],
      },
    });
    reg.onTaskTerminal(id, 0, {
      name: "a", index: 0, state: "completed", exitCode: 0, elapsedMs: 1,
    });
    reg.onTaskTerminal(id, 1, {
      name: "b", index: 1, state: "failed", exitCode: 2, elapsedMs: 1, error: "boom",
    });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].isError, true);
  });

  it("cancel transitions non-terminal tasks to cancelled and emits once", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: {
        mode: "parallel",
        tasks: [{ name: "a", agent: "x", task: "t1" }, { name: "b", agent: "x", task: "t2" }],
      },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "s0" });
    // task 1 still pending
    const res = reg.cancel(id);
    assert.deepEqual(res, { ok: true });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].isError, true);
    const states = emitted[0].results.map((r: any) => r.state);
    assert.deepEqual(states, ["cancelled", "cancelled"]);
  });

  it("cancel is idempotent on already-terminal orchestrations", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskTerminal(id, 0, { name: "a", index: 0, state: "completed", exitCode: 0, elapsedMs: 1 });
    assert.equal(emitted.length, 1);
    const res = reg.cancel(id);
    assert.deepEqual(res, { ok: true, alreadyTerminal: true });
    assert.equal(emitted.length, 1, "no duplicate completion on second cancel");
  });

  it("cancel on unknown id returns alreadyTerminal:true without throwing", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const res = reg.cancel("deadbeef");
    assert.deepEqual(res, { ok: true, alreadyTerminal: true });
    assert.equal(emitted.length, 0);
  });

  it("fires the RegistryHooks.onTaskTerminal hook on every per-task terminal transition", () => {
    const { emitter } = makeEmitterSpy();
    const taskTerminals: Array<{ orchestrationId: string; taskIndex: number; state: string }> = [];
    const reg = createRegistry(emitter, {
      onTaskTerminal: (ctx) => { taskTerminals.push(ctx); },
    });
    const id = reg.dispatchAsync({
      config: {
        mode: "parallel",
        tasks: [{ name: "a", agent: "x", task: "t1" }, { name: "b", agent: "x", task: "t2" }],
      },
    });
    reg.onTaskTerminal(id, 0, { name: "a", index: 0, state: "completed", exitCode: 0, elapsedMs: 1 });
    assert.deepEqual(taskTerminals, [{ orchestrationId: id, taskIndex: 0, state: "completed" }]);
    reg.onTaskTerminal(id, 1, { name: "b", index: 1, state: "failed", exitCode: 2, elapsedMs: 1 });
    assert.equal(taskTerminals.length, 2);
    assert.equal(taskTerminals[1].state, "failed");
  });

  it("fires onTaskTerminal for every slot transitioned by cancel()", () => {
    const { emitter } = makeEmitterSpy();
    const taskTerminals: Array<{ taskIndex: number; state: string }> = [];
    const reg = createRegistry(emitter, {
      onTaskTerminal: (ctx) => { taskTerminals.push({ taskIndex: ctx.taskIndex, state: ctx.state }); },
    });
    const id = reg.dispatchAsync({
      config: {
        mode: "parallel",
        tasks: [{ name: "a", agent: "x", task: "t1" }, { name: "b", agent: "x", task: "t2" }],
      },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "s0" });
    reg.cancel(id);
    assert.equal(taskTerminals.length, 2);
    assert.ok(taskTerminals.every((t) => t.state === "cancelled"));
  });

  it("updateSessionKey late-binds a key for a task launched without one (Claude-backed path)", () => {
    const { emitter } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    // Simulate Claude-backed launch: sessionKey not known yet.
    reg.onTaskLaunched(id, 0, {});
    assert.equal(reg.lookupOwner("claude-sess-xyz"), null);
    // The backend learns the Claude session id from system/init and calls:
    reg.updateSessionKey(id, 0, "claude-sess-xyz");
    const owner = reg.lookupOwner("claude-sess-xyz");
    assert.ok(owner);
    assert.equal(owner!.orchestrationId, id);
    assert.equal(owner!.taskIndex, 0);
    assert.equal(reg.getSnapshot(id)!.tasks[0].sessionKey, "claude-sess-xyz");
  });

  it("updateSessionKey is a no-op when a key is already recorded for the slot", () => {
    const { emitter } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "/tmp/path.jsonl" });
    reg.updateSessionKey(id, 0, "claude-should-not-override");
    // The original pi path remains the owner; the Claude id does NOT alias.
    assert.equal(reg.lookupOwner("/tmp/path.jsonl")!.orchestrationId, id);
    assert.equal(reg.lookupOwner("claude-should-not-override"), null);
  });

  it("a late-bound sessionKey routes subsequent onTaskBlocked / onResumeTerminal via ownership", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, {}); // Claude-backed: no sessionKey at launch
    reg.updateSessionKey(id, 0, "claude-sess-xyz");
    reg.onTaskBlocked(id, 0, { sessionKey: "claude-sess-xyz", message: "?" });
    assert.equal(emitted[0].kind, "blocked");
    assert.equal(emitted[0].sessionKey, "claude-sess-xyz");
    reg.onResumeTerminal("claude-sess-xyz", {
      name: "a", index: 0, state: "completed", finalMessage: "ok", exitCode: 0, elapsedMs: 1,
    });
    const complete = emitted.find((e) => e.kind === "orchestration_complete");
    assert.ok(complete);
    assert.equal(complete!.results[0].state, "completed");
  });
});
```

- [ ] **Step 3.2: Run to confirm fail**

Run: `node --test test/orchestration/registry.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3.3: Create notification-kinds module**

```ts
// pi-extension/orchestration/notification-kinds.ts

/** customType on the steer-back Message when an async orchestration completes. */
export const ORCHESTRATION_COMPLETE_KIND = "orchestration_complete";

/**
 * customType on the steer-back Message when an async task transitions to blocked.
 * Value matches the spec's public API kind exactly.
 */
export const BLOCKED_KIND = "blocked";
```

- [ ] **Step 3.4: Create the registry module**

```ts
// pi-extension/orchestration/registry.ts
import { randomBytes } from "node:crypto";
import type {
  OrchestratedTaskResult,
  OrchestrationState,
  OrchestrationTask,
} from "./types.ts";
import {
  ORCHESTRATION_COMPLETE_KIND,
  BLOCKED_KIND,
} from "./notification-kinds.ts";

export type OrchestrationMode = "serial" | "parallel";

export interface OrchestrationConfig {
  mode: OrchestrationMode;
  tasks: OrchestrationTask[];
  maxConcurrency?: number;
}

export interface OrchestrationCompleteEvent {
  kind: typeof ORCHESTRATION_COMPLETE_KIND;
  orchestrationId: string;
  results: OrchestratedTaskResult[];
  isError: boolean;
}

export interface OrchestrationBlockedEvent {
  kind: typeof BLOCKED_KIND;
  orchestrationId: string;
  taskIndex: number;
  taskName: string;
  /**
   * The identifier the parent will pass back via the existing
   * `subagent_resume({ sessionPath })` tool — for pi-backed children this is
   * the subagent session file path; for Claude-backed children it is the
   * Claude session id. Field name matches the spec's public API surface.
   */
  sessionKey: string;
  message: string;
}

export type RegistryEmission =
  | OrchestrationCompleteEvent
  | OrchestrationBlockedEvent;

export type RegistryEmitter = (payload: RegistryEmission) => void;

/**
 * Internal in-process subscriber for per-task lifecycle transitions. NOT a
 * user-facing notification kind — this fires alongside the emitter so the
 * extension layer can clear virtual widget rows as soon as a specific slot
 * transitions to a terminal state, even if the rest of the orchestration is
 * still running. Spec's "no per-task intermediate notifications" rule applies
 * to steer-back notifications; this local hook is not a notification.
 */
export interface RegistryHooks {
  onTaskTerminal?: (ctx: {
    orchestrationId: string;
    taskIndex: number;
    state: OrchestrationState; // always one of completed | failed | cancelled
  }) => void;
}

interface OrchestrationEntry {
  id: string;
  config: OrchestrationConfig;
  tasks: OrchestratedTaskResult[];
  overallState: "running" | "completed";
  sessionKeys: Map<number, string>; // taskIndex -> sessionKey (when known)
}

export interface Registry {
  dispatchAsync(params: { config: OrchestrationConfig }): string;
  /**
   * Called once per task after `deps.launch` returns. `sessionKey` is the
   * same identifier the parent will later hand to `subagent_resume` — the
   * session file path for pi children, the Claude session id for Claude
   * children. Populates the ownership map so any subsequent resume can
   * route back to the owning `(orchestrationId, taskIndex)`.
   */
  onTaskLaunched(orchestrationId: string, taskIndex: number, info: { sessionKey?: string }): void;
  /**
   * Late-bind a `sessionKey` that was not known at launch time. Claude-backed
   * children learn their session id from the `system/init` event, after
   * `onTaskLaunched` has already fired. Backends call this when that event
   * arrives (see Task 9.5). No-op if the task already has a `sessionKey`
   * recorded or if the orchestration/task does not exist. Must NOT change
   * task state — only populates the ownership map and the per-task
   * `sessionKey` field so later blocked routing and resume re-ingestion work.
   */
  updateSessionKey(orchestrationId: string, taskIndex: number, sessionKey: string): void;
  onTaskTerminal(orchestrationId: string, taskIndex: number, result: OrchestratedTaskResult): void;
  onTaskBlocked(orchestrationId: string, taskIndex: number, payload: {
    sessionKey: string;
    message: string;
    partial?: Partial<OrchestratedTaskResult>;
  }): void;
  /**
   * Called when a standalone `subagent_resume` finishes on an orch-owned
   * session. If the slot was `blocked`, restarts serial continuation (for
   * serial runs) and re-evaluates aggregation (for parallel runs).
   */
  onResumeTerminal(sessionKey: string, result: OrchestratedTaskResult): void;
  cancel(orchestrationId: string): { ok: true; alreadyTerminal?: boolean };
  getSnapshot(orchestrationId: string): { tasks: OrchestratedTaskResult[] } | null;
  lookupOwner(sessionKey: string): { orchestrationId: string; taskIndex: number } | null;
  listActive(): string[];
}

function newHexId(): string {
  return randomBytes(4).toString("hex");
}

function isTerminalState(s: OrchestrationState): boolean {
  return s === "completed" || s === "failed" || s === "cancelled";
}

export function createRegistry(emit: RegistryEmitter, hooks: RegistryHooks = {}): Registry {
  const entries = new Map<string, OrchestrationEntry>();
  const ownership = new Map<string, { orchestrationId: string; taskIndex: number }>();

  function notifyTaskTerminal(orchestrationId: string, taskIndex: number, state: OrchestrationState): void {
    try {
      hooks.onTaskTerminal?.({ orchestrationId, taskIndex, state });
    } catch {
      // Defensive: hook errors must never break registry state transitions.
    }
  }

  function tryFinalize(entry: OrchestrationEntry): void {
    if (entry.overallState !== "running") return;
    const allTerminal = entry.tasks.every((t) => isTerminalState(t.state));
    if (!allTerminal) return;
    entry.overallState = "completed";
    const isError = entry.tasks.some((t) => t.state !== "completed");
    emit({
      kind: ORCHESTRATION_COMPLETE_KIND,
      orchestrationId: entry.id,
      results: entry.tasks.map((t) => ({ ...t })),
      isError,
    });
    // Clear ownership entries for this orchestration.
    for (const [key, own] of ownership) {
      if (own.orchestrationId === entry.id) ownership.delete(key);
    }
  }

  return {
    dispatchAsync({ config }) {
      const id = newHexId();
      const tasks: OrchestratedTaskResult[] = config.tasks.map((t, i) => ({
        name: t.name ?? (config.mode === "serial" ? `step-${i + 1}` : `task-${i + 1}`),
        index: i,
        state: "pending",
      }));
      entries.set(id, {
        id,
        config,
        tasks,
        overallState: "running",
        sessionKeys: new Map(),
      });
      return id;
    },

    onTaskLaunched(orchestrationId, taskIndex, info) {
      const entry = entries.get(orchestrationId);
      if (!entry) return;
      const task = entry.tasks[taskIndex];
      if (!task) return;
      if (task.state === "pending") task.state = "running";
      if (info.sessionKey) {
        entry.sessionKeys.set(taskIndex, info.sessionKey);
        ownership.set(info.sessionKey, { orchestrationId, taskIndex });
        task.sessionKey = info.sessionKey;
      }
    },

    updateSessionKey(orchestrationId, taskIndex, sessionKey) {
      const entry = entries.get(orchestrationId);
      if (!entry) return;
      const task = entry.tasks[taskIndex];
      if (!task) return;
      // No-op if we already have a key for this slot. Late-binding is only
      // meant to fill in Claude session ids that were not available at launch.
      if (entry.sessionKeys.has(taskIndex)) return;
      entry.sessionKeys.set(taskIndex, sessionKey);
      ownership.set(sessionKey, { orchestrationId, taskIndex });
      task.sessionKey = sessionKey;
    },

    onTaskTerminal(orchestrationId, taskIndex, result) {
      const entry = entries.get(orchestrationId);
      if (!entry) return;
      const existing = entry.tasks[taskIndex];
      if (!existing) return;
      // Merge: keep pre-terminal sessionKey / name if missing in result.
      entry.tasks[taskIndex] = {
        ...existing,
        ...result,
        name: result.name ?? existing.name,
        index: taskIndex,
      };
      // Clear ownership for this sessionKey — no longer blockable/resumable.
      const key = entry.sessionKeys.get(taskIndex);
      if (key) ownership.delete(key);
      const finalState = entry.tasks[taskIndex].state;
      if (isTerminalState(finalState)) {
        notifyTaskTerminal(orchestrationId, taskIndex, finalState);
      }
      tryFinalize(entry);
    },

    onTaskBlocked(orchestrationId, taskIndex, payload) {
      const entry = entries.get(orchestrationId);
      if (!entry) return;
      const existing = entry.tasks[taskIndex];
      if (!existing) return;
      entry.tasks[taskIndex] = {
        ...existing,
        ...(payload.partial ?? {}),
        state: "blocked",
        sessionKey: payload.sessionKey,
        index: taskIndex,
      };
      entry.sessionKeys.set(taskIndex, payload.sessionKey);
      ownership.set(payload.sessionKey, { orchestrationId, taskIndex });
      emit({
        kind: BLOCKED_KIND,
        orchestrationId,
        taskIndex,
        taskName: entry.tasks[taskIndex].name,
        sessionKey: payload.sessionKey,
        message: payload.message,
      });
    },

    onResumeTerminal(sessionKey, result) {
      const own = ownership.get(sessionKey);
      if (!own) return;
      this.onTaskTerminal(own.orchestrationId, own.taskIndex, result);
    },

    cancel(orchestrationId) {
      const entry = entries.get(orchestrationId);
      if (!entry || entry.overallState !== "running") {
        return { ok: true, alreadyTerminal: true };
      }
      const cancelledIndices: number[] = [];
      for (let i = 0; i < entry.tasks.length; i++) {
        const t = entry.tasks[i];
        if (!isTerminalState(t.state)) {
          entry.tasks[i] = {
            ...t,
            state: "cancelled",
            exitCode: t.exitCode ?? 1,
            error: t.error ?? "cancelled",
          };
          cancelledIndices.push(i);
        }
      }
      for (const idx of cancelledIndices) {
        notifyTaskTerminal(orchestrationId, idx, "cancelled");
      }
      tryFinalize(entry);
      return { ok: true };
    },

    getSnapshot(orchestrationId) {
      const entry = entries.get(orchestrationId);
      if (!entry) return null;
      return { tasks: entry.tasks.map((t) => ({ ...t })) };
    },

    lookupOwner(sessionKey) {
      const own = ownership.get(sessionKey);
      return own ? { ...own } : null;
    },

    listActive() {
      return [...entries.values()]
        .filter((e) => e.overallState === "running")
        .map((e) => e.id);
    },
  };
}
```

- [ ] **Step 3.5: Run tests**

Run: `node --test test/orchestration/registry.test.ts`
Expected: PASS all 7 tests.

- [ ] **Step 3.6: Commit**

```bash
git add pi-extension/orchestration/registry.ts pi-extension/orchestration/notification-kinds.ts test/orchestration/registry.test.ts
git commit -m "feat(orchestration): add in-process registry for async runs"
```

---

### Task 4: Rename the orchestration tools (breaking)

**Files:**
- Modify: `pi-extension/orchestration/tool-handlers.ts`
- Modify: `pi-extension/subagents/launch-spec.ts`
- Modify: `test/orchestration/tool-handlers.test.ts`
- Modify: `test/orchestration/launch-spec.test.ts`
- Modify: `test/integration/orchestration-headless-no-mux.test.ts`

- [ ] **Step 4.1: Rewrite the tool-handlers tests against the new names**

In `test/orchestration/tool-handlers.test.ts`, replace every occurrence of:

- `"subagent_serial"` → `"subagent_run_serial"`
- `"subagent_parallel"` → `"subagent_run_parallel"`

(e.g., the `names.sort()` assertion becomes `["subagent_run_parallel", "subagent_run_serial"]`; `tools.find((t) => t.name === "subagent_serial")` becomes `"subagent_run_serial"`.)

Also replace error message assertions that mention the old names. The throw in `run-parallel.ts` currently says `subagent_parallel: maxConcurrency=...`; update that string (and its test assertion) to `subagent_run_parallel: maxConcurrency=...`. Similarly the `subagent_serial error:` summary line in `tool-handlers.ts` becomes `subagent_run_serial error:`.

- [ ] **Step 4.2: Run tests to verify failures**

Run: `node --test test/orchestration/tool-handlers.test.ts`
Expected: FAIL — old names still registered.

- [ ] **Step 4.3: Update tool-handlers.ts to register new names**

In `pi-extension/orchestration/tool-handlers.ts`:

```ts
if (shouldRegister("subagent_run_serial")) {
  pi.registerTool({
    name: "subagent_run_serial",
    label: "Serial Subagents",
    // ...existing description/promptSnippet unchanged...
    // ...
  });
}

if (shouldRegister("subagent_run_parallel")) {
  pi.registerTool({
    name: "subagent_run_parallel",
    // ...
  });
}
```

Update the error-summary strings inside each `catch`:

```ts
content: [{ type: "text", text: `subagent_run_serial error: ${err?.message ?? String(err)}` }],
```

and in the parallel hint:

```ts
const hint = msg.includes("hard cap")
  ? msg
  : `subagent_run_parallel error: ${msg}`;
```

In `pi-extension/orchestration/run-parallel.ts`, update the hard-cap error message:

```ts
throw new Error(
  `subagent_run_parallel: maxConcurrency=${cap} exceeds hard cap ${MAX_PARALLEL_HARD_CAP}. Split into sub-waves.`,
);
```

and:

```ts
throw new Error(`subagent_run_parallel: maxConcurrency=${cap} must be >= 1.`);
```

- [ ] **Step 4.4: Update SPAWNING_TOOLS**

In `pi-extension/subagents/launch-spec.ts`:

```ts
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagents_list",
  "subagent_resume",
  "subagent_run_serial",
  "subagent_run_parallel",
  "subagent_run_cancel",
]);
```

- [ ] **Step 4.5: Update adjacent tests**

In `test/orchestration/launch-spec.test.ts` and `test/integration/orchestration-headless-no-mux.test.ts`, replace every `subagent_serial` / `subagent_parallel` tool-name literal with the renamed version. Integration test file may reference both — check with Grep and update all occurrences.

Run: `grep -rn "subagent_serial\|subagent_parallel" test/` and update every hit.

- [ ] **Step 4.6: Run the tests**

Run: `node --test test/orchestration/*.test.ts test/integration/orchestration-headless-no-mux.test.ts`
Expected: PASS.

- [ ] **Step 4.7: Verify old names are gone**

Run: `grep -rn "subagent_serial\|subagent_parallel" pi-extension/ test/ | grep -v "\.pi/" | grep -v "#"`
Expected: no hits outside docs/specs.

- [ ] **Step 4.8: Commit**

```bash
git add pi-extension/orchestration/ pi-extension/subagents/launch-spec.ts test/orchestration/ test/integration/orchestration-headless-no-mux.test.ts
git commit -m "refactor(orchestration): rename to subagent_run_{serial,parallel}"
```

---

### Task 5: Add `wait: false` async dispatch path

**Files:**
- Modify: `pi-extension/orchestration/tool-handlers.ts`
- Modify: `pi-extension/subagents/index.ts`
- Create: `test/orchestration/async-dispatch.test.ts`

- [ ] **Step 5.1: Write failing tests for async dispatch**

```ts
// test/orchestration/async-dispatch.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import { createRegistry } from "../../pi-extension/orchestration/registry.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

function makeApi() {
  const tools: any[] = [];
  return {
    tools,
    api: {
      registerTool: (t: any) => { tools.push(t); },
      on() {},
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      sendUserMessage() {},
    } as any,
  };
}

const slowDeps: LauncherDeps = {
  async launch(task) {
    return { id: task.task, name: task.name ?? "step", startTime: Date.now() };
  },
  async waitForCompletion(handle) {
    await new Promise((r) => setTimeout(r, 50));
    return { name: handle.name, finalMessage: "ok", transcriptPath: null, exitCode: 0, elapsedMs: 50 };
  },
};

describe("wait: false async dispatch", () => {
  it("subagent_run_serial with wait:false returns an envelope immediately (before any task completes)", async () => {
    const emitted: any[] = [];
    const registry = createRegistry((p) => emitted.push(p));
    const { api, tools } = makeApi();
    registerOrchestrationTools(api, () => slowDeps, () => true, () => null, () => null, { registry });
    const serial = tools.find((t) => t.name === "subagent_run_serial");

    const t0 = Date.now();
    const out = await serial.execute(
      "call-1",
      { wait: false, tasks: [{ agent: "x", task: "t1" }, { agent: "x", task: "t2" }] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 30, `async dispatch should return <30ms, got ${elapsed}`);
    assert.equal(out.details.isError, false);
    assert.ok(out.details.orchestrationId);
    assert.match(out.details.orchestrationId, /^[0-9a-f]{8}$/);
    assert.equal(out.details.tasks.length, 2);
    assert.equal(out.details.tasks[0].state, "pending");
    assert.equal(out.details.tasks[0].index, 0);
    // Wait for background completion, confirm steer-back emission.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].kind, "orchestration_complete");
    assert.equal(emitted[0].orchestrationId, out.details.orchestrationId);
  });

  it("subagent_run_parallel with wait:true (default) keeps sync shape", async () => {
    const registry = createRegistry(() => {});
    const { api, tools } = makeApi();
    registerOrchestrationTools(api, () => slowDeps, () => true, () => null, () => null, { registry });
    const parallel = tools.find((t) => t.name === "subagent_run_parallel");
    const out = await parallel.execute(
      "call-2",
      { tasks: [{ agent: "x", task: "t1" }] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.equal(out.details.results.length, 1);
    assert.equal(out.details.orchestrationId, undefined);
    assert.equal(out.details.results[0].state, "completed");
  });

  it("two concurrent async dispatches get independent ids and independent completions", async () => {
    const emitted: any[] = [];
    const registry = createRegistry((p) => emitted.push(p));
    const { api, tools } = makeApi();
    registerOrchestrationTools(api, () => slowDeps, () => true, () => null, () => null, { registry });
    const serial = tools.find((t) => t.name === "subagent_run_serial");

    const [a, b] = await Promise.all([
      serial.execute("c-a", { wait: false, tasks: [{ agent: "x", task: "t" }] },
        new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" }),
      serial.execute("c-b", { wait: false, tasks: [{ agent: "x", task: "t" }] },
        new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" }),
    ]);
    assert.notEqual(a.details.orchestrationId, b.details.orchestrationId);
    await new Promise((r) => setTimeout(r, 200));
    const ids = new Set(emitted.map((e) => e.orchestrationId));
    assert.equal(ids.size, 2);
    assert.ok(ids.has(a.details.orchestrationId));
    assert.ok(ids.has(b.details.orchestrationId));
  });
});
```

- [ ] **Step 5.2: Run test to confirm failure**

Run: `node --test test/orchestration/async-dispatch.test.ts`
Expected: FAIL — `wait` field unknown, registry not injected, no async path.

- [ ] **Step 5.3: Add `wait` to the schema**

In `pi-extension/orchestration/tool-handlers.ts`:

```ts
const SerialParams = Type.Object({
  tasks: Type.Array(OrchestrationTaskSchema),
  wait: Type.Optional(Type.Boolean({ description: "Default true. Set false to dispatch asynchronously; tool returns immediately with { orchestrationId, tasks } and delivers aggregated results via steer-back." })),
});

const ParallelParams = Type.Object({
  tasks: Type.Array(OrchestrationTaskSchema),
  maxConcurrency: Type.Optional(Type.Number()),
  wait: Type.Optional(Type.Boolean({ description: "Default true. Set false to dispatch asynchronously; tool returns immediately with { orchestrationId, tasks } and delivers aggregated results via steer-back." })),
});
```

- [ ] **Step 5.4: Extend the registrar signature**

In the same file, extend `registerOrchestrationTools` to accept a registry:

```ts
import type { Registry } from "./registry.ts";

export interface OrchestrationRegistrarExtras {
  registry?: Registry;
}

export function registerOrchestrationTools(
  pi: ExtensionAPI,
  depsFactory: (ctx: { sessionManager: any; cwd: string }) => LauncherDeps,
  shouldRegister: (name: string) => boolean,
  preflight: PreflightFn = () => null,
  selfSpawn: SelfSpawnCheckFn = () => null,
  extras: OrchestrationRegistrarExtras = {},
) {
  const registry = extras.registry;
  // ...
}
```

- [ ] **Step 5.5: Add the async branch to serial.execute**

Inside the serial `execute` handler, before the existing synchronous `runSerial` call:

```ts
if (params.wait === false) {
  if (!registry) {
    return {
      content: [{ type: "text", text: "Async orchestration unavailable: registry not configured." }],
      details: { error: "registry unavailable" },
    };
  }
  const orchestrationId = registry.dispatchAsync({
    config: { mode: "serial", tasks: params.tasks },
  });
  const deps = depsFactory(ctx);
  // Fire-and-forget: background execution with registry bookkeeping.
  (async () => {
    try {
      const out = await runSerial(params.tasks, {
        // No signal: async runs are cancelled via subagent_run_cancel, not AbortSignal.
        onLaunched: (taskIndex, info) => registry.onTaskLaunched(orchestrationId, taskIndex, info),
        onTerminal: (taskIndex, result) => registry.onTaskTerminal(orchestrationId, taskIndex, result),
        // Phase 2 also wires onBlocked here (see Task 10). Left unset in Phase 1.
      }, deps);
      // Task 10 extends this dispatcher with a `blocked` branch that returns
      // without running the sweep. In Phase 1 (no blocked state yet) the sweep
      // runs unconditionally on terminal exits and is safe.
      const snap = registry.getSnapshot(orchestrationId);
      if (snap) {
        for (const t of snap.tasks) {
          if (t.state === "pending" || t.state === "running") {
            registry.onTaskTerminal(orchestrationId, t.index, {
              ...t, state: "cancelled", exitCode: 1, error: t.error ?? "not launched",
            });
          }
        }
      }
      void out;
    } catch (err: any) {
      // Catastrophic failure: mark every non-terminal slot as failed.
      const snap = registry.getSnapshot(orchestrationId);
      if (snap) {
        for (const t of snap.tasks) {
          if (t.state === "pending" || t.state === "running" || t.state === "blocked") {
            registry.onTaskTerminal(orchestrationId, t.index, {
              ...t, state: "failed", exitCode: 1, error: err?.message ?? String(err),
            });
          }
        }
      }
    }
  })();
  const envelope = {
    orchestrationId,
    tasks: params.tasks.map((t, i) => ({
      name: t.name ?? `step-${i + 1}`,
      index: i,
      state: "pending" as const,
    })),
    isError: false as const,
  };
  return {
    content: [{
      type: "text",
      text:
        `Orchestration "${orchestrationId}" started asynchronously (${params.tasks.length} task(s)). ` +
        `Do NOT assume results — aggregated completion will be delivered via a steer message.`,
    }],
    details: envelope,
  };
}
// (existing sync path below)
```

Mirror the same change in the `subagent_run_parallel` handler: branch on `params.wait === false`, dispatch via the registry, call `runParallel` with the hook options.

- [ ] **Step 5.6: Plumb `onLaunched` / `onTerminal` hooks through run-serial / run-parallel**

In `run-serial.ts`, extend `RunSerialOpts`:

```ts
export interface RunSerialOpts {
  signal?: AbortSignal;
  onUpdate?: (content: { content: { type: "text"; text: string }[]; details: any }) => void;
  /**
   * Registry hook: called just after `deps.launch` resolves. `sessionKey` is
   * the stable resume-addressable identifier for the launched child (session
   * file path for pi, Claude session id for Claude). Populated from
   * `LaunchedHandle.sessionKey` when the backend provides it.
   */
  onLaunched?: (taskIndex: number, info: { sessionKey?: string }) => void;
  /** Registry hook: called once per task as soon as its terminal state is known. */
  onTerminal?: (taskIndex: number, result: OrchestratedTaskResult) => void;
}
```

Call the hooks at the appropriate points — just after `deps.launch`:

```ts
const handle = await deps.launch(task, true, opts.signal);
opts.onLaunched?.(i, { sessionKey: handle.sessionKey });
```

And immediately after each `results.push(result)` completes the step — convert the `OrchestrationResult` to an `OrchestratedTaskResult` shape with `index: i`:

```ts
opts.onTerminal?.(i, {
  name: result.name,
  index: i,
  state: result.state ?? (result.exitCode === 0 && !result.error ? "completed" : "failed"),
  finalMessage: result.finalMessage,
  transcriptPath: result.transcriptPath ?? null,
  elapsedMs: result.elapsedMs,
  exitCode: result.exitCode,
  sessionKey: result.sessionKey,
  error: result.error,
  usage: result.usage,
  transcript: result.transcript,
});
```

Mirror the plumbing in `run-parallel.ts` — the worker loop calls `onLaunched` after `deps.launch` resolves and `onTerminal` after writing `results[i]`.

- [ ] **Step 5.7: Wire the registry in index.ts**

In `pi-extension/subagents/index.ts`, at the bottom of `subagentsExtension`:

```ts
import { createRegistry, type Registry } from "../orchestration/registry.ts";
import {
  ORCHESTRATION_COMPLETE_KIND,
  BLOCKED_KIND,
} from "../orchestration/notification-kinds.ts";

// Inside subagentsExtension(pi):
const registry: Registry = createRegistry(
  (payload) => {
    if (payload.kind === ORCHESTRATION_COMPLETE_KIND) {
      pi.sendMessage({
        customType: "orchestration_complete",
        content:
          `Orchestration "${payload.orchestrationId}" completed ` +
          `(${payload.results.length} task(s), isError=${payload.isError}).`,
        display: true,
        details: payload,
      }, { triggerTurn: true, deliverAs: "steer" });
    } else if (payload.kind === BLOCKED_KIND) {
      pi.sendMessage({
        customType: BLOCKED_KIND, // "blocked"
        content:
          `Task "${payload.taskName}" in orchestration "${payload.orchestrationId}" is blocked:\n\n${payload.message}`,
        display: true,
        details: payload,
      }, { triggerTurn: true, deliverAs: "steer" });
    }
  },
  {
    // Per-task terminal hook. Task 13 uses this to clear virtual blocked
    // widget rows the instant a specific (orchestrationId, taskIndex) slot
    // reaches a terminal state — regardless of whether the whole
    // orchestration is still running. This is NOT a notification kind; it
    // is an internal in-process signal only.
    onTaskTerminal: ({ orchestrationId, taskIndex }) => {
      onOrchestrationTaskTerminal(orchestrationId, taskIndex);
    },
  },
);

registerOrchestrationTools(
  pi,
  (ctx) => makeDefaultDeps(ctx),
  shouldRegister,
  preflightOrchestration,
  selfSpawnBlocked,
  { registry },
);
```

Declare a module-level `onOrchestrationTaskTerminal(orchestrationId, taskIndex)` stub near the top of `subagentsExtension`. Task 13 fills it in with virtual-widget cleanup logic; Task 5 leaves it as a no-op so the Task 5 tests keep passing.

- [ ] **Step 5.8: Run tests**

Run: `node --test test/orchestration/async-dispatch.test.ts test/orchestration/tool-handlers.test.ts test/orchestration/run-serial.test.ts test/orchestration/run-parallel.test.ts`
Expected: PASS.

- [ ] **Step 5.9: Run full typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 5.10: Commit**

```bash
git add pi-extension/orchestration/ pi-extension/subagents/index.ts test/orchestration/async-dispatch.test.ts
git commit -m "feat(orchestration): async dispatch with wait:false and steer-back completion"
```

---

### Task 6: Add `subagent_run_cancel` tool

**Files:**
- Modify: `pi-extension/orchestration/tool-handlers.ts`
- Create: `test/orchestration/cancel.test.ts`

- [ ] **Step 6.1: Write failing test**

```ts
// test/orchestration/cancel.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import { createRegistry } from "../../pi-extension/orchestration/registry.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

function makeApi() {
  const tools: any[] = [];
  return {
    tools,
    api: {
      registerTool: (t: any) => { tools.push(t); },
      on() {}, registerCommand() {}, registerMessageRenderer() {},
      sendMessage() {}, sendUserMessage() {},
    } as any,
  };
}

const foreverDeps: LauncherDeps = {
  async launch(task) { return { id: task.task, name: task.name ?? "step", startTime: Date.now() }; },
  async waitForCompletion() {
    return new Promise(() => {}); // never resolves
  },
};

describe("subagent_run_cancel", () => {
  it("cancels a running async orchestration and emits aggregated completion", async () => {
    const emitted: any[] = [];
    const registry = createRegistry((p) => emitted.push(p));
    const { api, tools } = makeApi();
    registerOrchestrationTools(api, () => foreverDeps, () => true, () => null, () => null, { registry });
    const serial = tools.find((t) => t.name === "subagent_run_serial");
    const cancelTool = tools.find((t) => t.name === "subagent_run_cancel");
    assert.ok(cancelTool, "subagent_run_cancel must be registered");

    const envelope = await serial.execute(
      "c1",
      { wait: false, tasks: [{ agent: "x", task: "t1" }, { agent: "x", task: "t2" }] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );

    // Give the background runner a tick to launch task 0.
    await new Promise((r) => setTimeout(r, 10));
    const res = await cancelTool.execute(
      "c1-cancel",
      { orchestrationId: envelope.details.orchestrationId },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.equal(res.details.ok, true);

    // One completion event with all cancelled.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].kind, "orchestration_complete");
    assert.equal(emitted[0].isError, true);
    assert.ok(emitted[0].results.every((r: any) => r.state === "cancelled"));
  });

  it("is idempotent: cancelling an already-terminal run returns alreadyTerminal:true without duplicate emission", async () => {
    const emitted: any[] = [];
    const registry = createRegistry((p) => emitted.push(p));
    const { api, tools } = makeApi();
    const instantDeps: LauncherDeps = {
      async launch(task) { return { id: task.task, name: task.name ?? "s", startTime: Date.now() }; },
      async waitForCompletion(h) {
        return { name: h.name, finalMessage: "ok", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
      },
    };
    registerOrchestrationTools(api, () => instantDeps, () => true, () => null, () => null, { registry });
    const serial = tools.find((t) => t.name === "subagent_run_serial");
    const cancelTool = tools.find((t) => t.name === "subagent_run_cancel");

    const envelope = await serial.execute(
      "c2",
      { wait: false, tasks: [{ agent: "x", task: "t" }] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emitted.length, 1);
    const res = await cancelTool.execute(
      "c2-cancel",
      { orchestrationId: envelope.details.orchestrationId },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.equal(res.details.ok, true);
    assert.equal(res.details.alreadyTerminal, true);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(emitted.length, 1);
  });

  it("returns alreadyTerminal:true for an unknown id without throwing", async () => {
    const registry = createRegistry(() => {});
    const { api, tools } = makeApi();
    registerOrchestrationTools(api, () => foreverDeps, () => true, () => null, () => null, { registry });
    const cancelTool = tools.find((t) => t.name === "subagent_run_cancel");
    const res = await cancelTool.execute(
      "c3",
      { orchestrationId: "deadbeef" },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.equal(res.details.ok, true);
    assert.equal(res.details.alreadyTerminal, true);
  });
});
```

- [ ] **Step 6.2: Run to confirm failure**

Run: `node --test test/orchestration/cancel.test.ts`
Expected: FAIL — cancel tool not registered.

- [ ] **Step 6.3: Register subagent_run_cancel**

Add to `tool-handlers.ts`, alongside the other tool registrations:

```ts
const CancelParams = Type.Object({
  orchestrationId: Type.String({ description: "Orchestration id returned from a prior wait:false dispatch." }),
});

if (registry && shouldRegister("subagent_run_cancel")) {
  pi.registerTool({
    name: "subagent_run_cancel",
    label: "Cancel Orchestration",
    description:
      "Cancel a running async orchestration by id. Transitions all non-terminal tasks " +
      "to `cancelled` and fires the standard aggregated completion steer-back. " +
      "Idempotent on already-terminal runs.",
    promptSnippet:
      "Cancel a running async orchestration by id. Idempotent on already-terminal runs.",
    parameters: CancelParams,
    async execute(_id, params) {
      const res = registry.cancel(params.orchestrationId);
      return {
        content: [{
          type: "text",
          text: res.alreadyTerminal
            ? `Orchestration "${params.orchestrationId}" already terminal.`
            : `Orchestration "${params.orchestrationId}" cancelled.`,
        }],
        details: res,
      };
    },
  });
}
```

Important: the background runner in Task 5.5 writes its async path assuming the `foreverDeps`-style wait never resolves after cancel. This is the "in-flight panes are closed; waits are aborted" part of the spec. For Phase 1, since we don't have per-task AbortSignal plumbing in the async dispatch, we synthesize the cancellation at the registry layer only. A follow-on TODO (filed as Phase 1 known limitation) is that the actual pane/child process is not killed until it finishes naturally — the user-visible aggregated completion is correct, but panes may outlive the cancel. Document this in the handler text and in the README (see Task 8).

For Phase 2 we add proper abort plumbing below; for Phase 1 the test uses `foreverDeps` but only asserts the aggregated completion shape, not process teardown.

- [ ] **Step 6.4: Run tests**

Run: `node --test test/orchestration/cancel.test.ts`
Expected: PASS.

- [ ] **Step 6.5: Commit**

```bash
git add pi-extension/orchestration/tool-handlers.ts test/orchestration/cancel.test.ts
git commit -m "feat(orchestration): add subagent_run_cancel tool"
```

---

### Task 7: Wire per-orchestration AbortController into async dispatch

**Files:**
- Modify: `pi-extension/orchestration/registry.ts`
- Modify: `pi-extension/orchestration/tool-handlers.ts`
- Modify: `test/orchestration/cancel.test.ts`
- Modify: `test/orchestration/registry.test.ts`

- [ ] **Step 7.1: Write a failing test that asserts cancel actually aborts in-flight deps**

Append to `test/orchestration/cancel.test.ts`:

```ts
describe("subagent_run_cancel abort plumbing", () => {
  it("cancel aborts the in-flight deps.waitForCompletion signal so the background runner stops launching further steps", async () => {
    const abortsSeen: boolean[] = [];
    const launchedTaskNames: string[] = [];
    const deps: LauncherDeps = {
      async launch(task) {
        launchedTaskNames.push(task.task);
        return { id: task.task, name: task.name ?? "s", startTime: Date.now() };
      },
      async waitForCompletion(h, signal) {
        return await new Promise((resolve) => {
          if (signal?.aborted) {
            abortsSeen.push(true);
            return resolve({ name: h.name, finalMessage: "", transcriptPath: null,
                             exitCode: 1, elapsedMs: 0, error: "cancelled" });
          }
          signal?.addEventListener("abort", () => {
            abortsSeen.push(true);
            resolve({ name: h.name, finalMessage: "", transcriptPath: null,
                      exitCode: 1, elapsedMs: 0, error: "cancelled" });
          }, { once: true });
        });
      },
    };
    const emitted: any[] = [];
    const registry = createRegistry((p) => emitted.push(p));
    const { api, tools } = makeApi();
    registerOrchestrationTools(api, () => deps, () => true, () => null, () => null, { registry });
    const serial = tools.find((t) => t.name === "subagent_run_serial");
    const cancelTool = tools.find((t) => t.name === "subagent_run_cancel");
    const envelope = await serial.execute(
      "abort-plumbing",
      { wait: false, tasks: [{ agent: "x", task: "t1" }, { agent: "x", task: "t2" }] },
      new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" },
    );
    await new Promise((r) => setTimeout(r, 10));
    await cancelTool.execute("c", { orchestrationId: envelope.details.orchestrationId },
      new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(abortsSeen.length >= 1, "waitForCompletion should have seen an abort");
    assert.equal(launchedTaskNames.length, 1, "second task should not have launched after cancel");
  });
});
```

- [ ] **Step 7.2: Run test, expect failure**

Run: `node --test test/orchestration/cancel.test.ts`
Expected: FAIL.

- [ ] **Step 7.3: Extend registry to own a per-orch AbortController**

In `pi-extension/orchestration/registry.ts`, extend the entry:

```ts
interface OrchestrationEntry {
  id: string;
  config: OrchestrationConfig;
  tasks: OrchestratedTaskResult[];
  overallState: "running" | "completed";
  sessionKeys: Map<number, string>;
  abort: AbortController;
}
```

Initialize `abort: new AbortController()` in `dispatchAsync`. Extend the public API:

```ts
export interface Registry {
  // ...existing...
  getAbortSignal(orchestrationId: string): AbortSignal | null;
}
```

Implementation:

```ts
getAbortSignal(orchestrationId) {
  const entry = entries.get(orchestrationId);
  return entry ? entry.abort.signal : null;
},
```

And inside `cancel`, call `entry.abort.abort()` before transitioning task states (so any deps watching the signal see it before the state machine flips):

```ts
cancel(orchestrationId) {
  const entry = entries.get(orchestrationId);
  if (!entry || entry.overallState !== "running") {
    return { ok: true, alreadyTerminal: true };
  }
  entry.abort.abort();
  for (let i = 0; i < entry.tasks.length; i++) { /* ...existing cancellation sweep... */ }
  tryFinalize(entry);
  return { ok: true };
},
```

Add a registry test confirming `getAbortSignal` returns an aborted signal after cancel:

```ts
// test/orchestration/registry.test.ts (appended)
it("cancel aborts the orchestration's shared AbortSignal", () => {
  const { emitter } = makeEmitterSpy();
  const reg = createRegistry(emitter);
  const id = reg.dispatchAsync({
    config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
  });
  const signal = reg.getAbortSignal(id);
  assert.ok(signal);
  assert.equal(signal!.aborted, false);
  reg.cancel(id);
  assert.equal(signal!.aborted, true);
});
```

- [ ] **Step 7.4: Thread the signal through the async dispatch path**

In `tool-handlers.ts` async branch, pass `registry.getAbortSignal(orchestrationId)!` into `runSerial` / `runParallel` as `opts.signal`:

```ts
const signal = registry.getAbortSignal(orchestrationId)!;
(async () => {
  try {
    await runSerial(params.tasks, {
      signal,
      onLaunched: (taskIndex, info) => registry.onTaskLaunched(orchestrationId, taskIndex, info),
      onTerminal: (taskIndex, result) => registry.onTaskTerminal(orchestrationId, taskIndex, result),
    }, deps);
    // ...fallback sweep unchanged...
  } catch (err: any) { /* ... */ }
})();
```

- [ ] **Step 7.5: Run tests**

Run: `node --test test/orchestration/registry.test.ts test/orchestration/cancel.test.ts test/orchestration/async-dispatch.test.ts`
Expected: PASS.

- [ ] **Step 7.6: Commit**

```bash
git add pi-extension/orchestration/registry.ts pi-extension/orchestration/tool-handlers.ts test/orchestration/
git commit -m "feat(orchestration): thread AbortSignal through async runs so cancel stops workers"
```

---

### Task 7b: Extension test seams (`__test__` surface for Phase 1/2 real-extension tests)

**Files:**
- Modify: `pi-extension/subagents/index.ts` (extend the existing `__test__` export)
- Modify: `test/test.ts` (contract tests for the new seams)

**Rationale.** Tasks 8.3b, 10.7b, 12, and 14.2 construct the real `subagentsExtension(pi)` and must intercept two cross-cutting collaborators without mocking the registry or forking the extension module:

1. The orchestration tool path's `LauncherDeps` factory — so real-extension tests can swap in deterministic fakes for `launch` / `waitForCompletion` without launching live pi children.
2. The `subagent_resume` handler's `watchSubagent` call — so Task 14.2's resume-routing recursion test can drive ping-during-resume outcomes through the real resume tool without spawning a resumed pi process.

Today the existing `__test__` surface only exposes widget/launch-spec helpers. Land these two seams in one place, explicitly, so later tasks can reference a known API surface instead of inventing it inline.

- [ ] **Step 7b.1: Contract test for the new seams**

Append to `test/test.ts`:

```ts
import * as subagentsModule from "../pi-extension/subagents/index.ts";

describe("subagents __test__ — extension-level seams", () => {
  const api = (subagentsModule as any).__test__;

  it("exposes LauncherDeps override setter + getter", () => {
    assert.equal(typeof api.setLauncherDepsOverride, "function");
    assert.equal(typeof api.getLauncherDepsOverride, "function");
    const fake = { launch: async () => ({}) as any, waitForCompletion: async () => ({}) as any };
    api.setLauncherDepsOverride(fake);
    assert.equal(api.getLauncherDepsOverride(), fake);
    api.setLauncherDepsOverride(null);
    assert.equal(api.getLauncherDepsOverride(), null);
  });

  it("exposes watchSubagent override setter + getter", () => {
    assert.equal(typeof api.setWatchSubagentOverride, "function");
    assert.equal(typeof api.getWatchSubagentOverride, "function");
    const fake = async () => ({}) as any;
    api.setWatchSubagentOverride(fake);
    assert.equal(api.getWatchSubagentOverride(), fake);
    api.setWatchSubagentOverride(null);
    assert.equal(api.getWatchSubagentOverride(), null);
  });
});
```

Run: `node --test test/test.ts`
Expected: FAIL (no such `__test__` members yet).

- [ ] **Step 7b.2: Add a `LauncherDeps` override at the orchestration registration site**

In `pi-extension/subagents/index.ts`, declare a module-level mutable reference near the other module-level state (e.g., next to `runningSubagents`):

```ts
let launcherDepsOverride: LauncherDeps | null = null;
```

Wrap the `deps` factory passed to `registerOrchestrationTools(...)` so it reads through the override when set (Task 5 installs this call at `(ctx) => makeDefaultDeps(ctx)`):

```ts
registerOrchestrationTools(
  pi,
  (ctx) => launcherDepsOverride ?? makeDefaultDeps(ctx),
  shouldRegister,
  preflightOrchestration,
  selfSpawnBlocked,
  { registry },
);
```

Production behavior is unchanged when the override is `null` (the default).

- [ ] **Step 7b.3: Add a `watchSubagent` override for `subagent_resume`**

In the same file, declare a second module-level reference:

```ts
import type { watchSubagent as WatchSubagentFn } from "./completion-watcher.ts";
// ...adjust import to match the actual export site of watchSubagent.
let watchSubagentOverride: typeof WatchSubagentFn | null = null;
```

Replace the direct call inside `subagent_resume.execute` (currently `watchSubagent(running, watcherAbort.signal).then(...)`) with:

```ts
const watcher = watchSubagentOverride ?? watchSubagent;
watcher(running, watcherAbort.signal).then(/* ...existing handler body unchanged... */);
```

Leave the existing handler body untouched — this step only indirects the function selection.

- [ ] **Step 7b.4: Extend `__test__`**

```ts
export const __test__ = {
  // ...existing exports...
  setLauncherDepsOverride(deps: LauncherDeps | null) { launcherDepsOverride = deps; },
  getLauncherDepsOverride(): LauncherDeps | null { return launcherDepsOverride; },
  setWatchSubagentOverride(fn: typeof WatchSubagentFn | null) { watchSubagentOverride = fn; },
  getWatchSubagentOverride(): typeof WatchSubagentFn | null { return watchSubagentOverride; },
};
```

- [ ] **Step 7b.5: Run the contract test + typecheck**

Run: `node --test test/test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7b.6: Document the seams at their call sites**

Add a one-line comment at each override-read site pointing to this task, so future readers know why the indirection exists:

```ts
// Test seam: Task 7b (__test__.setLauncherDepsOverride).
// Test seam: Task 7b (__test__.setWatchSubagentOverride).
```

- [ ] **Step 7b.7: Commit**

```bash
git add pi-extension/subagents/index.ts test/test.ts
git commit -m "test(subagents): expose __test__ seams for LauncherDeps + watchSubagent"
```

**Consumers of this seam (forward references).** Every later task that constructs `subagentsExtension(pi)` for real-extension coverage uses this surface instead of inventing its own:
- Task 8.3b — `orchestration-extension-async.test.ts` sets `setLauncherDepsOverride(deterministicDeps)` in `before`, restores in `after`.
- Task 10.7b — `orchestration-extension-blocked.test.ts` ditto, with a ping-returning `waitForCompletion`.
- Task 14.2 — `orchestration-extension-resume-routing.test.ts` uses `setWatchSubagentOverride(...)` to drive recursion (ping-during-resume) and terminal-resume paths through the real `subagent_resume` tool handler.

None of these consumers are permitted to add their own module-level mutation — if a new extension-level interception is needed, land another explicit seam here first.

---

### Task 8: Phase 1 integration test + README updates

**Files:**
- Create: `test/integration/orchestration-async.test.ts`
- Modify: `README.md`
- Modify: `pi-extension/subagents/index.ts` (register message renderers for new steer-back kinds)

- [ ] **Step 8.1: Add a message renderer for orchestration_complete**

In `pi-extension/subagents/index.ts`, near the other `registerMessageRenderer` calls:

```ts
pi.registerMessageRenderer("orchestration_complete", (message, _opts, theme) => {
  const details = message.details as any;
  if (!details) return undefined;
  return {
    invalidate() {},
    render(width: number): string[] {
      const id = details.orchestrationId ?? "?";
      const count = details.results?.length ?? 0;
      const isError = !!details.isError;
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const status = isError ? "completed with errors" : "completed";
      const header =
        `${icon} ${theme.fg("toolTitle", theme.bold("Orchestration"))} ` +
        theme.fg("dim", id) + " — " + status + theme.fg("dim", ` (${count} task(s))`);
      const lines: string[] = [header];
      for (const r of details.results ?? []) {
        const stateIcon = r.state === "completed" ? theme.fg("success", "✓")
          : r.state === "failed" ? theme.fg("error", "✗")
          : r.state === "cancelled" ? theme.fg("dim", "○")
          : theme.fg("dim", "·");
        lines.push(`  ${stateIcon} ${r.name} — ${r.state}`);
      }
      return ["", ...lines.map((l) => l.slice(0, width))];
    },
  };
});
```

- [ ] **Step 8.2: Write an end-to-end integration test**

```ts
// test/integration/orchestration-async.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import { createRegistry } from "../../pi-extension/orchestration/registry.ts";
import { ORCHESTRATION_COMPLETE_KIND } from "../../pi-extension/orchestration/notification-kinds.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

function makeApi() {
  const tools: any[] = []; const messages: any[] = [];
  return {
    tools, messages,
    api: {
      registerTool: (t: any) => tools.push(t),
      on() {}, registerCommand() {}, registerMessageRenderer() {},
      sendMessage(m: any) { messages.push(m); }, sendUserMessage() {},
    } as any,
  };
}

const okDeps: LauncherDeps = {
  async launch(t) { return { id: t.task, name: t.name ?? "s", startTime: Date.now() }; },
  async waitForCompletion(h) {
    await new Promise((r) => setTimeout(r, 20));
    return { name: h.name, finalMessage: `result-${h.name}`, transcriptPath: null, exitCode: 0, elapsedMs: 20 };
  },
};

describe("end-to-end async orchestration", () => {
  it("dispatches async, runs tasks, and delivers aggregated result via pi.sendMessage", async () => {
    const { api, tools, messages } = makeApi();
    const registry = createRegistry((payload) => {
      if (payload.kind === ORCHESTRATION_COMPLETE_KIND) {
        api.sendMessage({ customType: "orchestration_complete", content: "done", details: payload });
      }
    });
    registerOrchestrationTools(api, () => okDeps, () => true, () => null, () => null, { registry });
    const serial = tools.find((t) => t.name === "subagent_run_serial");

    const env = await serial.execute("e2e",
      { wait: false, tasks: [
        { name: "a", agent: "x", task: "t1" },
        { name: "b", agent: "x", task: "t2" },
      ] },
      new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.match(env.details.orchestrationId, /^[0-9a-f]{8}$/);
    assert.equal(env.details.tasks.every((t: any) => t.state === "pending"), true);

    // Wait for completion
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(messages.length, 1);
    const details = messages[0].details;
    assert.equal(details.kind, "orchestration_complete");
    assert.equal(details.orchestrationId, env.details.orchestrationId);
    assert.equal(details.isError, false);
    assert.equal(details.results.length, 2);
    assert.deepEqual(details.results.map((r: any) => r.state), ["completed", "completed"]);
    assert.deepEqual(details.results.map((r: any) => r.finalMessage), ["result-a", "result-b"]);
  });
});
```

- [ ] **Step 8.3: Run the integration test**

Run: `node --test test/integration/orchestration-async.test.ts`
Expected: PASS.

- [ ] **Step 8.3b: Write an extension-level async dispatch test (real `subagentsExtension` wiring)**

The test above covers `registerOrchestrationTools` with mocked `LauncherDeps`. Add a second test that constructs the real `subagentsExtension(pi)` against a fake `pi` (capturing `sendMessage` and `registerTool`), so the registry construction, emitter wiring, and `sendMessage({ deliverAs: "steer", triggerTurn: true })` calls are all exercised. Inject deterministic deps via `__test__.setLauncherDepsOverride(...)` from Task 7b; restore in `after`. Do NOT introduce ad-hoc module mutation.

```ts
// test/integration/orchestration-extension-async.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import subagentsExtension, { __test__ as subagentsTest } from "../../pi-extension/subagents/index.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

describe("async orchestration — real subagentsExtension wiring", () => {
  const okDeps: LauncherDeps = {
    async launch(t) { return { id: t.task, name: t.name ?? "s", startTime: Date.now() }; },
    async waitForCompletion(h) {
      return { name: h.name, finalMessage: `ok-${h.name}`, transcriptPath: null,
               exitCode: 0, elapsedMs: 1 };
    },
  };

  before(() => { subagentsTest.setLauncherDepsOverride(okDeps); });
  after(() => { subagentsTest.setLauncherDepsOverride(null); });

  it("extension registers subagent_run_{serial,parallel,cancel} and delivers orchestration_complete via pi.sendMessage", async () => {
    // 1. Construct subagentsExtension(pi) with a fake pi whose sendMessage
    //    spies on calls (record customType, details, and sendMessage options).
    //    Use the same makeFakePi() helper as orchestration-headless-no-mux.test.ts.
    // 2. Invoke subagent_run_serial with wait: false. Assert the handler
    //    returns an envelope with `orchestrationId` and `state: "pending"`
    //    per task.
    // 3. Await background completion. Assert exactly one
    //    pi.sendMessage({ customType: "orchestration_complete", details: ... },
    //      { deliverAs: "steer", triggerTurn: true }) was emitted.
    // 4. Assert `details.results` carries the terminal per-task states.
    //
    // This is the guardrail against regressing the extension-boundary wiring
    // independently of the registry/tool-handlers unit tests.
  });
});
```

Run: `node --test test/integration/orchestration-extension-async.test.ts`
Expected: PASS.

- [ ] **Step 8.4: Update README tool name section**

In `README.md`, find the "What's Included / Extensions" table (around line 108) and update the tool rows. Also update the "Tool restriction" / "Orchestration tools (fork additions)" sections. Specific edits:

- `subagent_serial` → `subagent_run_serial` (everywhere, including code snippets in the orchestration section).
- `subagent_parallel` → `subagent_run_parallel` (same).
- Add a new row for `subagent_run_cancel` under the tool table: `Cancel an async orchestration by id (idempotent on already-terminal runs).`
- Under `subagent_run_serial` and `subagent_run_parallel` sections, add a new paragraph describing `wait: false` and the async envelope:

```markdown
Both orchestration tools accept an optional `wait: boolean` field (default `true`). When `wait` is `false`, the call returns immediately with:

```json
{ "orchestrationId": "7a3f91e2", "tasks": [ { "name": "a", "index": 0, "state": "pending" }, ... ], "isError": false }
```

A single aggregated completion is delivered later via a `orchestration_complete` steer-back message. Cancel with `subagent_run_cancel({ orchestrationId })`. Registry state is in-process only — a pi crash kills live async runs silently.
```

- Update the "Async Subagent Flow" section to mention the new orchestration path alongside the existing single-subagent one.
- Update the deny-tools example (around line 454) to list the new names.

- [ ] **Step 8.5: Run full test suite**

Run: `npm test && node --test test/integration/orchestration-async.test.ts`
Expected: PASS.

- [ ] **Step 8.6: Commit**

```bash
git add pi-extension/subagents/index.ts test/integration/orchestration-async.test.ts test/integration/orchestration-extension-async.test.ts README.md
git commit -m "feat(orchestration): end-to-end async dispatch with steer-back renderer"
```

---

### Task 8b: Phase 1 backend-real async + cancel coverage (pane + headless)

**Why this task exists:** Every Phase 1 test through Task 8 runs with injected `LauncherDeps` or through the extension seam `__test__.setLauncherDepsOverride(...)`. That proves the registry and tool-handler shapes are correct, but it does NOT prove that a real pane or real headless backend actually delivers an async `wait: false` run or that `subagent_run_cancel` actually tears down live children. Phase 2's Tasks 14.2b/14.2c cover the blocked/resume path through the real backends, but the plain async dispatch/cancel path of Phase 1 has no backend-real coverage at all. The spec's Phase 1 testing strategy explicitly says both backends should be exercised where applicable; this task closes that gap before Phase 2 begins.

**Files:**
- Create: `test/integration/orchestration-pane-async-backend.test.ts`
- Create: `test/integration/orchestration-headless-async-backend.test.ts`

**Scope boundaries:**
- These tests do NOT exercise `caller_ping`, `blocked`, or resume. They only prove that `wait: false` dispatch and `subagent_run_cancel` work end-to-end through real backend stacks.
- No `__test__.setLauncherDepsOverride(...)` and no `__test__.setWatchSubagentOverride(...)`. The whole point is to hit `makeDefaultDeps` → `launchSubagent` → `watchSubagent` → the real backend.
- Both tests follow the skip-sentinel pattern from `pi-pane-smoke.test.ts` / `orchestration-headless-no-mux.test.ts`.

- [ ] **Step 8b.1: Add a trivial always-complete fixture agent**

Create `test/integration/agents/test-async-ok.md` — an agent that runs any task by writing `ok` and calling `subagent_done`. If a suitable minimal fixture already exists (e.g., the `test-ok.md` pattern used by existing integration tests — verify with `grep -l 'subagent_done' test/integration/agents/`), reuse it instead of adding a new file. Verification: `ls test/integration/agents/test-async-ok.md` (or the reused fixture) must show the file.

- [ ] **Step 8b.2: Write the pane backend-real async + cancel test**

```ts
// test/integration/orchestration-pane-async-backend.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  getAvailableBackends, setBackend, restoreBackend,
  createTestEnv, cleanupTestEnv, PI_TIMEOUT, type TestEnv,
} from "./harness.ts";
import subagentsExtension from "../../pi-extension/subagents/index.ts";
import { ORCHESTRATION_COMPLETE_KIND } from "../../pi-extension/orchestration/notification-kinds.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; }
})();
const backends = getAvailableBackends();
const SHOULD_SKIP = !PI_AVAILABLE || backends.length === 0;

for (const backend of backends) {
  describe(`orchestration-pane-async-backend [${backend}]`, {
    skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 3,
  }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    before(() => { prevMux = setBackend(backend); env = createTestEnv(backend); });
    after(() => { cleanupTestEnv(env); restoreBackend(prevMux); });

    it("pane: wait:false serial orchestration completes and delivers orchestration_complete via the real backend", async () => {
      // 1. Build fake pi (makeFakePi pattern from orchestration-headless-no-mux.test.ts).
      // 2. Boot subagentsExtension(fake.api). Do NOT call __test__.setLauncherDepsOverride.
      // 3. Invoke subagent_run_serial with wait:false and two tasks referencing
      //    the always-complete fixture (test-async-ok) so the real pane backend
      //    spawns actual children.
      // 4. Assert the synchronous return envelope carries an 8-char hex
      //    orchestrationId and tasks: [{state:"pending"}, {state:"pending"}].
      // 5. Await a sendMessage with customType === ORCHESTRATION_COMPLETE_KIND
      //    (bounded poll; fail with a clear message on timeout). Assert:
      //    - details.orchestrationId matches the envelope
      //    - details.isError === false
      //    - details.results.length === 2 and every state === "completed"
      //    - sendMessage options include { deliverAs: "steer", triggerTurn: true }
      // 6. Assert no panes are left open (use the same pane-count check the
      //    existing pane tests use, or cleanupTestEnv's pre-check).
    });

    it("pane: subagent_run_cancel during a wait:false run aborts live panes and emits aggregated completion with all cancelled", async () => {
      // 1. Build fake pi + boot extension as above.
      // 2. Dispatch subagent_run_serial wait:false with a fixture task that
      //    takes measurably longer than the cancel path (reuse an existing
      //    long-running integration fixture if one exists; otherwise use
      //    test-async-ok with a task prompt that exercises a short sleep).
      // 3. Immediately after the envelope returns, call the registered
      //    subagent_run_cancel tool with the envelope's orchestrationId.
      // 4. Assert the cancel tool's return carries details.ok === true.
      // 5. Await ORCHESTRATION_COMPLETE_KIND. Assert:
      //    - details.isError === true
      //    - every results[i].state === "cancelled"
      // 6. Assert panes launched by the cancelled run are no longer live
      //    (match the pane-cleanup assertion already used by pi-pane-smoke.test.ts).
    });
  });
}
```

Run: `node --test test/integration/orchestration-pane-async-backend.test.ts`
Expected: PASS when `pi` is on PATH and at least one mux backend is available; skipped otherwise.

- [ ] **Step 8b.3: Write the headless backend-real async + cancel test**

Mirror Step 8b.2 for the headless backend. The harness constraints are the same as Step 14.2c:

- Backend selection via `PI_SUBAGENT_MODE=headless` in `before` + restore in `after`.
- Use `mkdtempSync` + `copyTestAgents(dir)` (pattern: `orchestration-headless-no-mux.test.ts`) instead of `createTestEnv` (which requires a `MuxBackend`).
- The headless Phase 1 path does NOT need `subagent_resume`, so the skip sentinel only requires `pi` on PATH — mux is not required (unlike Step 14.2c's resume half).

```ts
// test/integration/orchestration-headless-async-backend.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { copyTestAgents, PI_TIMEOUT } from "./harness.ts";
import subagentsExtension from "../../pi-extension/subagents/index.ts";
import { ORCHESTRATION_COMPLETE_KIND } from "../../pi-extension/orchestration/notification-kinds.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; }
})();

describe("orchestration-headless-async-backend", {
  skip: !PI_AVAILABLE, timeout: PI_TIMEOUT * 3,
}, () => {
  let prevMode: string | undefined;
  let dir: string;

  before(() => {
    prevMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-integ-headless-async-"));
    copyTestAgents(dir);
  });
  after(() => {
    if (prevMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = prevMode;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it("headless: wait:false parallel orchestration completes and delivers orchestration_complete via the real runPiHeadless", async () => {
    // 1. Build fake pi (makeFakePi pattern from orchestration-headless-no-mux.test.ts).
    // 2. Boot subagentsExtension(fake.api). No __test__ overrides.
    // 3. Dispatch subagent_run_parallel wait:false with 2 tasks referencing
    //    the always-complete fixture. The real runPiHeadless spawns pi children.
    // 4. Assert envelope shape (orchestrationId + pending tasks).
    // 5. Await ORCHESTRATION_COMPLETE_KIND. Assert every result.state === "completed",
    //    isError === false, and sendMessage carries { deliverAs: "steer", triggerTurn: true }.
    // 6. Verify no .exit sidecars remain in the session file directory (this
    //    is Task 9.5's cleanup invariant at rest; for Phase 1 tasks that never
    //    ping, no sidecars should ever be created).
  });

  it("headless: subagent_run_cancel during a wait:false run aborts live pi children and emits aggregated completion with all cancelled", async () => {
    // 1. Boot extension + dispatch subagent_run_serial wait:false with two
    //    long-enough tasks that the first child is still running when cancel hits.
    // 2. Immediately invoke subagent_run_cancel with the orchestrationId.
    // 3. Assert cancel returns details.ok === true.
    // 4. Await ORCHESTRATION_COMPLETE_KIND carrying every state === "cancelled",
    //    isError === true.
    // 5. Assert no stray child `pi` processes survive (pidtree the test PID
    //    and fail if a pi child from this orchestration is still alive). This
    //    is what proves that Phase 1's cancel path really propagates through
    //    the real headless backend rather than just the registry state.
  });
});
```

Run: `node --test test/integration/orchestration-headless-async-backend.test.ts`
Expected: PASS when `pi` is on PATH; skipped otherwise.

- [ ] **Step 8b.4: Run both new backend-real tests**

Run: `node --test test/integration/orchestration-pane-async-backend.test.ts test/integration/orchestration-headless-async-backend.test.ts`
Expected: PASS (or skip, per sentinels).

- [ ] **Step 8b.5: Commit**

```bash
git add test/integration/agents/test-async-ok.md \
  test/integration/orchestration-pane-async-backend.test.ts \
  test/integration/orchestration-headless-async-backend.test.ts
git commit -m "test(orchestration): backend-real Phase 1 async+cancel coverage (pane + headless)"
```

---

## Phase 2 — `caller_ping` Integration + Resume Awareness

### Task 9: Add `ping` + mid-run `sessionKey` surfacing to the backend seam

**Files:**
- Modify: `pi-extension/subagents/backends/types.ts` — add `ping?`, `sessionKey?` to `BackendResult`; extend `Backend.watch(...)` with a fourth `onSessionKey?: (key: string) => void` callback so the backend can surface a Claude session id mid-run (Step 9.5b).
- Modify: `pi-extension/subagents/backends/pane.ts` — forward `onSessionKey` into `watchSubagent`; populate `BackendResult.ping` and `BackendResult.sessionKey`.
- Modify: `pi-extension/subagents/backends/headless.ts` — add `.exit` sidecar detection for pi (Step 9.5); fire `onSessionKey` the first time the `system/init` event is parsed in `runClaudeHeadless` (Step 9.5b).
- Modify: `pi-extension/subagents/index.ts` — extend `watchSubagent(running, signal, opts?)` with an `onSessionKey` opt and fire it inside `pollForExit`'s `onTick` the first time the Claude transcript pointer file (`sentinelFile + ".transcript"`) appears mid-run (Step 9.5b). This is the only concrete mechanism today that surfaces a pane-Claude child's session id before exit.
- Modify: `pi-extension/orchestration/default-deps.ts` — thread `hooks.onSessionKey` from `waitForCompletion` into `backend.watch(..., onSessionKey)`.
- Modify: `pi-extension/orchestration/types.ts` — extend `LauncherDeps.waitForCompletion` with `hooks?: { onSessionKey?: (sessionKey: string) => void }`.
- Modify: `pi-extension/orchestration/run-serial.ts`, `run-parallel.ts` — accept `onSessionKey` opt and forward into `deps.waitForCompletion` hooks.
- Modify: `pi-extension/orchestration/tool-handlers.ts` — wire `onSessionKey → registry.updateSessionKey` in the async branches.
- Create: `test/orchestration/ping-surfacing.test.ts`
- Create: `test/orchestration/backend-seam.test.ts` — backend-seam contract: `Backend.watch` accepts `onSessionKey`; a fake backend that fires the callback routes into `registry.updateSessionKey` via the full runner → dispatcher path (Step 9.5b).

- [ ] **Step 9.1: Write failing test against the pane adapter**

```ts
// test/orchestration/ping-surfacing.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BackendResult } from "../../pi-extension/subagents/backends/types.ts";

describe("BackendResult ping + sessionKey shape", () => {
  it("BackendResult accepts optional ping and sessionKey fields", () => {
    const r: BackendResult = {
      name: "a",
      finalMessage: "",
      transcriptPath: null,
      exitCode: 0,
      elapsedMs: 0,
      sessionKey: "/tmp/my-subagent-session.jsonl",
      ping: { name: "Worker", message: "Not sure which schema to use" },
    };
    assert.equal(r.sessionKey, "/tmp/my-subagent-session.jsonl");
    assert.equal(r.ping?.name, "Worker");
    assert.equal(r.ping?.message, "Not sure which schema to use");
  });
});
```

- [ ] **Step 9.2: Run, expect failure**

Run: `node --test test/orchestration/ping-surfacing.test.ts`
Expected: FAIL — unknown properties `ping` and `sessionKey`.

- [ ] **Step 9.3: Add `ping` and `sessionKey` to BackendResult**

In `pi-extension/subagents/backends/types.ts`:

```ts
export interface BackendResult {
  name: string;
  finalMessage: string;
  transcriptPath: string | null;
  exitCode: number;
  elapsedMs: number;
  /** Claude session id, if the backend knows one. Retained for existing callers. */
  sessionId?: string;
  /**
   * Stable resume-addressable identifier for this child. Pi-backed children
   * set this to the subagent session file path (the same value
   * `subagent_resume({ sessionPath })` accepts). Claude-backed children set
   * this to the Claude session id. The orchestration registry keys its
   * ownership map on this value so blocked tasks can be routed back to the
   * owning `(orchestrationId, taskIndex)` when the parent calls
   * `subagent_resume`.
   */
  sessionKey?: string;
  error?: string;
  usage?: UsageStats;
  transcript?: TranscriptMessage[];
  /**
   * Set when the child exited via `caller_ping` rather than `subagent_done`.
   * Phase 2 (caller_ping orchestration integration) consumes this to
   * transition the owning task to `blocked`.
   */
  ping?: { name: string; message: string };
}
```

- [ ] **Step 9.4: Surface ping + sessionKey in the pane adapter, including mid-run for Claude children**

In `pi-extension/subagents/backends/pane.ts::watch`, accept the `onSessionKey` callback (added in Step 9.5b to the `Backend.watch` signature), forward it into `watchSubagent`, and populate `BackendResult.sessionKey` and `ping`. Pi-backed children already know `sessionKey` at launch time (`running.sessionFile`); the mid-run callback is only meaningful for Claude-backed children, where the session id only becomes known once Claude writes its transcript pointer file. `watchSubagent`'s `onTick` is the concrete hook that observes that pointer file (see Step 9.5b).

```ts
async watch(
  handle: LaunchedHandle,
  signal?: AbortSignal,
  onSessionKey?: (sessionKey: string) => void,
): Promise<BackendResult> {
  // ...existing running lookup + abort wiring unchanged...
  try {
    const sub = await watchSubagent(running, abort.signal, {
      onSessionKey: (key) => onSessionKey?.(key),
    });
    return {
      name: handle.name,
      finalMessage: sub.summary,
      transcriptPath: sub.transcriptPath,
      exitCode: sub.exitCode,
      elapsedMs: sub.elapsed * 1000,
      sessionId: sub.claudeSessionId,
      sessionKey: running.sessionFile ?? sub.claudeSessionId,
      error: sub.error,
      ping: sub.ping,
    };
  } finally {
    // ...existing cleanup unchanged...
  }
}
```

Pi children populate `BackendResult.sessionKey` via `running.sessionFile`, which is always set before `launch` returns. Claude children's `sessionKey` on the final return is still a best-effort fallback to `sub.claudeSessionId`; the load-bearing delivery is the mid-run callback (Step 9.5b), since a `caller_ping` can fire before `watch` resolves.

Also in `pane.ts::launch`, populate `LaunchedHandle.sessionKey`:

```ts
return {
  id: running.id,
  name: running.name,
  startTime: running.startTime,
  sessionKey: running.sessionFile,
};
```

- [ ] **Step 9.5: Detect ping + populate sessionKey in the headless backend**

In `pi-extension/subagents/backends/headless.ts::runPiHeadless`, inside the `proc.on("close", ...)` handler, check for the `.exit` sidecar and set `sessionKey` from `spec.subagentSessionFile`:

```ts
proc.on("close", (code) => {
  exited = true;
  for (const line of lb.flush()) processLine(line);
  const elapsedMs = Date.now() - startTime;
  const archived = existsSync(spec.subagentSessionFile) ? spec.subagentSessionFile : null;
  const exitCode = code ?? 0;
  const final = getFinalOutput(transcript);

  // NEW: check .exit ping sidecar.
  let ping: { name: string; message: string } | undefined;
  try {
    const exitFile = `${spec.subagentSessionFile}.exit`;
    if (existsSync(exitFile)) {
      const data = JSON.parse(readFileSync(exitFile, "utf8"));
      rmSync(exitFile, { force: true });
      if (data.type === "ping") {
        ping = { name: data.name, message: data.message };
      }
    }
  } catch { /* ignore malformed sidecar */ }

  if (wasAborted) { /* existing */ }
  // If ping, resolve as non-error completion with ping field set so the
  // orchestration registry can route to blocked.
  if (ping) {
    resolve({
      name: spec.name, finalMessage: final, transcriptPath: archived,
      exitCode: 0, elapsedMs, usage, transcript, ping,
      sessionKey: spec.subagentSessionFile,
    });
    return;
  }
  // ...existing paths unchanged, but every resolve() should also include
  // sessionKey: spec.subagentSessionFile so the ownership key is always set.
});
```

(Add the missing `readFileSync`, `rmSync` imports at the top of `headless.ts` if they are not already present — verify via `grep -n "readFileSync\|rmSync" pi-extension/subagents/backends/headless.ts` before editing.)

Mirror the change in `runClaudeHeadless` — populate `sessionKey` from the Claude session id once the `system/init` event arrives; the sidecar check is safe idempotent for completeness.

Also in `headless.ts::launch`, populate `LaunchedHandle.sessionKey: spec.subagentSessionFile` for pi. For Claude-backed headless runs, `sessionKey` is not yet known at launch time — it arrives later via the `system/init` event. Use the late-binding seam described in Step 9.5b below to surface it to the registry as soon as the event fires. Do NOT leave the Claude `sessionKey` permanently unset: the spec requires ownership-map coverage for Claude-backed children as well.

- [ ] **Step 9.5b: Late-bind Claude `sessionKey` through a mid-run backend seam**

The pi case surfaces `sessionKey` at launch time because the session file path is provisioned before the child starts. The Claude case only learns its session id after the child has been running for some milliseconds — and critically, that can happen *before* the child calls `caller_ping`. If the registry's ownership map isn't populated before the block, the blocked steer-back carries no usable `sessionKey` for the parent to resume with.

Today the `Backend.watch(handle, signal, onUpdate?)` seam has no session-key callback, and `watchSubagent` archives the Claude session id only after sentinel exit (via `copyClaudeSession`). Close that gap with a single concrete mechanism that flows from backend → `LauncherDeps` → runner → async dispatcher → `registry.updateSessionKey`.

**Part A — extend the `Backend.watch` signature** (`pi-extension/subagents/backends/types.ts`):

```ts
export interface Backend {
  launch(
    params: BackendLaunchParams,
    defaultFocus: boolean,
    signal?: AbortSignal,
  ): Promise<LaunchedHandle>;
  watch(
    handle: LaunchedHandle,
    signal?: AbortSignal,
    onSessionKey?: (sessionKey: string) => void,
  ): Promise<BackendResult>;
}
```

The pre-existing `onUpdate?: (partial: BackendResult) => void` parameter is removed from the interface if it is unused today (verify with `grep -rn "backend\.watch\|Backend\.watch" pi-extension/`); otherwise rename the new parameter to sit alongside it as a 4th positional arg. Inspect the current callers before finalizing the signature.

**Part B — extend `watchSubagent` with an `onSessionKey` opt** (`pi-extension/subagents/index.ts`):

```ts
export async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
  opts?: { onSessionKey?: (sessionKey: string) => void },
): Promise<SubagentResult> {
  let firedSessionKey = false;
  const maybeFire = (key: string | undefined) => {
    if (!key || firedSessionKey) return;
    firedSessionKey = true;
    try { opts?.onSessionKey?.(key); } catch { /* defensive */ }
  };

  // Pi children: fire once immediately with the known session file.
  if (running.cli !== "claude") maybeFire(running.sessionFile);

  const result = await pollForExit(surface, AbortSignal.any([signal, getModuleAbortSignal()]), {
    interval: 1000,
    sessionFile,
    sentinelFile: running.sentinelFile,
    onTick() {
      if (running.cli === "claude" && !firedSessionKey && running.sentinelFile) {
        // The Claude Stop-hook plugin writes <sentinel>.transcript as soon as
        // the system/init event fires, long before the child exits. Read it
        // to derive the Claude session id mid-run.
        try {
          const pointer = running.sentinelFile + ".transcript";
          if (existsSync(pointer)) {
            const transcriptPath = readFileSync(pointer, "utf-8").trim();
            if (transcriptPath) {
              const filename = transcriptPath.split("/").pop() ?? "";
              const sessionId = filename.endsWith(".jsonl")
                ? filename.slice(0, -".jsonl".length)
                : filename;
              if (sessionId) maybeFire(sessionId);
            }
          }
        } catch { /* ignore; will be retried next tick */ }
      }
      // ...existing per-tick entry/byte accounting unchanged...
    },
  });
  // ...existing post-exit result-building path unchanged...
}
```

This is the concrete pane-Claude late-binding mechanism the v6 review flagged as missing. `pollForExit` already ticks every 1000ms; the first tick on which the `.transcript` pointer exists fires the callback, populating `registry.updateSessionKey` before any `caller_ping` that the child could possibly emit downstream. If the child exits before the pointer ever appears (launch failure path), the callback simply never fires and `sub.claudeSessionId` falls back to the existing post-exit archival path — no regression.

**Part C — fire `onSessionKey` from `runClaudeHeadless`** (`pi-extension/subagents/backends/headless.ts`): pass `onSessionKey` down into `runClaudeHeadless` via its existing spec object and invoke it the first time the `system/init` event is parsed. For `runPiHeadless`, no mid-run binding is needed (session file path is already set at launch — fire `onSessionKey?.(spec.subagentSessionFile)` once at the start of the run for symmetry).

**Part D — thread hooks through `LauncherDeps`** (`pi-extension/orchestration/types.ts`):

```ts
export interface LauncherDeps {
  launch(task: OrchestrationTask): Promise<LaunchedHandle>;
  waitForCompletion(
    handle: LaunchedHandle,
    hooks?: { onSessionKey?: (sessionKey: string) => void },
  ): Promise<OrchestrationResult>;
}
```

In `pi-extension/orchestration/default-deps.ts::waitForCompletion`, forward the hook into the backend:

```ts
const result = await backend.watch(handle, signal, hooks?.onSessionKey);
```

**Part E — forward `onSessionKey` through runners** (`pi-extension/orchestration/run-serial.ts` / `run-parallel.ts`). Extend `RunSerialOpts` / `RunParallelOpts` with `onSessionKey?: (taskIndex: number, sessionKey: string) => void` and forward it into the `deps.waitForCompletion` hook site:

```ts
const result = await deps.waitForCompletion(handle, {
  onSessionKey: (sessionKey) => opts.onSessionKey?.(i, sessionKey),
});
```

**Part F — wire registry in the async dispatcher** (`pi-extension/orchestration/tool-handlers.ts`):

```ts
onSessionKey: (i, sessionKey) => registry.updateSessionKey(orchestrationId, i, sessionKey),
```

**Part G — backend-seam contract test** (new file `test/orchestration/backend-seam.test.ts`):

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import { createRegistry } from "../../pi-extension/orchestration/registry.ts";
import { BLOCKED_KIND } from "../../pi-extension/orchestration/notification-kinds.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

describe("backend-seam: mid-run onSessionKey routes into registry.updateSessionKey", () => {
  it("a Claude-backed fake that fires onSessionKey mid-run populates ownership before any blocked event", async () => {
    // Simulate a Claude child: LaunchedHandle has NO sessionKey at launch.
    // waitForCompletion invokes hooks.onSessionKey after ~5ms, then returns a
    // ping result keyed on the Claude id. The registry must see the update
    // before the ping routes to onTaskBlocked, so the blocked event's
    // sessionKey matches what the parent will pass to subagent_resume({sessionId}).
    const claudeId = "claude-sess-late-bound";
    const deps: LauncherDeps = {
      async launch(t) {
        return { id: t.task, name: t.name ?? "s", startTime: Date.now() };
        // NOTE: no sessionKey returned — Claude launch-time identity gap.
      },
      async waitForCompletion(h, hooks) {
        setTimeout(() => hooks?.onSessionKey?.(claudeId), 5);
        await new Promise((r) => setTimeout(r, 15));
        return {
          name: h.name, finalMessage: "", transcriptPath: null,
          exitCode: 0, elapsedMs: 15,
          sessionKey: claudeId,
          ping: { name: h.name, message: "need input" },
        };
      },
    };
    const emitted: any[] = [];
    const registry = createRegistry((p) => emitted.push(p));
    const tools: any[] = [];
    const api = {
      registerTool: (t: any) => tools.push(t),
      on() {}, registerCommand() {}, registerMessageRenderer() {},
      sendMessage() {}, sendUserMessage() {},
    } as any;
    registerOrchestrationTools(api, () => deps, () => true, () => null, () => null, { registry });
    const serial = tools.find((t) => t.name === "subagent_run_serial");
    const env = await serial.execute("bs", { wait: false, tasks: [{ agent: "x", task: "t" }] },
      new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" });

    await new Promise((r) => setTimeout(r, 40));
    const blocked = emitted.find((e) => e.kind === BLOCKED_KIND);
    assert.ok(blocked, "blocked event must fire");
    assert.equal(blocked.sessionKey, claudeId);
    assert.equal(registry.lookupOwner(claudeId)!.orchestrationId, env.details.orchestrationId);
  });
});
```

The registry-level "late-bound sessionKey routes subsequent onTaskBlocked / onResumeTerminal" test added in Step 3.1 is still present and unchanged; this new test is the seam-level contract that proves the runner → dispatcher → `registry.updateSessionKey` wiring actually lands before the block.

- [ ] **Step 9.6: Propagate ping + sessionKey through makeDefaultDeps**

`OrchestrationResult.sessionKey` and `OrchestrationResult.ping` are already present on the type (added in Task 1.3). This step only wires them through the default deps. In `pi-extension/orchestration/default-deps.ts::waitForCompletion`, thread the new fields onto the final projection:

```ts
return {
  name: result.name,
  finalMessage: result.finalMessage,
  transcriptPath: result.transcriptPath,
  exitCode: result.exitCode,
  elapsedMs: result.elapsedMs,
  sessionId: result.sessionId,
  sessionKey: result.sessionKey, // NEW
  error: result.error,
  usage: result.usage,
  transcript: result.transcript,
  ping: result.ping, // NEW
};
```

In `default-deps.ts::launch`, pass `LaunchedHandle.sessionKey` through from the underlying backend's `launch`.

- [ ] **Step 9.7: Run tests**

Run: `node --test test/orchestration/ping-surfacing.test.ts test/orchestration/backend-seam.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 9.8: Commit**

```bash
git add pi-extension/subagents/ pi-extension/orchestration/ test/orchestration/ping-surfacing.test.ts test/orchestration/backend-seam.test.ts
git commit -m "feat(orchestration): propagate caller_ping + mid-run sessionKey via Backend.watch seam"
```

---

### Task 10: Registry — blocked state transition

**Files:**
- Modify: `pi-extension/orchestration/registry.ts` (already has `onTaskBlocked`)
- Modify: `pi-extension/orchestration/run-serial.ts`, `run-parallel.ts` (detect `ping` on completion and route to blocked instead of terminal)
- Modify: `test/orchestration/registry.test.ts`
- Create: `test/orchestration/block-resume.test.ts`

- [ ] **Step 10.1: Add a registry test for onTaskBlocked**

Append to `test/orchestration/registry.test.ts`:

```ts
describe("createRegistry onTaskBlocked / onResumeTerminal", () => {
  it("emits a blocked event and holds the orchestration open", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "need input" });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].kind, "blocked");
    assert.equal(emitted[0].taskIndex, 0);
    assert.equal(emitted[0].taskName, "a");
    assert.equal(emitted[0].sessionKey, "sess-a");
    assert.equal(emitted[0].message, "need input");
    // Snapshot reflects the blocked state:
    assert.equal(reg.getSnapshot(id)!.tasks[0].state, "blocked");
  });

  it("onResumeTerminal re-routes via ownership map and closes the orchestration", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "need input" });
    assert.equal(emitted.length, 1);
    // Standalone resume finishes:
    reg.onResumeTerminal("sess-a", {
      name: "a", index: 0, state: "completed", finalMessage: "resolved", exitCode: 0, elapsedMs: 5,
    });
    assert.equal(emitted.length, 2);
    assert.equal(emitted[1].kind, "orchestration_complete");
    assert.equal(emitted[1].isError, false);
  });

  it("cancel of a blocked task transitions it to cancelled without a resume", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "parallel", tasks: [
        { name: "a", agent: "x", task: "t" },
        { name: "b", agent: "x", task: "t" },
      ] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskLaunched(id, 1, { sessionKey: "sess-b" });
    reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "?" });
    reg.onTaskTerminal(id, 1, { name: "b", index: 1, state: "completed", exitCode: 0, elapsedMs: 1 });
    assert.equal(emitted.filter((e) => e.kind === "orchestration_complete").length, 0);
    reg.cancel(id);
    const complete = emitted.find((e) => e.kind === "orchestration_complete");
    assert.ok(complete);
    assert.equal(complete.results[0].state, "cancelled");
    assert.equal(complete.results[1].state, "completed");
  });
});
```

- [ ] **Step 10.2: Run, expect fails where behavior is missing**

Run: `node --test test/orchestration/registry.test.ts`
Expected: PASS (we implemented onTaskBlocked / onResumeTerminal in Task 3). Confirm the three new tests pass — if `cancel` test fails, audit `tryFinalize` emission order; it should run the cancellation sweep then finalize exactly once.

- [ ] **Step 10.3: Plumb ping → blocked in run-serial.ts**

In `pi-extension/orchestration/run-serial.ts`, when `result.ping` is set, branch on whether an `onBlocked` hook is present:

- **Async mode (`onBlocked` present):** treat the step as *non-terminal* — notify the registry, stop advancing the loop, return early with `blocked: true`.
- **Sync mode (`onBlocked` absent):** preserve today's behavior per spec — record the task as `completed`, substituting `ping.message` into `finalMessage`, and continue the sequence.

Extend `RunSerialOpts` and `RunSerialOutput`:

```ts
export interface RunSerialOpts {
  signal?: AbortSignal;
  onUpdate?: (content: { content: { type: "text"; text: string }[]; details: any }) => void;
  onLaunched?: (taskIndex: number, info: { sessionKey?: string }) => void;
  onTerminal?: (taskIndex: number, result: OrchestratedTaskResult) => void;
  onBlocked?: (taskIndex: number, payload: { sessionKey: string; message: string; partial: OrchestratedTaskResult }) => void;
}

export interface RunSerialOutput {
  results: OrchestrationResult[];
  isError: boolean;
  /** True when runSerial returned early because a step blocked; downstream steps remain untouched. */
  blocked?: boolean;
}
```

After `waitForCompletion` resolves, before annotating terminal state:

```ts
if (result.ping) {
  if (opts.onBlocked && result.sessionKey) {
    // Async path: transition to blocked and stop. Downstream steps stay
    // pending — the dispatcher must not run a cancellation sweep.
    opts.onBlocked(i, {
      sessionKey: result.sessionKey,
      message: result.ping.message,
      partial: {
        name: result.name, index: i, state: "blocked",
        finalMessage: result.finalMessage, transcriptPath: result.transcriptPath ?? null,
        elapsedMs: result.elapsedMs, exitCode: result.exitCode,
        sessionKey: result.sessionKey, usage: result.usage, transcript: result.transcript,
      },
    });
    return { results, isError: false, blocked: true };
  }
  // Sync path: preserve today's behavior — record as completed with ping
  // message folded into finalMessage.
  result = {
    ...result,
    finalMessage: result.ping.message,
    state: "completed",
  };
  // Fall through to the normal terminal annotation + push.
}
```

- [ ] **Step 10.4: Plumb ping → blocked in run-parallel.ts**

In `run-parallel.ts`, apply the same async/sync branch. Async (`onBlocked` present): call the hook, leave `results[i]` **undefined** so the aggregation carries no terminal entry for that slot (the registry owns "blocked"). Sync (`onBlocked` absent): fold `ping.message` into `finalMessage` and mark `state: "completed"` — identical to today's behavior aside from the additive `state` field.

```ts
if (result.ping) {
  if (opts.onBlocked && result.sessionKey) {
    opts.onBlocked(i, {
      sessionKey: result.sessionKey,
      message: result.ping.message,
      partial: {
        name: result.name, index: i, state: "blocked",
        finalMessage: result.finalMessage, transcriptPath: result.transcriptPath ?? null,
        elapsedMs: result.elapsedMs, exitCode: result.exitCode,
        sessionKey: result.sessionKey, usage: result.usage, transcript: result.transcript,
      },
    });
    // Do NOT write results[i]; the slot is left undefined so the aggregated
    // return carries no terminal entry for this task. Worker exits normally.
    return;
  }
  result = { ...result, finalMessage: result.ping.message, state: "completed" };
  // Fall through to results[i] = result.
}
```

The post-loop cancellation sweep must skip slots that the registry has marked `blocked`. Since `runParallel` has no registry handle in its internals, the sweep simply skips undefined slots *when an async hook was in play* — add a guard: only fill undefined slots with "cancelled" synthetic entries when `opts.onBlocked` is NOT set (sync path). In async mode, undefined slots are left alone; the registry owns them.

- [ ] **Step 10.5: Wire onBlocked in the async dispatch path AND skip the cancellation sweep when a run paused on a block**

In `tool-handlers.ts`, capture the runner's return value and branch on `blocked` before running any cleanup. The previous Task 5 dispatch discarded the return — here we must stop doing that, or a serial orchestration that blocks on step N will cancel steps N+1..end immediately and Task 11's continuation cannot run.

Serial async branch:

```ts
const out = await runSerial(params.tasks, {
  signal,
  onLaunched: (i, info) => registry.onTaskLaunched(orchestrationId, i, info),
  onTerminal: (i, r) => registry.onTaskTerminal(orchestrationId, i, r),
  onBlocked: (i, p) => registry.onTaskBlocked(orchestrationId, i, {
    sessionKey: p.sessionKey, message: p.message, partial: p.partial,
  }),
}, deps);

if (out.blocked) {
  // Paused, not finished. Task 11's continuation driver takes over when the
  // blocked slot transitions back to terminal (via onResumeTerminal). Do NOT
  // run the cancellation sweep — later steps must remain pending-launchable.
  return;
}

// Only reached on true terminal exits (success/failure/cancel). The sweep is
// a belt-and-suspenders guard against any slot the runner didn't explicitly
// terminate; blocked slots are skipped by construction.
const snap = registry.getSnapshot(orchestrationId);
if (snap) {
  for (const t of snap.tasks) {
    if (t.state === "pending" || t.state === "running") {
      registry.onTaskTerminal(orchestrationId, t.index, {
        ...t, state: "cancelled", exitCode: 1, error: t.error ?? "not launched",
      });
    }
  }
}
```

Parallel async branch — same shape, but parallel's `runParallel` does not return `blocked: true` as a whole (siblings keep running). Instead, `runParallel` finishes once every non-blocked slot has resolved; blocked slots are already owned by the registry. The sweep after `runParallel` should therefore skip `blocked` in addition to `pending`/`running`:

```ts
const snap = registry.getSnapshot(orchestrationId);
if (snap) {
  for (const t of snap.tasks) {
    if (t.state === "pending" || t.state === "running") {
      // "running" here means the runner exited with the slot never reported —
      // treat as cancelled. Blocked slots are owned by the registry and left
      // alone so onResumeTerminal can complete them.
      registry.onTaskTerminal(orchestrationId, t.index, {
        ...t, state: "cancelled", exitCode: 1, error: t.error ?? "not launched",
      });
    }
  }
}
```

Add an explicit "paused serial blocks do not cancel downstream tasks" test to `test/orchestration/block-resume.test.ts`:

```ts
it("serial block: downstream steps stay pending until the resumed task completes, then run", async () => {
  const launched: string[] = [];
  let step1Done = false;
  const deps: LauncherDeps = {
    async launch(t) {
      launched.push(t.task);
      return { id: t.task, name: t.name ?? "s", startTime: Date.now(), sessionKey: `sess-${t.name}` };
    },
    async waitForCompletion(h) {
      if (h.name === "a" && !step1Done) {
        step1Done = true;
        return { name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 1,
          sessionKey: "sess-a", ping: { name: "a", message: "?" } };
      }
      return { name: h.name, finalMessage: `ok-${h.name}`, transcriptPath: null,
               exitCode: 0, elapsedMs: 1, sessionKey: `sess-${h.name}` };
    },
  };
  const emitted: any[] = [];
  const registry = createRegistry((p) => emitted.push(p));
  const { api, tools } = makeApi();
  registerOrchestrationTools(api, () => deps, () => true, () => null, () => null, { registry });
  const serial = tools.find((t) => t.name === "subagent_run_serial");
  const env = await serial.execute("ds",
    { wait: false, tasks: [{ name: "a", agent: "x", task: "t1" }, { name: "b", agent: "x", task: "t2" }] },
    new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" });
  await new Promise((r) => setTimeout(r, 30));
  // Step b must NOT yet be cancelled or launched.
  const snap = registry.getSnapshot(env.details.orchestrationId)!;
  assert.equal(snap.tasks[1].state, "pending");
  assert.equal(launched.filter((x) => x === "t2").length, 0);
  assert.equal(emitted.filter((e) => e.kind === "orchestration_complete").length, 0);
});
```

- [ ] **Step 10.6: Write block/resume integration test**

```ts
// test/orchestration/block-resume.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import { createRegistry } from "../../pi-extension/orchestration/registry.ts";
import {
  BLOCKED_KIND,
  ORCHESTRATION_COMPLETE_KIND,
} from "../../pi-extension/orchestration/notification-kinds.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

function makeApi() {
  const tools: any[] = [];
  return {
    tools,
    api: {
      registerTool: (t: any) => tools.push(t),
      on() {}, registerCommand() {}, registerMessageRenderer() {},
      sendMessage() {}, sendUserMessage() {},
    } as any,
  };
}

describe("caller_ping -> blocked -> standalone resume -> aggregated completion", () => {
  it("serial: step 1 blocks, resume completes it, step 2 runs, aggregated completion fires", async () => {
    let step1Done = false;
    const deps: LauncherDeps = {
      async launch(t) {
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(),
                 sessionKey: `sess-${t.name ?? "s"}` };
      },
      async waitForCompletion(h) {
        if (h.name === "a" && !step1Done) {
          step1Done = true;
          return { name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 5,
            sessionKey: "sess-a", ping: { name: "a", message: "need input" } };
        }
        return { name: h.name, finalMessage: `result-${h.name}`, transcriptPath: null,
                 exitCode: 0, elapsedMs: 5, sessionKey: h.name === "a" ? "sess-a" : "sess-b" };
      },
    };
    const emitted: any[] = [];
    const registry = createRegistry((p) => emitted.push(p));
    const { api, tools } = makeApi();
    registerOrchestrationTools(api, () => deps, () => true, () => null, () => null, { registry });
    const serial = tools.find((t) => t.name === "subagent_run_serial");

    const env = await serial.execute("br1",
      { wait: false, tasks: [{ name: "a", agent: "x", task: "t1" },
                              { name: "b", agent: "x", task: "t2" }] },
      new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" });

    // Wait for task 1 to block
    await new Promise((r) => setTimeout(r, 30));
    const blocked = emitted.find((e) => e.kind === BLOCKED_KIND);
    assert.ok(blocked, "blocked event should have fired");
    assert.equal(blocked.orchestrationId, env.details.orchestrationId);
    assert.equal(blocked.taskIndex, 0);
    assert.equal(blocked.sessionKey, "sess-a");

    // Verify task 2 has not launched yet (serial pause semantics).
    const complete = emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND);
    assert.equal(complete, undefined);

    // Simulate the parent issuing subagent_resume which completes the child:
    registry.onResumeTerminal("sess-a", {
      name: "a", index: 0, state: "completed", finalMessage: "resolved-a",
      exitCode: 0, elapsedMs: 10, sessionKey: "sess-a",
    });
    // Give the serial runner a tick to launch task 2. In the current plan, the
    // "resume closes step 1 then continues step 2" behavior is driven by
    // restarting the run. That's the next task (Task 11 — serial continuation).
    await new Promise((r) => setTimeout(r, 50));

    const complete2 = emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND);
    assert.ok(complete2, "aggregated completion should fire after resume + task 2 runs");
    assert.equal(complete2.results[0].state, "completed");
    assert.equal(complete2.results[1].state, "completed");
  });
});
```

- [ ] **Step 10.7: Run the registry tests**

Run: `node --test test/orchestration/registry.test.ts`
Expected: PASS.

The `block-resume.test.ts` will PARTIALLY pass — the block event fires, but `complete2` will be undefined because Task 11 hasn't wired serial continuation yet. Mark the final assertion as pending-for-Task-11 with a test-level skip:

```ts
// In the test body, wrap the final block in a comment until Task 11:
// Confirmed in Task 11 (serial continuation after resume).
// assert.ok(complete2, ...);
```

- [ ] **Step 10.7b: Write an extension-level test for blocked delivery (real `subagentsExtension` wiring)**

Mirrors the Task 8 extension test but for Phase 2's new behavior. Construct the real `subagentsExtension(pi)` against a fake `pi`. Inject a `LauncherDeps` whose `waitForCompletion` returns a `BackendResult` with `ping` set and `sessionKey` set — via `__test__.setLauncherDepsOverride(...)` from Task 7b (restore in `after`). Dispatch an async orchestration via the registered `subagent_run_serial` tool. Assert that the extension emits exactly one `customType: "blocked"` `pi.sendMessage(...)` carrying `details.kind === "blocked"`, `details.sessionKey === <the sessionKey>`, `details.orchestrationId`, and `details.message === <the ping message>`.

```ts
// test/integration/orchestration-extension-blocked.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import subagentsExtension, { __test__ as subagentsTest } from "../../pi-extension/subagents/index.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

describe("async orchestration — blocked notification through the real extension", () => {
  const pingDeps: LauncherDeps = {
    async launch(t) {
      return { id: t.task, name: t.name ?? "s", startTime: Date.now(), sessionKey: "/tmp/owned.jsonl" };
    },
    async waitForCompletion(h) {
      return {
        name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 1,
        sessionKey: "/tmp/owned.jsonl",
        ping: { name: h.name, message: "need input" },
      };
    },
  };

  before(() => { subagentsTest.setLauncherDepsOverride(pingDeps); });
  after(() => { subagentsTest.setLauncherDepsOverride(null); });

  it("a pinging child surfaces exactly one customType:'blocked' sendMessage with spec-shaped details", async () => {
    // 1. Build fake pi with sendMessage spy; bootstrap subagentsExtension(pi).
    //    Use makeFakePi() from orchestration-headless-no-mux.test.ts as the pattern.
    // 2. Invoke subagent_run_serial with wait: false.
    // 3. Assert:
    //    - customType === "blocked"
    //    - details.kind === "blocked"
    //    - details.orchestrationId matches the envelope
    //    - details.sessionKey === "/tmp/owned.jsonl"
    //    - details.message === "need input"
    //    - sendMessage options include { deliverAs: "steer", triggerTurn: true }
    //
    // NOTE: Do NOT assert on the widget's virtual blocked-row state here.
    // The virtual-blocked row map, its `(orchestrationId, taskIndex)` keying,
    // and the `__test__` surface that exposes it are introduced in Task 13.
    // The matching widget assertion lives in Task 13 (see Step 13.4 for the
    // per-task terminal-cleanup test). Keep this test focused on the
    // steer-back emission path so Phase 2 dependencies flow forward.
  });
});
```

Run: `node --test test/integration/orchestration-extension-blocked.test.ts`
Expected: PASS.

- [ ] **Step 10.8: Commit**

```bash
git add pi-extension/orchestration/ test/orchestration/ test/integration/orchestration-extension-blocked.test.ts
git commit -m "feat(orchestration): route caller_ping to blocked state via registry"
```

---

### Task 11: Serial continuation after resume

**Files:**
- Modify: `pi-extension/orchestration/registry.ts`
- Modify: `pi-extension/orchestration/tool-handlers.ts`
- Modify: `test/orchestration/block-resume.test.ts`

- [ ] **Step 11.1: Un-skip the final assertion in block-resume.test.ts**

Remove the `// Confirmed in Task 11` comment and make the final `assert.ok(complete2, ...)` active.

Run: `node --test test/orchestration/block-resume.test.ts`
Expected: FAIL — serial doesn't resume.

- [ ] **Step 11.2: Add a continuation callback to the registry and finalize on non-successful resume**

Extend the registry to accept a continuation callback on dispatch:

```ts
export interface OrchestrationConfig {
  mode: OrchestrationMode;
  tasks: OrchestrationTask[];
  maxConcurrency?: number;
}

export interface Registry {
  // ...
  dispatchAsync(params: {
    config: OrchestrationConfig;
    onResumeUnblock?: (ctx: {
      orchestrationId: string;
      taskIndex: number;
      resumedResult: OrchestratedTaskResult;
    }) => void;
  }): string;
}
```

Store the callback on the `OrchestrationEntry` (extend the entry with an optional `continuation` field typed the same as `onResumeUnblock`, populated in `dispatchAsync` from `params.onResumeUnblock`).

Replace the stub `onResumeTerminal` introduced in Task 3 with the implementation below. It handles three branches, in order:

1. Always applies the resumed result to the blocked slot via `onTaskTerminal` (which itself runs `tryFinalize`).
2. For **serial** runs whose resumed slot landed non-successfully (`failed` or `cancelled`), synchronously collapses every remaining `pending` task to `cancelled`, fires the per-slot terminal hook for each, and re-runs `tryFinalize` so the aggregated completion can fire. Without this sweep, a failed/cancelled resume would leave downstream `pending` tasks that `tryFinalize` never transitions, and the orchestration would remain `running` forever.
3. For **serial** runs whose resumed slot landed `completed`, invokes the continuation callback that drives the next-step launch (wired in Step 11.3).

Parallel runs do not need either the sweep or the continuation callback: a failed/cancelled resume simply leaves any other running parallel slots to reach their own terminals, and `tryFinalize` emits the aggregated completion when the last slot terminates.

```ts
onResumeTerminal(sessionKey, result) {
  const own = ownership.get(sessionKey);
  if (!own) return;
  const entry = entries.get(own.orchestrationId);
  const wasBlocked = entry?.tasks[own.taskIndex].state === "blocked";

  // (1) Apply the resumed result. onTaskTerminal already calls tryFinalize,
  // but that call is a no-op for a serial run whose downstream tasks are
  // still `pending` — the sweep below is what lets aggregation fire.
  this.onTaskTerminal(own.orchestrationId, own.taskIndex, result);

  if (!entry) return;

  // (2) Serial non-success path: the serial pipeline is paused on this
  // slot, and all downstream tasks are still `pending` (never launched).
  // Forward progress stops here, so collapse the pending tail to
  // `cancelled` and re-run tryFinalize so the aggregated envelope reports
  // the failed/cancelled slot plus the untouched tail as `cancelled`.
  if (wasBlocked && entry.config.mode === "serial" && result.state !== "completed") {
    const cancelledIndices: number[] = [];
    for (let i = 0; i < entry.tasks.length; i++) {
      const t = entry.tasks[i];
      if (t.state === "pending") {
        entry.tasks[i] = {
          ...t,
          state: "cancelled",
          exitCode: t.exitCode ?? 1,
          error: t.error ?? "cancelled (upstream resume did not succeed)",
        };
        cancelledIndices.push(i);
      }
    }
    for (const idx of cancelledIndices) {
      notifyTaskTerminal(own.orchestrationId, idx, "cancelled");
    }
    tryFinalize(entry);
    return;
  }

  // (3) Serial success path: dispatch the continuation driver.
  if (wasBlocked && result.state === "completed" && entry.continuation) {
    entry.continuation({
      orchestrationId: entry.id,
      taskIndex: own.taskIndex,
      resumedResult: result,
    });
  }
},
```

Invariants enforced by this implementation — the regression tests in Step 11.5b exercise each:
- A non-successful serial resume **never** invokes the continuation callback; downstream tasks are not launched.
- A non-successful serial resume **always** finalizes the orchestration: the pending tail is swept to `cancelled` and `tryFinalize` emits the aggregated `orchestration_complete` event with `isError: true`.
- Parallel runs rely on `tryFinalize`'s existing all-terminal check; no sweep is needed because parallel slots are independent of the resumed slot's outcome.
- The sweep runs synchronously inside `onResumeTerminal`; it does not depend on the tool-handler continuation driver or on `subagent_run_cancel`.

- [ ] **Step 11.3: Continuation driver in tool-handlers.ts**

In the serial async branch, provide a continuation callback that runs **only when the registry invokes it** (i.e. only on a successful `completed` resume — the registry guard in Step 11.2 filters out `failed` / `cancelled`). The callback:
1. Resumes the serial sequence from `taskIndex + 1` using the resumed task's `finalMessage` as the new `{previous}` value.
2. Dispatches a nested `runSerial` over `params.tasks.slice(taskIndex + 1)` with the same registry hooks (index-offset by `taskIndex + 1`).
3. Applies the same fallback/cancellation sweep on completion.

```ts
function continueSerialFromIndex(opts: {
  orchestrationId: string;
  startIndex: number;
  previous: string;
  tasks: OrchestrationTask[];
  deps: LauncherDeps;
}): void {
  const { orchestrationId, startIndex, previous, tasks, deps } = opts;
  const signal = registry.getAbortSignal(orchestrationId)!;
  (async () => {
    try {
      // Substitute {previous} up front in the remaining tasks so `runSerial`
      // doesn't get its first-step lookback from nothing.
      const remaining = tasks.slice(startIndex).map((t, j) => ({
        ...t,
        task: j === 0 ? t.task.split("{previous}").join(previous) : t.task,
      }));
      const out = await runSerial(remaining, {
        signal,
        onLaunched: (j, info) => registry.onTaskLaunched(orchestrationId, startIndex + j, info),
        onTerminal: (j, r) => registry.onTaskTerminal(orchestrationId, startIndex + j, { ...r, index: startIndex + j }),
        onBlocked: (j, p) => registry.onTaskBlocked(orchestrationId, startIndex + j, p),
      }, deps);
      if (out.blocked) {
        // Paused again on a downstream step. Wait for the next resume to
        // drive another continuation — do NOT cancel the tail.
        return;
      }
      // Fallback sweep: only on true terminal exits.
      const snap = registry.getSnapshot(orchestrationId);
      if (snap) {
        for (const t of snap.tasks) {
          if (t.state === "pending" || t.state === "running") {
            registry.onTaskTerminal(orchestrationId, t.index, {
              ...t, state: "cancelled", exitCode: 1, error: t.error ?? "not launched",
            });
          }
        }
      }
    } catch (err: any) {
      const snap = registry.getSnapshot(orchestrationId);
      if (snap) {
        for (const t of snap.tasks) {
          if (t.state === "pending" || t.state === "running" || t.state === "blocked") {
            registry.onTaskTerminal(orchestrationId, t.index, {
              ...t, state: "failed", exitCode: 1, error: err?.message ?? String(err),
            });
          }
        }
      }
    }
  })();
}
```

Pass this as `onResumeUnblock`:

```ts
const orchestrationId = registry.dispatchAsync({
  config: { mode: "serial", tasks: params.tasks },
  onResumeUnblock: ({ taskIndex, resumedResult }) => {
    continueSerialFromIndex({
      orchestrationId,
      startIndex: taskIndex + 1,
      previous: resumedResult.finalMessage ?? "",
      tasks: params.tasks,
      deps,
    });
  },
});
```

Parallel orchestration doesn't need the continuation callback — the registry's `tryFinalize` already re-evaluates aggregation after a `blocked → completed` transition.

- [ ] **Step 11.4: Run block-resume test**

Run: `node --test test/orchestration/block-resume.test.ts`
Expected: PASS.

- [ ] **Step 11.5: Parallel block-resume test**

Append to `test/orchestration/block-resume.test.ts`:

```ts
describe("parallel block-resume", () => {
  it("one task blocks, siblings complete, resume closes the last slot, aggregated completion fires", async () => {
    let sent = false;
    const deps: LauncherDeps = {
      async launch(t) {
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(),
                 sessionKey: t.name === "blocker" ? "sess-block" : `sess-${t.name}` };
      },
      async waitForCompletion(h) {
        if (h.name === "blocker" && !sent) {
          sent = true;
          return { name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 1,
            sessionKey: "sess-block", ping: { name: "blocker", message: "?" } };
        }
        return { name: h.name, finalMessage: `ok-${h.name}`, transcriptPath: null,
                 exitCode: 0, elapsedMs: 1, sessionKey: h.name === "blocker" ? "sess-block" : `sess-${h.name}` };
      },
    };
    const emitted: any[] = [];
    const registry = createRegistry((p) => emitted.push(p));
    const { api, tools } = makeApi();
    registerOrchestrationTools(api, () => deps, () => true, () => null, () => null, { registry });
    const parallel = tools.find((t) => t.name === "subagent_run_parallel");
    const env = await parallel.execute("pbr",
      { wait: false, tasks: [
        { name: "blocker", agent: "x", task: "t1" },
        { name: "sibling", agent: "x", task: "t2" },
      ] },
      new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 50));
    // Sibling done, blocker blocked — no completion yet.
    assert.equal(emitted.filter((e) => e.kind === "orchestration_complete").length, 0);
    assert.ok(emitted.find((e) => e.kind === "blocked"));
    // Simulate the resume:
    registry.onResumeTerminal("sess-block", {
      name: "blocker", index: 0, state: "completed", finalMessage: "resolved-block",
      exitCode: 0, elapsedMs: 5, sessionKey: "sess-block",
    });
    await new Promise((r) => setTimeout(r, 10));
    const complete = emitted.find((e) => e.kind === "orchestration_complete");
    assert.ok(complete);
    assert.equal(complete.results[0].state, "completed");
    assert.equal(complete.results[1].state, "completed");
    assert.equal(complete.isError, false);
    void env;
  });
});
```

Run: `node --test test/orchestration/block-resume.test.ts`
Expected: PASS.

- [ ] **Step 11.5b: Serial resume into `failed` does NOT launch downstream tasks**

Serial continuation must gate on `state === "completed"`, not on "was blocked + terminal". A resumed task that fails (or is cancelled) must freeze forward progress. Append:

```ts
describe("serial block-resume — non-successful resume", () => {
  it("resume into `failed` does not launch downstream tasks; aggregated completion reports failed + cancelled tail", async () => {
    const launched: string[] = [];
    const deps: LauncherDeps = {
      async launch(t) {
        launched.push(t.name ?? "s");
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(),
                 sessionKey: `sess-${t.name}` };
      },
      async waitForCompletion(h) {
        if (h.name === "a") {
          // Block on first step.
          return { name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 1,
                   sessionKey: "sess-a", ping: { name: "a", message: "?" } };
        }
        return { name: h.name, finalMessage: `ok-${h.name}`, transcriptPath: null,
                 exitCode: 0, elapsedMs: 1, sessionKey: `sess-${h.name}` };
      },
    };
    const emitted: any[] = [];
    const registry = createRegistry((p) => emitted.push(p));
    const { api, tools } = makeApi();
    registerOrchestrationTools(api, () => deps, () => true, () => null, () => null, { registry });
    const serial = tools.find((t) => t.name === "subagent_run_serial");
    const env = await serial.execute("sbrf",
      { wait: false, tasks: [
        { name: "a", agent: "x", task: "t1" },
        { name: "b", agent: "x", task: "t2" },
        { name: "c", agent: "x", task: "t3" },
      ] },
      new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(launched, ["a"]); // only the blocker launched

    // Parent's resume fails.
    registry.onResumeTerminal("sess-a", {
      name: "a", index: 0, state: "failed", finalMessage: "err",
      exitCode: 1, elapsedMs: 5, sessionKey: "sess-a", error: "boom",
    });
    await new Promise((r) => setTimeout(r, 20));

    // b and c must NOT launch.
    assert.deepEqual(launched, ["a"]);

    const complete = emitted.find((e) => e.kind === "orchestration_complete");
    assert.ok(complete, "aggregated completion must still fire");
    assert.equal(complete.isError, true);
    assert.equal(complete.results[0].state, "failed");
    // Untouched downstream tasks collapse to cancelled in the final envelope.
    assert.equal(complete.results[1].state, "cancelled");
    assert.equal(complete.results[2].state, "cancelled");
    void env;
  });

  it("resume into `cancelled` does not launch downstream tasks", async () => {
    const launched: string[] = [];
    const deps: LauncherDeps = {
      async launch(t) {
        launched.push(t.name ?? "s");
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(),
                 sessionKey: `sess-${t.name}` };
      },
      async waitForCompletion(h) {
        if (h.name === "a") {
          return { name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 1,
                   sessionKey: "sess-a", ping: { name: "a", message: "?" } };
        }
        return { name: h.name, finalMessage: `ok-${h.name}`, transcriptPath: null,
                 exitCode: 0, elapsedMs: 1, sessionKey: `sess-${h.name}` };
      },
    };
    const emitted: any[] = [];
    const registry = createRegistry((p) => emitted.push(p));
    const { api, tools } = makeApi();
    registerOrchestrationTools(api, () => deps, () => true, () => null, () => null, { registry });
    const serial = tools.find((t) => t.name === "subagent_run_serial");
    const env = await serial.execute("sbrc",
      { wait: false, tasks: [
        { name: "a", agent: "x", task: "t1" },
        { name: "b", agent: "x", task: "t2" },
      ] },
      new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(launched, ["a"]);

    registry.onResumeTerminal("sess-a", {
      name: "a", index: 0, state: "cancelled", finalMessage: "",
      exitCode: 1, elapsedMs: 5, sessionKey: "sess-a",
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(launched, ["a"]);

    const complete = emitted.find((e) => e.kind === "orchestration_complete");
    assert.ok(complete);
    assert.equal(complete.isError, true);
    assert.equal(complete.results[0].state, "cancelled");
    assert.equal(complete.results[1].state, "cancelled");
    void env;
  });
});
```

Run: `node --test test/orchestration/block-resume.test.ts`
Expected: PASS.

- [ ] **Step 11.5c: Registry-level gating unit test for `onResumeTerminal` continuation**

Prove the gating lives in the registry, not only downstream. Append to `test/orchestration/registry.test.ts`:

```ts
describe("createRegistry onResumeTerminal — continuation gating", () => {
  it("invokes the continuation callback only when the resumed slot lands `completed`", () => {
    const calls: Array<{ taskIndex: number; state: string }> = [];
    const { emitter } = makeEmitterSpy();
    const reg = createRegistry(emitter);

    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [
        { name: "a", agent: "x", task: "t1" },
        { name: "b", agent: "x", task: "t2" },
      ] },
      onResumeUnblock: (ctx) => calls.push({
        taskIndex: ctx.taskIndex,
        state: ctx.resumedResult.state,
      }),
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "?" });

    // Failed resume must NOT fire the continuation callback.
    reg.onResumeTerminal("sess-a", {
      name: "a", index: 0, state: "failed",
      finalMessage: "err", exitCode: 1, elapsedMs: 5, sessionKey: "sess-a", error: "x",
    });
    assert.deepEqual(calls, []);
  });

  it("does not invoke the continuation for a `cancelled` resume either", () => {
    const calls: any[] = [];
    const { emitter } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [
        { name: "a", agent: "x", task: "t1" },
        { name: "b", agent: "x", task: "t2" },
      ] },
      onResumeUnblock: (ctx) => calls.push(ctx),
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "?" });
    reg.onResumeTerminal("sess-a", {
      name: "a", index: 0, state: "cancelled",
      finalMessage: "", exitCode: 1, elapsedMs: 5, sessionKey: "sess-a",
    });
    assert.equal(calls.length, 0);
  });

  it("invokes the continuation exactly once when the resumed slot lands `completed`", () => {
    const calls: any[] = [];
    const { emitter } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [
        { name: "a", agent: "x", task: "t1" },
        { name: "b", agent: "x", task: "t2" },
      ] },
      onResumeUnblock: (ctx) => calls.push(ctx),
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "?" });
    reg.onResumeTerminal("sess-a", {
      name: "a", index: 0, state: "completed",
      finalMessage: "ok", exitCode: 0, elapsedMs: 5, sessionKey: "sess-a",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].taskIndex, 0);
    assert.equal(calls[0].resumedResult.state, "completed");
  });
});
```

Run: `node --test test/orchestration/registry.test.ts`
Expected: PASS.

- [ ] **Step 11.6: Registry-level recursion test (unit)**

This test exercises the registry's `onTaskBlocked` + `onResumeTerminal` primitives directly — it locks the state-machine contract. The **production** recursion path through the real `subagent_resume` tool is exercised in the e2e test at Task 14 (Step 14.2) after Task 12 wires the resume handler to route re-pings into `onTaskBlocked`.

Append:

```ts
it("registry recursion: repeated blocked transitions then a terminal resume", async () => {
  const emitted: any[] = [];
  const registry = createRegistry((p) => emitted.push(p));
  const id = registry.dispatchAsync({
    config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
  });
  registry.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
  registry.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "?" });
  assert.equal(emitted.filter((e) => e.kind === "blocked").length, 1);
  // Simulate the resumed child pinging again: second blocked transition on
  // the same (orchestrationId, taskIndex).
  registry.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "??" });
  assert.equal(emitted.filter((e) => e.kind === "blocked").length, 2);
  // Final resume completes.
  registry.onResumeTerminal("sess-a", {
    name: "a", index: 0, state: "completed", finalMessage: "final",
    exitCode: 0, elapsedMs: 1, sessionKey: "sess-a",
  });
  assert.ok(emitted.find((e) => e.kind === "orchestration_complete"));
});
```

Run: `node --test test/orchestration/block-resume.test.ts`
Expected: PASS.

- [ ] **Step 11.7: Commit**

```bash
git add pi-extension/orchestration/ test/orchestration/block-resume.test.ts
git commit -m "feat(orchestration): serial continuation after resume-unblock"
```

---

### Task 12: `subagent_resume` cross-orch re-ingestion

**Files:**
- Modify: `pi-extension/subagents/index.ts` (the `subagent_resume.execute` handler)
- Modify: `test/integration/orchestration-async.test.ts` (add a resume e2e test) OR create a new test file

- [ ] **Step 12.1: Write a failing e2e test for the cross-orch hook**

Append to `test/integration/orchestration-async.test.ts`:

```ts
describe("subagent_resume re-ingestion into owning orchestration", () => {
  it("when standalone subagent_resume completes on an orch-owned session, the registry receives onResumeTerminal", async () => {
    // The pi-backed ownership key is the session file path (same value that
    // `subagent_resume({ sessionPath })` accepts). Use a realistic path-like
    // value to pin that contract.
    const ownedKey = "/tmp/orch-owned.jsonl";
    const registry = createRegistry(() => {});
    // Dispatch an orchestration that blocks task 0:
    const id = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    registry.onTaskLaunched(id, 0, { sessionKey: ownedKey });
    registry.onTaskBlocked(id, 0, { sessionKey: ownedKey, message: "?" });
    assert.equal(registry.lookupOwner(ownedKey)!.orchestrationId, id);

    // Simulate what subagent_resume.execute's watcher must do on completion:
    registry.onResumeTerminal(ownedKey, {
      name: "a", index: 0, state: "completed", finalMessage: "resolved",
      exitCode: 0, elapsedMs: 5, sessionKey: ownedKey,
    });
    const snap = registry.getSnapshot(id);
    assert.equal(snap!.tasks[0].state, "completed");
    assert.equal(snap!.tasks[0].finalMessage, "resolved");
  });

  it("Claude-backed re-ingestion: sessionId-keyed ownership routes the resume result back to the owning orchestration", async () => {
    // Claude children learn their sessionKey (=claudeSessionId) after launch
    // via updateSessionKey (Task 9.5b).
    const claudeId = "claude-sess-abc123";
    const registry = createRegistry(() => {});
    const id = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    registry.onTaskLaunched(id, 0, {}); // no sessionKey at launch for Claude
    registry.updateSessionKey(id, 0, claudeId);
    registry.onTaskBlocked(id, 0, { sessionKey: claudeId, message: "?" });
    assert.equal(registry.lookupOwner(claudeId)!.orchestrationId, id);

    // subagent_resume({ sessionId: claudeId, ... }) path funnels through the
    // same lookup; its watcher calls onResumeTerminal with the Claude id:
    registry.onResumeTerminal(claudeId, {
      name: "a", index: 0, state: "completed", finalMessage: "claude-resolved",
      exitCode: 0, elapsedMs: 5, sessionKey: claudeId,
    });
    const snap = registry.getSnapshot(id);
    assert.equal(snap!.tasks[0].state, "completed");
    assert.equal(snap!.tasks[0].finalMessage, "claude-resolved");
  });
});
```

Run: `node --test test/integration/orchestration-async.test.ts`
Expected: PASS (registry already supports this from Tasks 3 + 10). This test locks the contract.

- [ ] **Step 12.2: Wire `subagent_resume` in index.ts to call into the registry**

**Ownership key contract recap.** The registry's ownership map is keyed on the same value the parent will pass back through `subagent_resume`. For pi-backed children, that value is the session file path (set at launch time from `running.sessionFile` / `spec.subagentSessionFile` and threaded through `BackendResult.sessionKey` → `LaunchedHandle.sessionKey` → `registry.onTaskLaunched({ sessionKey })`). Claude-backed children set `sessionKey = claudeSessionId`, late-bound through `registry.updateSessionKey(...)` when the `system/init` event arrives (Task 9.5b). The `subagent_resume` tool accepts either `sessionPath` (pi) or `sessionId` (Claude) as mutually-exclusive inputs; both funnel through the same ownership-map lookup.

**Schema change to `subagent_resume`.** Extend the tool's parameter schema so exactly one of `sessionPath` / `sessionId` must be provided:

```ts
const ResumeParams = Type.Object({
  sessionPath: Type.Optional(Type.String({
    description: "Path to the pi-backed subagent session file. Mutually exclusive with sessionId.",
  })),
  sessionId: Type.Optional(Type.String({
    description: "Claude session id for a Claude-backed subagent. Mutually exclusive with sessionPath.",
  })),
  message: Type.String({ description: "Follow-up prompt to deliver to the resumed session." }),
});
```

Inside `execute`, validate that exactly one of `sessionPath` / `sessionId` is set and compute the canonical ownership key:

```ts
if (!!params.sessionPath === !!params.sessionId) {
  return {
    content: [{ type: "text", text: "subagent_resume: provide exactly one of sessionPath or sessionId." }],
    isError: true,
  };
}
const sessionKey = params.sessionPath ?? params.sessionId!;
```

Branch the actual resume launch on which identifier was provided. The `sessionPath` path is unchanged (existing mux-pane resume). The `sessionId` path launches a Claude resume:

- Pane backend available → open a mux pane running `claude --resume <sessionId>` with the follow-up `message` piped in. Reuse the existing mux-pane plumbing (the same helper `subagent_resume` already uses for `sessionPath`, parameterized on the underlying command).
- No mux available → return the existing `muxUnavailableResult()` with a message that names the unavailable backend so the caller can decide whether to retry once mux is configured.

**Resume → registry routing.** In `pi-extension/subagents/index.ts`, hoist `registry` so it is in scope inside the `subagent_resume` handler (it already is — registry is constructed at the top of `subagentsExtension`). Inside the `watchSubagent(running, watcherAbort.signal).then(...)` completion callback, route both outcomes into the registry:

1. **Terminal completion** → `registry.onResumeTerminal(sessionKey, terminalResult)` if the session is owned. Unblocks the owning slot and drives serial continuation / parallel aggregation.
2. **Ping during resume** → `registry.onTaskBlocked(owningOrchId, owningTaskIndex, { sessionKey, message })` if the session is owned. Re-transitions the slot to `blocked` and re-emits the blocked steer-back so recursion works through the real tool path.

```ts
// Inside subagent_resume's watchSubagent.then(...) callback, immediately after
// the existing widget update but BEFORE the two branches that send standalone
// ping / completion steer-back messages, compute the ownership key once:
// sessionKey was computed above from whichever of sessionPath/sessionId was
// provided; it matches whatever the registry recorded at launch / late-bind.
const owner = registry.lookupOwner(sessionKey);

if (result.ping) {
  // existing standalone subagent_ping emission...
  pi.sendMessage({ /* ...unchanged... */ }, { triggerTurn: true, deliverAs: "steer" });

  // NEW: if orch-owned, re-block the owning slot.
  if (owner) {
    registry.onTaskBlocked(owner.orchestrationId, owner.taskIndex, {
      sessionKey,
      message: result.ping.message,
    });
  }
  return;
}

// existing terminal-completion path: compute summary, emit standalone steer-back,
// then, if owned, re-ingest the terminal result into the owning orchestration.
// ... existing pi.sendMessage(...) for subagent_result/subagent_cancel ...

if (owner) {
  registry.onResumeTerminal(sessionKey, {
    name: /* pull from registry snapshot */ registry.getSnapshot(owner.orchestrationId)
      ?.tasks[owner.taskIndex].name ?? `task-${owner.taskIndex + 1}`,
    index: owner.taskIndex,
    state: result.exitCode === 0 && !result.error ? "completed" : "failed",
    finalMessage: summary,            // the variable computed in the existing path
    transcriptPath: null,
    elapsedMs: result.elapsed * 1000,
    exitCode: result.exitCode,
    sessionKey,
    error: result.error,
  });
}
```

- [ ] **Step 12.3: (No separate sessionKey task needed)**

Task 1 already added `LaunchedHandle.sessionKey`. The concrete wiring at each call site:

- `pi-extension/subagents/backends/types.ts`: `BackendResult.sessionKey?: string`.
- `pi-extension/subagents/backends/pane.ts`: populate `BackendResult.sessionKey` from `running.sessionFile` (pi children) or from `sub.claudeSessionId` (Claude children). Also populate `LaunchedHandle.sessionKey` from `running.sessionFile` at launch time for pi.
- `pi-extension/subagents/backends/headless.ts`: populate both fields from `spec.subagentSessionFile` for pi; for Claude, best-effort from the `system/init` session id (late-bound — document the gap).
- `pi-extension/orchestration/default-deps.ts`: pass `BackendResult.sessionKey` through on the `waitForCompletion` return; pass `LaunchedHandle.sessionKey` through on `launch` return.
- `pi-extension/orchestration/run-serial.ts` / `run-parallel.ts`: on `deps.launch` resolve, call `opts.onLaunched?.(i, { sessionKey: handle.sessionKey })`. When a result carries `ping` AND `sessionKey`, route via `opts.onBlocked?.(i, { sessionKey, message, partial })` (Task 10).

- [ ] **Step 12.4: Run tests**

Run: `node --test test/orchestration/registry.test.ts test/orchestration/async-dispatch.test.ts test/orchestration/block-resume.test.ts test/integration/orchestration-async.test.ts`
Expected: PASS.

- [ ] **Step 12.5: Commit**

```bash
git add pi-extension/orchestration/ pi-extension/subagents/ test/
git commit -m "feat(orchestration): re-ingest standalone subagent_resume into owning orch"
```

---

### Task 13: Widget `blocked` state

**Files:**
- Modify: `pi-extension/subagents/index.ts` (renderSubagentWidgetLines + RunningSubagent)
- Modify: `test/test.ts` (widget rendering assertions)

- [ ] **Step 13.1: Write failing widget test**

Append to `test/test.ts` in the `describe("subagents widget rendering", ...)` block:

```ts
it("renders blocked tasks with a distinct status, keyed on (orchestrationId, taskIndex)", () => {
  const testApi = (subagentsModule as any).__test__;
  const originalNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const lines = testApi.renderSubagentWidgetLines([
      {
        id: "a1", name: "A", task: "",
        startTime: 1_000_000 - 5000,
        blocked: {
          orchestrationId: "7a3f91e2", taskIndex: 0,
          message: "which schema?",
        },
      },
    ], 60);
    // The blocked row must include something signalling "blocked" — the exact
    // glyph is up to the implementation, but it must not render as "starting…"
    // or "running…".
    const body = lines.join("\n");
    assert.ok(/blocked/i.test(body), `expected blocked indicator, got: ${body}`);
    assert.ok(!/starting|running/.test(body), `blocked row must not say starting/running, got: ${body}`);
  } finally {
    Date.now = originalNow;
  }
});
```

- [ ] **Step 13.2: Run, expect fail**

Run: `node --test test/test.ts`
Expected: FAIL.

- [ ] **Step 13.3: Extend RunningSubagent and widget**

In `pi-extension/subagents/index.ts`:

```ts
export interface RunningSubagent {
  // ...existing fields...
  blocked?: {
    orchestrationId: string;
    taskIndex: number;
    message: string;
  };
}

// In renderSubagentWidgetLines, within the per-agent loop:
for (const agent of agents) {
  const elapsed = formatElapsedMMSS(agent.startTime);
  const agentTag = agent.agent ? ` (${agent.agent})` : "";
  const left = ` ${elapsed}  ${agent.name}${agentTag} `;
  let right: string;
  if (agent.blocked) {
    right = ` blocked — awaiting parent `;
  } else if (agent.entries != null && agent.bytes != null) {
    right = ` ${agent.entries} msgs (${formatBytes(agent.bytes)}) `;
  } else if (agent.cli === "claude") {
    right = " running… ";
  } else {
    right = " starting… ";
  }
  lines.push(borderLine(left, right, width));
}
```

- [ ] **Step 13.4: Hook the registry → widget mapping**

Extend the registry wiring from Task 5 so a blocked event adds a virtual `RunningSubagent` entry that keeps the widget row visible after the pane closes, and the per-task `onTaskTerminal` hook clears it when the slot reaches any terminal state — not only when the whole orchestration finishes. Spec: "Cleared on transition to any terminal state."

Declare the virtual-blocked map and the `onOrchestrationTaskTerminal` stub introduced in Task 5, then replace the emitter body:

```ts
const virtualBlocked = new Map<string, RunningSubagent>(); // keyed by `${oid}:${taskIndex}`

function onOrchestrationTaskTerminal(orchestrationId: string, taskIndex: number): void {
  const key = `${orchestrationId}:${taskIndex}`;
  const virt = virtualBlocked.get(key);
  if (!virt) return;
  runningSubagents.delete(virt.id);
  virtualBlocked.delete(key);
  updateWidget();
}

const registry = createRegistry(
  (payload) => {
    if (payload.kind === BLOCKED_KIND) {
      const key = `${payload.orchestrationId}:${payload.taskIndex}`;
      const entry: RunningSubagent = {
        id: `virt-${key}`,
        name: payload.taskName,
        task: "",
        backend: "pane",
        startTime: Date.now(),
        blocked: {
          orchestrationId: payload.orchestrationId,
          taskIndex: payload.taskIndex,
          message: payload.message,
        },
      };
      virtualBlocked.set(key, entry);
      runningSubagents.set(entry.id, entry);
      updateWidget();
      pi.sendMessage({
        customType: BLOCKED_KIND,
        content:
          `Task "${payload.taskName}" in orchestration "${payload.orchestrationId}" is blocked:\n\n${payload.message}`,
        display: true,
        details: payload,
      }, { triggerTurn: true, deliverAs: "steer" });
    } else if (payload.kind === ORCHESTRATION_COMPLETE_KIND) {
      // Per-task cleanup is handled by the onTaskTerminal hook below.
      // This branch only sends the aggregated steer-back.
      updateWidget();
      pi.sendMessage({
        customType: "orchestration_complete",
        content:
          `Orchestration "${payload.orchestrationId}" completed ` +
          `(${payload.results.length} task(s), isError=${payload.isError}).`,
        display: true,
        details: payload,
      }, { triggerTurn: true, deliverAs: "steer" });
    }
  },
  {
    // Per-task terminal transitions clear virtual blocked widget rows the
    // instant a specific slot goes terminal, without waiting for the whole
    // orchestration to complete. This is what keeps a resumed serial run
    // from showing a stale "blocked" row while step N+1 is already running.
    onTaskTerminal: ({ orchestrationId, taskIndex }) => {
      onOrchestrationTaskTerminal(orchestrationId, taskIndex);
    },
  },
);
```

(This replaces the registry-wiring block installed in Task 5 — Task 5 left the branches and the `onOrchestrationTaskTerminal` stub in place so that Task 13 can fill them in without re-plumbing the emitter contract.)

Also append a test to `test/test.ts` that proves the per-task terminal cleanup path:

```ts
it("removes a virtual blocked row when that task transitions to terminal, even if the orchestration is still running", () => {
  // Drive the registry directly through a tiny bootstrap that mirrors
  // subagentsExtension's wiring, or expose the hook + virtualBlocked map
  // via __test__ for assertion. The invariant to lock: if onTaskTerminal
  // fires for (oid, idx), the corresponding `virt-${oid}:${idx}` entry is
  // removed from runningSubagents and the widget re-renders.
  //
  // Implementation detail: this test is the guard against regressing to
  // "only clear on orchestration_complete" behavior.
});
```

Fill the test body using the same `__test__` surface already used by the existing widget tests.

- [ ] **Step 13.5: Run tests**

Run: `node --test test/test.ts`
Expected: PASS including the new blocked widget test.

- [ ] **Step 13.6: Commit**

```bash
git add pi-extension/subagents/index.ts test/test.ts
git commit -m "feat(orchestration): widget blocked state with (oid, taskIndex) keying"
```

---

### Task 13b: Sync-mode ping regression test

**Files:**
- Create: `test/orchestration/sync-ping-regression.test.ts`

- [ ] **Step 13b.1: Write the regression test**

```ts
// test/orchestration/sync-ping-regression.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSerial } from "../../pi-extension/orchestration/run-serial.ts";
import { runParallel } from "../../pi-extension/orchestration/run-parallel.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

describe("sync orchestration with a pinging child — behavior unchanged", () => {
  const pingDeps: LauncherDeps = {
    async launch(t) { return { id: t.task, name: t.name ?? "s", startTime: Date.now() }; },
    async waitForCompletion(h) {
      return {
        name: h.name, finalMessage: "", transcriptPath: null,
        exitCode: 0, elapsedMs: 1,
        sessionKey: `sess-${h.name}`,
        ping: { name: h.name, message: "need help" },
      };
    },
  };

  it("runSerial (sync, no onBlocked hook) records ping as completed with finalMessage=ping.message", async () => {
    const out = await runSerial(
      [{ name: "a", agent: "x", task: "t" }, { name: "b", agent: "x", task: "t2" }],
      {}, // no onBlocked
      pingDeps,
    );
    assert.equal(out.isError, false);
    assert.equal(out.results[0].state, "completed");
    assert.equal(out.results[0].finalMessage, "need help");
    // Sequence continues — step 2 runs too:
    assert.equal(out.results.length, 2);
    assert.equal(out.results[1].finalMessage, "need help");
  });

  it("runParallel (sync, no onBlocked hook) records ping as completed with finalMessage=ping.message", async () => {
    const out = await runParallel(
      [{ name: "a", agent: "x", task: "t" }, { name: "b", agent: "x", task: "t" }],
      {},
      pingDeps,
    );
    assert.equal(out.isError, false);
    assert.equal(out.results.every((r: any) => r.state === "completed"), true);
    assert.equal(out.results.every((r: any) => r.finalMessage === "need help"), true);
  });
});
```

- [ ] **Step 13b.2: Run the regression test**

Run: `node --test test/orchestration/sync-ping-regression.test.ts`
Expected: PASS (implementation from Task 10 already supports this).

- [ ] **Step 13b.3: Commit**

```bash
git add test/orchestration/sync-ping-regression.test.ts
git commit -m "test(orchestration): pin sync caller_ping backwards compat"
```

---

### Task 14: Phase 2 integration test + docs

**Files:**
- Create: `test/integration/agents/test-ping-resumable.md` (fixture used by 14.2b and 14.2c)
- Create: `test/integration/orchestration-block-resume-e2e.test.ts`
- Create: `test/integration/orchestration-extension-resume-routing.test.ts`
- Create: `test/integration/orchestration-pane-block-backend.test.ts`
- Create: `test/integration/orchestration-headless-block-backend.test.ts`
- Modify: `README.md`

**Fixture note.** The existing `test/integration/agents/test-ping.md` instructs the child to call `caller_ping` for ANY task it receives — there is no path for a resumed session to terminate normally. The backend-real tests below require a child that pings once and then completes on resume, so Step 14.2a introduces a new `test-ping-resumable` agent instead of modifying `test-ping` (other integration tests rely on `test-ping`'s always-ping behavior).

- [ ] **Step 14.1: Write the registry-level e2e block/resume test**

```ts
// test/integration/orchestration-block-resume-e2e.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import { createRegistry } from "../../pi-extension/orchestration/registry.ts";
import {
  BLOCKED_KIND,
  ORCHESTRATION_COMPLETE_KIND,
} from "../../pi-extension/orchestration/notification-kinds.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

describe("orchestration end-to-end — block/resume across parallel fan-out", () => {
  it("3 workers, 1 pings, parent resumes, all complete", async () => {
    let pinged = false;
    const deps: LauncherDeps = {
      async launch(t) {
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(),
                 sessionKey: `sess-${t.name ?? "s"}` };
      },
      async waitForCompletion(h) {
        if (h.name === "w2" && !pinged) {
          pinged = true;
          return { name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 5,
                   sessionKey: "sess-w2", ping: { name: "w2", message: "need help" } };
        }
        return { name: h.name, finalMessage: `ok-${h.name}`, transcriptPath: null,
                 exitCode: 0, elapsedMs: 5, sessionKey: `sess-${h.name}` };
      },
    };
    const emitted: any[] = [];
    const registry = createRegistry((p) => emitted.push(p));
    const tools: any[] = [];
    const api = {
      registerTool: (t: any) => tools.push(t),
      on() {}, registerCommand() {}, registerMessageRenderer() {},
      sendMessage() {}, sendUserMessage() {},
    } as any;
    registerOrchestrationTools(api, () => deps, () => true, () => null, () => null, { registry });
    const parallel = tools.find((t) => t.name === "subagent_run_parallel");

    const env = await parallel.execute("e2e",
      { wait: false, tasks: [
        { name: "w1", agent: "x", task: "t1" },
        { name: "w2", agent: "x", task: "t2" },
        { name: "w3", agent: "x", task: "t3" },
      ] },
      new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" });

    await new Promise((r) => setTimeout(r, 60));
    const blocked = emitted.find((e) => e.kind === BLOCKED_KIND);
    assert.ok(blocked, "w2 should block");
    assert.equal(blocked.taskIndex, 1);
    assert.equal(blocked.message, "need help");
    const completeBefore = emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND);
    assert.equal(completeBefore, undefined);

    // Parent resumes:
    registry.onResumeTerminal("sess-w2", {
      name: "w2", index: 1, state: "completed",
      finalMessage: "answered", exitCode: 0, elapsedMs: 10, sessionKey: "sess-w2",
    });
    await new Promise((r) => setTimeout(r, 10));
    const complete = emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND);
    assert.ok(complete);
    assert.equal(complete.isError, false);
    assert.equal(complete.results.length, 3);
    assert.ok(complete.results.every((r: any) => r.state === "completed"));
    void env;
  });
});
```

- [ ] **Step 14.2: Write the real-`subagent_resume`-path e2e test (covers recursion through the real extension)**

This test exercises the full extension wiring (from review finding #4 / finding #6): a blocked task, resumed via the real `subagent_resume` tool registered by `subagentsExtension(...)`, where the resumed child pings again — and the orchestration re-blocks through the production path rather than a simulated `registry.onTaskBlocked` call. It also confirms that a terminal resume closes the owning slot via the same production handler.

```ts
// test/integration/orchestration-extension-resume-routing.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { subagentsExtension } from "../../pi-extension/subagents/index.ts";
import {
  BLOCKED_KIND,
  ORCHESTRATION_COMPLETE_KIND,
} from "../../pi-extension/orchestration/notification-kinds.ts";

// This test uses a controlled `watchSubagent` seam so the real
// subagent_resume tool handler and its registry routing run end-to-end
// without launching actual pi children. The seam is exposed through
// `pi-extension/subagents/index.ts::__test__` (add to the existing
// test-hook export if not already present).

describe("subagent_resume re-ingestion through the real extension wiring", () => {
  it("ping-during-resume routes via registry.onTaskBlocked so the orchestration re-blocks (recursion)", async () => {
    // 1. Boot the real extension against a fake pi that captures sendMessage.
    //    Use the existing extension test harness pattern (see test/test.ts
    //    for `__test__` surface).
    // 2. Dispatch an async orchestration whose task blocks on first wait.
    // 3. Assert the initial BLOCKED steer-back was emitted.
    // 4. Invoke the registered `subagent_resume` tool's `execute` against the
    //    blocked session path. Have the seamed `watchSubagent` return a
    //    second `ping` result.
    // 5. Assert a SECOND BLOCKED steer-back was emitted — i.e. the real
    //    subagent_resume handler called registry.onTaskBlocked, not just
    //    the standalone subagent_ping path.
    // 6. Invoke `subagent_resume` again; this time the seam returns a
    //    terminal completion. Assert an `ORCHESTRATION_COMPLETE_KIND`
    //    event fires carrying the resumed finalMessage.
  });

  it("terminal resume of a blocked task feeds back through subagent_resume into aggregated completion", async () => {
    // Same harness; only one ping + one terminal resume, confirming that
    // onResumeTerminal is reached through the real handler.
  });
});
```

The test above must exercise:
- The registered `subagent_resume` tool (not a direct `registry.onResumeTerminal` call).
- The `registry.onTaskBlocked` routing inside the resume handler (Task 12).
- The `ORCHESTRATION_COMPLETE_KIND` and `BLOCKED_KIND` emissions via `pi.sendMessage`.

Implementation notes: the existing `pi-extension/subagents/index.ts` already exposes a `__test__` object for the widget tests in `test/test.ts`. Extend that surface as needed to inject a fake `watchSubagent` result for the resumed session. Do not mock the registry.

Run: `node --test test/integration/orchestration-block-resume-e2e.test.ts test/integration/orchestration-extension-resume-routing.test.ts`
Expected: PASS.

- [ ] **Step 14.2a: Add a resumable ping fixture**

Create `test/integration/agents/test-ping-resumable.md`. This agent pings on its first turn and terminates normally when resumed with a follow-up message. The existing `test-ping.md` unconditionally calls `caller_ping` for any task it receives, so a resumed session cannot complete — that fixture is unchanged (it is still used by `subagent-lifecycle.test.ts` and other callers that want "always pings" behavior).

File contents:

```md
---
name: test-ping-resumable
description: Integration test agent — pings once on launch, completes normally on resume
model: anthropic/claude-haiku-4-5
tools: read, bash
spawning: false
disable-model-invocation: true
---

You are a test agent with two distinct behaviors based on message history.

**On your FIRST turn (no prior assistant messages in this session):** Call the `caller_ping` tool with `message` set to "PING: " followed by the task text you received. Do NOT call any other tool and do NOT attempt to complete the task. This is the initial block-state signal for the integration test.

**On any subsequent turn (you see your own prior `caller_ping` call in the conversation):** Reply with a short text message "resumed-ok" and STOP. Do NOT call `caller_ping` again. Do NOT call any other tools. Your goal is to terminate normally so the orchestration can mark the task `completed`.

The distinguishing signal is whether this session already contains an assistant turn with a `caller_ping` tool call: if yes, you are resumed and must finish; if no, you are in your first turn and must ping.
```

Verification: `ls test/integration/agents/test-ping-resumable.md` must show the file.

Smoke-check that `subagent-lifecycle.test.ts` and other callers of the existing `test-ping.md` are unmodified: `grep -l "test-ping" test/integration/*.test.ts`. The new fixture is used only by 14.2b and 14.2c.

- [ ] **Step 14.2b: Write a backend-real async/block test for the pane path**

**Files:**
- Create: `test/integration/orchestration-pane-block-backend.test.ts`

The tests above prove the registry/tool-handler bridge with injected `LauncherDeps` seams. This test proves that an actual pane backend result carrying a ping is transformed all the way into the expected `blocked` / completion behavior — without injecting `LauncherDeps` or seaming `watchSubagent`. It closes the gap around the pane backend's `ping` / `sessionKey` propagation in `pi-extension/subagents/backends/pane.ts` (from Task 9.4), which is otherwise covered only indirectly.

Use the `test-ping-resumable` agent from Step 14.2a (NOT `test-ping.md`, which never completes after resume) and the `pi-pane-smoke.test.ts` harness pattern for backend selection + skip semantics. The test must:

1. Boot the real `subagentsExtension(pi)` against a capturing fake `pi` (same `makeFakePi` pattern as Step 10.7b).
2. Do NOT call `__test__.setLauncherDepsOverride(...)` or `setWatchSubagentOverride(...)` — the whole point is to exercise the real `makeDefaultDeps` so that `launchSubagent` → `watchSubagent` → `pane.ts` run through the genuine backend path.
3. Dispatch `subagent_run_serial` with `wait: false` and one task referencing `test-ping-resumable`.
4. Assert one `customType: "blocked"` `pi.sendMessage(...)` fires with `details.sessionKey` equal to the subagent session file path the pane backend actually used (assert via `existsSync(details.sessionKey)` that the path is real, not fabricated), and `details.message` starts with `"PING: "`.
5. Invoke the registered `subagent_resume` tool with that `sessionPath` and a follow-up message (any non-empty string; the fixture completes on any resume input).
6. Assert an `orchestration_complete` steer-back fires carrying the task as `state: "completed"`.

```ts
// test/integration/orchestration-pane-block-backend.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  getAvailableBackends, setBackend, restoreBackend,
  createTestEnv, cleanupTestEnv, PI_TIMEOUT, type TestEnv,
} from "./harness.ts";
import subagentsExtension from "../../pi-extension/subagents/index.ts";
import {
  BLOCKED_KIND, ORCHESTRATION_COMPLETE_KIND,
} from "../../pi-extension/orchestration/notification-kinds.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; }
})();
const backends = getAvailableBackends();
const SHOULD_SKIP = !PI_AVAILABLE || backends.length === 0;

for (const backend of backends) {
  describe(`orchestration-pane-block-backend [${backend}]`, {
    skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 3,
  }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    before(() => { prevMux = setBackend(backend); env = createTestEnv(backend); });
    after(() => { cleanupTestEnv(env); restoreBackend(prevMux); });

    it("pane: caller_ping from a real child → blocked steer-back → subagent_resume → orchestration_complete", async () => {
      // Build a capturing fake pi that satisfies ExtensionAPI. Use the
      // makeFakePi() helper from orchestration-headless-no-mux.test.ts.
      // Boot subagentsExtension(fake.api). Dispatch subagent_run_serial with
      // a single task referencing agents/test-ping-resumable.md.
      // Await the BLOCKED_KIND sendMessage; assert sessionKey exists on disk.
      // Invoke the registered subagent_resume tool with that sessionPath and
      // any follow-up message. Await the ORCHESTRATION_COMPLETE_KIND
      // sendMessage and assert results[0].state === "completed".
    });
  });
}
```

Run: `node --test test/integration/orchestration-pane-block-backend.test.ts`
Expected: PASS on machines where `pi` is available and at least one mux backend is present; skipped otherwise (same skip semantics as `pi-pane-smoke.test.ts`).

- [ ] **Step 14.2c: Write a backend-real async/block test for the headless path**

**Files:**
- Create: `test/integration/orchestration-headless-block-backend.test.ts`

Mirror Step 14.2b for the headless backend. This exercises the real `runPiHeadless` ping-sidecar-detection change from Task 9.5 (the `.exit` sidecar parse → `BackendResult.ping` propagation) end-to-end.

**Current-codebase reality that constrains this test (calls out three non-obvious details):**

- Backend selection is controlled by `PI_SUBAGENT_MODE` (see `pi-extension/subagents/backends/select.ts`). There is no `PI_SUBAGENT_BACKEND` env var.
- `harness.createTestEnv(backend)` requires a `MuxBackend` (`"cmux"` or `"tmux"`) — it does NOT accept `"headless"`. Use the mkdtemp + `copyTestAgents()` pattern from `test/integration/orchestration-headless-no-mux.test.ts` to build an isolated, mux-free test directory instead.
- The registered `subagent_resume` tool still hard-requires mux today (it calls `isMuxAvailable()` and returns `muxUnavailableResult()` otherwise — see `pi-extension/subagents/index.ts` in the `subagent_resume.execute` handler). Making `subagent_resume` headless-capable is out of scope for this plan. Therefore the resume → completion half of this test requires a mux backend; the skip sentinel must check for `pi` AND at least one mux backend.

The test must:

1. Boot the real `subagentsExtension(pi)` against a capturing fake `pi` (same `makeFakePi` pattern used elsewhere).
2. Force headless-backend selection for the async dispatch: set `PI_SUBAGENT_MODE=headless` in `before` and restore in `after`. Do NOT call `__test__.setLauncherDepsOverride(...)` — the whole point is exercising the real headless backend + `.exit` sidecar parsing.
3. Build an isolated test project directory with `mkdtempSync` + `copyTestAgents(dir)` (pattern: `orchestration-headless-no-mux.test.ts`). This seeds `<dir>/.pi/agents/` with the fixture agents, including `test-ping-resumable` from Step 14.2a.
4. Dispatch `subagent_run_serial` with `wait: false` and one task referencing `test-ping-resumable` (NOT `test-ping.md`, which never terminates on resume).
5. Assert a `BLOCKED_KIND` `pi.sendMessage(...)` fires with `details.sessionKey` equal to the `spec.subagentSessionFile` the headless runner actually created, and verify `existsSync(details.sessionKey)` — the path is real, not fabricated.
6. Verify the Task 9.5 sidecar-cleanup invariant: once the ping has propagated into `BackendResult.ping`, the headless runner is expected to have removed `${sessionKey}.exit`; assert `existsSync(sessionKey + ".exit") === false`.
7. Invoke the registered `subagent_resume` tool with that `sessionPath` and any non-empty follow-up message. The resume handler opens a mux pane — this half requires mux availability; the skip sentinel already ensures that.
8. Assert `ORCHESTRATION_COMPLETE_KIND` is emitted with `state: "completed"`.

```ts
// test/integration/orchestration-headless-block-backend.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { copyTestAgents, getAvailableBackends, PI_TIMEOUT } from "./harness.ts";
import subagentsExtension from "../../pi-extension/subagents/index.ts";
import {
  BLOCKED_KIND, ORCHESTRATION_COMPLETE_KIND,
} from "../../pi-extension/orchestration/notification-kinds.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; }
})();
const HAS_MUX = getAvailableBackends().length > 0;
// The dispatch half runs headless (no mux needed), but the `subagent_resume`
// tool still hard-requires a mux. Skip when either is missing.
const SHOULD_SKIP = !PI_AVAILABLE || !HAS_MUX;

describe("orchestration-headless-block-backend", {
  skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 3,
}, () => {
  let prevMode: string | undefined;
  let dir: string;

  before(() => {
    prevMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-integ-headless-block-"));
    copyTestAgents(dir);
  });
  after(() => {
    if (prevMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = prevMode;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it("headless: caller_ping from a real child → blocked steer-back (real session path, sidecar cleaned) → subagent_resume → orchestration_complete", async () => {
    // 1. Build fake pi (makeFakePi pattern from orchestration-headless-no-mux.test.ts).
    // 2. Boot subagentsExtension(fake.api).
    // 3. Dispatch subagent_run_serial({ wait: false, tasks: [
    //      { name: "r1", agent: "test-ping-resumable", task: "hello" },
    //    ]}).
    // 4. Await a sendMessage with customType === BLOCKED_KIND. Capture
    //    details.sessionKey and assert existsSync(sessionKey) === true.
    //    Assert existsSync(sessionKey + ".exit") === false (Task 9.5 cleanup).
    // 5. Invoke the registered subagent_resume tool with
    //    { sessionPath: sessionKey, message: "please finish" }.
    //    (This half requires mux — the skip sentinel already guarantees it.)
    // 6. Await a sendMessage with customType === ORCHESTRATION_COMPLETE_KIND.
    //    Assert details.results[0].state === "completed".
  });
});
```

Run: `node --test test/integration/orchestration-headless-block-backend.test.ts`
Expected: PASS on machines where `pi` is on PATH AND at least one mux backend is available; skipped otherwise.

- [ ] **Step 14.3: Update README**

Add a new section after the `caller_ping` section (around README line 273):

```markdown
### caller_ping inside async orchestration

When a child spawned through `subagent_run_serial` / `subagent_run_parallel` (with `wait: false`) calls `caller_ping`, the task transitions to a `blocked` state instead of completing:

1. Orchestration emits a `blocked` steer-back with `{ orchestrationId, taskIndex, taskName, sessionKey, message }`. `sessionKey` is the session file path for pi-backed children (same value accepted by `subagent_resume({ sessionPath })`) or the Claude session id for Claude-backed children (accepted by `subagent_resume({ sessionId })`).
2. Widget row for the task stays visible with a "blocked — awaiting parent" indicator. The row clears as soon as that specific task transitions to any terminal state, even if the rest of the orchestration is still running.
3. Parent resumes the child via standalone `subagent_resume` using whichever identifier matches its backend (`sessionPath` for pi, `sessionId` for Claude; pass exactly one). On terminal completion the result is re-ingested into the original orchestration. If the resumed child pings again, the orchestration re-blocks (recursive unblock loop supported).
4. Serial runs resume from the next step using the resumed task's `finalMessage` as `{previous}`; parallel runs re-evaluate aggregation and fire completion once all slots are terminal.

Cancelling a blocked task via `subagent_run_cancel` transitions it to `cancelled` without attempting resume.

**v1 limitations:**
- No depth limit on recursion (pinging child resumed, pings again).
- Sync orchestrations (`wait: true` or omitted) continue today's behavior: `caller_ping` closes the pane and the task is recorded as `completed` with the ping message as `finalMessage`.
- No disk persistence of registry / ownership map: a pi crash or `/reload` kills live async runs silently.
- `subagent_resume` requires a mux backend for both `sessionPath` and `sessionId` paths in v1; without one it returns the standard mux-unavailable result.
```

Also update the tool-list table at line ~110 with the Phase 2 addition: add a note on `subagent_run_serial` / `subagent_run_parallel` that "tasks may enter `blocked` state in async mode". If a steer-back listing exists, add an entry for the `blocked` notification kind (value `"blocked"`, matching the spec).

- [ ] **Step 14.4: Full test suite run**

Run: `npm test && npm run typecheck`
Expected: PASS with 0 type errors.

- [ ] **Step 14.5: Commit**

```bash
git add README.md \
  test/integration/agents/test-ping-resumable.md \
  test/integration/orchestration-block-resume-e2e.test.ts \
  test/integration/orchestration-extension-resume-routing.test.ts \
  test/integration/orchestration-pane-block-backend.test.ts \
  test/integration/orchestration-headless-block-backend.test.ts
git commit -m "docs(orchestration): document caller_ping in async orchestration"
```

---

### Task 15: Final regression pass

**Files:**
- No new files — run every test and fix any regressions.

- [ ] **Step 15.1: Run every in-repo test**

Run: `npm test`
Expected: all pre-existing tests still pass (run-serial's existing 10+ tests, run-parallel, tool-handlers, launch-spec, etc.).

- [ ] **Step 15.2: Run every integration test**

Run: `npm run test:integration`
Expected: PASS.

- [ ] **Step 15.3: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 15.4: Grep for dangling old names**

Run: `grep -rn "subagent_serial\|subagent_parallel" pi-extension/ test/ README.md | grep -v "2026-04-22-orchestration-lifecycle"`
Expected: no hits (the spec and this plan are the only files that may reference the old names, for historical context).

- [ ] **Step 15.5: Grep for TODO / placeholder markers**

Run: `grep -rn "TBD\|TODO(phase)\|FIXME" pi-extension/orchestration/ | grep -v "^Binary"`
Expected: no unresolved markers introduced by this plan.

- [ ] **Step 15.6: Grep for blocked-kind consistency**

Run: `grep -rn "orchestration_blocked" pi-extension/ test/` and `grep -rn "BLOCKED_KIND\s*=\s*\"orchestration_blocked\"" pi-extension/`
Expected: no hits. The blocked kind is exactly `"blocked"` per spec.

- [ ] **Step 15.7: Self-review against the spec**

Open `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md` and the plan side by side. For each section in the spec, locate the implementing task:

- Unified lifecycle model → Task 1, 2
- Async dispatch with `wait: false` → Tasks 3–5
- `subagent_run_cancel` → Tasks 6–7
- Shared result envelope (including `index` on sync `wait:true` returns) → Task 1.3, Task 2.3/2.6 (runner annotation), Task 2.7 (sync tool-handler envelope mapping)
- Tool renames → Task 4
- Extension test seams (`__test__.setLauncherDepsOverride`, `__test__.setWatchSubagentOverride`) → Task 7b
- Session-ownership map (pi path + Claude path) → Task 3 (registry + `updateSessionKey`), Task 9 (backend + Step 9.5b backend-seam late-bind), Task 12 (resume routing for both `sessionPath` and `sessionId`)
- caller_ping detection → Task 9
- Blocked steer-back (`kind: "blocked"`) → Tasks 10, 11
- Resume re-ingestion (terminal + ping-during-resume, pi + Claude) → Tasks 11–12
- Claude-backed `sessionKey` late-binding via the `Backend.watch` `onSessionKey` seam → Step 9.5b (Parts A–G), including backend-seam contract test (`test/orchestration/backend-seam.test.ts`)
- `subagent_resume` accepts `sessionPath` OR `sessionId` → Step 12.2
- Recursion through real `subagent_resume` → Task 12, 14 (uses Task 7b's `setWatchSubagentOverride`)
- Cancellation of blocked → Task 10 (registry test)
- Widget blocked state (clears on per-task terminal) → Task 13
- Real-extension integration coverage → Tasks 8.3b, 10.7b, 14.2 (all use Task 7b's seams)
- Backend-real Phase 1 async/cancel coverage (pane + headless) → Task 8b
- Resumable ping fixture (`test-ping-resumable.md`) → Step 14.2a
- Backend-real Phase 2 async/block coverage (pane + headless) → Tasks 14.2b, 14.2c
- Claude-backed block/resume coverage (registry level) → Step 12.1 Claude test; Step 3.1 `updateSessionKey` tests; Step 9.5b Part G backend-seam test

Any spec section without a task → file a follow-up in `.pi/todos/` rather than expanding this plan.

- [ ] **Step 15.8: Commit regressions (if any)**

```bash
git add -A  # only if fixes were made in this task
git commit -m "fix(orchestration): regression pass on lifecycle expansion"
```

---

## Known v1 limitations (documented, not implemented)

- No disk persistence of registry/ownership state — `/reload` and crashes kill live async runs silently.
- No `subagent_run_status` query tool.
- No per-task intermediate notifications beyond `blocked`.
- No depth limit on `caller_ping` recursion.
- No timeouts on unanswered blocks.
- No bare-subagent cancellation (`subagent_run_cancel` targets orchestrations only).
- Pane-backend `usage` / `transcript` parity is P2's scope, not this spec's.
- No orchestration grouping in the widget (per-pane rows with state indicators only).
- Sync orchestrations with a pinging child remain unchanged: the task records as `completed` with the ping message as `finalMessage`.
- `subagent_resume` in v1 still requires a mux backend to open the resumed session (both the `sessionPath` and `sessionId` paths). Callers without a mux receive the standard mux-unavailable response.
