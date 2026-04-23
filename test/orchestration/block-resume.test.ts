// test/orchestration/block-resume.test.ts
//
// Step 10.6: block-resume full-flow + "downstream stays pending" tests.
// These tests cover the core invariant: when a serial run blocks on step N,
// steps N+1..end stay pending (NOT swept to cancelled).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import { createRegistry } from "../../pi-extension/orchestration/registry.ts";
import { BLOCKED_KIND } from "../../pi-extension/orchestration/notification-kinds.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

function makeHarness(deps: LauncherDeps) {
  const emitted: any[] = [];
  const registry = createRegistry((p) => emitted.push(p));
  const tools: any[] = [];
  const api = {
    registerTool: (t: any) => tools.push(t),
    on() {}, registerCommand() {}, registerMessageRenderer() {},
    sendMessage() {}, sendUserMessage() {},
  } as any;
  registerOrchestrationTools(api, () => deps, () => true, () => null, () => null, { registry });
  const serial = tools.find((t) => t.name === "subagent_run_serial");
  return { emitted, registry, serial };
}

describe("block-resume: downstream steps stay pending after serial block", () => {
  it("step 0 blocks → step 1 stays pending, no orchestration_complete fires", async () => {
    const pingDeps: LauncherDeps = {
      async launch(t) {
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(), sessionKey: `sess-${t.task}` };
      },
      async waitForCompletion(h) {
        return {
          name: h.name,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 0,
          sessionKey: h.sessionKey ?? `sess-${h.id}`,
          ping: { name: h.name, message: "need user input" },
        };
      },
    };

    const { emitted, registry, serial } = makeHarness(pingDeps);
    const env = await serial.execute(
      "block-test",
      { wait: false, tasks: [
        { name: "step-a", agent: "x", task: "t1" },
        { name: "step-b", agent: "x", task: "t2" },
      ] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );

    // Give the async IIFE time to complete
    await new Promise((r) => setTimeout(r, 40));

    const orchId = env.details.orchestrationId;

    // A blocked event must have fired
    const blocked = emitted.find((e) => e.kind === BLOCKED_KIND);
    assert.ok(blocked, "blocked event must fire");
    assert.equal(blocked.taskIndex, 0);
    assert.equal(blocked.orchestrationId, orchId);

    // No orchestration_complete must have fired yet
    const complete = emitted.find((e) => e.kind === "orchestration_complete");
    assert.equal(complete, undefined, "orchestration must NOT complete while step 0 is blocked");

    // Step 0 is blocked in the registry
    const snap = registry.getSnapshot(orchId);
    assert.ok(snap);
    assert.equal(snap!.tasks[0].state, "blocked");

    // Step 1 must be PENDING, not cancelled
    assert.equal(snap!.tasks[1].state, "pending",
      "downstream step must stay pending when serial blocks — the invariant of Task 10");
  });
});

describe("block-resume: async runParallel blocked slot does not cascade-cancel siblings", () => {
  it("parallel task 0 blocks, task 1 completes → orchestration stays open", async () => {
    // Task 0 blocks, task 1 completes normally.
    // With onBlocked wired, the parallel runner leaves results[0] undefined
    // (registry-owned). The post-loop sweep skips undefined slots in async mode.
    // The orchestration does NOT finalize until task 0's blocked state is resolved.
    let call = 0;
    const mixedDeps: LauncherDeps = {
      async launch(t) {
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(), sessionKey: `sess-${t.task}` };
      },
      async waitForCompletion(h) {
        const i = call++;
        if (i === 0) {
          return {
            name: h.name,
            finalMessage: "",
            transcriptPath: null,
            exitCode: 0,
            elapsedMs: 0,
            sessionKey: h.sessionKey ?? `sess-${h.id}`,
            ping: { name: h.name, message: "blocked on input" },
          };
        }
        return {
          name: h.name,
          finalMessage: `ok-${h.name}`,
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 1,
        };
      },
    };

    const { emitted, registry, serial: _serial } = makeHarness(mixedDeps);
    const tools: any[] = [];
    const api = {
      registerTool: (t: any) => tools.push(t),
      on() {}, registerCommand() {}, registerMessageRenderer() {},
      sendMessage() {}, sendUserMessage() {},
    } as any;
    const reg2 = registry; // same registry from harness
    registerOrchestrationTools(api, () => mixedDeps, () => true, () => null, () => null, { registry: reg2 });
    const parallel = tools.find((t) => t.name === "subagent_run_parallel");

    const env = await parallel.execute(
      "par-block-test",
      { wait: false, tasks: [
        { name: "a", agent: "x", task: "t1" },
        { name: "b", agent: "x", task: "t2" },
      ] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );

    await new Promise((r) => setTimeout(r, 40));

    const orchId = env.details.orchestrationId;

    // A blocked event must have fired for task 0
    const blocked = emitted.find((e) => e.kind === BLOCKED_KIND);
    assert.ok(blocked, "blocked event must fire");
    assert.equal(blocked.orchestrationId, orchId);

    // No orchestration_complete yet — one task is still blocked
    const complete = emitted.find((e) => e.kind === "orchestration_complete");
    assert.equal(complete, undefined, "orchestration must NOT complete while a task is blocked");

    // Task 0 is blocked
    const snap = reg2.getSnapshot(orchId);
    assert.ok(snap);
    assert.equal(snap!.tasks[0].state, "blocked");
    // Task 1 is completed
    assert.equal(snap!.tasks[1].state, "completed");
  });
});
