import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runParallel } from "../../pi-extension/orchestration/run-parallel.ts";
import type { LauncherDeps, OrchestrationTask } from "../../pi-extension/orchestration/types.ts";
import { MAX_PARALLEL_HARD_CAP } from "../../pi-extension/orchestration/types.ts";

interface Spy {
  deps: LauncherDeps;
  maxInFlight: number;
  launchOrder: string[];
}

function spyDeps(
  results: Record<string, { finalMessage: string; exitCode?: number; delayMs?: number }>,
): Spy {
  let inFlight = 0;
  let maxInFlight = 0;
  const launchOrder: string[] = [];

  const deps: LauncherDeps = {
    async launch(task) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      launchOrder.push(task.name!);
      return { id: task.name!, name: task.name!, startTime: Date.now() };
    },
    async waitForCompletion(handle) {
      const r = results[handle.name] ?? { finalMessage: "" };
      await new Promise((res) => setTimeout(res, r.delayMs ?? 5));
      inFlight--;
      return {
        name: handle.name,
        finalMessage: r.finalMessage,
        transcriptPath: null,
        exitCode: r.exitCode ?? 0,
        elapsedMs: 1,
      };
    },
  };
  return { deps, maxInFlight, launchOrder } as any; // maxInFlight read through closure
}

describe("runParallel", () => {
  it("respects maxConcurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const deps: LauncherDeps = {
      async launch(task) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return {
          name: handle.name,
          finalMessage: "ok",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 1,
        };
      },
    };

    const tasks: OrchestrationTask[] = Array.from({ length: 6 }, (_, i) => ({
      name: `t${i}`,
      agent: "x",
      task: "t",
    }));
    const out = await runParallel(tasks, { maxConcurrency: 2 }, deps);
    assert.equal(peak, 2);
    assert.equal(out.results.length, 6);
  });

  it("aggregates results in INPUT order regardless of completion order", async () => {
    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        const delay = handle.name === "fast" ? 1 : 30;
        await new Promise((r) => setTimeout(r, delay));
        return {
          name: handle.name,
          finalMessage: handle.name,
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: delay,
        };
      },
    };
    const out = await runParallel(
      [
        { name: "slow", agent: "x", task: "t" },
        { name: "fast", agent: "x", task: "t" },
      ],
      { maxConcurrency: 4 },
      deps,
    );
    assert.equal(out.results[0].name, "slow");
    assert.equal(out.results[1].name, "fast");
  });

  it("partial failure does not cancel siblings; isError=true reported", async () => {
    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return {
          name: handle.name,
          finalMessage: "x",
          transcriptPath: null,
          exitCode: handle.name === "bad" ? 1 : 0,
          elapsedMs: 1,
        };
      },
    };
    const out = await runParallel(
      [
        { name: "ok1", agent: "x", task: "t" },
        { name: "bad", agent: "x", task: "t" },
        { name: "ok2", agent: "x", task: "t" },
      ],
      {},
      deps,
    );
    assert.equal(out.results.length, 3);
    assert.equal(out.isError, true);
    assert.equal(out.results[0].exitCode, 0);
    assert.equal(out.results[1].exitCode, 1);
    assert.equal(out.results[2].exitCode, 0);
  });

  it("rejects maxConcurrency above hard cap", async () => {
    const deps: LauncherDeps = {
      async launch() { throw new Error("should not launch"); },
      async waitForCompletion() { throw new Error("should not wait"); },
    };
    await assert.rejects(
      runParallel(
        [{ name: "t", agent: "x", task: "t" }],
        { maxConcurrency: MAX_PARALLEL_HARD_CAP + 1 },
        deps,
      ),
      /hard cap/,
    );
  });

  it("defaults maxConcurrency=4 when omitted", async () => {
    let peak = 0;
    let inFlight = 0;
    const deps: LauncherDeps = {
      async launch(task) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return {
          name: handle.name,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 1,
        };
      },
    };
    const tasks: OrchestrationTask[] = Array.from({ length: 8 }, (_, i) => ({
      name: `t${i}`,
      agent: "x",
      task: "t",
    }));
    await runParallel(tasks, {}, deps);
    assert.equal(peak, 4);
  });

  it("passes defaultFocus=false to launcher", async () => {
    let sawFocus: boolean | undefined;
    const deps: LauncherDeps = {
      async launch(task, defaultFocus) {
        sawFocus = defaultFocus;
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return {
          name: handle.name,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 1,
        };
      },
    };
    await runParallel([{ name: "t", agent: "x", task: "t" }], {}, deps);
    assert.equal(sawFocus, false);
  });

  it("signal already aborted before run: no task is launched and results are all synthetic cancelled", async () => {
    // Pre-aborted signal must short-circuit the worker loop on the very
    // first iteration, before any deps.launch call, and fill all result
    // slots with synthetic cancelled entries at their input index.
    let launched = 0;
    const deps: LauncherDeps = {
      async launch() {
        launched++;
        return { id: "x", name: "t", startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return { name: handle.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
      },
    };
    const ac = new AbortController();
    ac.abort();
    const out = await runParallel(
      [
        { name: "t1", agent: "x", task: "t" },
        { name: "t2", agent: "x", task: "t" },
        { name: "t3", agent: "x", task: "t" },
      ],
      { maxConcurrency: 2, signal: ac.signal },
      deps,
    );
    assert.equal(launched, 0);
    assert.equal(out.isError, true);
    assert.equal(out.results.length, 3);
    for (const r of out.results) {
      assert.equal(r.exitCode, 1);
      assert.equal(r.error, "cancelled");
    }
    assert.equal(out.results[0].name, "t1");
    assert.equal(out.results[1].name, "t2");
    assert.equal(out.results[2].name, "t3");
  });

  it("signal aborted mid-run: in-flight waits honor the signal and unstarted tasks are marked cancelled", async () => {
    // maxConcurrency=2 and 4 tasks. After the first two are launched,
    // abort fires: the in-flight waits must see the signal and resolve
    // as cancelled; workers must not pick up t3 / t4, which should end
    // up as synthetic cancelled entries at their input indices.
    let launched = 0;
    const deps: LauncherDeps = {
      async launch(task, _defaultFocus, _signal) {
        launched++;
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle, signal) {
        return new Promise((resolve) => {
          if (signal?.aborted) {
            resolve({
              name: handle.name,
              finalMessage: "",
              transcriptPath: null,
              exitCode: 1,
              elapsedMs: 1,
              error: "cancelled",
            });
            return;
          }
          signal?.addEventListener(
            "abort",
            () => {
              resolve({
                name: handle.name,
                finalMessage: "",
                transcriptPath: null,
                exitCode: 1,
                elapsedMs: 1,
                error: "cancelled",
              });
            },
            { once: true },
          );
        });
      },
    };
    const ac = new AbortController();
    const runPromise = runParallel(
      [
        { name: "t1", agent: "x", task: "t" },
        { name: "t2", agent: "x", task: "t" },
        { name: "t3", agent: "x", task: "t" },
        { name: "t4", agent: "x", task: "t" },
      ],
      { maxConcurrency: 2, signal: ac.signal },
      deps,
    );
    await new Promise((r) => setImmediate(r));
    ac.abort();
    const out = await runPromise;
    assert.equal(launched, 2, "only the first two tasks should have been launched before abort");
    assert.equal(out.results.length, 4);
    assert.equal(out.isError, true);
    assert.equal(out.results[0].name, "t1");
    assert.equal(out.results[0].error, "cancelled");
    assert.equal(out.results[1].name, "t2");
    assert.equal(out.results[1].error, "cancelled");
    assert.equal(out.results[2].name, "t3");
    assert.equal(out.results[2].error, "cancelled");
    assert.equal(out.results[3].name, "t4");
    assert.equal(out.results[3].error, "cancelled");
  });

  it("one task throwing does not cancel siblings; failing task appears at its input index", async () => {
    // v4 fix: a thrown error from deps.launch or deps.waitForCompletion for
    // one worker must not reject Promise.all for the whole run. Siblings
    // continue and the aggregated result includes the synthetic failure in
    // INPUT order.
    const deps: LauncherDeps = {
      async launch(task) {
        if (task.name === "boom-launch") throw new Error("surface creation failed");
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        if (handle.name === "boom-wait") throw new Error("watch IO failed");
        await new Promise((r) => setTimeout(r, 5));
        return {
          name: handle.name,
          finalMessage: handle.name,
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 1,
        };
      },
    };
    const out = await runParallel(
      [
        { name: "ok1", agent: "x", task: "t" },
        { name: "boom-launch", agent: "x", task: "t" },
        { name: "boom-wait", agent: "x", task: "t" },
        { name: "ok2", agent: "x", task: "t" },
      ],
      { maxConcurrency: 4 },
      deps,
    );
    assert.equal(out.results.length, 4);
    assert.equal(out.isError, true);
    assert.equal(out.results[0].name, "ok1");
    assert.equal(out.results[0].exitCode, 0);
    assert.equal(out.results[1].name, "boom-launch");
    assert.equal(out.results[1].exitCode, 1);
    assert.match(out.results[1].error ?? "", /surface creation failed/);
    assert.equal(out.results[2].name, "boom-wait");
    assert.equal(out.results[2].exitCode, 1);
    assert.match(out.results[2].error ?? "", /watch IO failed/);
    assert.equal(out.results[3].name, "ok2");
    assert.equal(out.results[3].exitCode, 0);
  });
});

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
    assert.equal(out.results[0].state, "completed");
    assert.equal(out.results[0].index, 0);
    assert.equal(out.results[1].state, "failed");
    assert.equal(out.results[1].index, 1);
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
    assert.equal(out.results[0].state, "cancelled");
    assert.equal(out.results[1].state, "cancelled");
  });
});
