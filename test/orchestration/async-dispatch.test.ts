import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import { createRegistry } from "../../pi-extension/orchestration/registry.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";
import { buildOrchestrationCompleteContent } from "../../pi-extension/subagents/index.ts";
import { ORCHESTRATION_COMPLETE_KIND } from "../../pi-extension/orchestration/notification-kinds.ts";

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

describe("async orchestration_complete steer content shape (artifact rows)", () => {
  let tmpDir: string;

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits a sendMessage whose content carries header + hint + per-task artifact rows", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-async-arts-"));

    const multiLineDeps: LauncherDeps = {
      async launch(task) {
        return { id: task.task, name: task.name ?? "step", startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        await new Promise((r) => setTimeout(r, 50));
        const idx = handle.id === "t1" ? 0 : 1;
        return {
          name: handle.name,
          finalMessage: `multi\nline\nbody-${idx}`,
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 50,
        };
      },
    };

    const sent: any[] = [];

    // Mirror what registryEmitter does in production: use buildOrchestrationCompleteContent
    // to build the content and route it to sendMessage.
    const registry = createRegistry((payload: any) => {
      if (payload.kind === ORCHESTRATION_COMPLETE_KIND) {
        sent.push({
          customType: "orchestration_complete",
          content: buildOrchestrationCompleteContent(payload),
          details: payload,
        });
      }
    });

    const { api, tools } = makeApi();
    registerOrchestrationTools(api, () => multiLineDeps, () => true, () => null, () => null, { registry });
    const serial = tools.find((t) => t.name === "subagent_run_serial");

    const sessionManager = {
      getSessionDir: () => tmpDir,
      getSessionId: () => "sess1",
    };

    await serial.execute(
      "call-art",
      { wait: false, tasks: [{ agent: "x", task: "t1", name: "step-1" }, { agent: "x", task: "t2", name: "step-2" }] },
      new AbortController().signal,
      () => {},
      { sessionManager: sessionManager as any, cwd: tmpDir },
    );

    // Poll until the background runner emits completion.
    const deadline = Date.now() + 2000;
    while (sent.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(sent.length, 1, "expected exactly one orchestration_complete sendMessage");
    const content = sent[0].content as string;
    const lines = content.split("\n");

    // First line: header
    assert.match(
      lines[0],
      /^Orchestration "[0-9a-f]+" completed \(2 task\(s\), isError=false\)\.$/,
      `header line mismatch: ${lines[0]}`,
    );
    // Second line: hint
    assert.equal(
      lines[1],
      "Each task's full final message is at the artifact path. Read it before acting on the result.",
      `hint line mismatch: ${lines[1]}`,
    );
    // Per-task rows
    assert.match(
      lines[2],
      /^- step-1: exit=0 \(\d+ms\) — artifact: .+\/orchestrations\/[0-9a-f]+\/task-0\.md$/,
      `task-0 row mismatch: ${lines[2]}`,
    );
    assert.match(
      lines[3],
      /^- step-2: exit=0 \(\d+ms\) — artifact: .+\/task-1\.md$/,
      `task-1 row mismatch: ${lines[3]}`,
    );

    // Extract paths and verify byte-equality with finalMessages
    const pathMatch0 = lines[2].match(/artifact: (.+\.md)$/);
    const pathMatch1 = lines[3].match(/artifact: (.+\.md)$/);
    assert.ok(pathMatch0, "task-0 row must contain artifact path");
    assert.ok(pathMatch1, "task-1 row must contain artifact path");
    assert.equal(readFileSync(pathMatch0![1], "utf8"), "multi\nline\nbody-0");
    assert.equal(readFileSync(pathMatch1![1], "utf8"), "multi\nline\nbody-1");
  });
});
