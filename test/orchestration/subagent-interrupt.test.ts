import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __test__ } from "../../pi-extension/subagents/index.ts";
import { createStatusState, observeStatus, classifyStatus } from "../../pi-extension/subagents/status.ts";
import { getSubagentActivityFile } from "../../pi-extension/subagents/activity.ts";
import type { RunningSubagent } from "../../pi-extension/subagents/index.ts";

// ── helpers ────────────────────────────────────────────────────────────────

let tmpDir: string | null = null;

function getTmpDir(): string {
  if (!tmpDir) {
    tmpDir = mkdtempSync(join(tmpdir(), "subagent-interrupt-test-"));
  }
  return tmpDir;
}

after(() => {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeRunning(overrides: Partial<RunningSubagent> & Record<string, unknown> = {}): RunningSubagent {
  return {
    id: "a1",
    name: "Worker",
    task: "",
    backend: "pane",
    surface: "pane-1",
    startTime: 0,
    sessionFile: "worker.jsonl",
    interactive: false,
    statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
    ...overrides,
  } as RunningSubagent;
}

function getRunningMap(): Map<string, RunningSubagent> {
  return __test__.getRunningSubagents();
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("subagent interruption", () => {
  before(() => {
    getRunningMap().clear();
    __test__.resetRegistry();
  });

  after(() => {
    getRunningMap().clear();
  });

  describe("resolveInterruptTarget", () => {
    it("returns running entry when resolved by exact id", () => {
      const map = getRunningMap();
      map.clear();
      const entry = makeRunning({ id: "c3", name: "Scout" });
      map.set("a1", makeRunning({ id: "a1", name: "Worker" }));
      map.set("b2", makeRunning({ id: "b2", name: "Worker" }));
      map.set("c3", entry);
      try {
        const result = __test__.resolveInterruptTarget({ id: "c3" });
        assert.ok("running" in result, "expected running entry");
        assert.equal((result as any).running.id, "c3");
      } finally {
        map.clear();
      }
    });

    it("returns error when id is missing", () => {
      const map = getRunningMap();
      map.clear();
      try {
        const result = __test__.resolveInterruptTarget({ id: "no-such-id" });
        assert.ok("error" in result, "expected error");
        assert.match((result as any).error, /No running subagent with id/);
      } finally {
        map.clear();
      }
    });

    it("id takes precedence over name", () => {
      const map = getRunningMap();
      map.clear();
      map.set("a1", makeRunning({ id: "a1", name: "Worker" }));
      map.set("c3", makeRunning({ id: "c3", name: "Scout" }));
      try {
        const result = __test__.resolveInterruptTarget({ id: "c3", name: "Worker" });
        assert.ok("running" in result);
        assert.equal((result as any).running.id, "c3");
      } finally {
        map.clear();
      }
    });

    it("returns running entry when resolved by unique name", () => {
      const map = getRunningMap();
      map.clear();
      map.set("c3", makeRunning({ id: "c3", name: "Scout" }));
      try {
        const result = __test__.resolveInterruptTarget({ name: "Scout" });
        assert.ok("running" in result);
        assert.equal((result as any).running.id, "c3");
      } finally {
        map.clear();
      }
    });

    it("returns error with matched ids when name is ambiguous", () => {
      const map = getRunningMap();
      map.clear();
      map.set("a1", makeRunning({ id: "a1", name: "Worker" }));
      map.set("b2", makeRunning({ id: "b2", name: "Worker" }));
      try {
        const result = __test__.resolveInterruptTarget({ name: "Worker" });
        assert.ok("error" in result);
        assert.match((result as any).error, /Ambiguous subagent name/);
        assert.match((result as any).error, /a1/);
        assert.match((result as any).error, /b2/);
      } finally {
        map.clear();
      }
    });

    it("returns error when no id or name is provided", () => {
      const result = __test__.resolveInterruptTarget({});
      assert.ok("error" in result);
      assert.match((result as any).error, /Provide a running subagent id or exact display name/);
    });
  });

  describe("requestSubagentInterrupt", () => {
    it("returns ok:true and calls sendEscapeKey with surface when escape succeeds", () => {
      const map = getRunningMap();
      map.clear();
      let sentSurface = "";
      const running = makeRunning({ surface: "pane-1" });
      const result = __test__.requestSubagentInterrupt(running, (surface: string) => {
        sentSurface = surface;
      });
      assert.deepEqual(result, { ok: true });
      assert.equal(sentSurface, "pane-1");
    });

    it("returns error matching /Failed to send Escape/ when escape throws", () => {
      let aborted = false;
      const running = makeRunning({
        abortController: { abort() { aborted = true; } } as any,
      });
      const result = __test__.requestSubagentInterrupt(running, () => {
        throw new Error("mux write failed");
      });
      assert.ok("error" in result);
      assert.match((result as any).error, /Failed to send Escape/);
      assert.equal(aborted, false, "abort should not be called on escape failure");
    });

    it("does not set interruptRequested on the running entry", () => {
      const running = makeRunning();
      __test__.requestSubagentInterrupt(running, () => {});
      assert.equal("interruptRequested" in running, false);
    });
  });

  describe("handleSubagentInterrupt", () => {
    it("succeeds for a pane-Pi child: sets interrupted label, emits interrupt_requested, leaves entry in map", () => {
      const map = getRunningMap();
      map.clear();

      const activeState = observeStatus(
        createStatusState({ source: "pi", startTimeMs: 0 }),
        {
          snapshot: "present",
          updatedAt: 5_000,
          sequence: 1,
          phase: "active",
          active: true,
          activeScope: "tool",
          activeSince: 5_000,
          activityLabel: "bash",
        },
        5_000,
      );

      try {
        map.set("a1", makeRunning({ statusState: activeState }));
        let sentSurface = "";

        const result = __test__.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
          sentSurface = surface;
        });

        assert.equal(sentSurface, "pane-1", "should have sent escape to surface");
        assert.equal(result.content[0].text, 'Interrupt requested for subagent "Worker".');
        assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "interrupt_requested" });

        const state = map.get("a1")!.statusState!;
        const snapshot = classifyStatus(state, Date.now() + 60_000);
        assert.equal(snapshot.kind, "waiting");
        assert.equal(snapshot.activityLabel, "interrupted");
        assert.equal(map.has("a1"), true, "entry should remain in map");
      } finally {
        map.clear();
      }
    });

    it("rejects Claude-backed subagents before Escape delivery", () => {
      const map = getRunningMap();
      map.clear();
      let delivered = false;
      try {
        map.set("a1", makeRunning({ cli: "claude" } as any));
        const result = __test__.handleSubagentInterrupt({ name: "Worker" }, () => {
          delivered = true;
        });
        assert.equal(delivered, false, "Escape should not be delivered for Claude");
        assert.match(result.content[0].text, /currently supported only for pane-Pi subagents/i);
        assert.deepEqual(result.details, {
          error: "claude interrupt unsupported",
          id: "a1",
          name: "Worker",
        });
      } finally {
        map.clear();
      }
    });

    it("rejects headless subagents before Escape delivery", () => {
      const map = getRunningMap();
      map.clear();
      let delivered = false;
      try {
        map.set("a1", makeRunning({ backend: "headless", surface: undefined } as any));
        const result = __test__.handleSubagentInterrupt({ name: "Worker" }, () => {
          delivered = true;
        });
        assert.equal(delivered, false, "Escape should not be delivered for headless");
        assert.match(result.content[0].text, /currently supported only for pane-Pi subagents/i);
        assert.deepEqual(result.details, {
          error: "headless interrupt unsupported",
          id: "a1",
          name: "Worker",
        });
      } finally {
        map.clear();
      }
    });

    it("leaves statusState.currentKind unchanged when Escape delivery fails", () => {
      const map = getRunningMap();
      map.clear();

      const activeState = observeStatus(
        createStatusState({ source: "pi", startTimeMs: 0 }),
        {
          snapshot: "present",
          updatedAt: 5_000,
          sequence: 1,
          phase: "active",
          active: true,
          activeScope: "tool",
          activeSince: 5_000,
          activityLabel: "bash",
        },
        5_000,
      );

      try {
        map.set("a1", makeRunning({ statusState: activeState }));

        const result = __test__.handleSubagentInterrupt({ name: "Worker" }, () => {
          throw new Error("mux write failed");
        });

        assert.match(result.content[0].text, /Failed to send Escape/);
        const state = map.get("a1")!.statusState!;
        const snapshot = classifyStatus(state, 20_000);
        assert.equal(snapshot.kind, "active", "status should remain active after failed escape");
      } finally {
        map.clear();
      }
    });

    it("sends Escape every time for repeated interrupt calls; entry is not removed", () => {
      const map = getRunningMap();
      map.clear();
      const surfaces: string[] = [];
      try {
        map.set("a1", makeRunning());
        __test__.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
          surfaces.push(surface);
        });
        __test__.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
          surfaces.push(surface);
        });
        assert.deepEqual(surfaces, ["pane-1", "pane-1"]);
        assert.equal(map.has("a1"), true, "entry should still be in map");
      } finally {
        map.clear();
      }
    });

    it("refreshes activity snapshot before forcing interrupt; observeRunningSubagent is called", () => {
      const map = getRunningMap();
      map.clear();
      const dir = getTmpDir();

      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const activityFile = getSubagentActivityFile(dir, "a1");
      const activity = {
        version: 1,
        runningChildId: "a1",
        createdAt: 1_000,
        updatedAt: 19_000,
        sequence: 7,
        latestEvent: "tool_execution_start",
        phase: "active",
        agentActive: true,
        turnActive: true,
        providerActive: false,
        toolActive: true,
        activeScope: "tool",
        activeSince: 19_000,
        toolName: "bash",
      };
      writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

      try {
        map.set("a1", makeRunning({
          activityFile,
          statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
        }));

        let sentSurface = "";
        __test__.handleSubagentInterrupt({ name: "Worker" }, (surface: string) => {
          sentSurface = surface;
        });

        assert.equal(sentSurface, "pane-1");
        const state = map.get("a1")!.statusState!;
        const snapshot = classifyStatus(state, Date.now() + 60_000);
        assert.equal(snapshot.kind, "waiting");
        assert.equal(snapshot.activityLabel, "interrupted");
        assert.equal(state.lastActivitySequence, 7);
      } finally {
        map.clear();
      }
    });

    it("orchestration-owned slot: returns interrupt_requested and does not call registry transitions", () => {
      const map = getRunningMap();
      map.clear();
      __test__.resetRegistry();

      const reg = __test__.getRegistry();

      const orchId = reg.dispatchAsync({
        config: { mode: "serial", tasks: [{ agent: "x", task: "do work" }] },
      });
      reg.onTaskLaunched(orchId, 0, { sessionKey: "worker.jsonl" });

      let terminalCalled = false;
      let blockedCalled = false;
      const origTerminal = reg.onTaskTerminal.bind(reg);
      const origBlocked = reg.onTaskBlocked.bind(reg);
      (reg as any).onTaskTerminal = (...args: any[]) => {
        terminalCalled = true;
        return origTerminal(...args);
      };
      (reg as any).onTaskBlocked = (...args: any[]) => {
        blockedCalled = true;
        return origBlocked(...args);
      };

      try {
        map.set("a1", makeRunning({ sessionFile: "worker.jsonl" }));

        const result = __test__.handleSubagentInterrupt({ name: "Worker" }, () => {});

        assert.equal(result.details?.status, "interrupt_requested");
        assert.equal(terminalCalled, false, "onTaskTerminal should not be called");
        assert.equal(blockedCalled, false, "onTaskBlocked should not be called");
      } finally {
        map.clear();
        __test__.resetRegistry();
        (reg as any).onTaskTerminal = origTerminal;
        (reg as any).onTaskBlocked = origBlocked;
      }
    });
  });
});
