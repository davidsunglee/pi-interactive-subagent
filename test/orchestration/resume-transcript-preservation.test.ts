// test/orchestration/resume-transcript-preservation.test.ts
//
// Review-v1 finding #3: subagent_resume re-ingestion must preserve the
// transcriptPath produced by watchSubagent. Hard-coding null erases the
// archived Claude transcript path (and the pi session path on the pi branch),
// weakening the orchestration result envelope across resume.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("subagent_resume preserves transcriptPath in registry.onResumeTerminal (review-v1 #3)", () => {
  let tools: any[];
  let scratch: string;

  beforeEach(() => {
    __test__.resetRegistry();
    const fake = makeFakePi();
    subagentsExtension(fake.api as any);
    tools = fake.tools;
    scratch = mkdtempSync(join(tmpdir(), "resume-transcript-"));

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

  it("Claude resume: archived transcriptPath survives re-ingestion into the orchestration result", async () => {
    const claudeId = "claude-sess-transcript";
    const archivedPath = join(scratch, "claude-archive", "claude-sess-transcript.jsonl");

    __test__.setWatchSubagentOverride(async () => ({
      name: "n", task: "t", summary: "ok",
      transcriptPath: archivedPath, // watchSubagent already discovered it
      exitCode: 0, elapsed: 1, claudeSessionId: claudeId,
    }) as any);

    const registry = __test__.getRegistry();
    const orchId = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    registry.onTaskLaunched(orchId, 0, {});
    registry.updateSessionKey(orchId, 0, claudeId);
    registry.onTaskBlocked(orchId, 0, { sessionKey: claudeId, message: "?" });

    const resume = tools.find((t) => t.name === "subagent_resume");
    assert.ok(resume);
    await resume.execute(
      "c-claude",
      { sessionId: claudeId, message: "go" },
      new AbortController().signal,
      () => {},
      {
        sessionManager: {
          getSessionFile: () => "/tmp/parent.jsonl",
          getSessionId: () => "parent-session",
          getSessionDir: () => "/tmp",
        },
        cwd: "/tmp",
      },
    );

    // Let the fire-and-forget watcher complete + re-ingest.
    await new Promise((r) => setTimeout(r, 50));

    const snap = registry.getSnapshot(orchId);
    assert.ok(snap);
    assert.equal(snap!.tasks[0].state, "completed");
    assert.equal(
      snap!.tasks[0].transcriptPath,
      archivedPath,
      "Claude resume must preserve the archived transcript path discovered by watchSubagent.",
    );
  });

  it("pi resume: session path survives re-ingestion as transcriptPath", async () => {
    const sessionPath = join(scratch, "pi-session.jsonl");
    writeFileSync(sessionPath, '{"role":"assistant","content":"hi"}\n', "utf8");

    __test__.setWatchSubagentOverride(async () => ({
      name: "n", task: "t", summary: "ok",
      transcriptPath: sessionPath, // pi watch sets transcriptPath = sessionFile
      exitCode: 0, elapsed: 1,
    }) as any);

    const registry = __test__.getRegistry();
    const orchId = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    registry.onTaskLaunched(orchId, 0, { sessionKey: sessionPath });
    registry.onTaskBlocked(orchId, 0, { sessionKey: sessionPath, message: "?" });

    const resume = tools.find((t) => t.name === "subagent_resume");
    assert.ok(resume);
    await resume.execute(
      "c-pi",
      { sessionPath, message: "go" },
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

    await new Promise((r) => setTimeout(r, 50));

    const snap = registry.getSnapshot(orchId);
    assert.ok(snap);
    assert.equal(snap!.tasks[0].state, "completed");
    assert.equal(
      snap!.tasks[0].transcriptPath,
      sessionPath,
      "pi resume must preserve the session path as transcriptPath in the orchestration result.",
    );
  });
});
