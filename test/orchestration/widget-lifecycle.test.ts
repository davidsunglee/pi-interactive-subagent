import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  registerHeadlessSubagent,
  updateHeadlessSubagentUsage,
  unregisterHeadlessSubagent,
  __test__,
} from "../../pi-extension/subagents/index.ts";
import { makeDefaultDeps } from "../../pi-extension/orchestration/default-deps.ts";
import type { SubagentStatusState } from "../../pi-extension/subagents/status.ts";

describe("widget lifecycle helpers", () => {
  it("registerHeadlessSubagent adds an entry to runningSubagents", () => {
    const id = "wl-test-" + Math.random().toString(36).slice(2);
    try {
      registerHeadlessSubagent({ id, name: "TestAgent", task: "do stuff" });
      const map = __test__.getRunningSubagents();
      const entry = map.get(id);
      assert.ok(entry, "entry should be in runningSubagents after register");
      assert.equal(entry.backend, "headless");
      assert.equal(entry.name, "TestAgent");
      assert.equal(entry.task, "do stuff");
    } finally {
      unregisterHeadlessSubagent(id);
    }
  });

  it("updateHeadlessSubagentUsage mutates the usage field on the entry", () => {
    const id = "wl-test-" + Math.random().toString(36).slice(2);
    registerHeadlessSubagent({ id, name: "UsageAgent", task: "compute" });
    try {
      const map = __test__.getRunningSubagents();
      assert.equal(map.get(id)?.usage, undefined, "usage should start undefined");

      updateHeadlessSubagentUsage(id, {
        input: 1000,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.001,
        contextTokens: 1200,
        turns: 1,
      });
      assert.deepEqual(map.get(id)?.usage, {
        input: 1000,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.001,
        contextTokens: 1200,
        turns: 1,
      });

      updateHeadlessSubagentUsage(id, {
        input: 2000,
        output: 400,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.002,
        contextTokens: 2400,
        turns: 2,
      });
      assert.equal(map.get(id)?.usage?.turns, 2, "usage should update to second partial");
    } finally {
      unregisterHeadlessSubagent(id);
    }
  });

  it("unregisterHeadlessSubagent removes the entry", () => {
    const id = "wl-test-" + Math.random().toString(36).slice(2);
    registerHeadlessSubagent({ id, name: "DelAgent", task: "clean" });
    assert.ok(__test__.getRunningSubagents().has(id), "should exist before unregister");
    unregisterHeadlessSubagent(id);
    assert.ok(!__test__.getRunningSubagents().has(id), "should be gone after unregister");
  });

  it("registerHeadlessSubagent seeds activityFile, interactive, and statusState when provided", () => {
    const id = "wl-status-" + Math.random().toString(36).slice(2);
    const startTime = Date.now();
    try {
      registerHeadlessSubagent({
        id,
        name: "StatusAgent",
        task: "status task",
        activityFile: "/tmp/activity.json",
        interactive: true,
        source: "pi",
        startTime,
      });
      const map = __test__.getRunningSubagents();
      const entry = map.get(id);
      assert.ok(entry, "entry should exist after register");
      assert.equal(entry.activityFile, "/tmp/activity.json");
      assert.equal(entry.interactive, true);
      assert.ok(entry.statusState != null, "statusState must be set");
      const ss = entry.statusState as SubagentStatusState;
      assert.equal(ss.source, "pi");
      assert.equal(ss.startTimeMs, startTime);
      assert.equal(ss.currentKind, "starting", "pi source starts as 'starting'");
    } finally {
      unregisterHeadlessSubagent(id);
    }
  });

  it("registerHeadlessSubagent defaults interactive to false and uses pi source when not provided", () => {
    const id = "wl-default-" + Math.random().toString(36).slice(2);
    try {
      registerHeadlessSubagent({ id, name: "DefaultAgent", task: "default task" });
      const map = __test__.getRunningSubagents();
      const entry = map.get(id);
      assert.ok(entry, "entry should exist");
      assert.equal(entry.interactive, false, "interactive defaults to false");
      assert.ok(entry.statusState != null, "statusState must be set even without explicit source");
      const ss = entry.statusState as SubagentStatusState;
      assert.equal(ss.source, "pi", "defaults to pi source");
    } finally {
      unregisterHeadlessSubagent(id);
    }
  });

  it("registerHeadlessSubagent seeds claude statusState with running kind", () => {
    const id = "wl-claude-" + Math.random().toString(36).slice(2);
    try {
      registerHeadlessSubagent({ id, name: "ClaudeAgent", task: "claude task", source: "claude" });
      const map = __test__.getRunningSubagents();
      const entry = map.get(id);
      assert.ok(entry, "entry should exist");
      const ss = entry.statusState as SubagentStatusState;
      assert.equal(ss.source, "claude");
      assert.equal(ss.currentKind, "running", "claude source starts as 'running'");
    } finally {
      unregisterHeadlessSubagent(id);
    }
  });
});

describe("makeDefaultDeps headless widget lifecycle", () => {
  let origMode: string | undefined;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
  });

  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
  });

  it("registers an entry after launch and unregisters after waitForCompletion", async () => {
    const deps = makeDefaultDeps({
      sessionManager: {
        getSessionFile: () => "/tmp/fake-session.jsonl",
        getSessionId: () => "test-session",
        getSessionDir: () => "/tmp",
      } as any,
      cwd: process.cwd(),
    });

    const handle = await deps.launch({ agent: "x", task: "lifecycle-test" }, false);

    // After launch, the entry should be registered.
    const map = __test__.getRunningSubagents();
    assert.ok(map.has(handle.id), `entry for ${handle.id} should be in runningSubagents after launch`);
    const entry = map.get(handle.id)!;
    assert.equal(entry.backend, "headless");
    assert.equal(entry.task, "lifecycle-test");

    await deps.waitForCompletion(handle);

    // After completion, the entry should be removed.
    assert.ok(!map.has(handle.id), `entry for ${handle.id} should be removed after waitForCompletion`);
  });

  it("updates usage via onUpdate callback during waitForCompletion", async () => {
    const deps = makeDefaultDeps({
      sessionManager: {
        getSessionFile: () => "/tmp/fake-session.jsonl",
        getSessionId: () => "test-session",
        getSessionDir: () => "/tmp",
      } as any,
      cwd: process.cwd(),
    });

    const handle = await deps.launch({ agent: "x", task: "usage-test" }, false);
    const map = __test__.getRunningSubagents();
    assert.ok(map.has(handle.id), "entry should be registered");

    const partialUsages: Array<{ turns: number }> = [];
    await deps.waitForCompletion(handle, undefined, (partial) => {
      if (partial.usage) partialUsages.push({ turns: partial.usage.turns });
    });

    assert.ok(!map.has(handle.id), "entry should be removed after completion");
  });
});
