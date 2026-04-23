import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools, toPublicResults } from "../../pi-extension/orchestration/tool-handlers.ts";
import type { LauncherDeps, OrchestrationResult } from "../../pi-extension/orchestration/types.ts";

function createMockApi() {
  const tools: any[] = [];
  return {
    tools,
    api: {
      registerTool(tool: any) { tools.push(tool); },
      on() {},
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      sendUserMessage() {},
    } as any,
  };
}

const noopDeps: LauncherDeps = {
  async launch(task) {
    return { id: "x", name: task.name ?? "step", startTime: Date.now() };
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

describe("registerOrchestrationTools", () => {
  it("registers both tools when shouldRegister returns true for both", () => {
    const { api, tools } = createMockApi();
    registerOrchestrationTools(api, () => noopDeps, () => true);
    const names = tools.map((t) => t.name);
    assert.deepEqual(names.sort(), ["subagent_run_parallel", "subagent_run_serial"]);
  });

  it("registers only subagent_run_serial when subagent_run_parallel is denied", () => {
    const { api, tools } = createMockApi();
    registerOrchestrationTools(
      api,
      () => noopDeps,
      (name) => name === "subagent_run_serial",
    );
    const names = tools.map((t) => t.name);
    assert.deepEqual(names, ["subagent_run_serial"]);
  });

  it("registers only subagent_run_parallel when subagent_run_serial is denied", () => {
    const { api, tools } = createMockApi();
    registerOrchestrationTools(
      api,
      () => noopDeps,
      (name) => name === "subagent_run_parallel",
    );
    const names = tools.map((t) => t.name);
    assert.deepEqual(names, ["subagent_run_parallel"]);
  });

  it("registers nothing when shouldRegister rejects both", () => {
    const { api, tools } = createMockApi();
    registerOrchestrationTools(api, () => noopDeps, () => false);
    assert.deepEqual(tools, []);
  });

  it("subagent_run_serial.execute invokes runSerial and returns aggregated result", async () => {
    const { api, tools } = createMockApi();
    registerOrchestrationTools(api, () => noopDeps, () => true);
    const serial = tools.find((t) => t.name === "subagent_run_serial");
    const out = await serial.execute(
      "call-1",
      { tasks: [{ agent: "x", task: "t1" }, { agent: "x", task: "t2" }] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    const details = out.details;
    assert.equal(details.results.length, 2);
    assert.equal(details.isError, false);
  });

  it("subagent_run_parallel rejects maxConcurrency > 8 with a readable message", async () => {
    const { api, tools } = createMockApi();
    registerOrchestrationTools(api, () => noopDeps, () => true);
    const parallel = tools.find((t) => t.name === "subagent_run_parallel");
    const out = await parallel.execute(
      "call-2",
      { tasks: [{ agent: "x", task: "t" }], maxConcurrency: 12 },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.match(out.content[0].text, /hard cap/);
    assert.equal(out.details.error, "maxConcurrency exceeds hard cap");
  });

  it("subagent_run_serial short-circuits with the shared preflight error when the ctx rejects", async () => {
    // The mock `noopDeps` launch/wait would otherwise succeed; the handler
    // must call the injected preflight helper BEFORE building deps.
    const { api, tools } = createMockApi();
    // Inject a preflight that always returns a "no session file" error.
    const denyingPreflight = () => ({
      content: [{ type: "text" as const, text: "Error: no session file. Start pi with a persistent session to use subagents." }],
      details: { error: "no session file" },
    });
    registerOrchestrationTools(api, () => noopDeps, () => true, denyingPreflight);
    const serial = tools.find((t) => t.name === "subagent_run_serial");
    const out = await serial.execute(
      "call-3",
      { tasks: [{ agent: "x", task: "t" }] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.match(out.content[0].text, /no session file/);
    assert.equal(out.details.error, "no session file");
  });

  it("subagent_run_serial short-circuits with self-spawn-blocked when ANY task targets the current agent", async () => {
    // v5 review finding #1: the bare `subagent` tool already rejects when
    // params.agent === PI_SUBAGENT_AGENT; orchestration must match that
    // existing runtime invariant for `subagent_run_serial` / `subagent_run_parallel`
    // (a `planner` session cannot launch another `planner` via the wrappers).
    //
    // The registrar accepts an injected `selfSpawn` check so this test
    // doesn't need to manipulate process.env. Inject a check that blocks
    // agent name "planner"; verify a mixed task list with one "planner"
    // entry is rejected whole (no deps.launch calls, error shape matches
    // the bare tool).
    let launched = 0;
    const countingDeps: LauncherDeps = {
      async launch(task) {
        launched++;
        return { id: "x", name: task.name ?? "step", startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return { name: handle.name, finalMessage: "ok", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
      },
    };
    const denyingSelfSpawn = (agent: string | undefined) =>
      agent === "planner"
        ? {
            content: [
              {
                type: "text" as const,
                text: `You are the planner agent — do not start another planner. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          }
        : null;

    const { api, tools } = createMockApi();
    registerOrchestrationTools(
      api,
      () => countingDeps,
      () => true,
      () => null, // preflight: pass
      denyingSelfSpawn,
    );
    const serial = tools.find((t) => t.name === "subagent_run_serial");
    const out = await serial.execute(
      "call-4",
      {
        tasks: [
          { agent: "scout", task: "t1" },
          { agent: "planner", task: "t2" }, // offending task
          { agent: "worker", task: "t3" },
        ],
      },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.equal(launched, 0, "no task should be launched when any task is self-spawn-blocked");
    assert.match(out.content[0].text, /planner agent/);
    assert.equal(out.details.error, "self-spawn blocked");
  });

  it("subagent_run_serial threads the tool AbortSignal into runSerial so a pre-aborted call records no launch", async () => {
    let launched = 0;
    const spyDeps: LauncherDeps = {
      async launch(task) {
        launched++;
        return { id: "x", name: task.name ?? "step", startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return { name: handle.name, finalMessage: "ok", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
      },
    };
    const { api, tools } = createMockApi();
    registerOrchestrationTools(api, () => spyDeps, () => true);
    const serial = tools.find((t) => t.name === "subagent_run_serial");
    const ac = new AbortController();
    ac.abort();
    const out = await serial.execute(
      "call-serial-abort",
      { tasks: [{ agent: "x", task: "t1" }, { agent: "x", task: "t2" }] },
      ac.signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.equal(launched, 0);
    assert.equal(out.details.isError, true);
    assert.equal(out.details.results.length, 1);
    assert.equal(out.details.results[0].error, "cancelled");
  });

  it("subagent_run_parallel threads the tool AbortSignal into runParallel so a pre-aborted call records no launch", async () => {
    let launched = 0;
    const spyDeps: LauncherDeps = {
      async launch(task) {
        launched++;
        return { id: "x", name: task.name ?? "step", startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return { name: handle.name, finalMessage: "ok", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
      },
    };
    const { api, tools } = createMockApi();
    registerOrchestrationTools(api, () => spyDeps, () => true);
    const parallel = tools.find((t) => t.name === "subagent_run_parallel");
    const ac = new AbortController();
    ac.abort();
    const out = await parallel.execute(
      "call-parallel-abort",
      {
        tasks: [
          { name: "t1", agent: "x", task: "t" },
          { name: "t2", agent: "x", task: "t" },
        ],
      },
      ac.signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.equal(launched, 0);
    assert.equal(out.details.isError, true);
    assert.equal(out.details.results.length, 2);
    assert.equal(out.details.results[0].error, "cancelled");
    assert.equal(out.details.results[1].error, "cancelled");
  });

  it("subagent_run_serial (wait:true) returns results with index on every task per the public envelope", async () => {
    const { api, tools } = createMockApi();
    registerOrchestrationTools(api, () => noopDeps, () => true);
    const serial = tools.find((t) => t.name === "subagent_run_serial");
    const out = await serial.execute(
      "call-envelope-serial",
      { tasks: [{ agent: "x", task: "t1" }, { agent: "x", task: "t2" }] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.equal(out.details.results[0].index, 0);
    assert.equal(out.details.results[1].index, 1);
    assert.equal(out.details.results[0].state, "completed");
  });

  it("subagent_run_parallel (wait:true) returns results with index on every task per the public envelope", async () => {
    const { api, tools } = createMockApi();
    registerOrchestrationTools(api, () => noopDeps, () => true);
    const parallel = tools.find((t) => t.name === "subagent_run_parallel");
    const out = await parallel.execute(
      "call-envelope-parallel",
      { tasks: [{ name: "t1", agent: "x", task: "t1" }, { name: "t2", agent: "x", task: "t2" }] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.equal(out.details.results[0].index, 0);
    assert.equal(out.details.results[1].index, 1);
    assert.equal(out.details.results[0].state, "completed");
  });

  it("subagent_run_parallel short-circuits with self-spawn-blocked when ANY task targets the current agent", async () => {
    let launched = 0;
    const countingDeps: LauncherDeps = {
      async launch(task) {
        launched++;
        return { id: "x", name: task.name ?? "step", startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return { name: handle.name, finalMessage: "ok", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
      },
    };
    const denyingSelfSpawn = (agent: string | undefined) =>
      agent === "worker"
        ? {
            content: [
              {
                type: "text" as const,
                text: `You are the worker agent — do not start another worker. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          }
        : null;

    const { api, tools } = createMockApi();
    registerOrchestrationTools(
      api,
      () => countingDeps,
      () => true,
      () => null,
      denyingSelfSpawn,
    );
    const parallel = tools.find((t) => t.name === "subagent_run_parallel");
    const out = await parallel.execute(
      "call-5",
      {
        tasks: [
          { agent: "scout", task: "t1" },
          { agent: "worker", task: "t2" },
        ],
      },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.equal(launched, 0);
    assert.match(out.content[0].text, /worker agent/);
    assert.equal(out.details.error, "self-spawn blocked");
  });
});

describe("toPublicResults", () => {
  it("falls back state to 'completed' when r.state is missing and exitCode===0 with no error", () => {
    const input: OrchestrationResult[] = [
      {
        name: "task-a",
        finalMessage: "done",
        transcriptPath: null,
        exitCode: 0,
        elapsedMs: 10,
        // state intentionally omitted — exercises fallback branch 1
      },
    ];
    const out = toPublicResults(input);
    assert.equal(out[0].state, "completed");
    assert.equal(out[0].index, 0);
    assert.equal(out[0].name, "task-a");
  });

  it("falls back state to 'failed' when r.state is missing and exitCode!==0", () => {
    const input: OrchestrationResult[] = [
      {
        name: "task-b",
        finalMessage: "",
        transcriptPath: null,
        exitCode: 1,
        elapsedMs: 5,
        // state intentionally omitted — exercises fallback branch 2
      },
    ];
    const out = toPublicResults(input);
    assert.equal(out[0].state, "failed");
  });

  it("falls back state to 'failed' when r.state is missing and error is set (exitCode===0)", () => {
    const input: OrchestrationResult[] = [
      {
        name: "task-c",
        finalMessage: "",
        transcriptPath: null,
        exitCode: 0,
        elapsedMs: 5,
        error: "something went wrong",
        // state intentionally omitted — exercises fallback branch 2 (error present)
      },
    ];
    const out = toPublicResults(input);
    assert.equal(out[0].state, "failed");
  });

  it("falls back index to map position i when r.index is missing", () => {
    const input: OrchestrationResult[] = [
      { name: "t0", finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 1 },
      { name: "t1", finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 1 },
      { name: "t2", finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 1 },
    ];
    const out = toPublicResults(input);
    assert.equal(out[0].index, 0);
    assert.equal(out[1].index, 1);
    assert.equal(out[2].index, 2);
  });

  it("uses r.state and r.index when both are already set (no fallback needed)", () => {
    const input: OrchestrationResult[] = [
      {
        name: "task-d",
        finalMessage: "ok",
        transcriptPath: null,
        exitCode: 0,
        elapsedMs: 7,
        state: "cancelled",
        index: 5,
      },
    ];
    const out = toPublicResults(input);
    assert.equal(out[0].state, "cancelled");
    assert.equal(out[0].index, 5);
  });
});
