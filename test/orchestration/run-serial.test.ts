import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSerial } from "../../pi-extension/orchestration/run-serial.ts";
import type { LauncherDeps, OrchestrationTask } from "../../pi-extension/orchestration/types.ts";

function fakeDeps(
  results: Array<{ finalMessage: string; exitCode?: number; transcriptPath?: string }>,
): { deps: LauncherDeps; launchCalls: OrchestrationTask[] } {
  let idx = 0;
  const launchCalls: OrchestrationTask[] = [];
  const deps: LauncherDeps = {
    async launch(task, _defaultFocus) {
      launchCalls.push({ ...task });
      return { id: `id-${idx}`, name: task.name ?? `step-${idx + 1}`, startTime: Date.now() };
    },
    async waitForCompletion(handle) {
      const i = Number(handle.id.replace("id-", ""));
      const r = results[i] ?? { finalMessage: "", exitCode: 0 };
      idx = i + 1;
      return {
        name: handle.name,
        finalMessage: r.finalMessage,
        transcriptPath: r.transcriptPath ?? null,
        exitCode: r.exitCode ?? 0,
        elapsedMs: 1,
      };
    },
  };
  return { deps, launchCalls };
}

describe("runSerial", () => {
  it("runs tasks in order and auto-generates names", async () => {
    const { deps, launchCalls } = fakeDeps([{ finalMessage: "A" }, { finalMessage: "B" }]);
    const out = await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "t2" },
      ],
      {},
      deps,
    );
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].name, "step-1");
    assert.equal(out.results[1].name, "step-2");
    assert.equal(launchCalls[0].task, "t1");
    assert.equal(launchCalls[1].task, "t2");
    assert.equal(out.isError, false);
  });

  it("substitutes {previous} with prior step's finalMessage", async () => {
    const { deps, launchCalls } = fakeDeps([
      { finalMessage: "A RESULT" },
      { finalMessage: "done" },
    ]);
    await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "use {previous} as input" },
      ],
      {},
      deps,
    );
    assert.equal(launchCalls[1].task, "use A RESULT as input");
  });

  it("substitutes {previous} literally — no $-sequence interpretation", async () => {
    // Assistant output can contain $$, $&, $1 etc. Using String.replace as
    // the substitution primitive would interpret these. split/join must not.
    const tricky = "totals: $$200 then $&chunk $1arg";
    const { deps, launchCalls } = fakeDeps([
      { finalMessage: tricky },
      { finalMessage: "done" },
    ]);
    await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "wrap: [{previous}]" },
      ],
      {},
      deps,
    );
    assert.equal(launchCalls[1].task, `wrap: [${tricky}]`);
  });

  it("stops on first failure, reports all prior + failing, no later spawns", async () => {
    const { deps, launchCalls } = fakeDeps([
      { finalMessage: "ok" },
      { finalMessage: "bad", exitCode: 2 },
    ]);
    const out = await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "t2" },
        { agent: "x", task: "t3" },
      ],
      {},
      deps,
    );
    assert.equal(launchCalls.length, 2);
    assert.equal(out.results.length, 2);
    assert.equal(out.results[1].exitCode, 2);
    assert.equal(out.isError, true);
  });

  it("respects explicit names over auto-generated ones", async () => {
    const { deps } = fakeDeps([{ finalMessage: "A" }]);
    const out = await runSerial([{ name: "custom", agent: "x", task: "t" }], {}, deps);
    assert.equal(out.results[0].name, "custom");
  });

  it("defaults focus=true for each task when unspecified", async () => {
    const { deps, launchCalls } = fakeDeps([{ finalMessage: "A" }]);
    // The wrapper calls launch(task, defaultFocus); we peek defaultFocus via a spy
    let sawFocus: boolean | undefined;
    deps.launch = async (task, defaultFocus) => {
      sawFocus = defaultFocus;
      return { id: "id-0", name: task.name ?? "step-1", startTime: Date.now() };
    };
    await runSerial([{ agent: "x", task: "t" }], {}, deps);
    assert.equal(sawFocus, true);
    assert.equal(launchCalls.length, 0);
  });

  it("when deps.launch throws on step N, prior results are preserved and later steps are not spawned", async () => {
    // v4 fix: upstream launchSubagent can throw before a result object exists
    // (mux/surface creation failure, dispatch failure). runSerial must
    // synthesize a failing OrchestrationResult so Task 9/10's "reports
    // completed + failing step" contract holds.
    const launchCalls: string[] = [];
    const deps: LauncherDeps = {
      async launch(task) {
        launchCalls.push(task.task);
        if (task.task === "t2") throw new Error("surface creation failed");
        return { id: task.task, name: task.name ?? "step", startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return {
          name: handle.name,
          finalMessage: "ok",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 1,
        };
      },
    };
    const out = await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "t2" },
        { agent: "x", task: "t3" },
      ],
      {},
      deps,
    );
    assert.deepEqual(launchCalls, ["t1", "t2"]);
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].exitCode, 0);
    assert.equal(out.results[1].exitCode, 1);
    assert.match(out.results[1].error ?? "", /surface creation failed/);
    assert.equal(out.isError, true);
  });

  it("signal already aborted before run: no task is launched and the run returns isError:true", async () => {
    // v2 review follow-up: the orchestration tool's AbortSignal must
    // short-circuit the whole run before any launch when it arrives
    // pre-aborted (e.g. tool call cancelled between registration and
    // execute).
    let launched = 0;
    const deps: LauncherDeps = {
      async launch() {
        launched++;
        return { id: "x", name: "step", startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return { name: handle.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
      },
    };
    const ac = new AbortController();
    ac.abort();
    const out = await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "t2" },
      ],
      { signal: ac.signal },
      deps,
    );
    assert.equal(launched, 0);
    assert.equal(out.isError, true);
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].error, "cancelled");
    assert.equal(out.results[0].exitCode, 1);
  });

  it("signal aborted mid-run: the in-flight step's wait sees the signal, remaining steps are not launched", async () => {
    // The abort happens after step 1 is launched but before completion.
    // Deps must receive the signal so its wait honors cancellation;
    // the wrapper records the cancelled step and stops.
    let launchedCount = 0;
    const launchCalls: string[] = [];
    const deps: LauncherDeps = {
      async launch(task, _defaultFocus, _signal) {
        launchCalls.push(task.task);
        launchedCount++;
        return { id: task.task, name: task.name ?? "step", startTime: Date.now() };
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
    const runPromise = runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "t2" },
        { agent: "x", task: "t3" },
      ],
      { signal: ac.signal },
      deps,
    );
    await new Promise((r) => setImmediate(r));
    ac.abort();
    const out = await runPromise;
    assert.equal(launchedCount, 1, "only t1 should have been launched before abort");
    assert.deepEqual(launchCalls, ["t1"]);
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].exitCode, 1);
    assert.equal(out.results[0].error, "cancelled");
    assert.equal(out.isError, true);
  });

  it("when deps.waitForCompletion throws, the throwing step is recorded as a failure and the run stops", async () => {
    // v4 fix: watchSubagent can throw (abort, IO failure) after launch
    // succeeds. The failing step must still appear in results.
    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.task, name: task.name ?? "step", startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        if (handle.name === "step-2") throw new Error("watch IO failed");
        return {
          name: handle.name,
          finalMessage: "ok",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 1,
        };
      },
    };
    const out = await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "t2" },
        { agent: "x", task: "t3" },
      ],
      {},
      deps,
    );
    assert.equal(out.results.length, 2);
    assert.equal(out.results[1].exitCode, 1);
    assert.match(out.results[1].error ?? "", /watch IO failed/);
    assert.equal(out.isError, true);
  });
});

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
