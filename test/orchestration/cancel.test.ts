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
