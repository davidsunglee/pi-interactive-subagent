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
    assert.ok(elapsed < 100, `async dispatch should return quickly, got ${elapsed}`);
    assert.equal(out.details.isError, false);
    assert.ok(out.details.orchestrationId);
    assert.match(out.details.orchestrationId, /^[0-9a-f]+$/);
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

  it("subagent_run_parallel with wait:false returns an envelope immediately and emits completion", async () => {
    const emitted: any[] = [];
    const registry = createRegistry((p) => emitted.push(p));
    const { api, tools } = makeApi();
    registerOrchestrationTools(api, () => slowDeps, () => true, () => null, () => null, { registry });
    const parallel = tools.find((t) => t.name === "subagent_run_parallel");

    const t0 = Date.now();
    const out = await parallel.execute(
      "call-p",
      { wait: false, tasks: [{ agent: "x", task: "t1" }, { agent: "x", task: "t2" }] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 100, `async dispatch should return quickly, got ${elapsed}`);
    assert.ok(out.details.orchestrationId);
    assert.match(out.details.orchestrationId, /^[0-9a-f]+$/);
    assert.equal(out.details.tasks.length, 2);
    assert.equal(out.details.tasks[0].state, "pending");

    await new Promise((r) => setTimeout(r, 200));
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].kind, "orchestration_complete");
    assert.equal(emitted[0].orchestrationId, out.details.orchestrationId);
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
