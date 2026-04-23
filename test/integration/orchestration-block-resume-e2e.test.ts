// test/integration/orchestration-block-resume-e2e.test.ts
//
// Step 14.1: Registry-level e2e block/resume test across a parallel fan-out.
// Tests that 3 parallel workers (w2 pings) → BLOCKED_KIND event → no
// orchestration_complete until resume → onResumeTerminal → ORCHESTRATION_COMPLETE_KIND
// with all 3 tasks completed and isError false.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import { createRegistry } from "../../pi-extension/orchestration/registry.ts";
import {
  BLOCKED_KIND,
  ORCHESTRATION_COMPLETE_KIND,
} from "../../pi-extension/orchestration/notification-kinds.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

describe("orchestration end-to-end — block/resume across parallel fan-out", () => {
  it("3 workers, 1 pings, parent resumes, all complete", async () => {
    let pinged = false;
    const deps: LauncherDeps = {
      async launch(t) {
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(),
                 sessionKey: `sess-${t.name ?? "s"}` };
      },
      async waitForCompletion(h) {
        if (h.name === "w2" && !pinged) {
          pinged = true;
          return { name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 5,
                   sessionKey: "sess-w2", ping: { name: "w2", message: "need help" } };
        }
        return { name: h.name, finalMessage: `ok-${h.name}`, transcriptPath: null,
                 exitCode: 0, elapsedMs: 5, sessionKey: `sess-${h.name}` };
      },
    };
    const emitted: any[] = [];
    const registry = createRegistry((p) => emitted.push(p));
    const tools: any[] = [];
    const api = {
      registerTool: (t: any) => tools.push(t),
      on() {}, registerCommand() {}, registerMessageRenderer() {},
      sendMessage() {}, sendUserMessage() {},
    } as any;
    registerOrchestrationTools(api, () => deps, () => true, () => null, () => null, { registry });
    const parallel = tools.find((t) => t.name === "subagent_run_parallel");

    const env = await parallel.execute("e2e",
      { wait: false, tasks: [
        { name: "w1", agent: "x", task: "t1" },
        { name: "w2", agent: "x", task: "t2" },
        { name: "w3", agent: "x", task: "t3" },
      ] },
      new AbortController().signal, () => {}, { sessionManager: {} as any, cwd: "/tmp" });

    await new Promise((r) => setTimeout(r, 60));

    // w2 (taskIndex 1) should be blocked with "need help"
    const blocked = emitted.find((e) => e.kind === BLOCKED_KIND);
    assert.ok(blocked, "w2 should block");
    assert.equal(blocked.taskIndex, 1);
    assert.equal(blocked.message, "need help");

    // No orchestration_complete yet
    const completeBefore = emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND);
    assert.equal(completeBefore, undefined, "orchestration must NOT complete while w2 is blocked");

    // Parent resumes w2 directly via registry (simulates subagent_resume tool outcome):
    registry.onResumeTerminal("sess-w2", {
      name: "w2", index: 1, state: "completed",
      finalMessage: "answered", exitCode: 0, elapsedMs: 10, sessionKey: "sess-w2",
    });
    await new Promise((r) => setTimeout(r, 10));

    // Now orchestration_complete should fire with all 3 tasks completed, isError false
    const complete = emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND);
    assert.ok(complete, "orchestration_complete must fire after resume");
    assert.equal(complete.isError, false);
    assert.equal(complete.results.length, 3);
    assert.ok(complete.results.every((r: any) => r.state === "completed"),
      `All tasks should be completed, got: ${JSON.stringify(complete.results.map((r: any) => r.state))}`);
    void env;
  });
});
