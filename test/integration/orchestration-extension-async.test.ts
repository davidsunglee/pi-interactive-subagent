// test/integration/orchestration-extension-async.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import subagentsExtension, { __test__ as subagentsTest } from "../../pi-extension/subagents/index.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

const okDeps: LauncherDeps = {
  async launch(t) { return { id: t.task, name: t.name ?? "s", startTime: Date.now() }; },
  async waitForCompletion(h) {
    return { name: h.name, finalMessage: `ok-${h.name}`, transcriptPath: null,
             exitCode: 0, elapsedMs: 1 };
  },
};

describe("async orchestration — real subagentsExtension wiring", () => {
  before(() => {
    subagentsTest.setLauncherDepsOverride(okDeps);
    subagentsTest.resetRegistry(); // isolate from prior tests
  });
  after(() => {
    subagentsTest.setLauncherDepsOverride(null);
    subagentsTest.resetRegistry();
  });

  it("extension registers subagent_run_{serial,parallel,cancel} and delivers orchestration_complete via pi.sendMessage", async () => {
    const tools: any[] = [];
    const sendMessageCalls: Array<{ msg: any; options?: any }> = [];
    const fakePi: any = {
      registerTool: (t: any) => tools.push(t),
      registerMessageRenderer: () => {},
      registerCommand: () => {},
      on: () => {},
      sendMessage: (msg: any, options?: any) => { sendMessageCalls.push({ msg, options }); },
      sendUserMessage: () => {},
    };

    subagentsExtension(fakePi);

    const toolNames = tools.map((t) => t.name);
    assert.ok(toolNames.includes("subagent_run_serial"));
    assert.ok(toolNames.includes("subagent_run_parallel"));
    assert.ok(toolNames.includes("subagent_run_cancel"));

    const serial = tools.find((t) => t.name === "subagent_run_serial");
    assert.ok(serial);
    const env = await serial.execute(
      "ext-e2e",
      { wait: false, tasks: [
        { name: "a", agent: "x", task: "t1" },
        { name: "b", agent: "x", task: "t2" },
      ] },
      new AbortController().signal,
      () => {},
      { sessionManager: { getSessionFile: () => "/tmp/fake-session.jsonl" } as any, cwd: "/tmp" },
    );
    assert.match(env.details.orchestrationId, /^[0-9a-f]+$/);
    assert.equal(env.details.tasks.every((t: any) => t.state === "pending"), true);

    await new Promise((r) => setTimeout(r, 100));

    const completions = sendMessageCalls.filter(
      (c) => c.msg.customType === "orchestration_complete",
    );
    assert.equal(completions.length, 1, "expected exactly one orchestration_complete");
    const completion = completions[0];
    assert.equal(completion.options?.deliverAs, "steer");
    assert.equal(completion.options?.triggerTurn, true);
    assert.equal(completion.msg.details.orchestrationId, env.details.orchestrationId);
    assert.equal(completion.msg.details.results.length, 2);
    assert.deepEqual(
      completion.msg.details.results.map((r: any) => r.state),
      ["completed", "completed"],
    );
  });
});
