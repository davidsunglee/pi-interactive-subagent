import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import { createRegistry } from "../../pi-extension/orchestration/registry.ts";
import { ORCHESTRATION_COMPLETE_KIND } from "../../pi-extension/orchestration/notification-kinds.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";


function makeApi() {
  const tools: any[] = []; const messages: any[] = [];
  return {
    tools, messages,
    api: {
      registerTool: (t: any) => tools.push(t),
      on() {}, registerCommand() {}, registerMessageRenderer() {},
      sendMessage(m: any) { messages.push(m); }, sendUserMessage() {},
    } as any,
  };
}

const okDeps: LauncherDeps = {
  async launch(t) { return { id: t.task, name: t.name ?? "s", startTime: Date.now() }; },
  async waitForCompletion(h) {
    await new Promise((r) => setTimeout(r, 20));
    return { name: h.name, finalMessage: `result-${h.name}`, transcriptPath: null, exitCode: 0, elapsedMs: 20 };
  },
};

describe("end-to-end async orchestration", () => {
  it("dispatches async, runs tasks, and delivers aggregated result via pi.sendMessage", async () => {
    const { api, tools, messages } = makeApi();
    const registry = createRegistry((payload) => {
      if (payload.kind === ORCHESTRATION_COMPLETE_KIND) {
        api.sendMessage({ customType: "orchestration_complete", content: "done", details: payload });
      }
    });
    registerOrchestrationTools(api, () => okDeps, () => true, () => null, () => null, { registry });
    const serial = tools.find((t: any) => t.name === "subagent_run_serial");

    const env = await serial.execute("e2e",
      { wait: false, tasks: [
        { name: "a", agent: "x", task: "t1" },
        { name: "b", agent: "x", task: "t2" },
      ] },
      new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.match(env.details.orchestrationId, /^[0-9a-f]+$/);
    assert.equal(env.details.tasks.every((t: any) => t.state === "pending"), true);

    // Wait for completion
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(messages.length, 1);
    const details = messages[0].details;
    assert.equal(details.kind, "orchestration_complete");
    assert.equal(details.orchestrationId, env.details.orchestrationId);
    assert.equal(details.isError, false);
    assert.equal(details.results.length, 2);
    assert.deepEqual(details.results.map((r: any) => r.state), ["completed", "completed"]);
    assert.deepEqual(details.results.map((r: any) => r.finalMessage), ["result-a", "result-b"]);
  });
});

describe("subagent_resume re-ingestion into owning orchestration", () => {
  it("when standalone subagent_resume completes on an orch-owned session, the registry receives onResumeTerminal", async () => {
    const ownedKey = "/tmp/orch-owned.jsonl";
    const registry = createRegistry(() => {});
    const id = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    registry.onTaskLaunched(id, 0, { sessionKey: ownedKey });
    registry.onTaskBlocked(id, 0, { sessionKey: ownedKey, message: "?" });
    assert.equal(registry.lookupOwner(ownedKey)!.orchestrationId, id);
    registry.onResumeTerminal(ownedKey, {
      name: "a", index: 0, state: "completed", finalMessage: "resolved",
      exitCode: 0, elapsedMs: 5, sessionKey: ownedKey,
    });
    const snap = registry.getSnapshot(id);
    assert.equal(snap!.tasks[0].state, "completed");
    assert.equal(snap!.tasks[0].finalMessage, "resolved");
  });

  it("Claude-backed re-ingestion: sessionId-keyed ownership routes the resume result back to the owning orchestration", async () => {
    const claudeId = "claude-sess-abc123";
    const registry = createRegistry(() => {});
    const id = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    registry.onTaskLaunched(id, 0, {});
    registry.updateSessionKey(id, 0, claudeId);
    registry.onTaskBlocked(id, 0, { sessionKey: claudeId, message: "?" });
    assert.equal(registry.lookupOwner(claudeId)!.orchestrationId, id);
    registry.onResumeTerminal(claudeId, {
      name: "a", index: 0, state: "completed", finalMessage: "claude-resolved",
      exitCode: 0, elapsedMs: 5, sessionKey: claudeId,
    });
    const snap = registry.getSnapshot(id);
    assert.equal(snap!.tasks[0].state, "completed");
    assert.equal(snap!.tasks[0].finalMessage, "claude-resolved");
  });
});
