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

      // ── Step 5.3: Drive runParallel with three concurrent tasks ───────────
      //
      // maxConcurrency=3 so all three tasks launch concurrently. After
      // capturing widget visibility and emitting telemetry partials for
      // task-alpha, we resolve task-alpha and abort while task-beta and
      // task-gamma are still in-flight, exercising each runner's abort
      // listener so they record terminal "cancelled" results.

      const tasks = [
        { name: "task-alpha", agent: "x", task: "do alpha" },
        { name: "task-beta", agent: "x", task: "do beta" },
        { name: "task-gamma", agent: "x", task: "do gamma" },
      ];

      const envelopes: any[] = [];
      // Snapshot widget map as [id, name] entries after each onUpdate so we
      // can verify each launched task's name remains visible across the
      // running lifecycle (not just that the map is non-empty).
      const widgetSnapshots: Array<Array<{ id: string; name: string }>> = [];
      const controller = new AbortController();

      const runPromise = runParallel(
        tasks,
        {
          maxConcurrency: 3,
          signal: controller.signal,
          onUpdate: (env) => {
            envelopes.push(env);
            const entries = [...(subagentsTest.getRunningSubagents() as Map<string, any>).entries()].map(
              ([id, v]) => ({ id, name: v.name as string }),
            );
            widgetSnapshots.push(entries);
          },
        },
        deps,
      );

      // Yield repeatedly to let all three launch microtasks + post-launch
      // emitInflight fire under maxConcurrency=3.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // All three runners must have been invoked under maxConcurrency=3.
      assert.equal(runners.length, 3, "all three runners must have been invoked under maxConcurrency=3");
      const runnerByName = new Map(runners.map((r) => [r.specName, r]));
      const runner0 = runnerByName.get("task-alpha")!;
      const runnerBeta = runnerByName.get("task-beta")!;
      const runnerGamma = runnerByName.get("task-gamma")!;
      assert.ok(runner0 && runnerBeta && runnerGamma, "runners for all three tasks must exist");

      // ── Step 5.5: Widget visibility (all three names in map while running) ─
      const widgetMapBefore = subagentsTest.getRunningSubagents() as Map<string, any>;
      const widgetNamesBefore = new Set(
        [...widgetMapBefore.values()].map((e: any) => e.name),
      );
      assert.ok(widgetNamesBefore.has("task-alpha"), "widget map must contain task-alpha while running");
      assert.ok(widgetNamesBefore.has("task-beta"), "widget map must contain task-beta while running");
      assert.ok(widgetNamesBefore.has("task-gamma"), "widget map must contain task-gamma while running");

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

      // ── Step 5.7: Cancellation while siblings are in-flight ──────────────
      //
      // Resolve task-alpha as completed, then abort while task-beta and
      // task-gamma's runner promises are STILL in flight. Each runner's
      // abort listener (registered in Step 5.1) resolves its promise with
      // a cancelled BackendResult. This exercises the running-task abort
      // path (terminal cancelled via runner abort handler) — distinct from
      // the post-loop sweep path that only handles never-launched slots.

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

      // Confirm task-beta and task-gamma have NOT yet resolved before abort,
      // so we are aborting while their runner promises are genuinely in
      // flight (not after they have already settled).
      assert.equal(runnerBeta.aborted, false, "task-beta must still be in flight before abort");
      assert.equal(runnerGamma.aborted, false, "task-gamma must still be in flight before abort");

      // Snapshot the envelope count just before resolve+abort so we can
      // bound the "registered window" assertion. After this point,
      // unregisterHeadlessSubagent fires for each task before the worker
      // emits its corresponding terminal envelope, so widget contents may
      // legitimately drop ahead of the slot-state transition.
      const envelopesAtAbort = envelopes.length;

      controller.abort();

      const out = await runPromise;

      // Both sibling runners must have observed their abort listener.
      assert.equal(runnerBeta.aborted, true, "task-beta runner abort listener must have fired");
      assert.equal(runnerGamma.aborted, true, "task-gamma runner abort listener must have fired");

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

      // ── Step 5.5: Widget visibility (per-task name across running window) ─
      //
      // For each launched task, verify its name was continuously visible in
      // the widget map snapshot for every "running" envelope captured BEFORE
      // resolve+abort fired (i.e., during the registered-and-not-yet-
      // unregistered window). After abort, unregister runs synchronously
      // before the worker emits its terminal envelope, so widget contents
      // can legitimately drop ahead of the slot-state transition; those
      // post-abort envelopes are not part of the registered window.

      for (let taskIndex = 0; taskIndex < 3; taskIndex++) {
        const taskName = tasks[taskIndex].name;
        let observedRunningInWindow = 0;
        for (let i = 0; i < envelopesAtAbort; i++) {
          const slot = envelopes[i].details.results[taskIndex];
          if (!slot || slot.state !== "running") continue;
          observedRunningInWindow++;
          const snap = widgetSnapshots[i];
          assert.ok(snap != null, `widgetSnapshot for ${taskName} at envelope ${i} must exist`);
          const names = snap.map((e) => e.name);
          assert.ok(
            names.includes(taskName),
            `widget map must contain ${taskName} while running (envelope ${i}); got names=${JSON.stringify(names)}`,
          );
        }
        assert.ok(
          observedRunningInWindow >= 1,
          `${taskName} must be observed running in at least one envelope before abort`,
        );
      }

      // ── Step 5.7 assertions ───────────────────────────────────────────────

      assert.equal(out.results.length, 3, "results must have 3 entries");
      assert.equal(out.results[0].state, "completed", "task-alpha must be completed");
      assert.equal(out.results[0].name, "task-alpha");

      // task-beta and task-gamma were aborted while their runner promises
      // were in flight — their runner abort listeners produced cancelled
      // terminal results (exitCode 1, error: "cancelled") which the worker
      // normalizes to state "failed" because exitCode !== 0. The terminal
      // result for the slot must therefore be terminal-non-completed, with
      // error "cancelled".
      for (const sibling of [out.results[1], out.results[2]]) {
        assert.ok(
          sibling.state === "failed" || sibling.state === "cancelled",
          `${sibling.name} must be in a terminal cancelled/failed state, got ${sibling.state}`,
        );
        assert.equal(sibling.error, "cancelled", `${sibling.name} must have error: cancelled`);
      }
      assert.equal(out.results[1].name, "task-beta");
      assert.equal(out.results[2].name, "task-gamma");

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
