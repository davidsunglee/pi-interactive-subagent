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

describe("createRegistry onTaskBlocked / onResumeTerminal", () => {
  it("emits a blocked event and holds the orchestration open", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "need input" });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].kind, "blocked");
    assert.equal(emitted[0].taskIndex, 0);
    assert.equal(emitted[0].taskName, "a");
    assert.equal(emitted[0].sessionKey, "sess-a");
    assert.equal(emitted[0].message, "need input");
    assert.equal(reg.getSnapshot(id)!.tasks[0].state, "blocked");
  });

  it("onResumeTerminal re-routes via ownership map and closes the orchestration", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "need input" });
    assert.equal(emitted.length, 1);
    reg.onResumeTerminal("sess-a", {
      name: "a", index: 0, state: "completed", finalMessage: "resolved", exitCode: 0, elapsedMs: 5,
    });
    assert.equal(emitted.length, 2);
    assert.equal(emitted[1].kind, "orchestration_complete");
    assert.equal(emitted[1].isError, false);
  });

  it("cancel of a blocked task transitions it to cancelled without a resume", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "parallel", tasks: [
        { name: "a", agent: "x", task: "t" },
        { name: "b", agent: "x", task: "t" },
      ] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskLaunched(id, 1, { sessionKey: "sess-b" });
    reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "?" });
    reg.onTaskTerminal(id, 1, { name: "b", index: 1, state: "completed", exitCode: 0, elapsedMs: 1 });
    assert.equal(emitted.filter((e) => e.kind === "orchestration_complete").length, 0);
    reg.cancel(id);
    const complete = emitted.find((e) => e.kind === "orchestration_complete");
    assert.ok(complete);
    assert.equal(complete.results[0].state, "cancelled");
    assert.equal(complete.results[1].state, "completed");
  });
});

describe("createRegistry onResumeTerminal continuation gating", () => {
  it("failed resume does NOT invoke the continuation", () => {
    const { emitter } = makeEmitterSpy();
    let continuationCalls = 0;
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [
        { name: "a", agent: "x", task: "t0" },
        { name: "b", agent: "x", task: "t1" },
      ] },
      onResumeUnblock: () => { continuationCalls++; },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "?" });
    reg.onResumeStarted("sess-a");
    reg.onResumeTerminal("sess-a", {
      name: "a", index: 0, state: "failed", finalMessage: "", exitCode: 1, elapsedMs: 1, error: "boom",
    });
    assert.equal(continuationCalls, 0, "continuation must NOT fire on failed resume");
  });

  it("cancelled resume does NOT invoke the continuation", () => {
    const { emitter } = makeEmitterSpy();
    let continuationCalls = 0;
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [
        { name: "a", agent: "x", task: "t0" },
        { name: "b", agent: "x", task: "t1" },
      ] },
      onResumeUnblock: () => { continuationCalls++; },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "?" });
    reg.onResumeStarted("sess-a");
    reg.onResumeTerminal("sess-a", {
      name: "a", index: 0, state: "cancelled", finalMessage: "", exitCode: 1, elapsedMs: 1,
    });
    assert.equal(continuationCalls, 0, "continuation must NOT fire on cancelled resume");
  });

  it("completed resume invokes the continuation exactly once with the correct payload", () => {
    const { emitter } = makeEmitterSpy();
    const continuationPayloads: any[] = [];
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [
        { name: "a", agent: "x", task: "t0" },
        { name: "b", agent: "x", task: "t1" },
      ] },
      onResumeUnblock: (ctx) => { continuationPayloads.push(ctx); },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "?" });
    reg.onResumeStarted("sess-a");
    reg.onResumeTerminal("sess-a", {
      name: "a", index: 0, state: "completed", finalMessage: "done", exitCode: 0, elapsedMs: 5,
    });
    assert.equal(continuationPayloads.length, 1, "continuation must fire exactly once on completed resume");
    assert.equal(continuationPayloads[0].orchestrationId, id);
    assert.equal(continuationPayloads[0].taskIndex, 0);
    assert.equal(continuationPayloads[0].resumedResult.state, "completed");
    assert.equal(continuationPayloads[0].resumedResult.finalMessage, "done");
  });
});

describe("createRegistry onResumeTerminal clears stale block-time usage/transcript (review-v5 finding 1)", () => {
  // Rationale: the pre-lifecycle resume path runs in the pane backend, which
  // does not populate `usage`/`transcript`. The headless backend freezes a
  // point-in-time snapshot of those fields at block time. When the pane-based
  // resume completes, merging the (usage-less) resume result over the
  // blocked snapshot would leak the pre-block snapshot into the final payload
  // — presenting partial telemetry as authoritative. The registry must drop
  // those fields on resume terminal so the final payload reflects only what
  // the resume leg actually produced (which, in v1, is none).
  it("drops stale usage/transcript fields from the blocked snapshot when the resume result omits them", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    // Seed the blocked snapshot with headless-style accumulators — this
    // mirrors the `partial` that runSerial passes through to onTaskBlocked
    // from a headless backend's point-in-time usage/transcript.
    reg.onTaskBlocked(id, 0, {
      sessionKey: "sess-a",
      message: "need input",
      partial: {
        name: "a",
        index: 0,
        state: "blocked",
        sessionKey: "sess-a",
        usage: {
          input: 100, output: 50, cacheRead: 0, cacheWrite: 0,
          cost: 0.01, contextTokens: 150, turns: 1,
        },
        transcript: [
          { role: "user", content: [{ type: "text", text: "pre-block prompt" }] },
        ],
      },
    });
    // Guard: before resume, the blocked snapshot has usage/transcript.
    const preResume = reg.getSnapshot(id)!.tasks[0];
    assert.ok(preResume.usage, "pre-condition: blocked snapshot carries usage");
    assert.ok(preResume.transcript, "pre-condition: blocked snapshot carries transcript");

    // Resume terminal with no usage/transcript (pane backend in v1).
    reg.onResumeTerminal("sess-a", {
      name: "a",
      index: 0,
      state: "completed",
      finalMessage: "resolved",
      exitCode: 0,
      elapsedMs: 5,
      sessionKey: "sess-a",
    });

    const postResume = reg.getSnapshot(id)!.tasks[0];
    assert.equal(postResume.state, "completed");
    assert.equal(postResume.finalMessage, "resolved");
    assert.equal(postResume.usage, undefined,
      "resume terminal must drop the stale pre-block usage snapshot");
    assert.equal(postResume.transcript, undefined,
      "resume terminal must drop the stale pre-block transcript snapshot");
    // And the emitted orchestration_complete payload must also lack stale fields.
    const complete = emitted.find((e) => e.kind === "orchestration_complete");
    assert.ok(complete);
    assert.equal(complete.results[0].usage, undefined);
    assert.equal(complete.results[0].transcript, undefined);
  });

  it("passes through usage/transcript when the resume result explicitly carries them (future backend parity)", () => {
    // Guards against over-correction: if a future backend does provide usage
    // on the resume leg, the registry must still surface it in the emitted
    // completion payload. (The stored snapshot is stripped post-finalize for
    // memory reasons; the emitted payload is the authoritative observer.)
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    reg.onTaskBlocked(id, 0, {
      sessionKey: "sess-a",
      message: "?",
      partial: {
        name: "a",
        index: 0,
        state: "blocked",
        sessionKey: "sess-a",
        usage: {
          input: 100, output: 50, cacheRead: 0, cacheWrite: 0,
          cost: 0.01, contextTokens: 150, turns: 1,
        },
      },
    });
    const resumedUsage = {
      input: 200, output: 120, cacheRead: 0, cacheWrite: 0,
      cost: 0.05, contextTokens: 320, turns: 3,
    };
    reg.onResumeTerminal("sess-a", {
      name: "a",
      index: 0,
      state: "completed",
      finalMessage: "resolved",
      exitCode: 0,
      elapsedMs: 5,
      sessionKey: "sess-a",
      usage: resumedUsage,
    });
    const complete = emitted.find((e) => e.kind === "orchestration_complete");
    assert.ok(complete);
    assert.deepEqual(complete.results[0].usage, resumedUsage,
      "when resume provides usage, it replaces the pre-block snapshot in the emitted payload");
  });
});
