// test/orchestration/resume-artifact.test.ts
//
// Task 8: blocked-then-resumed orchestration tasks must have artifactPath
// populated on the merged tombstone, and the emitted orchestration_complete
// payload must carry both finalMessage and artifactPath (strip happens after
// emit).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension, { __test__ } from "../../pi-extension/subagents/index.ts";

const SUMMARY = "resumed body — multi-line\nfinding 1\nfinding 2";

function makeFakePi() {
  const tools: any[] = [];
  const sent: any[] = [];
  return {
    tools,
    sent,
    api: {
      registerTool: (t: any) => tools.push(t),
      on() {},
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage(msg: any) { sent.push(msg); },
      sendUserMessage() {},
    },
  };
}

describe("subagent_resume writes artifact for blocked-then-resumed orchestration task (Task 8)", () => {
  let tools: any[];
  let sent: any[];
  let scratch: string;

  beforeEach(() => {
    __test__.resetRegistry();
    const fake = makeFakePi();
    subagentsExtension(fake.api as any);
    tools = fake.tools;
    sent = fake.sent;
    scratch = mkdtempSync(join(tmpdir(), "resume-artifact-"));

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

  it("writes artifact and populates artifactPath on tombstone after successful resume (Claude branch)", async () => {
    const claudeId = "claude-resume-artifact-test";

    __test__.setWatchSubagentOverride(async () => ({
      name: "a",
      task: "t",
      summary: SUMMARY,
      transcriptPath: null,
      exitCode: 0,
      elapsed: 1,
      claudeSessionId: claudeId,
    }) as any);

    const registry = __test__.getRegistry();
    const orchId = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    registry.onTaskLaunched(orchId, 0, {});
    registry.updateSessionKey(orchId, 0, claudeId);
    registry.onTaskBlocked(orchId, 0, { sessionKey: claudeId, message: "waiting" });

    const resume = tools.find((t) => t.name === "subagent_resume");
    assert.ok(resume, "subagent_resume tool must be registered");

    await resume.execute(
      "c-claude",
      { sessionId: claudeId, message: "continue" },
      new AbortController().signal,
      () => {},
      {
        sessionManager: {
          getSessionFile: () => join(scratch, "parent.jsonl"),
          getSessionId: () => "parent-session",
          getSessionDir: () => scratch,
        },
        cwd: scratch,
      },
    );

    // Allow the fire-and-forget watcher to complete and re-ingest.
    await new Promise((r) => setTimeout(r, 50));

    const snap = registry.getSnapshot(orchId);
    assert.ok(snap, "registry must retain a snapshot after finalization");

    // (1) Tombstone carries artifactPath pointing to a file with the resumed summary byte-for-byte.
    const artifactPath = snap!.tasks[0].artifactPath;
    assert.ok(
      typeof artifactPath === "string" && artifactPath.length > 0,
      `artifactPath must be a non-empty string, got: ${String(artifactPath)}`,
    );
    assert.ok(
      artifactPath!.endsWith(`/orchestrations/${orchId}/task-0.md`),
      `artifactPath must end with /orchestrations/${orchId}/task-0.md, got: ${artifactPath}`,
    );
    const written = readFileSync(artifactPath!, "utf8");
    assert.equal(written, SUMMARY, "artifact file content must equal the resumed summary byte-for-byte");

    // (2) After tryFinalize strips finalMessage (Task 7), tombstone should not carry finalMessage.
    assert.equal(
      snap!.tasks[0].finalMessage,
      undefined,
      "tombstone must drop finalMessage once artifactPath is set (Task 7 strip)",
    );

    // (3) Emitted orchestration_complete payload still carries both finalMessage AND artifactPath
    //     (emit happens before strip).
    const completeMsg = sent.find((m) => m.customType === "orchestration_complete");
    assert.ok(completeMsg, "orchestration_complete steer must have been sent");
    const emittedTask = completeMsg.details.results[0];
    assert.equal(
      emittedTask.finalMessage,
      SUMMARY,
      "emitted payload must retain finalMessage (strip happens after emit)",
    );
    assert.equal(
      emittedTask.artifactPath,
      artifactPath,
      "emitted payload must carry artifactPath",
    );
  });

  it("produces artifactPath: null when resumed summary is empty", async () => {
    const claudeId = "claude-resume-empty-summary";

    __test__.setWatchSubagentOverride(async () => ({
      name: "a",
      task: "t",
      summary: "",
      transcriptPath: null,
      exitCode: 0,
      elapsed: 1,
      claudeSessionId: claudeId,
    }) as any);

    const registry = __test__.getRegistry();
    const orchId = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    registry.onTaskLaunched(orchId, 0, {});
    registry.updateSessionKey(orchId, 0, claudeId);
    registry.onTaskBlocked(orchId, 0, { sessionKey: claudeId, message: "waiting" });

    const resume = tools.find((t) => t.name === "subagent_resume");
    await resume.execute(
      "c-claude-empty",
      { sessionId: claudeId, message: "continue" },
      new AbortController().signal,
      () => {},
      {
        sessionManager: {
          getSessionFile: () => join(scratch, "parent.jsonl"),
          getSessionId: () => "parent-session",
          getSessionDir: () => scratch,
        },
        cwd: scratch,
      },
    );

    await new Promise((r) => setTimeout(r, 50));

    const snap = registry.getSnapshot(orchId);
    assert.ok(snap);
    assert.equal(
      snap!.tasks[0].artifactPath ?? null,
      null,
      "empty resumed summary must produce artifactPath: null",
    );
  });

  it("uses owner.taskIndex (not 0) as the artifact task index", async () => {
    // A 3-step serial where only task 2 (index 2) blocks. Proves the path
    // uses the original orchestration task index, not a local 0.
    const claudeId = "claude-task-index-test";
    const TASK2_SUMMARY = "task-2 body";

    __test__.setWatchSubagentOverride(async () => ({
      name: "c",
      task: "t",
      summary: TASK2_SUMMARY,
      transcriptPath: null,
      exitCode: 0,
      elapsed: 1,
      claudeSessionId: claudeId,
    }) as any);

    const registry = __test__.getRegistry();
    const orchId = registry.dispatchAsync({
      config: {
        mode: "serial",
        tasks: [
          { name: "a", agent: "x", task: "t" },
          { name: "b", agent: "x", task: "t" },
          { name: "c", agent: "x", task: "t" },
        ],
      },
    });
    // Simulate tasks 0 and 1 completing, task 2 blocking.
    registry.onTaskLaunched(orchId, 0, {});
    registry.onTaskTerminal(orchId, 0, {
      name: "a", index: 0, state: "completed", exitCode: 0, elapsedMs: 1,
    });
    registry.onTaskLaunched(orchId, 1, {});
    registry.onTaskTerminal(orchId, 1, {
      name: "b", index: 1, state: "completed", exitCode: 0, elapsedMs: 1,
    });
    registry.onTaskLaunched(orchId, 2, {});
    registry.updateSessionKey(orchId, 2, claudeId);
    registry.onTaskBlocked(orchId, 2, { sessionKey: claudeId, message: "waiting on task 2" });

    const resume = tools.find((t) => t.name === "subagent_resume");
    await resume.execute(
      "c-task-idx",
      { sessionId: claudeId, message: "continue" },
      new AbortController().signal,
      () => {},
      {
        sessionManager: {
          getSessionFile: () => join(scratch, "parent.jsonl"),
          getSessionId: () => "parent-session",
          getSessionDir: () => scratch,
        },
        cwd: scratch,
      },
    );

    await new Promise((r) => setTimeout(r, 50));

    const snap = registry.getSnapshot(orchId);
    assert.ok(snap);
    const artifactPath = snap!.tasks[2].artifactPath;
    assert.ok(
      typeof artifactPath === "string",
      "task-2 must have an artifactPath after resume",
    );
    assert.ok(
      artifactPath!.endsWith(`/orchestrations/${orchId}/task-2.md`),
      `artifact must use original task index (task-2.md), got: ${artifactPath}`,
    );
    const content = readFileSync(artifactPath!, "utf8");
    assert.equal(content, TASK2_SUMMARY, "artifact must contain task-2 summary byte-for-byte");
  });
});
