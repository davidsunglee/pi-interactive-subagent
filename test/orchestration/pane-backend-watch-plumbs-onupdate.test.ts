import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makePaneBackend } from "../../pi-extension/subagents/backends/pane.ts";
import type { RunningSubagent } from "../../pi-extension/subagents/index.ts";
import type { BackendResult } from "../../pi-extension/subagents/backends/types.ts";

function makeFakeCtx() {
  return {
    sessionManager: {
      getSessionFile: () => "/tmp/parent.jsonl",
      getSessionId: () => "parent",
      getSessionDir: () => "/tmp",
    } as any,
    cwd: "/tmp",
  };
}

const fakeTranscript = [
  { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
];
const fakeUsage = {
  input: 100,
  output: 50,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0.001,
  contextTokens: 150,
  turns: 1,
};

describe("pane backend watch() plumbs onUpdate, transcript, usage", () => {
  it("forwards onUpdate partials with transcript and usage from watchSubagent", async () => {
    const fakeRunning: RunningSubagent = {
      id: "test-id",
      name: "TestAgent",
      task: "do stuff",
      backend: "pane",
      startTime: Date.now(),
      sessionFile: "/tmp/session.jsonl",
      cli: undefined,
    };

    const capturedUpdates: Partial<BackendResult>[] = [];

    const backend = makePaneBackend(makeFakeCtx(), {
      launchSubagent: async () => fakeRunning,
      watchSubagent: async (_running, _signal, opts) => {
        opts?.onUpdate?.({
          name: "TestAgent",
          task: "do stuff",
          summary: "in progress",
          transcriptPath: null,
          exitCode: 0,
          elapsed: 0.5,
          transcript: fakeTranscript,
          usage: fakeUsage,
        });
        return {
          name: "TestAgent",
          task: "do stuff",
          summary: "done",
          transcriptPath: "/tmp/session.jsonl",
          exitCode: 0,
          elapsed: 1.5,
          transcript: fakeTranscript,
          usage: fakeUsage,
        };
      },
    });

    const handle = await backend.launch({ name: "TestAgent", task: "do stuff" }, false);
    const result = await backend.watch(handle, undefined, (partial) => {
      capturedUpdates.push(partial);
    });

    // onUpdate was forwarded with transcript and usage
    assert.ok(capturedUpdates.length >= 1, "expected at least one onUpdate call");
    const lastUpdate = capturedUpdates.at(-1)!;
    assert.ok(lastUpdate.transcript, "onUpdate partial should include transcript");
    assert.equal(lastUpdate.transcript!.length, 1);
    assert.equal(lastUpdate.transcript![0].role, "assistant");
    assert.ok(lastUpdate.usage, "onUpdate partial should include usage");
    assert.equal(lastUpdate.usage!.turns, 1);
    assert.equal(lastUpdate.usage!.input, 100);

    // Final resolved result includes transcript and usage
    assert.ok(result.transcript, "final BackendResult should include transcript");
    assert.equal(result.transcript!.length, 1);
    assert.ok(result.usage, "final BackendResult should include usage");
    assert.equal(result.usage!.turns, 1);
    assert.equal(result.usage!.input, 100);

    // Core BackendResult fields are correct
    assert.equal(result.name, "TestAgent");
    assert.equal(result.finalMessage, "done");
    assert.equal(result.exitCode, 0);
    assert.equal(result.elapsedMs, 1500);
    assert.equal(result.transcriptPath, "/tmp/session.jsonl");
  });

  it("onUpdate partial includes ping, error, sessionId, sessionKey fields", async () => {
    const fakeRunning: RunningSubagent = {
      id: "test-id-2",
      name: "PingAgent",
      task: "ping task",
      backend: "pane",
      startTime: Date.now(),
      sessionFile: "/tmp/session2.jsonl",
      cli: "claude",
      sentinelFile: "/tmp/sentinel2",
    };

    const capturedUpdates: Partial<BackendResult>[] = [];

    const backend = makePaneBackend(makeFakeCtx(), {
      launchSubagent: async () => fakeRunning,
      watchSubagent: async (_running, _signal, opts) => {
        opts?.onUpdate?.({
          name: "PingAgent",
          task: "ping task",
          summary: "",
          transcriptPath: null,
          exitCode: 0,
          elapsed: 0,
          transcript: fakeTranscript,
          usage: fakeUsage,
          ping: { name: "PingAgent", message: "still alive" },
          claudeSessionId: "claude-sess-123",
          error: undefined,
        });
        return {
          name: "PingAgent",
          task: "ping task",
          summary: "complete",
          transcriptPath: null,
          exitCode: 0,
          elapsed: 2,
          transcript: fakeTranscript,
          usage: fakeUsage,
          claudeSessionId: "claude-sess-123",
        };
      },
    });

    const handle = await backend.launch({ name: "PingAgent", task: "ping task", cli: "claude" }, false);
    const result = await backend.watch(handle, undefined, (partial) => {
      capturedUpdates.push(partial);
    });

    assert.ok(capturedUpdates.length >= 1);
    const update = capturedUpdates[0];
    assert.deepEqual(update.ping, { name: "PingAgent", message: "still alive" });
    assert.ok(update.transcript);
    assert.ok(update.usage);

    // Claude: sessionKey should be claudeSessionId
    assert.equal(result.sessionId, "claude-sess-123");
    assert.equal(result.sessionKey, "claude-sess-123");
    assert.ok(result.transcript);
    assert.ok(result.usage);
  });
});
