// test/orchestration/claude-resume-branch.test.ts
//
// Step 14.2d: Non-seamed coverage of the Claude sessionId resume branch.
// Tests that the real subagent_resume.execute Claude branch:
//   1. Constructs a RunningSubagent with cli="claude" and a sentinelFile
//   2. Builds a command containing --resume <sessionId>
//   3. Routes registry ownership through the input sessionId for re-ingestion

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import subagentsExtension, { __test__ } from "../../pi-extension/subagents/index.ts";

function makeFakePi() {
  const tools: any[] = [];
  return {
    tools,
    api: {
      registerTool: (t: any) => tools.push(t),
      on() {}, registerCommand() {}, registerMessageRenderer() {},
      sendMessage() {}, sendUserMessage() {},
    },
  };
}

describe("subagent_resume Claude sessionId branch (non-seamed construction)", () => {
  let tools: any[];

  beforeEach(() => {
    __test__.resetRegistry();
    const fake = makeFakePi();
    subagentsExtension(fake.api as any);
    tools = fake.tools;

    __test__.setMuxAvailableOverride(true);
    // Surface seam: stub createSurface + sendLongCommand so no real mux pane is opened.
    // The Claude branch's RunningSubagent is still constructed and registered.
    __test__.setSurfaceOverrides({
      createSurface: () => "test-surface-claude",
      sendLongCommand: () => {},
    });
    // Watcher seam: prevent fire-and-forget watchSubagent from touching real files.
    // The test asserts on the constructed RunningSubagent before the watcher runs.
    __test__.setWatchSubagentOverride(async () => ({
      name: "stub",
      task: "stub-task",
      transcriptPath: null,
      exitCode: 0,
      elapsed: 0,
      ping: undefined,
      summary: "done",
    }) as any);
  });

  afterEach(() => {
    __test__.setMuxAvailableOverride(null);
    __test__.setSurfaceOverrides(null);
    __test__.setWatchSubagentOverride(null);
    __test__.resetRegistry();
  });

  it("constructs a Claude-shaped RunningSubagent with cli='claude', a sentinelFile, and a --resume argv", async () => {
    const claudeId = "claude-sess-resumed-xyz";
    const resume = tools.find((t) => t.name === "subagent_resume");
    assert.ok(resume, "subagent_resume must be registered");

    // Snapshot runningSubagents before to detect the newly added entry
    const before = new Set(__test__.getRunningSubagents().keys());

    await resume.execute(
      "c-claude",
      { sessionId: claudeId, message: "go" },
      new AbortController().signal,
      () => {},
      {
        sessionManager: {
          getSessionFile: () => "/tmp/fake-parent.jsonl",
          getSessionId: () => "parent-session",
          getSessionDir: () => "/tmp",
        },
        cwd: "/tmp",
      },
    );

    // Find the newly registered RunningSubagent
    const after = __test__.getRunningSubagents();
    const newKeys = [...after.keys()].filter((k) => !before.has(k));
    assert.ok(newKeys.length > 0, "a new RunningSubagent must have been registered");
    const last = after.get(newKeys[newKeys.length - 1])!;

    // 1. cli must be "claude"
    assert.equal(last.cli, "claude",
      `RunningSubagent.cli must be "claude", got ${last.cli}`);

    // 2. sentinelFile must match the expected pattern
    assert.ok(
      last.sentinelFile && /^\/tmp\/pi-claude-[0-9a-f]+-done$/.test(last.sentinelFile),
      `sentinelFile must match /tmp/pi-claude-<hex>-done, got: ${last.sentinelFile}`,
    );

    // 3. The launch command must contain --resume <claudeId>
    const lastCmd = __test__.getLastLaunchCommand();
    assert.ok(lastCmd, "getLastLaunchCommand must return the recorded command");
    assert.ok(
      lastCmd.includes(`--resume ${claudeId}`) || lastCmd.includes(`--resume '${claudeId}'`),
      `command must contain --resume <claudeId>; got: ${lastCmd}`,
    );
  });

  it("registry ownership routes through the input sessionId, not any later-rotated id", async () => {
    const claudeId = "claude-sess-original-id";
    const registry = __test__.getRegistry();

    // Seed the registry with a blocked orchestration owned by claudeId
    const orchId = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    registry.onTaskLaunched(orchId, 0, {});
    registry.updateSessionKey(orchId, 0, claudeId);
    registry.onTaskBlocked(orchId, 0, { sessionKey: claudeId, message: "?" });

    assert.equal(registry.lookupOwner(claudeId)?.orchestrationId, orchId,
      "ownership must be seeded before invoke");

    const resume = tools.find((t) => t.name === "subagent_resume");
    assert.ok(resume, "subagent_resume must be registered");

    await resume.execute(
      "c-claude2",
      { sessionId: claudeId, message: "go" },
      new AbortController().signal,
      () => {},
      {
        sessionManager: {
          getSessionFile: () => "/tmp/fake-parent2.jsonl",
          getSessionId: () => "parent-session2",
          getSessionDir: () => "/tmp",
        },
        cwd: "/tmp",
      },
    );

    // Give the fire-and-forget watcher time to resolve
    await new Promise((r) => setTimeout(r, 50));

    // The watcher stub returned exitCode: 0, no ping → registry.onResumeTerminal must
    // have fired keyed on the input claudeId → task 0 should be "completed"
    const snap = registry.getSnapshot(orchId);
    assert.ok(snap, "snapshot must exist");
    assert.equal(snap!.tasks[0].state, "completed",
      `task 0 should be completed after re-ingestion via sessionId; got ${snap!.tasks[0].state}`);
  });
});
