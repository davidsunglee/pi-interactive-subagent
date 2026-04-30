# Orchestration Lifecycle Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend orchestration (`subagent_serial` / `subagent_parallel`) with a unified lifecycle model covering three new capabilities: async dispatch (`wait: false`) delivered via steer-back (P1), `caller_ping`-driven `blocked` state surfaced structurally (P4), and cross-orchestration resume re-ingestion so a standalone `subagent_resume` targeting an orch-owned session folds its result back into the original aggregated run (P6). Rename the orchestration tool family to `subagent_run_{serial,parallel,cancel}` as a breaking change.

**Architecture:**

1. **Unified lifecycle state on every task result.** `OrchestratedTaskResult.state` (`pending | running | blocked | completed | failed | cancelled`) becomes the single lifecycle vocabulary for both sync and async orchestrations. Sync runs use only terminal values plus the additive `state` field; async runs use the full state machine.
2. **In-process orchestration registry.** A new `pi-extension/orchestration/registry.ts` owns every live async run keyed by a short hex `orchestrationId`, tracks per-task state transitions, and fires aggregated completion via an injected steer-back emitter. Sync runs bypass the registry.
3. **Session-ownership map (Phase 2).** `pi-extension/orchestration/ownership-map.ts` maintains `sessionId → (orchestrationId, taskIndex)` for every running orch-owned task. `subagent_resume` consults the map after its normal completion path and routes the resumed child's result back into the owning registry slot, unblocking paused serial sequences and driving aggregated completion.
4. **Distinct `caller_ping` surfacing at the backend boundary.** Both backends already detect `.exit` ping sidecars (pane path) or can be extended to detect them (headless); the backends propagate `ping?: { name, message }` on their `BackendResult` so the registry can transition `running → blocked` and emit a `blocked` steer-back.
5. **Tool rename (breaking).** `subagent_serial` → `subagent_run_serial`, `subagent_parallel` → `subagent_run_parallel`, plus new `subagent_run_cancel`. No compatibility shim.

**Tech Stack:** TypeScript (Node's native `--test` runner, `node:assert/strict`), `@sinclair/typebox` for tool schemas, `@mariozechner/pi-coding-agent` for the extension API (including `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`), `node:crypto.randomUUID`/hex for orchestration ids. No new external dependencies.

## Key decisions and invariants

- **Phasing:** Phase 1 delivers P1 (async + rename + cancel). Phase 2 delivers P4+P6 (blocked state + resume re-ingestion). Phase 2 activates **only** for `wait: false` orchestrations; sync runs with a pinging child continue today's behavior (record as `completed` with ping text as `finalMessage`).
- **Shared result envelope.** Every per-task result (sync or async) includes `state`. Pre-terminal values (`pending`, `running`, `blocked`) only ever appear in async completion notifications; sync returns always have terminal `state`.
- **Orchestration id:** generated as an 8-char hex (same scheme as `safeScriptName` id in `launchSubagent`) on every `wait: false` dispatch; sync runs have no id.
- **No disk persistence.** Registry + ownership map are in-process only. `/reload` / crash kills async runs silently; documented limitation.
- **No status query tool.** Steer-back is the sole delivery mechanism in v1.
- **No per-task intermediate completion pings.** Phase 2's `blocked` is the single pre-terminal notification kind.
- **Cancellation scope.** `subagent_run_cancel` cancels async orchestrations only; sync runs continue to use the tool-call `AbortSignal`.
- **Usage/transcript on resume.** Because the resumed child reuses the same session id, accumulators extend cumulatively across `blocked → running` transitions. Pane-backend `usage` / `transcript` parity is out of scope (P2 work).
- **Widget per-pane rendering preserved.** Phase 2 adds a post-pane `blocked` visual state keyed on `(orchestrationId, taskIndex)` so the row persists after the pane closes; no grouping or collapsible headers.

---

## File Structure

**New files**

- `pi-extension/orchestration/registry.ts` — async orchestration registry. Owns `orchestrationId → OrchestrationEntry` (config, per-task `OrchestratedTaskResult[]`, overall state, per-orch AbortController, injected emitter) **plus** the session-ownership index `sessionKey → (orchestrationId, taskIndex)`. API: `dispatchAsync`, `cancel`, `onTaskLaunched`, `onTaskTerminal`, `onTaskBlocked`, `onResumeTerminal`, `lookupOwner`, `listActive`, `getAbortSignal`, `getSnapshot`. Pure module; no direct `ExtensionAPI` imports (emitter is injected). The ownership index is colocated with the registry (rather than a separate `ownership-map.ts`) because every mutation is driven by registry lifecycle events — splitting it introduces a cyclic coupling without any reuse benefit.
- `pi-extension/orchestration/notification-kinds.ts` — named string constants for steer-back `customType` and `details.kind` values (`orchestration_complete`, `orchestration_blocked`). Avoids typo drift across emission sites.
- `test/orchestration/registry.test.ts` — unit tests for registry state transitions, id generation, cancellation idempotency, concurrent runs, ownership-index populate/clear/lookup, cross-orch re-ingestion via `onResumeTerminal`.
- `test/orchestration/async-dispatch.test.ts` — unit tests for `wait: false` branch in tool handlers (immediate return, completion notification wiring).
- `test/orchestration/cancel.test.ts` — unit tests for `subagent_run_cancel`.
- `test/orchestration/block-resume.test.ts` (Phase 2) — unit tests for `caller_ping` → blocked → standalone resume → aggregated completion.
- `test/orchestration/sync-ping-regression.test.ts` (Phase 2) — unit test that `wait: true` with a pinging child still records `state: "completed"` and `finalMessage === ping.message` (spec's sync-unchanged invariant).

**Modified files**

- `pi-extension/orchestration/types.ts` — add `OrchestratedTaskResult` type with `state` field; keep legacy `OrchestrationResult` name as a type alias for backward-compat at the internal seam; add `AsyncDispatchEnvelope` type; add `OrchestrationState`.
- `pi-extension/orchestration/run-serial.ts` — annotate results with `state`; add a `onTaskLaunched` / `onTaskTerminal` callback seam so the registry can hook without changing the sync path; (Phase 2) pause sequence on blocked, resume from the next step when the blocked slot transitions to `completed`.
- `pi-extension/orchestration/run-parallel.ts` — annotate results with `state`; add the same callback seam; (Phase 2) aggregated completion re-evaluates on `blocked → terminal`.
- `pi-extension/orchestration/tool-handlers.ts` — rename tool registrations; add `wait` field; branch to registry path on `wait: false`; add `subagent_run_cancel` registration.
- `pi-extension/subagents/backends/types.ts` — add `ping?: { name: string; message: string }` to `BackendResult`; add `state?: OrchestrationState` passthrough (optional).
- `pi-extension/subagents/backends/pane.ts` — propagate `sub.ping` into `BackendResult.ping` (currently dropped).
- `pi-extension/subagents/backends/headless.ts` (Phase 2) — detect `${subagentSessionFile}.exit` ping sidecar on child close and set `BackendResult.ping` accordingly.
- `pi-extension/subagents/index.ts` — register orchestration tools with `pi` handle wired for steer-back emission; extend widget to render `blocked` state keyed on `(orchestrationId, taskIndex)`; in `subagent_resume.execute`, after completion send the result into the registry via `onResumeTerminal` for cross-orch re-ingestion.
- `pi-extension/subagents/launch-spec.ts` — add `subagent_run_serial`, `subagent_run_parallel`, `subagent_run_cancel` to `SPAWNING_TOOLS`; drop old names.
- `README.md` — update tool names, add `wait`/async section, document `subagent_run_cancel`, document the `blocked` state and `caller_ping` orchestration behavior.

---

## Self-review invariants

Code review against this plan must verify:
- Every sync test file still passes without modification except for added `state` assertions (tests named `run-serial.test.ts`, `run-parallel.test.ts`, `tool-handlers.test.ts`).
- `subagent_serial` / `subagent_parallel` as tool names return tool-not-found errors after Phase 1 (no compat shim).
- No disk write of registry/ownership state anywhere in the new code.

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
  sessionId?: string;
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

- [ ] **Step 1.4: Run the test to verify it passes**

Run: `node --test test/orchestration/types.test.ts`
Expected: PASS.

- [ ] **Step 1.5: Run the full typecheck**

Run: `npm run typecheck`
Expected: no new errors (existing `OrchestrationResult` is untouched — it remains the internal core type; `OrchestratedTaskResult` is the new public shape).

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
- Modify: `pi-extension/orchestration/tool-handlers.ts` (annotate results before returning)
- Test: `test/orchestration/run-serial.test.ts` (add state assertions), `test/orchestration/run-parallel.test.ts` (add state assertions)

- [ ] **Step 2.1: Write failing tests for run-serial state annotation**

Append to `test/orchestration/run-serial.test.ts`:

```ts
describe("runSerial state annotation", () => {
  it("annotates every successful step with state: 'completed'", async () => {
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
    assert.equal((out.results[1] as any).state, "completed");
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

- [ ] **Step 2.3: Update run-serial.ts to set state**

In `pi-extension/orchestration/run-serial.ts`, change result construction to include state. Locate each `results.push(...)` site and annotate:

```ts
// At the top of the file, augment the OrchestrationResult internal shape
// to carry state. Import the type:
import type {
  LauncherDeps,
  OrchestrationResult,
  OrchestrationState,
  OrchestrationTask,
} from "./types.ts";
```

Also update `OrchestrationResult` in `types.ts` to include an optional `state`:

```ts
export interface OrchestrationResult {
  // ...existing fields...
  state?: OrchestrationState;
}
```

In `run-serial.ts`, set `state` on each push:

```ts
// On abort-before-launch:
results.push({
  name: task.name!,
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
  finalMessage: "",
  transcriptPath: null,
  exitCode: 1,
  elapsedMs: Date.now() - startedAt,
  error: err?.message ?? String(err),
  state: "failed",
};

// After a successful waitForCompletion, annotate before push:
result.state = result.exitCode === 0 && !result.error ? "completed" : "failed";
```

- [ ] **Step 2.4: Write failing tests for run-parallel state annotation**

Append to `test/orchestration/run-parallel.test.ts`:

```ts
describe("runParallel state annotation", () => {
  it("annotates successful tasks with state: 'completed' and failures with 'failed'", async () => {
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
    assert.equal((out.results[1] as any).state, "failed");
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

Mirror the run-serial changes in `run-parallel.ts` — annotate each `result = { ... }` and the post-loop cancellation fill-in with the appropriate `state`:

```ts
// On successful wait:
result.state = result.exitCode === 0 && !result.error ? "completed" : "failed";

// On thrown launch / wait:
result = {
  name: task.name!,
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
  finalMessage: "",
  transcriptPath: null,
  exitCode: 1,
  elapsedMs: 0,
  error: "cancelled",
  state: "cancelled",
};
```

- [ ] **Step 2.7: Run both test files, confirm passes**

Run: `node --test test/orchestration/run-serial.test.ts test/orchestration/run-parallel.test.ts`
Expected: PASS.

- [ ] **Step 2.8: Commit**

```bash
git add pi-extension/orchestration/types.ts pi-extension/orchestration/run-serial.ts pi-extension/orchestration/run-parallel.ts test/orchestration/run-serial.test.ts test/orchestration/run-parallel.test.ts
git commit -m "feat(orchestration): annotate sync results with lifecycle state"
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
    reg.onTaskLaunched(id, 0, { sessionId: "s0" });
    reg.onTaskLaunched(id, 1, { sessionId: "s1" });
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
    reg.onTaskLaunched(id, 0, { sessionId: "s0" });
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

/** customType on the steer-back Message when an async task transitions to blocked. */
export const ORCHESTRATION_BLOCKED_KIND = "orchestration_blocked";
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
  ORCHESTRATION_BLOCKED_KIND,
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
  kind: typeof ORCHESTRATION_BLOCKED_KIND;
  orchestrationId: string;
  taskIndex: number;
  taskName: string;
  sessionId: string;
  message: string;
}

export type RegistryEmission =
  | OrchestrationCompleteEvent
  | OrchestrationBlockedEvent;

export type RegistryEmitter = (payload: RegistryEmission) => void;

interface OrchestrationEntry {
  id: string;
  config: OrchestrationConfig;
  tasks: OrchestratedTaskResult[];
  overallState: "running" | "completed";
  sessionIds: Map<number, string>; // taskIndex -> sessionId (when known)
}

export interface Registry {
  dispatchAsync(params: { config: OrchestrationConfig }): string;
  onTaskLaunched(orchestrationId: string, taskIndex: number, info: { sessionId?: string }): void;
  onTaskTerminal(orchestrationId: string, taskIndex: number, result: OrchestratedTaskResult): void;
  onTaskBlocked(orchestrationId: string, taskIndex: number, payload: {
    sessionId: string;
    message: string;
    partial?: Partial<OrchestratedTaskResult>;
  }): void;
  onResumeTerminal(sessionId: string, result: OrchestratedTaskResult): void;
  cancel(orchestrationId: string): { ok: true; alreadyTerminal?: boolean };
  getSnapshot(orchestrationId: string): { tasks: OrchestratedTaskResult[] } | null;
  lookupOwner(sessionId: string): { orchestrationId: string; taskIndex: number } | null;
  listActive(): string[];
}

function newHexId(): string {
  return randomBytes(4).toString("hex");
}

function isTerminalState(s: OrchestrationState): boolean {
  return s === "completed" || s === "failed" || s === "cancelled";
}

export function createRegistry(emit: RegistryEmitter): Registry {
  const entries = new Map<string, OrchestrationEntry>();
  const ownership = new Map<string, { orchestrationId: string; taskIndex: number }>();

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
    for (const [sid, own] of ownership) {
      if (own.orchestrationId === entry.id) ownership.delete(sid);
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
        sessionIds: new Map(),
      });
      return id;
    },

    onTaskLaunched(orchestrationId, taskIndex, info) {
      const entry = entries.get(orchestrationId);
      if (!entry) return;
      const task = entry.tasks[taskIndex];
      if (!task) return;
      if (task.state === "pending") task.state = "running";
      if (info.sessionId) {
        entry.sessionIds.set(taskIndex, info.sessionId);
        ownership.set(info.sessionId, { orchestrationId, taskIndex });
      }
    },

    onTaskTerminal(orchestrationId, taskIndex, result) {
      const entry = entries.get(orchestrationId);
      if (!entry) return;
      const existing = entry.tasks[taskIndex];
      if (!existing) return;
      // Merge: keep pre-terminal sessionId / name if missing in result.
      entry.tasks[taskIndex] = {
        ...existing,
        ...result,
        name: result.name ?? existing.name,
        index: taskIndex,
      };
      // Clear ownership for this sessionId — no longer blockable.
      const sid = entry.sessionIds.get(taskIndex);
      if (sid) ownership.delete(sid);
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
        sessionId: payload.sessionId,
        index: taskIndex,
      };
      entry.sessionIds.set(taskIndex, payload.sessionId);
      ownership.set(payload.sessionId, { orchestrationId, taskIndex });
      emit({
        kind: ORCHESTRATION_BLOCKED_KIND,
        orchestrationId,
        taskIndex,
        taskName: entry.tasks[taskIndex].name,
        sessionId: payload.sessionId,
        message: payload.message,
      });
    },

    onResumeTerminal(sessionId, result) {
      const own = ownership.get(sessionId);
      if (!own) return;
      this.onTaskTerminal(own.orchestrationId, own.taskIndex, result);
    },

    cancel(orchestrationId) {
      const entry = entries.get(orchestrationId);
      if (!entry || entry.overallState !== "running") {
        return { ok: true, alreadyTerminal: true };
      }
      for (let i = 0; i < entry.tasks.length; i++) {
        const t = entry.tasks[i];
        if (!isTerminalState(t.state)) {
          entry.tasks[i] = {
            ...t,
            state: "cancelled",
            exitCode: t.exitCode ?? 1,
            error: t.error ?? "cancelled",
          };
        }
      }
      tryFinalize(entry);
      return { ok: true };
    },

    getSnapshot(orchestrationId) {
      const entry = entries.get(orchestrationId);
      if (!entry) return null;
      return { tasks: entry.tasks.map((t) => ({ ...t })) };
    },

    lookupOwner(sessionId) {
      const own = ownership.get(sessionId);
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
      }, deps);
      // Fallback: in case runSerial returns without emitting terminal for every task
      // (e.g. early return on failure), ensure remaining tasks land as cancelled.
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
  /** Registry hook: called just after `deps.launch` resolves. */
  onLaunched?: (taskIndex: number, info: { sessionId?: string }) => void;
  /** Registry hook: called once per task as soon as its terminal state is known. */
  onTerminal?: (taskIndex: number, result: OrchestratedTaskResult) => void;
}
```

Call the hooks at the appropriate points — just after `deps.launch`:

```ts
const handle = await deps.launch(task, true, opts.signal);
opts.onLaunched?.(i, { sessionId: undefined /* fill if handle carries it */ });
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
  sessionId: result.sessionId,
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
  ORCHESTRATION_BLOCKED_KIND,
} from "../orchestration/notification-kinds.ts";

// Inside subagentsExtension(pi):
const registry: Registry = createRegistry((payload) => {
  if (payload.kind === ORCHESTRATION_COMPLETE_KIND) {
    pi.sendMessage({
      customType: "orchestration_complete",
      content:
        `Orchestration "${payload.orchestrationId}" completed ` +
        `(${payload.results.length} task(s), isError=${payload.isError}).`,
      display: true,
      details: payload,
    }, { triggerTurn: true, deliverAs: "steer" });
  } else if (payload.kind === ORCHESTRATION_BLOCKED_KIND) {
    pi.sendMessage({
      customType: "orchestration_blocked",
      content:
        `Task "${payload.taskName}" in orchestration "${payload.orchestrationId}" is blocked:\n\n${payload.message}`,
      display: true,
      details: payload,
    }, { triggerTurn: true, deliverAs: "steer" });
  }
});

registerOrchestrationTools(
  pi,
  (ctx) => makeDefaultDeps(ctx),
  shouldRegister,
  preflightOrchestration,
  selfSpawnBlocked,
  { registry },
);
```

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
  sessionIds: Map<number, string>;
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
git add pi-extension/subagents/index.ts test/integration/orchestration-async.test.ts README.md
git commit -m "feat(orchestration): end-to-end async dispatch with steer-back renderer"
```

---

## Phase 2 — `caller_ping` Integration + Resume Awareness

### Task 9: Add `ping` to the backend result shape

**Files:**
- Modify: `pi-extension/subagents/backends/types.ts`
- Modify: `pi-extension/subagents/backends/pane.ts`
- Modify: `pi-extension/subagents/backends/headless.ts`
- Modify: `pi-extension/orchestration/default-deps.ts`
- Create: `test/orchestration/ping-surfacing.test.ts`

- [ ] **Step 9.1: Write failing test against the pane adapter**

```ts
// test/orchestration/ping-surfacing.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BackendResult } from "../../pi-extension/subagents/backends/types.ts";

describe("BackendResult ping shape", () => {
  it("BackendResult accepts an optional ping field", () => {
    const r: BackendResult = {
      name: "a",
      finalMessage: "",
      transcriptPath: null,
      exitCode: 0,
      elapsedMs: 0,
      ping: { name: "Worker", message: "Not sure which schema to use" },
    };
    assert.equal(r.ping?.name, "Worker");
    assert.equal(r.ping?.message, "Not sure which schema to use");
  });
});
```

- [ ] **Step 9.2: Run, expect failure**

Run: `node --test test/orchestration/ping-surfacing.test.ts`
Expected: FAIL — unknown property `ping`.

- [ ] **Step 9.3: Add `ping` to BackendResult**

In `pi-extension/subagents/backends/types.ts`:

```ts
export interface BackendResult {
  name: string;
  finalMessage: string;
  transcriptPath: string | null;
  exitCode: number;
  elapsedMs: number;
  sessionId?: string;
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

- [ ] **Step 9.4: Surface ping in the pane adapter**

In `pi-extension/subagents/backends/pane.ts::watch`, extend the return to carry `sub.ping`:

```ts
const sub = await watchSubagent(running, abort.signal);
return {
  name: handle.name,
  finalMessage: sub.summary,
  transcriptPath: sub.transcriptPath,
  exitCode: sub.exitCode,
  elapsedMs: sub.elapsed * 1000,
  sessionId: sub.claudeSessionId,
  error: sub.error,
  ping: sub.ping, // NEW
};
```

- [ ] **Step 9.5: Detect ping in the headless backend**

In `pi-extension/subagents/backends/headless.ts::runPiHeadless`, inside the `proc.on("close", ...)` handler, check for the `.exit` sidecar:

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
    });
    return;
  }
  // ...existing paths unchanged...
});
```

(Add the missing `readFileSync`, `rmSync` imports at the top of `headless.ts` if they are not already present — verify via `grep -n "readFileSync\|rmSync" pi-extension/subagents/backends/headless.ts` before editing.)

Mirror the change in `runClaudeHeadless` — Claude CLI has no ping concept today but the sidecar is session-file-keyed; the safe idempotent addition is to check the same sidecar path post-close.

- [ ] **Step 9.6: Propagate ping through makeDefaultDeps**

In `pi-extension/orchestration/default-deps.ts::waitForCompletion`, add `ping` to both the `onUpdate` partial projection and the final projection:

```ts
return {
  name: result.name,
  finalMessage: result.finalMessage,
  transcriptPath: result.transcriptPath,
  exitCode: result.exitCode,
  elapsedMs: result.elapsedMs,
  sessionId: result.sessionId,
  error: result.error,
  usage: result.usage,
  transcript: result.transcript,
  ping: result.ping, // NEW
};
```

Also add `ping` to the `OrchestrationResult` interface in `types.ts`:

```ts
export interface OrchestrationResult {
  // ...
  ping?: { name: string; message: string };
}
```

- [ ] **Step 9.7: Run tests**

Run: `node --test test/orchestration/ping-surfacing.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 9.8: Commit**

```bash
git add pi-extension/subagents/backends/ pi-extension/orchestration/ test/orchestration/ping-surfacing.test.ts
git commit -m "feat(orchestration): propagate caller_ping on BackendResult"
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
    reg.onTaskLaunched(id, 0, { sessionId: "sess-a" });
    reg.onTaskBlocked(id, 0, { sessionId: "sess-a", message: "need input" });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].kind, "orchestration_blocked");
    assert.equal(emitted[0].taskIndex, 0);
    assert.equal(emitted[0].taskName, "a");
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
    reg.onTaskLaunched(id, 0, { sessionId: "sess-a" });
    reg.onTaskBlocked(id, 0, { sessionId: "sess-a", message: "need input" });
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
    reg.onTaskLaunched(id, 0, { sessionId: "sess-a" });
    reg.onTaskLaunched(id, 1, { sessionId: "sess-b" });
    reg.onTaskBlocked(id, 0, { sessionId: "sess-a", message: "?" });
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

Extend `RunSerialOpts`:

```ts
export interface RunSerialOpts {
  signal?: AbortSignal;
  onUpdate?: (content: { content: { type: "text"; text: string }[]; details: any }) => void;
  onLaunched?: (taskIndex: number, info: { sessionId?: string }) => void;
  onTerminal?: (taskIndex: number, result: OrchestratedTaskResult) => void;
  onBlocked?: (taskIndex: number, payload: { sessionId: string; message: string; partial: OrchestratedTaskResult }) => void;
}
```

After `waitForCompletion` resolves, before annotating terminal state:

```ts
if (result.ping) {
  if (opts.onBlocked && result.sessionId) {
    // Async path: transition to blocked and stop.
    opts.onBlocked(i, {
      sessionId: result.sessionId,
      message: result.ping.message,
      partial: {
        name: result.name, index: i, state: "blocked",
        finalMessage: result.finalMessage, transcriptPath: result.transcriptPath ?? null,
        elapsedMs: result.elapsedMs, exitCode: result.exitCode,
        sessionId: result.sessionId, usage: result.usage, transcript: result.transcript,
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

Extend the `RunSerialOutput` to carry `blocked?: boolean` so the async dispatcher can distinguish "paused" from "done". Sync callers ignore it.

- [ ] **Step 10.4: Plumb ping → blocked in run-parallel.ts**

In `run-parallel.ts`, apply the same async/sync branch. Async (`onBlocked` present): call the hook, leave `results[i]` **undefined** so the aggregation carries no terminal entry for that slot (the registry owns "blocked"). Sync (`onBlocked` absent): fold `ping.message` into `finalMessage` and mark `state: "completed"` — identical to today's behavior aside from the additive `state` field.

```ts
if (result.ping) {
  if (opts.onBlocked && result.sessionId) {
    opts.onBlocked(i, {
      sessionId: result.sessionId,
      message: result.ping.message,
      partial: {
        name: result.name, index: i, state: "blocked",
        finalMessage: result.finalMessage, transcriptPath: result.transcriptPath ?? null,
        elapsedMs: result.elapsedMs, exitCode: result.exitCode,
        sessionId: result.sessionId, usage: result.usage, transcript: result.transcript,
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

- [ ] **Step 10.5: Wire onBlocked in the async dispatch path**

In `tool-handlers.ts`, pass the blocked hook into `runSerial` / `runParallel`:

```ts
await runSerial(params.tasks, {
  signal,
  onLaunched: (i, info) => registry.onTaskLaunched(orchestrationId, i, info),
  onTerminal: (i, r) => registry.onTaskTerminal(orchestrationId, i, r),
  onBlocked: (i, p) => registry.onTaskBlocked(orchestrationId, i, {
    sessionId: p.sessionId, message: p.message, partial: p.partial,
  }),
}, deps);
```

Update the async dispatch fallback sweep to skip `blocked` slots:

```ts
for (const t of snap.tasks) {
  if (t.state === "pending" || t.state === "running") {
    registry.onTaskTerminal(orchestrationId, t.index, {
      ...t, state: "cancelled", exitCode: 1, error: t.error ?? "not launched",
    });
  }
}
```

- [ ] **Step 10.6: Write block/resume integration test**

```ts
// test/orchestration/block-resume.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import { createRegistry } from "../../pi-extension/orchestration/registry.ts";
import {
  ORCHESTRATION_BLOCKED_KIND,
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
      async launch(t) { return { id: t.task, name: t.name ?? "s", startTime: Date.now() }; },
      async waitForCompletion(h) {
        if (h.name === "a" && !step1Done) {
          step1Done = true;
          return { name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 5,
            sessionId: "sess-a", ping: { name: "a", message: "need input" } };
        }
        return { name: h.name, finalMessage: `result-${h.name}`, transcriptPath: null,
                 exitCode: 0, elapsedMs: 5, sessionId: h.name === "a" ? "sess-a" : "sess-b" };
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
    const blocked = emitted.find((e) => e.kind === ORCHESTRATION_BLOCKED_KIND);
    assert.ok(blocked, "blocked event should have fired");
    assert.equal(blocked.orchestrationId, env.details.orchestrationId);
    assert.equal(blocked.taskIndex, 0);
    assert.equal(blocked.sessionId, "sess-a");

    // Verify task 2 has not launched yet (serial pause semantics).
    const complete = emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND);
    assert.equal(complete, undefined);

    // Simulate the parent issuing subagent_resume which completes the child:
    registry.onResumeTerminal("sess-a", {
      name: "a", index: 0, state: "completed", finalMessage: "resolved-a",
      exitCode: 0, elapsedMs: 10, sessionId: "sess-a",
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

- [ ] **Step 10.8: Commit**

```bash
git add pi-extension/orchestration/ test/orchestration/
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

- [ ] **Step 11.2: Add a continuation callback to the registry**

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

Store the callback on the `OrchestrationEntry`. In `onResumeTerminal`:

```ts
onResumeTerminal(sessionId, result) {
  const own = ownership.get(sessionId);
  if (!own) return;
  const entry = entries.get(own.orchestrationId);
  const wasBlocked = entry?.tasks[own.taskIndex].state === "blocked";
  this.onTaskTerminal(own.orchestrationId, own.taskIndex, result);
  if (wasBlocked && entry?.continuation) {
    entry.continuation({
      orchestrationId: entry.id,
      taskIndex: own.taskIndex,
      resumedResult: result,
    });
  }
},
```

- [ ] **Step 11.3: Continuation driver in tool-handlers.ts**

In the serial async branch, provide a continuation callback that:
1. On unblock, resumes the serial sequence from `taskIndex + 1` using the resumed task's `finalMessage` as the new `{previous}` value.
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
      await runSerial(remaining, {
        signal,
        onLaunched: (j, info) => registry.onTaskLaunched(orchestrationId, startIndex + j, info),
        onTerminal: (j, r) => registry.onTaskTerminal(orchestrationId, startIndex + j, { ...r, index: startIndex + j }),
        onBlocked: (j, p) => registry.onTaskBlocked(orchestrationId, startIndex + j, p),
      }, deps);
      // Fallback sweep as in the primary dispatch.
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
      async launch(t) { return { id: t.task, name: t.name ?? "s", startTime: Date.now() }; },
      async waitForCompletion(h) {
        if (h.name === "blocker" && !sent) {
          sent = true;
          return { name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 1,
            sessionId: "sess-block", ping: { name: "blocker", message: "?" } };
        }
        return { name: h.name, finalMessage: `ok-${h.name}`, transcriptPath: null,
                 exitCode: 0, elapsedMs: 1, sessionId: h.name === "blocker" ? "sess-block" : `sess-${h.name}` };
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
    assert.ok(emitted.find((e) => e.kind === "orchestration_blocked"));
    // Simulate the resume:
    registry.onResumeTerminal("sess-block", {
      name: "blocker", index: 0, state: "completed", finalMessage: "resolved-block",
      exitCode: 0, elapsedMs: 5, sessionId: "sess-block",
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

- [ ] **Step 11.6: Recursion test (resumed child re-blocks)**

Append:

```ts
it("recursion: resumed child blocks again, second resume finalizes", async () => {
  let pings = 0;
  const deps: LauncherDeps = {
    async launch(t) { return { id: t.task, name: t.name ?? "s", startTime: Date.now() }; },
    async waitForCompletion(h) {
      if (h.name === "a" && pings < 1) {
        pings++;
        return { name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0,
          elapsedMs: 1, sessionId: "sess-a", ping: { name: "a", message: "?" } };
      }
      return { name: h.name, finalMessage: "ok", transcriptPath: null,
        exitCode: 0, elapsedMs: 1, sessionId: "sess-a" };
    },
  };
  const emitted: any[] = [];
  const registry = createRegistry((p) => emitted.push(p));
  const { api, tools } = makeApi();
  registerOrchestrationTools(api, () => deps, () => true, () => null, () => null, { registry });
  const serial = tools.find((t) => t.name === "subagent_run_serial");
  await serial.execute("rec",
    { wait: false, tasks: [{ name: "a", agent: "x", task: "t" }] },
    new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" });
  await new Promise((r) => setTimeout(r, 30));
  const blockedFirst = emitted.filter((e) => e.kind === "orchestration_blocked").length;
  assert.equal(blockedFirst, 1);
  // First resume — but the resumed child still says ping (simulated by deps).
  // In this simplified test, onResumeTerminal sets completed; the true
  // recursion path is driven by the real resume channel in index.ts. To exercise
  // the registry recursion specifically, simulate a second blocked directly:
  registry.onTaskBlocked(emitted[0].orchestrationId, 0, { sessionId: "sess-a", message: "??" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(emitted.filter((e) => e.kind === "orchestration_blocked").length, 2);
  // Final resume completes.
  registry.onResumeTerminal("sess-a", {
    name: "a", index: 0, state: "completed", finalMessage: "final", exitCode: 0, elapsedMs: 1,
    sessionId: "sess-a",
  });
  await new Promise((r) => setTimeout(r, 10));
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
    // Use the registry's ownership map directly to verify.
    const registry = createRegistry(() => {});
    // Dispatch an orchestration that blocks task 0:
    const id = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    registry.onTaskLaunched(id, 0, { sessionId: "sess-owned" });
    registry.onTaskBlocked(id, 0, { sessionId: "sess-owned", message: "?" });
    assert.equal(registry.lookupOwner("sess-owned")!.orchestrationId, id);

    // Simulate what subagent_resume.execute's watcher must do on completion:
    registry.onResumeTerminal("sess-owned", {
      name: "a", index: 0, state: "completed", finalMessage: "resolved",
      exitCode: 0, elapsedMs: 5, sessionId: "sess-owned",
    });
    const snap = registry.getSnapshot(id);
    assert.equal(snap!.tasks[0].state, "completed");
    assert.equal(snap!.tasks[0].finalMessage, "resolved");
  });
});
```

Run: `node --test test/integration/orchestration-async.test.ts`
Expected: PASS (registry already supports this from Tasks 3 + 10). This test locks the contract.

- [ ] **Step 12.2: Wire `subagent_resume` in index.ts to call into the registry**

In `pi-extension/subagents/index.ts`, inside the fire-and-forget `.then` handler of the `subagent_resume` tool (around line 1507), after sending the standalone steer-back, forward to the registry:

```ts
// Near the top of subagentsExtension, after registry is created:
// (hoist `registry` so subagent_resume can close over it)

// Inside subagent_resume's watchSubagent.then(...) completion path, AFTER the
// existing pi.sendMessage(...) call, add:
if (running.sessionFile) {
  // If this resumed session is owned by an orchestration, route the terminal
  // result back so the owning orchestration can aggregate / continue.
  // Use the Claude session id if present, otherwise fall back to the session
  // file path (the same key used in ownership map at launch time).
  const sid = result.claudeSessionId ?? params.sessionPath;
  const owner = registry.lookupOwner(sid);
  if (owner) {
    registry.onResumeTerminal(sid, {
      name: owner.taskIndex.toString(), // name is re-populated from registry snapshot
      index: owner.taskIndex,
      state: result.exitCode === 0 ? "completed" : "failed",
      finalMessage: rawSummary, // variable used earlier in the handler
      transcriptPath: null,
      elapsedMs: result.elapsed * 1000,
      exitCode: result.exitCode,
      sessionId: sid,
      error: result.error,
    });
  }
}
```

Note: the actual session id key needs consistency between "when a task launched" (registry records it via `onTaskLaunched`) and "when subagent_resume completes" (registry looks it up). Both sides must agree on whether the key is the Claude session id, the session file path, or both. Document the chosen key explicitly in a comment on `onTaskLaunched` — the plan prescribes: **use the session file path as the primary key, fall back to Claude session id when sessionFile is absent**.

Update `registry.ts::onTaskLaunched` to accept both forms:

```ts
onTaskLaunched(orchestrationId, taskIndex, info: { sessionId?: string; sessionFile?: string }): void {
  // ...
  const key = info.sessionFile ?? info.sessionId;
  if (key) {
    entry.sessionIds.set(taskIndex, key);
    ownership.set(key, { orchestrationId, taskIndex });
  }
}
```

And update every `onLaunched` call site in `run-serial.ts` / `run-parallel.ts` to pass whichever key is available on the `LaunchedHandle`. `LaunchedHandle` only carries `id`, `name`, `startTime`; the registry key has to come from the backend via `BackendResult.sessionId` (which is set on Claude and on pi — see headless.ts). Since the sessionId is only known at launch-time for Claude (via `resumeSessionId` or after the stream `init` event), and for pi it's the sessionFile — make the plumbing:

- Extend `LaunchedHandle` with optional `sessionKey?: string`.
- Each backend sets `sessionKey` when it has one at launch.
- Pane backend (`pane.ts`) sets `sessionKey = running.sessionFile` for pi.
- Headless pi sets `sessionKey = spec.subagentSessionFile`.
- Headless Claude sets `sessionKey` after the `system/init` event (may be after launch; the registry can accept a late `onTaskLaunched` update).

For v1, since the session-ownership-map is the only consumer and the Claude-path late-binding is a known gap, keep the plan simple: **session key is the subagent session file path for pi, and the Claude session id for Claude**. Both are known to `launchSubagent` / `makeHeadlessBackend` at the point where they return the handle.

- [ ] **Step 12.3: Thread sessionKey through LaunchedHandle**

Edit `pi-extension/orchestration/types.ts`:

```ts
export interface LaunchedHandle {
  id: string;
  name: string;
  startTime: number;
  sessionKey?: string;
}
```

Edit `pane.ts::launch` to set `sessionKey`:

```ts
return { id: running.id, name: running.name, startTime: running.startTime, sessionKey: running.sessionFile };
```

Edit `headless.ts::launch` (both the production path and the test harness path) to set `sessionKey: spec.subagentSessionFile` for pi. For Claude, leave `sessionKey` unset at launch time; the ownership map will not cover Claude-resume re-ingestion in v1 — document this as a known limitation.

Edit `run-serial.ts` / `run-parallel.ts` to call `onLaunched` with the handle's `sessionKey`:

```ts
const handle = await deps.launch(task, true, opts.signal);
opts.onLaunched?.(i, { sessionFile: handle.sessionKey });
```

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

In the registry emitter inside `subagentsExtension`, when a blocked event fires, add a virtual `RunningSubagent` entry to keep the widget row visible after the pane closes:

```ts
const virtualBlocked = new Map<string, RunningSubagent>(); // keyed by `${oid}:${taskIndex}`

const registry = createRegistry((payload) => {
  if (payload.kind === ORCHESTRATION_BLOCKED_KIND) {
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
    pi.sendMessage({ /* ...existing blocked message... */ },
      { triggerTurn: true, deliverAs: "steer" });
  } else if (payload.kind === ORCHESTRATION_COMPLETE_KIND) {
    for (const r of payload.results) {
      const key = `${payload.orchestrationId}:${r.index}`;
      const virt = virtualBlocked.get(key);
      if (virt) {
        runningSubagents.delete(virt.id);
        virtualBlocked.delete(key);
      }
    }
    updateWidget();
    pi.sendMessage({ /* ...existing completion message... */ },
      { triggerTurn: true, deliverAs: "steer" });
  }
});
```

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
        sessionId: `sess-${h.name}`,
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
- Create: `test/integration/orchestration-block-resume-e2e.test.ts`
- Modify: `README.md`

- [ ] **Step 14.1: Write the e2e block/resume test**

```ts
// test/integration/orchestration-block-resume-e2e.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import { createRegistry } from "../../pi-extension/orchestration/registry.ts";
import {
  ORCHESTRATION_BLOCKED_KIND,
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
                   sessionId: "sess-w2", ping: { name: "w2", message: "need help" } };
        }
        return { name: h.name, finalMessage: `ok-${h.name}`, transcriptPath: null,
                 exitCode: 0, elapsedMs: 5, sessionId: `sess-${h.name}` };
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
    const blocked = emitted.find((e) => e.kind === ORCHESTRATION_BLOCKED_KIND);
    assert.ok(blocked, "w2 should block");
    assert.equal(blocked.taskIndex, 1);
    assert.equal(blocked.message, "need help");
    const completeBefore = emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND);
    assert.equal(completeBefore, undefined);

    // Parent resumes:
    registry.onResumeTerminal("sess-w2", {
      name: "w2", index: 1, state: "completed",
      finalMessage: "answered", exitCode: 0, elapsedMs: 10, sessionId: "sess-w2",
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

- [ ] **Step 14.2: Run**

Run: `node --test test/integration/orchestration-block-resume-e2e.test.ts`
Expected: PASS.

- [ ] **Step 14.3: Update README**

Add a new section after the `caller_ping` section (around README line 273):

```markdown
### caller_ping inside async orchestration

When a child spawned through `subagent_run_serial` / `subagent_run_parallel` (with `wait: false`) calls `caller_ping`, the task transitions to a `blocked` state instead of completing:

1. Orchestration emits an `orchestration_blocked` steer-back with `{ orchestrationId, taskIndex, taskName, sessionId, message }`.
2. Widget row for the task stays visible with a "blocked — awaiting parent" indicator.
3. Parent resumes the child via standalone `subagent_resume`; on terminal completion, the result is re-ingested into the original orchestration.
4. Serial runs resume from the next step; parallel runs re-evaluate aggregation and fire completion once all slots are terminal.

Cancelling a blocked task via `subagent_run_cancel` transitions it to `cancelled` without attempting resume.

**v1 limitations:**
- No depth limit on recursion (pinging child resumed, pings again).
- Sync orchestrations (`wait: true` or omitted) continue today's behavior: `caller_ping` closes the pane and the task is recorded as `completed` with the ping message as `finalMessage`.
- Claude sessions: session-id ownership tracking uses the session-file key, not the Claude session id. Claude-path re-ingestion works when the resume reuses the same session file; pure Claude session-id-keyed resumes are a documented v1 gap.
- No disk persistence of registry / ownership map: a pi crash or `/reload` kills live async runs silently.
```

Also update the tool-list table at line ~110 with the Phase 2 addition: add a note on `subagent_run_serial` / `subagent_run_parallel` that "tasks may enter `blocked` state in async mode". Add an entry for `orchestration_blocked` to any steer-back listing if one exists.

- [ ] **Step 14.4: Full test suite run**

Run: `npm test && npm run typecheck`
Expected: PASS with 0 type errors.

- [ ] **Step 14.5: Commit**

```bash
git add README.md test/integration/orchestration-block-resume-e2e.test.ts
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

- [ ] **Step 15.6: Self-review against the spec**

Open `.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design.md` and the plan side by side. For each section in the spec, locate the implementing task:

- Unified lifecycle model → Task 1, 2
- Async dispatch with `wait: false` → Tasks 3–5
- `subagent_run_cancel` → Tasks 6–7
- Shared result envelope → Task 1, 2
- Tool renames → Task 4
- Session-ownership map → Task 3, 12
- caller_ping detection → Task 9
- Blocked steer-back → Tasks 10, 11
- Resume re-ingestion → Tasks 11–12
- Recursion → Task 11
- Cancellation of blocked → Task 10 (registry test)
- Widget blocked state → Task 13

Any spec section without a task → file a follow-up in `.pi/todos/` rather than expanding this plan.

- [ ] **Step 15.7: Commit regressions (if any)**

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
- Claude-session-id-keyed re-ingestion is a documented gap; session-file-keyed re-ingestion is the supported path.
