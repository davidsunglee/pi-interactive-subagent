// test/orchestration/pane-resume-tail-offset.test.ts
//
// Task 8: verify that subagent_resume passes tailStartLine = entryCountBefore
// to the watcher, that the watcher result's transcript is forwarded in the
// terminal subagent_result.details, and that the orchestration registry receives
// transcript/usage on re-ingestion.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension, { __test__ } from "../../pi-extension/subagents/index.ts";

function makeFakePi() {
  const tools: any[] = [];
  const sentMessages: any[] = [];
  return {
    tools,
    sentMessages,
    api: {
      registerTool: (t: any) => tools.push(t),
      on() {}, registerCommand() {}, registerMessageRenderer() {},
      sendMessage(message: any, opts?: any) { sentMessages.push({ message, opts }); },
      sendUserMessage() {},
    },
  };
}

function makeSessionEntry(role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    type: "message",
    id: `msg-${Math.random().toString(16).slice(2)}`,
    message: { role, content: [{ type: "text", text }] },
  }) + "\n";
}

describe("pane resume tail-offset wiring (Task 8)", () => {
  let fake: ReturnType<typeof makeFakePi>;
  let scratch: string;

  beforeEach(() => {
    __test__.resetRegistry();
    fake = makeFakePi();
    subagentsExtension(fake.api as any);
    scratch = mkdtempSync(join(tmpdir(), "resume-tail-offset-"));

    __test__.setMuxAvailableOverride(true);
    __test__.setSurfaceOverrides({
      createSurface: () => "test-surface",
      sendLongCommand: () => {},
    });
  });

  afterEach(() => {
    __test__.setMuxAvailableOverride(null);
    __test__.setSurfaceOverrides(null);
    __test__.setWatchSubagentOverride(null);
    __test__.resetRegistry();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("passes tailStartLine = pre-existing entry count to the watcher and forwards transcript/usage in subagent_result.details", async () => {
    // Create session file with 3 pre-existing entries.
    const sessionPath = join(scratch, "pi-session.jsonl");
    writeFileSync(
      sessionPath,
      makeSessionEntry("user", "old-1") +
      makeSessionEntry("assistant", "old-2") +
      makeSessionEntry("user", "old-3"),
      "utf8",
    );

    let capturedTailStartLine: number | undefined;

    const newTranscript = [
      { role: "user" as const, content: [{ type: "text" as const, text: "new-user" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "new-assistant" }] },
    ];
    const newUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 100, turns: 1 };

    __test__.setWatchSubagentOverride(async (_running: any, _signal: AbortSignal, opts?: { tailStartLine?: number }) => {
      capturedTailStartLine = opts?.tailStartLine;
      return {
        name: "n",
        task: "t",
        summary: "done",
        transcriptPath: sessionPath,
        exitCode: 0,
        elapsed: 1,
        transcript: newTranscript,
        usage: newUsage,
      } as any;
    });

    const registry = __test__.getRegistry();
    const orchId = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    registry.onTaskLaunched(orchId, 0, { sessionKey: sessionPath });
    registry.onTaskBlocked(orchId, 0, { sessionKey: sessionPath, message: "?" });

    const resume = fake.tools.find((t) => t.name === "subagent_resume");
    assert.ok(resume, "subagent_resume tool must be registered");

    await resume.execute(
      "c-pi",
      { sessionPath, message: "continue" },
      new AbortController().signal,
      () => {},
      {
        sessionManager: {
          getSessionFile: () => "/tmp/parent.jsonl",
          getSessionId: () => "parent-session",
          getSessionDir: () => scratch,
        },
        cwd: scratch,
      },
    );

    // Wait for the fire-and-forget watcher to complete and re-ingest.
    await new Promise((r) => setTimeout(r, 50));

    // 1. Watcher must have received tailStartLine = 3 (number of pre-existing entries).
    assert.equal(
      capturedTailStartLine,
      3,
      "watcher opts.tailStartLine must equal the pre-existing entry count (3)",
    );

    // 2. Terminal subagent_result.details must include transcript and usage.
    const resultMsg = fake.sentMessages.find((m) => m.message?.customType === "subagent_result");
    assert.ok(resultMsg, "a subagent_result steer message must be sent");
    const details = resultMsg.message.details;
    assert.ok(details.transcript, "subagent_result.details must include transcript");
    assert.equal(
      details.transcript.length,
      2,
      "forwarded transcript must have 2 entries (the two new ones from the watcher)",
    );
    assert.deepEqual(details.transcript, newTranscript, "forwarded transcript must match watcher result");
    assert.ok(details.usage, "subagent_result.details must include usage");
    assert.equal(details.usage.turns, 1);

    // 3. Orchestration task must reach completed state.
    const snap = registry.getSnapshot(orchId);
    assert.ok(snap, "registry snapshot must exist");
    assert.equal(snap!.tasks[0].state, "completed");
  });
});
