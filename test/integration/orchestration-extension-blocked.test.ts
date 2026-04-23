// test/integration/orchestration-extension-blocked.test.ts
//
// Step 10.7b: Extension-level blocked integration test.
// Mirrors orchestration-extension-async.test.ts but uses a ping-carrying
// waitForCompletion so the registry emits a "blocked" steer message.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import subagentsExtension, { __test__ as subagentsTest } from "../../pi-extension/subagents/index.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";
import { BLOCKED_KIND } from "../../pi-extension/orchestration/notification-kinds.ts";

const pingDeps: LauncherDeps = {
  async launch(t) {
    return { id: t.task, name: t.name ?? "s", startTime: Date.now(), sessionKey: `/tmp/sess-${t.task}.jsonl` };
  },
  async waitForCompletion(h) {
    return {
      name: h.name,
      finalMessage: "",
      transcriptPath: null,
      exitCode: 0,
      elapsedMs: 0,
      sessionKey: h.sessionKey ?? `/tmp/sess-${h.id}.jsonl`,
      ping: { name: h.name, message: "Awaiting user input before continuing." },
    };
  },
};

describe("blocked orchestration — real subagentsExtension wiring", () => {
  before(() => {
    subagentsTest.setLauncherDepsOverride(pingDeps);
    subagentsTest.resetRegistry();
  });
  after(() => {
    subagentsTest.setLauncherDepsOverride(null);
    subagentsTest.resetRegistry();
  });

  it("dispatching wait:false serial with a ping-carrying result delivers exactly one 'blocked' sendMessage with spec-shaped details", async () => {
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

    const serial = tools.find((t) => t.name === "subagent_run_serial");
    assert.ok(serial, "subagent_run_serial must be registered");

    const env = await serial.execute(
      "ext-blocked-e2e",
      { wait: false, tasks: [
        { name: "worker", agent: "x", task: "do-work" },
      ] },
      new AbortController().signal,
      () => {},
      { sessionManager: { getSessionFile: () => "/tmp/fake-session.jsonl" } as any, cwd: "/tmp" },
    );

    assert.match(env.details.orchestrationId, /^[0-9a-f]+$/, "orchestrationId must be a hex string");
    assert.equal(env.details.tasks.every((t: any) => t.state === "pending"), true);

    // Allow the async IIFE to run
    await new Promise((r) => setTimeout(r, 100));

    // There should be exactly one blocked steer-back message
    const blockedMessages = sendMessageCalls.filter((c) => c.msg.customType === BLOCKED_KIND);
    assert.equal(blockedMessages.length, 1, "expected exactly one 'blocked' sendMessage");

    const blockedCall = blockedMessages[0];
    assert.equal(blockedCall.options?.deliverAs, "steer");
    assert.equal(blockedCall.options?.triggerTurn, true);

    const details = blockedCall.msg.details;
    assert.equal(details.kind, BLOCKED_KIND);
    assert.equal(details.orchestrationId, env.details.orchestrationId);
    assert.equal(details.taskIndex, 0);
    assert.equal(details.taskName, "worker");
    assert.ok(details.sessionKey, "sessionKey must be present in blocked details");
    assert.equal(details.message, "Awaiting user input before continuing.");

    // No orchestration_complete should have fired
    const completions = sendMessageCalls.filter((c) => c.msg.customType === "orchestration_complete");
    assert.equal(completions.length, 0, "orchestration must NOT complete while task is blocked");
  });
});
