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
