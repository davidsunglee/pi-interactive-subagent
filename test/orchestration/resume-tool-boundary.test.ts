// test/orchestration/resume-tool-boundary.test.ts
//
// Step 12.2a: Tool-boundary tests for the extended subagent_resume handler.
// Tests cover:
//   1. XOR: neither provided → isError: true
//   2. XOR: both provided → isError: true
//   3. sessionPath + real empty file → routes terminal to onResumeTerminal
//   4. sessionId + registry-seeded Claude block → routes terminal to onResumeTerminal
//   5. sessionId + ping result → routes to onTaskBlocked (recursion)
//   6. Unowned sessionPath + real empty file → handler succeeds; registry unchanged

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension, { __test__ } from "../../pi-extension/subagents/index.ts";

// Minimal SubagentResult-shaped stub for terminal outcomes.
// The resume handler reads result.ping, result.exitCode, result.error,
// result.elapsed, result.summary. The required SubagentResult fields
// name/task/transcriptPath are included to satisfy the TypeScript type.
function makeTerminalResult(overrides: {
  exitCode?: number;
  error?: string;
  summary?: string;
} = {}) {
  return {
    name: "stub",
    task: "stub-task",
    transcriptPath: null as string | null,
    exitCode: overrides.exitCode ?? 0,
    error: overrides.error,
    ping: undefined as undefined | { name: string; message: string },
    elapsed: 0.01,
    summary: overrides.summary,
  };
}

// Minimal ping SubagentResult-shaped stub.
function makePingResult(pingName: string, pingMessage: string) {
  return {
    name: "stub",
    task: "stub-task",
    transcriptPath: null as string | null,
    exitCode: 0,
    error: undefined as string | undefined,
    ping: { name: pingName, message: pingMessage },
    elapsed: 0.01,
    summary: undefined as string | undefined,
  };
}

function makeFakePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sentMessages: Array<{ message: any; opts?: any }> = [];
  return {
    tools,
    commands,
    sentMessages,
    api: {
      registerTool(spec: any) { tools.set(spec.name, spec); },
      registerCommand(name: string, spec: any) { commands.set(name, spec); },
      registerMessageRenderer() {},
      sendUserMessage() {},
      sendMessage(message: any, opts?: any) { sentMessages.push({ message, opts }); },
      on() {},
    },
  };
}

function makeCtx(dir: string) {
  return {
    sessionManager: {
      getSessionFile: () => join(dir, "parent.jsonl"),
      getSessionId: () => "test-parent-session",
      getSessionDir: () => dir,
    },
    cwd: dir,
  };
}

describe("subagent_resume tool boundary", () => {
  let scratchDir: string;
  let ownedPath: string;
  let strayPath: string;
  let fake: ReturnType<typeof makeFakePi>;
  let resumeTool: any;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "resume-boundary-"));
    ownedPath = join(scratchDir, "owned.jsonl");
    strayPath = join(scratchDir, "stray.jsonl");
    writeFileSync(ownedPath, "", "utf8");
    writeFileSync(strayPath, "", "utf8");

    // Build a fresh fake pi and call subagentsExtension to register all tools.
    fake = makeFakePi();
    subagentsExtension(fake.api as any);

    // Enable mux so we don't short-circuit on isMuxAvailable().
    __test__.setMuxAvailableOverride(true);

    // Stub createSurface and sendLongCommand to avoid real IO.
    __test__.setSurfaceOverrides({
      createSurface: () => "test-surface",
      sendLongCommand: () => {},
    });

    resumeTool = fake.tools.get("subagent_resume");
    assert.ok(resumeTool, "subagent_resume must be registered");
  });

  afterEach(() => {
    __test__.setMuxAvailableOverride(null);
    __test__.setSurfaceOverrides(null);
    __test__.setWatchSubagentOverride(null);
    __test__.resetRegistry();
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("XOR: neither sessionPath nor sessionId → isError: true", async () => {
    const result = await resumeTool.execute(
      "tc-1",
      { name: "Test" },
      new AbortController().signal,
      () => {},
      makeCtx(scratchDir),
    );
    assert.equal(result.isError, true, "should return isError when neither param provided");
    assert.match(result.content[0].text, /sessionPath.*sessionId|sessionId.*sessionPath/i);
  });

  it("XOR: both sessionPath and sessionId → isError: true", async () => {
    const result = await resumeTool.execute(
      "tc-2",
      { sessionPath: ownedPath, sessionId: "some-claude-id", name: "Test" },
      new AbortController().signal,
      () => {},
      makeCtx(scratchDir),
    );
    assert.equal(result.isError, true, "should return isError when both params provided");
    assert.match(result.content[0].text, /sessionPath.*sessionId|sessionId.*sessionPath/i);
  });

  it("sessionPath + orch-owned → watcher terminal routes to onResumeTerminal and updates registry", async () => {
    // Seed registry: dispatch an orch, launch task 0 with ownedPath, block it.
    const registry = __test__.getRegistry();
    const orchId = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "step-a", agent: "x", task: "t0" }] },
    });
    registry.onTaskLaunched(orchId, 0, { sessionKey: ownedPath });
    registry.onTaskBlocked(orchId, 0, { sessionKey: ownedPath, message: "blocked" });

    assert.equal(registry.lookupOwner(ownedPath)?.orchestrationId, orchId,
      "ownership must be registered before resume");

    // Stub watcher to return a terminal result immediately.
    __test__.setWatchSubagentOverride(async (_running: any, _signal: any) => makeTerminalResult());

    const ctx = makeCtx(scratchDir);
    const result = await resumeTool.execute(
      "tc-3",
      { sessionPath: ownedPath, name: "Test" },
      new AbortController().signal,
      () => {},
      ctx,
    );

    // Handler should return "started" status, not an error.
    assert.equal(result.details?.status, "started");
    assert.ok(!result.isError, "should not be an error result");

    // Give the fire-and-forget watcher time to complete.
    await new Promise((r) => setTimeout(r, 50));

    // The task should have been re-ingested as "completed".
    const snap = registry.getSnapshot(orchId);
    assert.ok(snap, "snapshot must exist");
    assert.equal(snap!.tasks[0].state, "completed",
      `task should be completed after re-ingestion; got ${snap!.tasks[0].state}`);
  });

  it("sessionId + registry-seeded Claude block → terminal routes to onResumeTerminal", async () => {
    const claudeId = "claude-sess-xyz789";

    // Seed registry: dispatch an orch, bind Claude session key, block it.
    const registry = __test__.getRegistry();
    const orchId = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "claude-task", agent: "claude-agent", task: "t1" }] },
    });
    registry.onTaskLaunched(orchId, 0, {});
    registry.updateSessionKey(orchId, 0, claudeId);
    registry.onTaskBlocked(orchId, 0, { sessionKey: claudeId, message: "claude needs input" });

    assert.equal(registry.lookupOwner(claudeId)?.orchestrationId, orchId,
      "Claude session key ownership must be registered");

    // Stub watcher to return terminal immediately (no summary → triggers fallback message).
    __test__.setWatchSubagentOverride(async (_running: any, _signal: any) =>
      makeTerminalResult(),
    );

    const ctx = makeCtx(scratchDir);
    const result = await resumeTool.execute(
      "tc-4",
      { sessionId: claudeId, name: "Claude Resume" },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.equal(result.details?.status, "started");
    assert.ok(!result.isError);

    // Wait for async completion.
    await new Promise((r) => setTimeout(r, 50));

    const snap = registry.getSnapshot(orchId);
    assert.ok(snap);
    assert.equal(snap!.tasks[0].state, "completed",
      `Claude task should be completed after re-ingestion; got ${snap!.tasks[0].state}`);
    assert.equal(snap!.tasks[0].finalMessage, "Resumed Claude session exited",
      "finalMessage should reflect Claude terminal default when watcher provides no summary");
  });

  it("sessionId + ping result → routes to onTaskBlocked (ping re-block)", async () => {
    const claudeId = "claude-sess-ping-test";

    // Seed registry: dispatch + launch + block.
    const registry = __test__.getRegistry();
    const orchId = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "ping-task", agent: "x", task: "t2" }] },
    });
    registry.onTaskLaunched(orchId, 0, {});
    registry.updateSessionKey(orchId, 0, claudeId);
    registry.onTaskBlocked(orchId, 0, { sessionKey: claudeId, message: "first block" });

    // Stub watcher to return a ping result.
    __test__.setWatchSubagentOverride(async (_running: any, _signal: any) =>
      makePingResult("ping-task", "need more info"),
    );

    const ctx = makeCtx(scratchDir);
    await resumeTool.execute(
      "tc-5",
      { sessionId: claudeId, name: "Ping Resume" },
      new AbortController().signal,
      () => {},
      ctx,
    );

    // Wait for the async watcher to complete.
    await new Promise((r) => setTimeout(r, 50));

    // The ping path should have re-blocked the task.
    const snap = registry.getSnapshot(orchId);
    assert.ok(snap);
    assert.equal(snap!.tasks[0].state, "blocked",
      `task should be re-blocked after ping; got ${snap!.tasks[0].state}`);

    // A subagent_ping steer message should have been sent.
    const pingMsg = fake.sentMessages.find((m) => m.message?.customType === "subagent_ping");
    assert.ok(pingMsg, "subagent_ping steer message must be sent on ping result");
    assert.match(pingMsg.message.content, /need more info/);
  });

  it("unowned sessionPath + empty file → handler succeeds; registry unchanged", async () => {
    // strayPath exists but is NOT registered in the registry.
    const registry = __test__.getRegistry();

    // Stub watcher to return terminal result.
    __test__.setWatchSubagentOverride(async (_running: any, _signal: any) => makeTerminalResult());

    const ctx = makeCtx(scratchDir);
    const result = await resumeTool.execute(
      "tc-6",
      { sessionPath: strayPath, name: "Stray" },
      new AbortController().signal,
      () => {},
      ctx,
    );

    // Should succeed (not an error).
    assert.equal(result.details?.status, "started");
    assert.ok(!result.isError, "unowned resume should not be an error");

    // Wait for the watcher to complete.
    await new Promise((r) => setTimeout(r, 50));

    // Registry should have no active orchestrations.
    const active = registry.listActive();
    assert.equal(active.length, 0, "registry should have no active orchestrations for unowned resume");

    // A subagent_result steer message should still be sent.
    const resultMsg = fake.sentMessages.find((m) => m.message?.customType === "subagent_result");
    assert.ok(resultMsg, "subagent_result steer message must be sent even for unowned resume");
  });
});
