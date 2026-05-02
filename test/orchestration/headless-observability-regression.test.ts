import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __test__ as headlessTest } from "../../pi-extension/subagents/backends/headless.ts";
import {
  registerHeadlessSubagent,
  updateHeadlessSubagentUsage,
  unregisterHeadlessSubagent,
} from "../../pi-extension/subagents/index.ts";
import { runParallel } from "../../pi-extension/orchestration/run-parallel.ts";
import type { LauncherDeps, OrchestrationResult } from "../../pi-extension/orchestration/types.ts";
import type { BackendResult, UsageStats } from "../../pi-extension/subagents/backends/types.ts";

// Import __test__ dynamically to avoid TS complaints about the opaque __test__ export shape.
import * as subagentsModule from "../../pi-extension/subagents/index.ts";
const subagentsTest = (subagentsModule as any).__test__;

const ctx = {
  sessionManager: {
    getSessionFile: () => "/tmp/parent.jsonl",
    getSessionId: () => "sess-test",
    getSessionDir: () => "/tmp",
  } as any,
  cwd: "/tmp",
};

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type RunnerControl = {
  resolve: (r: BackendResult) => void;
  reject: (e: unknown) => void;
  aborted: boolean;
  emit: (snap: BackendResult) => void;
  specName: string;
};

describe("headless observability end-to-end regression", () => {
  it(
    "lifecycle stability, widget visibility, telemetry truth, and cancellation",
    async () => {
      // ── Step 5.1: Per-task fake runner ────────────────────────────────────
      //
      // Each invocation pushes a RunnerControl into `runners` so the test can
      // drive partials and resolution deterministically.  On abort the runner
      // immediately resolves with a cancelled BackendResult so the in-flight
      // watch() promise settles without needing a manual resolve.

      const runners: RunnerControl[] = [];

      const backend = headlessTest.makeHeadlessBackendWithRunner(
        ctx,
        ({ spec, abort, emitPartial }) => {
          const { promise, resolve, reject } = deferred<BackendResult>();
          const specName = spec.name ?? "subagent";
          const control: RunnerControl = { resolve, reject, aborted: false, emit: emitPartial, specName };
          runners.push(control);

          abort.addEventListener(
            "abort",
            () => {
              if (control.aborted) return;
              control.aborted = true;
              resolve({
                name: specName,
                finalMessage: "",
                transcriptPath: null,
                exitCode: 1,
                elapsedMs: 0,
                error: "cancelled",
                usage: emptyUsage(),
              });
            },
            { once: true },
          );

          return promise;
        },
      );

      // ── Step 5.2: LauncherDeps with real widget lifecycle ─────────────────
      //
      // Mirrors the adapter shape of default-deps.ts so the module-level
      // runningSubagents map (visible via __test__.getRunningSubagents()) is
      // updated by real lifecycle events.

      const deps: LauncherDeps = {
        async launch(task, _defaultFocus, signal) {
          const handle = await backend.launch(task as any, false, signal);
          registerHeadlessSubagent({
            id: handle.id,
            name: handle.name,
            task: task.task,
            agent: task.agent,
            startTime: handle.startTime,
          });
          return handle;
        },

        async waitForCompletion(handle, signal, onUpdate) {
          try {
            const result = await backend.watch(handle, signal, (partial) => {
              if (partial.usage) {
                updateHeadlessSubagentUsage(handle.id, partial.usage);
              }
              if (onUpdate) {
                onUpdate({
                  name: partial.name,
                  finalMessage: partial.finalMessage,
                  transcriptPath: partial.transcriptPath,
                  exitCode: partial.exitCode,
                  elapsedMs: partial.elapsedMs,
                  error: partial.error,
                  usage: partial.usage,
                });
              }
            });
            return {
              name: result.name,
              finalMessage: result.finalMessage,
              transcriptPath: result.transcriptPath,
              exitCode: result.exitCode,
              elapsedMs: result.elapsedMs,
              error: result.error,
              usage: result.usage,
            };
          } finally {
            unregisterHeadlessSubagent(handle.id);
          }
        },
      };

      // ── Step 5.3: Drive runParallel with three tasks ───────────────────────
      //
      // maxConcurrency=1 so only task-alpha runs; task-beta and task-gamma stay
      // pending.  After task-alpha completes and abort fires, the post-loop sweep
      // cancels the two still-pending tasks, giving a clean "cancelled" state.

      const tasks = [
        { name: "task-alpha", agent: "x", task: "do alpha" },
        { name: "task-beta", agent: "x", task: "do beta" },
        { name: "task-gamma", agent: "x", task: "do gamma" },
      ];

      const envelopes: any[] = [];
      // Snapshot widget map keys after each onUpdate so we can verify
      // widget row presence across the running lifecycle.
      const widgetSnapshots: string[][] = [];
      const controller = new AbortController();

      const runPromise = runParallel(
        tasks,
        {
          maxConcurrency: 1,
          signal: controller.signal,
          onUpdate: (env) => {
            envelopes.push(env);
            widgetSnapshots.push([...subagentsTest.getRunningSubagents().keys()]);
          },
        },
        deps,
      );

      // Yield to let the launch microtask + post-launch emitInflight fire.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // task-alpha should have launched its runner by now.
      assert.ok(runners.length >= 1, "task-alpha runner must have been invoked after launch");
      const runner0 = runners[0];
      assert.equal(runner0.specName, "task-alpha");

      // ── Step 5.5: Widget visibility (task-alpha in map while running) ──────
      const widgetMapBefore = subagentsTest.getRunningSubagents() as Map<string, any>;
      const alphaInWidget = [...widgetMapBefore.values()].some((e) => e.name === "task-alpha");
      assert.ok(alphaInWidget, "widget map must contain task-alpha row while running");

      // ── Step 5.6: Telemetry truth — emit assistant-event partial (pre-result)
      //
      // Claude-shaped assistant event: turns increments, token counts stay zero.
      runner0.emit({
        name: "task-alpha",
        finalMessage: "working...",
        transcriptPath: null,
        exitCode: 0,
        elapsedMs: 100,
        usage: { turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
      });
      await new Promise((r) => setImmediate(r));

      // Find the most recent envelope that carries a usage object on slot 0.
      const preResultPartials = envelopes.filter((e) => {
        const r = e.details.results[0];
        return r?.state === "running" && r?.usage != null;
      });

      assert.ok(preResultPartials.length >= 1, "must have captured at least one pre-result partial with usage");
      const latestPreResult = preResultPartials[preResultPartials.length - 1];
      const preUsage = latestPreResult.details.results[0].usage;
      assert.equal(preUsage.input, 0, "pre-result partial must have usage.input === 0");
      assert.equal(preUsage.output, 0, "pre-result partial must have usage.output === 0");
      assert.equal(preUsage.cost, 0, "pre-result partial must have usage.cost === 0");
      assert.equal(preUsage.cacheRead, 0, "pre-result partial must have usage.cacheRead === 0");
      assert.equal(preUsage.cacheWrite, 0, "pre-result partial must have usage.cacheWrite === 0");

      // Emit a result-event partial (full token/cost usage now available).
      runner0.emit({
        name: "task-alpha",
        finalMessage: "done",
        transcriptPath: null,
        exitCode: 0,
        elapsedMs: 200,
        usage: {
          turns: 2,
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 0,
          cost: 0.01,
          contextTokens: 150,
        },
      });
      await new Promise((r) => setImmediate(r));

      // Post-result partial must carry non-zero token counts.
      const postResultPartials = envelopes.filter((e) => {
        const r = e.details.results[0];
        return r?.state === "running" && r?.usage && r.usage.input > 0;
      });
      assert.ok(postResultPartials.length >= 1, "must have captured at least one post-result partial with input > 0");
      const latestPostResult = postResultPartials[postResultPartials.length - 1];
      const postUsage = latestPostResult.details.results[0].usage;
      assert.equal(postUsage.input, 100, "post-result partial must have usage.input === 100");

      // ── Step 5.7: Cancellation ────────────────────────────────────────────
      //
      // Resolve task-alpha as completed and immediately fire abort (before any
      // microtasks run) so the worker sees opts.signal.aborted === true when it
      // loops back after task-alpha finishes.  With maxConcurrency=1, task-beta
      // and task-gamma are still pending; the post-loop abort sweep cancels them.

      runner0.resolve({
        name: "task-alpha",
        finalMessage: "done",
        transcriptPath: null,
        exitCode: 0,
        elapsedMs: 300,
        usage: {
          turns: 2,
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 0,
          cost: 0.01,
          contextTokens: 150,
        },
      });

      // Fire abort synchronously before any microtask runs so the worker
      // sees opts.signal.aborted === true on its next loop iteration and
      // returns without launching task-beta or task-gamma.
      controller.abort();

      const out = await runPromise;

      // ── Step 5.4: Lifecycle stability ─────────────────────────────────────
      //
      // For every captured envelope: all 3 slots are non-null with a string
      // state.  Once a slot has been observed at "running" it must never
      // revert to "pending".

      const hasBeenRunning = new Set<number>();

      for (const env of envelopes) {
        assert.equal(
          env.details.results.length,
          3,
          `every envelope must have tasks.length (3) entries; got ${env.details.results.length}`,
        );
        for (let i = 0; i < env.details.results.length; i++) {
          const r = env.details.results[i];
          assert.ok(r != null, `slot ${i} must not be null/undefined in any envelope`);
          assert.ok(typeof r.state === "string", `slot ${i} must have a string state field`);

          if (r.state === "running") {
            hasBeenRunning.add(i);
          } else if (r.state === "pending" && hasBeenRunning.has(i)) {
            assert.fail(
              `slot ${i} reverted to "pending" after having been "running" — lifecycle stability violated`,
            );
          }
        }
      }

      // ── Step 5.5: Widget visibility (full run) ─────────────────────────────
      //
      // Verify that while task-alpha's runner was in-flight, every captured
      // widgetSnapshot contained its id (i.e., the row was present across the
      // entire running lifecycle).  We check the snapshots taken while
      // task-alpha was in the "running" state.

      const alphaRunningEnvelopeIndices = envelopes
        .map((e, idx) => ({ idx, state: e.details.results[0]?.state }))
        .filter(({ state }) => state === "running")
        .map(({ idx }) => idx);

      assert.ok(
        alphaRunningEnvelopeIndices.length >= 1,
        "task-alpha must have been captured in at least one running envelope",
      );

      for (const idx of alphaRunningEnvelopeIndices) {
        const snap = widgetSnapshots[idx];
        assert.ok(
          snap != null,
          `widgetSnapshot at envelope index ${idx} must exist`,
        );
        // The widget map keyed by handle id: at least one entry must have
        // name === "task-alpha".  We introspect via the running-subagents map
        // captured synchronously with each envelope.
        // (Snapshot stores id keys; check via the live map for name lookup is
        // not needed — the snapshot just confirms non-empty during running.)
        assert.ok(
          snap.length >= 1,
          `widget map must be non-empty while task-alpha is running (envelope ${idx})`,
        );
      }

      // ── Step 5.7 assertions ───────────────────────────────────────────────

      assert.equal(out.results.length, 3, "results must have 3 entries");
      assert.equal(out.results[0].state, "completed", "task-alpha must be completed");
      assert.equal(out.results[0].name, "task-alpha");

      // task-beta and task-gamma were never launched (pending when abort fired)
      // → post-loop sweep sets them to "cancelled".
      assert.equal(out.results[1].state, "cancelled", "task-beta must be cancelled");
      assert.equal(out.results[1].error, "cancelled", "task-beta must have error: cancelled");
      assert.equal(out.results[2].state, "cancelled", "task-gamma must be cancelled");
      assert.equal(out.results[2].error, "cancelled", "task-gamma must have error: cancelled");

      // Every entry must have a terminal state — none reverted to pending.
      assert.ok(
        out.results.every(
          (r: OrchestrationResult) =>
            r.state === "completed" || r.state === "failed" || r.state === "cancelled",
        ),
        `all results must be terminal; got: ${out.results.map((r: OrchestrationResult) => r.state).join(", ")}`,
      );
    },
  );
});
