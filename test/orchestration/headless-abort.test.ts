import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

describe("headless abort", { timeout: 15_000 }, () => {
  let lastFakeProc: any;
  let killed: string[];
  let backendModule: any;

  function makeFakeProc() {
    const ee = new EventEmitter() as any;
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.killed = false;        // Real Node: only set when kill() successfully sends.
    ee.kill = (sig: string) => {
      killed.push(sig);
      return true;
    };
    ee._fakeExit = (code: number) => {
      ee.emit("exit", code);
      ee.emit("close", code);
    };
    lastFakeProc = ee;
    return ee;
  }

  before(async () => {
    backendModule = await import("../../pi-extension/subagents/backends/headless.ts");
    backendModule.__test__.setSpawn(() => makeFakeProc());
  });

  after(() => {
    backendModule.__test__.restoreSpawn();
  });

  function patchSetTimeout(): {
    scheduled: Array<{ ms: number; fn: () => void }>;
    restore: () => void;
  } {
    const orig = globalThis.setTimeout;
    const scheduled: Array<{ ms: number; fn: () => void }> = [];
    (globalThis as any).setTimeout = ((fn: () => void, ms: number) => {
      scheduled.push({ ms, fn });
      return { unref: () => {} } as any;
    }) as any;
    return { scheduled, restore: () => { (globalThis as any).setTimeout = orig; } };
  }

  const ctx = {
    sessionManager: {
      getSessionFile: () => "/tmp/fake",
      getSessionId: () => "test",
      getSessionDir: () => "/tmp",
    } as any,
    cwd: "/tmp",
  };

  it("sends SIGTERM immediately, then schedules SIGKILL; no escalation when child exits cleanly", async () => {
    killed = [];
    const t = patchSetTimeout();
    try {
      const backend = backendModule.makeHeadlessBackend(ctx);
      const controller = new AbortController();
      const handle = await backend.launch(
        { agent: "x", task: "spin", cli: "pi" }, false, controller.signal,
      );
      await new Promise((r) => setImmediate(r));

      controller.abort();
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(killed, ["SIGTERM"]);
      assert.ok(t.scheduled.find((s) => s.ms === 5000), "5s escalation timer must be scheduled");

      lastFakeProc._fakeExit(0);
      t.scheduled.find((s) => s.ms === 5000)!.fn();
      assert.deepEqual(killed, ["SIGTERM"], "no SIGKILL when child already exited");

      const result = await backend.watch(handle);
      assert.equal(result.error, "aborted");
      assert.equal(result.exitCode, 1);
    } finally {
      t.restore();
    }
  });

  it("sends SIGKILL after 5s when the child ignores SIGTERM (regression for proc.killed bug)", async () => {
    killed = [];
    const t = patchSetTimeout();
    try {
      const backend = backendModule.makeHeadlessBackend(ctx);
      const controller = new AbortController();
      const handle = await backend.launch(
        { agent: "x", task: "spin", cli: "pi" }, false, controller.signal,
      );
      await new Promise((r) => setImmediate(r));

      controller.abort();
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(killed, ["SIGTERM"]);

      const fiveSec = t.scheduled.find((s) => s.ms === 5000);
      assert.ok(fiveSec);
      fiveSec!.fn();
      assert.deepEqual(killed, ["SIGTERM", "SIGKILL"],
        `SIGKILL must be sent when child has not exited; got ${killed.join(",")}`);

      lastFakeProc._fakeExit(137);
      const result = await backend.watch(handle);
      assert.equal(result.error, "aborted");
      assert.equal(result.exitCode, 1);
    } finally {
      t.restore();
    }
  });
});
