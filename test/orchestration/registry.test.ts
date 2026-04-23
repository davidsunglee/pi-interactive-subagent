import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, type RegistryEmitter } from "../../pi-extension/orchestration/registry.ts";
import type { OrchestratedTaskResult } from "../../pi-extension/orchestration/types.ts";

function makeEmitterSpy(): { emitter: RegistryEmitter; emitted: any[] } {
  const emitted: any[] = [];
  return {
    emitted,
    emitter: (payload) => { emitted.push(payload); },
  };
}

describe("createRegistry", () => {
  it("generates a unique 8-char hex orchestrationId per dispatch", () => {
    const { emitter } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id1 = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ agent: "x", task: "t1" }] },
    });
    const id2 = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ agent: "x", task: "t1" }] },
    });
    assert.notEqual(id1, id2);
    assert.match(id1, /^[0-9a-f]{8}$/);
    assert.match(id2, /^[0-9a-f]{8}$/);
  });

  it("initializes tasks as pending in input order", () => {
    const { emitter } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: {
        mode: "parallel",
        tasks: [
          { name: "a", agent: "x", task: "t1" },
          { name: "b", agent: "x", task: "t2" },
        ],
      },
    });
    const snap = reg.getSnapshot(id);
    assert.ok(snap);
    assert.equal(snap.tasks.length, 2);
    assert.equal(snap.tasks[0].state, "pending");
    assert.equal(snap.tasks[0].name, "a");
    assert.equal(snap.tasks[1].name, "b");
  });

  it("emits a single aggregated completion when every task is terminal", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: {
        mode: "parallel",
        tasks: [{ name: "a", agent: "x", task: "t1" }, { name: "b", agent: "x", task: "t2" }],
      },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "s0" });
    reg.onTaskLaunched(id, 1, { sessionKey: "s1" });
    reg.onTaskTerminal(id, 0, {
      name: "a", index: 0, state: "completed", finalMessage: "ok-a", exitCode: 0, elapsedMs: 1,
    });
    assert.equal(emitted.length, 0, "should not fire until every task terminal");
    reg.onTaskTerminal(id, 1, {
      name: "b", index: 1, state: "completed", finalMessage: "ok-b", exitCode: 0, elapsedMs: 1,
    });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].kind, "orchestration_complete");
    assert.equal(emitted[0].orchestrationId, id);
    assert.equal(emitted[0].isError, false);
    assert.deepEqual(emitted[0].results.map((r: any) => r.state), ["completed", "completed"]);
  });

  it("reports isError:true when any task is non-completed at aggregation", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: {
        mode: "parallel",
        tasks: [{ name: "a", agent: "x", task: "t1" }, { name: "b", agent: "x", task: "t2" }],
      },
    });
    reg.onTaskTerminal(id, 0, {
      name: "a", index: 0, state: "completed", exitCode: 0, elapsedMs: 1,
    });
    reg.onTaskTerminal(id, 1, {
      name: "b", index: 1, state: "failed", exitCode: 2, elapsedMs: 1, error: "boom",
    });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].isError, true);
  });

  it("cancel transitions non-terminal tasks to cancelled and emits once", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: {
        mode: "parallel",
        tasks: [{ name: "a", agent: "x", task: "t1" }, { name: "b", agent: "x", task: "t2" }],
      },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "s0" });
    // task 1 still pending
    const res = reg.cancel(id);
    assert.deepEqual(res, { ok: true });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].isError, true);
    const states = emitted[0].results.map((r: any) => r.state);
    assert.deepEqual(states, ["cancelled", "cancelled"]);
  });

  it("cancel is idempotent on already-terminal orchestrations", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskTerminal(id, 0, { name: "a", index: 0, state: "completed", exitCode: 0, elapsedMs: 1 });
    assert.equal(emitted.length, 1);
    const res = reg.cancel(id);
    assert.deepEqual(res, { ok: true, alreadyTerminal: true });
    assert.equal(emitted.length, 1, "no duplicate completion on second cancel");
  });

  it("cancel on unknown id returns alreadyTerminal:true without throwing", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const res = reg.cancel("deadbeef");
    assert.deepEqual(res, { ok: true, alreadyTerminal: true });
    assert.equal(emitted.length, 0);
  });

  it("fires the RegistryHooks.onTaskTerminal hook on every per-task terminal transition", () => {
    const { emitter } = makeEmitterSpy();
    const taskTerminals: Array<{ orchestrationId: string; taskIndex: number; state: string }> = [];
    const reg = createRegistry(emitter, {
      onTaskTerminal: (ctx) => { taskTerminals.push(ctx); },
    });
    const id = reg.dispatchAsync({
      config: {
        mode: "parallel",
        tasks: [{ name: "a", agent: "x", task: "t1" }, { name: "b", agent: "x", task: "t2" }],
      },
    });
    reg.onTaskTerminal(id, 0, { name: "a", index: 0, state: "completed", exitCode: 0, elapsedMs: 1 });
    assert.deepEqual(taskTerminals, [{ orchestrationId: id, taskIndex: 0, state: "completed" }]);
    reg.onTaskTerminal(id, 1, { name: "b", index: 1, state: "failed", exitCode: 2, elapsedMs: 1 });
    assert.equal(taskTerminals.length, 2);
    assert.equal(taskTerminals[1].state, "failed");
  });

  it("fires onTaskTerminal for every slot transitioned by cancel()", () => {
    const { emitter } = makeEmitterSpy();
    const taskTerminals: Array<{ taskIndex: number; state: string }> = [];
    const reg = createRegistry(emitter, {
      onTaskTerminal: (ctx) => { taskTerminals.push({ taskIndex: ctx.taskIndex, state: ctx.state }); },
    });
    const id = reg.dispatchAsync({
      config: {
        mode: "parallel",
        tasks: [{ name: "a", agent: "x", task: "t1" }, { name: "b", agent: "x", task: "t2" }],
      },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "s0" });
    reg.cancel(id);
    assert.equal(taskTerminals.length, 2);
    assert.ok(taskTerminals.every((t) => t.state === "cancelled"));
  });

  it("updateSessionKey late-binds a key for a task launched without one (Claude-backed path)", () => {
    const { emitter } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    // Simulate Claude-backed launch: sessionKey not known yet.
    reg.onTaskLaunched(id, 0, {});
    assert.equal(reg.lookupOwner("claude-sess-xyz"), null);
    // The backend learns the Claude session id from system/init and calls:
    reg.updateSessionKey(id, 0, "claude-sess-xyz");
    const owner = reg.lookupOwner("claude-sess-xyz");
    assert.ok(owner);
    assert.equal(owner!.orchestrationId, id);
    assert.equal(owner!.taskIndex, 0);
    assert.equal(reg.getSnapshot(id)!.tasks[0].sessionKey, "claude-sess-xyz");
  });

  it("updateSessionKey is a no-op when a key is already recorded for the slot", () => {
    const { emitter } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "/tmp/path.jsonl" });
    reg.updateSessionKey(id, 0, "claude-should-not-override");
    // The original pi path remains the owner; the Claude id does NOT alias.
    assert.equal(reg.lookupOwner("/tmp/path.jsonl")!.orchestrationId, id);
    assert.equal(reg.lookupOwner("claude-should-not-override"), null);
  });

  it("a late-bound sessionKey routes subsequent onTaskBlocked / onResumeTerminal via ownership", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, {}); // Claude-backed: no sessionKey at launch
    reg.updateSessionKey(id, 0, "claude-sess-xyz");
    reg.onTaskBlocked(id, 0, { sessionKey: "claude-sess-xyz", message: "?" });
    assert.equal(emitted[0].kind, "blocked");
    assert.equal(emitted[0].sessionKey, "claude-sess-xyz");
    reg.onResumeTerminal("claude-sess-xyz", {
      name: "a", index: 0, state: "completed", finalMessage: "ok", exitCode: 0, elapsedMs: 1,
    });
    const complete = emitted.find((e) => e.kind === "orchestration_complete");
    assert.ok(complete);
    assert.equal(complete!.results[0].state, "completed");
  });

  it("onResumeStarted transitions an owned blocked slot to running and fires the hook", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const resumeStarts: Array<{ orchestrationId: string; taskIndex: number }> = [];
    const reg = createRegistry(emitter, {
      onResumeStarted: (ctx) => { resumeStarts.push(ctx); },
    });
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "?" });
    assert.equal(reg.getSnapshot(id)!.tasks[0].state, "blocked");
    reg.onResumeStarted("sess-a");
    // Spec's `blocked -> running` leg:
    assert.equal(reg.getSnapshot(id)!.tasks[0].state, "running");
    // Ownership is preserved so the eventual terminal still routes back:
    const owner = reg.lookupOwner("sess-a");
    assert.ok(owner);
    assert.equal(owner!.orchestrationId, id);
    assert.equal(owner!.taskIndex, 0);
    // Hook fires exactly once with the owning (orchId, taskIndex):
    assert.equal(resumeStarts.length, 1);
    assert.equal(resumeStarts[0].orchestrationId, id);
    assert.equal(resumeStarts[0].taskIndex, 0);
  });

  it("onResumeStarted is a no-op for an unowned sessionKey (standalone resume)", () => {
    const { emitter } = makeEmitterSpy();
    const resumeStarts: any[] = [];
    const reg = createRegistry(emitter, {
      onResumeStarted: (ctx) => { resumeStarts.push(ctx); },
    });
    reg.onResumeStarted("/tmp/not-owned.jsonl"); // must not throw
    assert.equal(resumeStarts.length, 0);
  });

  it("onResumeStarted does not change state for a slot that is not blocked", () => {
    const { emitter } = makeEmitterSpy();
    const resumeStarts: any[] = [];
    const reg = createRegistry(emitter, {
      onResumeStarted: (ctx) => { resumeStarts.push(ctx); },
    });
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    // Slot is `running`, not `blocked`. Calling onResumeStarted (e.g. via a
    // race between cancellation and resume-start) must be a no-op.
    assert.equal(reg.getSnapshot(id)!.tasks[0].state, "running");
    reg.onResumeStarted("sess-a");
    assert.equal(reg.getSnapshot(id)!.tasks[0].state, "running");
    assert.equal(resumeStarts.length, 0);
  });

  it("throwing emitter during tryFinalize does not propagate and state transition lands", () => {
    const throwingEmitter: RegistryEmitter = () => { throw new Error("emitter exploded"); };
    const reg = createRegistry(throwingEmitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    // Must not throw even though the emitter throws.
    assert.doesNotThrow(() => {
      reg.onTaskTerminal(id, 0, {
        name: "a", index: 0, state: "completed", exitCode: 0, elapsedMs: 1,
      });
    });
    // State transition still lands correctly.
    assert.equal(reg.getSnapshot(id)!.tasks[0].state, "completed");
  });

  it("throwing emitter during onTaskBlocked does not propagate and state transition lands", () => {
    const throwingEmitter: RegistryEmitter = () => { throw new Error("emitter exploded"); };
    const reg = createRegistry(throwingEmitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    // Must not throw even though the emitter throws.
    assert.doesNotThrow(() => {
      reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "need input" });
    });
    // State transition still lands correctly.
    assert.equal(reg.getSnapshot(id)!.tasks[0].state, "blocked");
  });

  it("onTaskTerminal after orchestration finalization is a no-op", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskTerminal(id, 0, {
      name: "a", index: 0, state: "completed", exitCode: 0, elapsedMs: 1,
    });
    assert.equal(emitted.length, 1, "one completion event emitted");
    // Late callback: simulate a race with a second terminal call after finalization.
    reg.onTaskTerminal(id, 0, {
      name: "a", index: 0, state: "failed", exitCode: 1, elapsedMs: 2, error: "late",
    });
    assert.equal(emitted.length, 1, "no duplicate event");
    assert.equal(reg.getSnapshot(id)!.tasks[0].state, "completed", "original state preserved");
  });

  it("onTaskBlocked after orchestration finalization is a no-op", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "parallel", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    // cancel() finalizes the orchestration by marking all tasks as cancelled.
    reg.cancel(id);
    assert.equal(emitted.length, 1, "one completion event emitted by cancel");
    // Late callback: onTaskBlocked on a slot that is now cancelled.
    reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "too late" });
    assert.equal(emitted.length, 1, "no second event emitted");
    assert.equal(reg.getSnapshot(id)!.tasks[0].state, "cancelled", "slot remains cancelled");
  });

  it("cancel aborts the orchestration's shared AbortSignal", () => {
    const { emitter } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    const signal = reg.getAbortSignal(id);
    assert.ok(signal);
    assert.equal(signal!.aborted, false);
    reg.cancel(id);
    assert.equal(signal!.aborted, true);
  });

  it("getAbortSignal returns null for unknown id", () => {
    const { emitter } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    assert.equal(reg.getAbortSignal("deadbeef"), null);
  });
});
