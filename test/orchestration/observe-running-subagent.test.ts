import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { observeRunningSubagent, __test__ } from "../../pi-extension/subagents/index.ts";
import { createStatusState } from "../../pi-extension/subagents/status.ts";
import type { SubagentActivityState } from "../../pi-extension/subagents/activity.ts";
import type { RunningSubagent } from "../../pi-extension/subagents/index.ts";

// ── helpers ────────────────────────────────────────────────────────────────

let tmpDir: string | null = null;

function getTmpDir(): string {
  if (!tmpDir) {
    tmpDir = mkdtempSync(join(tmpdir(), "observe-subagent-test-"));
  }
  return tmpDir;
}

after(() => {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeActivity(id: string, overrides: Partial<SubagentActivityState> = {}): SubagentActivityState {
  return {
    version: 1,
    runningChildId: id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sequence: 1,
    latestEvent: "agent_start",
    phase: "active",
    agentActive: true,
    turnActive: true,
    providerActive: false,
    toolActive: false,
    activeScope: "turn",
    activeSince: Date.now() - 1000,
    ...overrides,
  };
}

function makeRunning(id: string, extra: Partial<RunningSubagent> = {}): RunningSubagent {
  return {
    id,
    name: "TestAgent",
    task: "do stuff",
    backend: "pane",
    startTime: Date.now(),
    statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }),
    ...extra,
  } as RunningSubagent;
}

function writeActivityFile(dir: string, activity: SubagentActivityState): string {
  const actDir = join(dir, "subagent-activity");
  mkdirSync(actDir, { recursive: true });
  const path = join(actDir, `${activity.runningChildId}.json`);
  writeFileSync(path, JSON.stringify(activity), "utf8");
  return path;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("observeRunningSubagent", () => {
  it("skips entries with no statusState", () => {
    const running = makeRunning("no-state-id", { statusState: undefined });
    const before = running.statusState;
    observeRunningSubagent(running);
    assert.equal(running.statusState, before, "statusState should remain unchanged");
  });

  it("skips synthetic blocked virtual rows", () => {
    const running = makeRunning("blocked-id", {
      blocked: { orchestrationId: "orch-1", taskIndex: 0, message: "waiting" },
    });
    const stateBefore = running.statusState;
    observeRunningSubagent(running);
    assert.equal(running.statusState, stateBefore, "blocked row statusState should not change");
  });

  it("skips Claude children", () => {
    const running = makeRunning("claude-id", { cli: "claude" });
    const stateBefore = running.statusState;
    observeRunningSubagent(running);
    assert.equal(running.statusState, stateBefore, "claude child statusState should not change");
  });

  it("handles missing activityFile (no path provided)", () => {
    const running = makeRunning("no-file-id", { activityFile: undefined });
    const stateBefore = running.statusState;
    assert.ok(stateBefore, "should have initial statusState");
    observeRunningSubagent(running);
    // statusState should be updated with 'missing' snapshot observation
    assert.ok(running.statusState, "statusState should still be set");
    assert.equal(running.statusState?.snapshotState, "missing", "snapshotState should be missing");
  });

  it("reads activity file and updates statusState on success", () => {
    const dir = getTmpDir();
    const id = "observe-test-" + Math.random().toString(36).slice(2);
    const activity = makeActivity(id);
    const activityFile = writeActivityFile(dir, activity);

    const running = makeRunning(id, { activityFile });
    observeRunningSubagent(running, Date.now());

    assert.equal(running.activity?.runningChildId, id, "activity should be populated");
    assert.equal(running.statusState?.snapshotState, "present", "snapshotState should be present");
    assert.equal(running.statusState?.phase, "active", "phase should be active");
  });

  it("handles file not found gracefully", () => {
    const running = makeRunning("missing-file-id", {
      activityFile: "/tmp/nonexistent-activity-file-12345.json",
    });
    observeRunningSubagent(running);
    assert.equal(running.statusState?.snapshotState, "missing", "snapshotState should be missing");
    assert.equal(running.activity, undefined, "activity should not be populated");
  });
});

describe("activityLabel helper (via __test__)", () => {
  it("returns undefined for non-active phase", () => {
    const activity = makeActivity("x", { phase: "waiting", activeScope: undefined });
    assert.equal(__test__.activityLabel(activity), undefined);
  });

  it("returns toolName for tool scope", () => {
    const activity = makeActivity("x", { phase: "active", activeScope: "tool", toolName: "Bash" });
    assert.equal(__test__.activityLabel(activity), "Bash");
  });

  it("returns 'tool' when toolName is absent", () => {
    const activity = makeActivity("x", { phase: "active", activeScope: "tool", toolName: undefined });
    assert.equal(__test__.activityLabel(activity), "tool");
  });

  it("returns 'provider' for provider scope", () => {
    const activity = makeActivity("x", { phase: "active", activeScope: "provider" });
    assert.equal(__test__.activityLabel(activity), "provider");
  });

  it("returns 'streaming' for streaming scope", () => {
    const activity = makeActivity("x", { phase: "active", activeScope: "streaming" });
    assert.equal(__test__.activityLabel(activity), "streaming");
  });

  it("returns activeScope for other scopes", () => {
    const activity = makeActivity("x", { phase: "active", activeScope: "turn" });
    assert.equal(__test__.activityLabel(activity), "turn");
  });
});

describe("startStatusRefresh gates on statusConfig.enabled", () => {
  it("does not start interval when enabled is false", () => {
    const prevConfig = __test__.statusConfig;
    __test__.setStatusConfig({ enabled: false, lineLimit: 4 });
    try {
      // Capture globalThis state before
      const keyBefore = (globalThis as any)[Symbol.for("pi-subagents/status-interval")];
      // Call startStatusRefresh with a mock pi
      const mockPi = { sendMessage() {} } as any;
      __test__.startStatusRefresh(mockPi);
      const keyAfter = (globalThis as any)[Symbol.for("pi-subagents/status-interval")];
      // If no interval was started, the key should remain the same (null or unchanged)
      assert.equal(keyAfter, keyBefore, "no interval should start when enabled=false");
    } finally {
      __test__.setStatusConfig(prevConfig);
    }
  });
});
