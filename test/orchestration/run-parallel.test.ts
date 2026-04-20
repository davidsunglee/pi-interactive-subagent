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
