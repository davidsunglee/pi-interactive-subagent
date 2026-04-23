// test/orchestration/block-resume.test.ts
//
// Step 10.6: block-resume full-flow + "downstream stays pending" tests.
// These tests cover the core invariant: when a serial run blocks on step N,
// steps N+1..end stay pending (NOT swept to cancelled).
// Step 11: serial continuation after resume-unblock.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import { createRegistry } from "../../pi-extension/orchestration/registry.ts";
import { BLOCKED_KIND, ORCHESTRATION_COMPLETE_KIND } from "../../pi-extension/orchestration/notification-kinds.ts";
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

describe("block-resume: serial continuation after resume", () => {
  it("serial: step 1 blocks, resume completes it, step 2 runs, aggregated completion fires", async () => {
    // step 0 completes instantly, step 1 blocks, then resume completes step 1,
    // continuation runs step 2, aggregated completion fires.
    let callCount = 0;
    const sessionKeyForBlocker = "sess-step1-blocker";
    let resolveResume: ((result: any) => void) | null = null;
    const resumePromise = new Promise<any>((res) => { resolveResume = res; });

    const deps: LauncherDeps = {
      async launch(t) {
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(), sessionKey: `sess-${t.task}` };
      },
      async waitForCompletion(h) {
        const i = callCount++;
        if (i === 0) {
          // step 0: completes normally
          return { name: h.name, finalMessage: "step0-done", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
        }
        if (i === 1) {
          // step 1: blocks (ping), returns with sessionKey for resume
          return {
            name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 0,
            sessionKey: sessionKeyForBlocker,
            ping: { name: h.name, message: "need user input" },
          };
        }
        // step 2: completes (called after resume continuation)
        return { name: h.name, finalMessage: "step2-done", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
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
    const serial = tools.find((t) => t.name === "subagent_run_serial");

    const env = await serial.execute(
      "block-resume-e2e",
      { wait: false, tasks: [
        { name: "step-a", agent: "x", task: "t0" },
        { name: "step-b", agent: "x", task: "t1" },
        { name: "step-c", agent: "x", task: "t2" },
      ] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );

    // Give the async IIFE time to run step 0 and block on step 1
    await new Promise((r) => setTimeout(r, 60));

    const orchId = env.details.orchestrationId;

    // Step 1 should be blocked
    const blocked = emitted.find((e) => e.kind === BLOCKED_KIND);
    assert.ok(blocked, "blocked event must fire for step 1");
    assert.equal(blocked.taskIndex, 1);

    const snapBefore = registry.getSnapshot(orchId);
    assert.ok(snapBefore);
    assert.equal(snapBefore!.tasks[1].state, "blocked");
    assert.equal(snapBefore!.tasks[2].state, "pending");

    // No completion yet
    assert.equal(emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND), undefined);

    // Simulate resume: mark resume started, then terminal with completed result
    registry.onResumeStarted(sessionKeyForBlocker);
    registry.onResumeTerminal(sessionKeyForBlocker, {
      name: "step-b", index: 1, state: "completed", finalMessage: "step1-resumed-done",
      exitCode: 0, elapsedMs: 5, sessionKey: sessionKeyForBlocker,
    });

    // Give the continuation time to run step 2 and finalize
    await new Promise((r) => setTimeout(r, 80));

    const complete2 = emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND);
    assert.ok(complete2, "aggregated completion should fire after resume + task 2 runs");
    assert.equal(complete2.results[0].state, "completed");
    assert.equal(complete2.results[1].state, "completed");
  });
});

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

  it("maxConcurrency:1 + block at task 0 must not strand siblings (review-v3 #1 e2e)", async () => {
    // Exact reproduction from review-v3 issue #1: with maxConcurrency=1 and
    // task 0 blocking, the single worker must continue claiming task 1. The
    // tool-handlers post-run sweep then skips the registry-owned blocked slot
    // and leaves task 1 in its terminal state (completed). Before the fix, the
    // worker exited after onBlocked, task 1 was never launched, and the sweep
    // swept it to "cancelled" as "not launched".
    let call = 0;
    const sessionKeyForBlocker = "sess-mx1-block";
    const deps: LauncherDeps = {
      async launch(t) {
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(), sessionKey: `sess-${t.task}` };
      },
      async waitForCompletion(h) {
        const i = call++;
        if (i === 0) {
          return {
            name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 0,
            sessionKey: sessionKeyForBlocker,
            ping: { name: h.name, message: "need input" },
          };
        }
        return { name: h.name, finalMessage: "ok", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
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

    const env = await parallel.execute(
      "par-mx1-block",
      { wait: false, maxConcurrency: 1, tasks: [
        { name: "a", agent: "x", task: "t1" },
        { name: "b", agent: "x", task: "t2" },
      ] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );

    await new Promise((r) => setTimeout(r, 60));

    const orchId = env.details.orchestrationId;
    const snap = registry.getSnapshot(orchId);
    assert.ok(snap);
    assert.equal(snap!.tasks[0].state, "blocked",
      "task 0 must be blocked (it called caller_ping)");
    assert.equal(snap!.tasks[1].state, "completed",
      "task 1 must have been launched after task 0 blocked and completed normally — " +
      "before the fix, the lone worker exited on block and the sweep cancelled task 1");

    // No aggregated completion yet (task 0 is still blocked).
    assert.equal(emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND), undefined,
      "orchestration must stay open while task 0 is blocked");
  });

  it("parallel block-resume: blocked task resumes to completed, aggregated completion fires", async () => {
    // Task 0 blocks (parallel), task 1 completes.
    // After resume of task 0 to completed, tryFinalize should fire aggregated completion.
    const sessionKeyForBlocker = "sess-par-block";
    let call = 0;

    const deps: LauncherDeps = {
      async launch(t) {
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(), sessionKey: `sess-${t.task}` };
      },
      async waitForCompletion(h) {
        const i = call++;
        if (i === 0) {
          return {
            name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 0,
            sessionKey: sessionKeyForBlocker,
            ping: { name: h.name, message: "blocked on input" },
          };
        }
        return { name: h.name, finalMessage: "ok", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
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

    const env = await parallel.execute(
      "par-resume-test",
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
    assert.ok(emitted.find((e) => e.kind === BLOCKED_KIND), "blocked event must fire");
    assert.equal(emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND), undefined, "no completion yet");

    // Resume task 0 to completed
    registry.onResumeStarted(sessionKeyForBlocker);
    registry.onResumeTerminal(sessionKeyForBlocker, {
      name: "a", index: 0, state: "completed", finalMessage: "par-resumed",
      exitCode: 0, elapsedMs: 3, sessionKey: sessionKeyForBlocker,
    });

    await new Promise((r) => setTimeout(r, 20));

    const complete = emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND);
    assert.ok(complete, "aggregated completion should fire after parallel resume");
    assert.equal(complete.isError, false);
    assert.equal(complete.results[0].state, "completed");
    assert.equal(complete.results[1].state, "completed");
  });
});

describe("block-resume: serial non-success resume sweeps downstream", () => {
  it("resume into `failed` does not launch downstream tasks; aggregated completion reports failed + cancelled tail", async () => {
    const sessionKeyForBlocker = "sess-fail-resume";
    let launched = 0;

    const deps: LauncherDeps = {
      async launch(t) {
        launched++;
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(), sessionKey: `sess-${t.task}` };
      },
      async waitForCompletion(h) {
        return {
          name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 0,
          sessionKey: sessionKeyForBlocker,
          ping: { name: h.name, message: "need input" },
        };
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
    const serial = tools.find((t) => t.name === "subagent_run_serial");

    await serial.execute(
      "fail-resume-test",
      { wait: false, tasks: [
        { name: "step-a", agent: "x", task: "t0" },
        { name: "step-b", agent: "x", task: "t1" },
        { name: "step-c", agent: "x", task: "t2" },
      ] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );

    await new Promise((r) => setTimeout(r, 40));

    // Only step-a should have been launched (it blocked)
    assert.equal(launched, 1, "only the blocking step was launched");

    // Resume step-a to failed
    registry.onResumeStarted(sessionKeyForBlocker);
    registry.onResumeTerminal(sessionKeyForBlocker, {
      name: "step-a", index: 0, state: "failed", finalMessage: "",
      exitCode: 1, elapsedMs: 3, error: "remote failure", sessionKey: sessionKeyForBlocker,
    });

    await new Promise((r) => setTimeout(r, 20));

    // No additional launches
    assert.equal(launched, 1, "no downstream launches after failed resume");

    const complete = emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND);
    assert.ok(complete, "aggregated completion must fire after failed resume");
    assert.equal(complete.isError, true);
    assert.equal(complete.results[0].state, "failed");
    assert.equal(complete.results[1].state, "cancelled");
    assert.equal(complete.results[2].state, "cancelled");
  });

  it("resume into `cancelled` does not launch downstream tasks", async () => {
    const sessionKeyForBlocker = "sess-cancelled-resume";
    let launched = 0;

    const deps: LauncherDeps = {
      async launch(t) {
        launched++;
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(), sessionKey: `sess-${t.task}` };
      },
      async waitForCompletion(h) {
        return {
          name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 0,
          sessionKey: sessionKeyForBlocker,
          ping: { name: h.name, message: "need input" },
        };
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
    const serial = tools.find((t) => t.name === "subagent_run_serial");

    await serial.execute(
      "cancelled-resume-test",
      { wait: false, tasks: [
        { name: "step-a", agent: "x", task: "t0" },
        { name: "step-b", agent: "x", task: "t1" },
      ] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(launched, 1, "only blocker was launched");

    // Resume to cancelled
    registry.onResumeStarted(sessionKeyForBlocker);
    registry.onResumeTerminal(sessionKeyForBlocker, {
      name: "step-a", index: 0, state: "cancelled", finalMessage: "",
      exitCode: 1, elapsedMs: 1, sessionKey: sessionKeyForBlocker,
    });

    await new Promise((r) => setTimeout(r, 20));

    assert.equal(launched, 1, "no downstream launches after cancelled resume");

    const complete = emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND);
    assert.ok(complete, "aggregated completion must fire");
    assert.equal(complete.isError, true);
    assert.equal(complete.results[0].state, "cancelled");
    assert.equal(complete.results[1].state, "cancelled");
  });
});

describe("block-resume: registry recursion — repeated blocks then terminal", () => {
  it("registry recursion: step blocks twice (two distinct sessions), then terminal resume fires completion", async () => {
    // Simulates a step that ping-blocks twice (e.g., two rounds of user interaction)
    // before reaching a terminal state. The registry should emit 2 blocked events
    // and then 1 orchestration_complete.
    //
    // We test this at the registry level (not through tool-handlers) to avoid
    // needing the full runSerial machinery for two separate block→resume cycles.
    const { emitter, emitted } = (() => {
      const emitted: any[] = [];
      return { emitter: (p: any) => emitted.push(p), emitted };
    })();
    const registry = createRegistry(emitter);

    const id = registry.dispatchAsync({
      config: { mode: "serial", tasks: [
        { name: "step-a", agent: "x", task: "t0" },
        { name: "step-b", agent: "x", task: "t1" },
      ] },
    });

    // First block
    registry.onTaskLaunched(id, 0, { sessionKey: "sess-first" });
    registry.onTaskBlocked(id, 0, { sessionKey: "sess-first", message: "round 1" });
    assert.equal(emitted.filter((e) => e.kind === BLOCKED_KIND).length, 1, "first blocked event");

    // Resume starts, slot goes running
    registry.onResumeStarted("sess-first");
    assert.equal(registry.getSnapshot(id)!.tasks[0].state, "running");

    // Second block (new session key from resumed interaction)
    registry.onTaskBlocked(id, 0, { sessionKey: "sess-second", message: "round 2" });
    assert.equal(emitted.filter((e) => e.kind === BLOCKED_KIND).length, 2, "second blocked event");
    assert.equal(registry.getSnapshot(id)!.tasks[0].state, "blocked");

    // Terminal resume — the task finishes
    registry.onResumeStarted("sess-second");
    registry.onResumeTerminal("sess-second", {
      name: "step-a", index: 0, state: "completed", finalMessage: "done", exitCode: 0, elapsedMs: 5,
    });

    // step-b is still pending (no continuation callback), so sweep it manually
    registry.onTaskTerminal(id, 1, {
      name: "step-b", index: 1, state: "completed", finalMessage: "b-done", exitCode: 0, elapsedMs: 1,
    });

    const complete = emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND);
    assert.ok(complete, "aggregated completion must fire");
    assert.equal(complete.results[0].state, "completed");
    assert.equal(complete.results[1].state, "completed");
  });
});
