// test/orchestration/pane-backend-claude-session-key.test.ts
//
// Review-v1 finding #1 (pane-backed Claude tasks record the wrong sessionKey).
// The pane backend must surface the Claude session id (not the unused pi
// `subagentSessionFile` placeholder) as the LaunchedHandle.sessionKey and the
// BackendResult.sessionKey, so the registry's late-bound `updateSessionKey`
// path is the one that wins for Claude pane orchestrations.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makePaneBackend } from "../../pi-extension/subagents/backends/pane.ts";
import type { RunningSubagent } from "../../pi-extension/subagents/index.ts";

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

describe("makePaneBackend Claude sessionKey routing (review-v1 #1)", () => {
  it("Claude launch: LaunchedHandle.sessionKey is omitted (let onSessionKey late-bind it)", async () => {
    let captured: any = null;
    const fakeRunning = {
      id: "id-claude",
      name: "n",
      task: "t",
      backend: "pane",
      startTime: Date.now(),
      sessionFile: "/tmp/should-not-be-the-key.jsonl",
      cli: "claude",
      sentinelFile: "/tmp/sentinel",
    } as RunningSubagent;

    const backend = makePaneBackend(makeFakeCtx(), {
      launchSubagent: async () => fakeRunning,
      watchSubagent: async () => ({
        name: "n", task: "t", summary: "", transcriptPath: null,
        exitCode: 0, elapsed: 0, claudeSessionId: "claude-late-bound",
      }) as any,
    });

    const handle = await backend.launch(
      { name: "n", task: "t", cli: "claude" },
      true,
    );
    captured = handle;

    assert.equal(
      captured.sessionKey,
      undefined,
      "Claude launch must NOT publish a sessionKey at launch time — it is late-bound via onSessionKey.",
    );
  });

  it("Claude watch: BackendResult.sessionKey === sub.claudeSessionId (not the pi placeholder file)", async () => {
    const fakeRunning = {
      id: "id-claude-watch",
      name: "n",
      task: "t",
      backend: "pane",
      startTime: Date.now(),
      sessionFile: "/tmp/should-not-be-the-key.jsonl",
      cli: "claude",
      sentinelFile: "/tmp/sentinel",
    } as RunningSubagent;

    const fired: string[] = [];
    const backend = makePaneBackend(makeFakeCtx(), {
      launchSubagent: async () => fakeRunning,
      watchSubagent: async (_running, _signal, opts) => {
        // Simulate watchSubagent's race-closer: synchronous fire of the Claude id.
        try { opts?.onSessionKey?.("claude-late-bound"); } catch {}
        return {
          name: "n", task: "t", summary: "fin",
          transcriptPath: "/tmp/archive/claude-late-bound.jsonl",
          exitCode: 0, elapsed: 1, claudeSessionId: "claude-late-bound",
        } as any;
      },
    });

    const handle = await backend.launch(
      { name: "n", task: "t", cli: "claude" },
      true,
    );
    const result = await backend.watch(handle, undefined, undefined, {
      onSessionKey: (k) => fired.push(k),
    });

    assert.equal(
      result.sessionKey,
      "claude-late-bound",
      "Claude watch must surface sub.claudeSessionId as sessionKey, not the pi placeholder.",
    );
    assert.deepEqual(
      fired,
      ["claude-late-bound"],
      "onSessionKey hook must propagate the Claude id once watchSubagent learns it.",
    );
  });

  it("pi launch: LaunchedHandle.sessionKey === running.sessionFile (unchanged behavior)", async () => {
    const fakeRunning = {
      id: "id-pi",
      name: "n",
      task: "t",
      backend: "pane",
      startTime: Date.now(),
      sessionFile: "/tmp/pi-session.jsonl",
      cli: undefined, // pi
    } as RunningSubagent;

    const backend = makePaneBackend(makeFakeCtx(), {
      launchSubagent: async () => fakeRunning,
      watchSubagent: async () => ({
        name: "n", task: "t", summary: "", transcriptPath: null,
        exitCode: 0, elapsed: 0,
      }) as any,
    });

    const handle = await backend.launch(
      { name: "n", task: "t" },
      true,
    );
    assert.equal(handle.sessionKey, "/tmp/pi-session.jsonl");
  });

  it("pi watch: BackendResult.sessionKey === running.sessionFile (unchanged behavior)", async () => {
    const fakeRunning = {
      id: "id-pi-watch",
      name: "n",
      task: "t",
      backend: "pane",
      startTime: Date.now(),
      sessionFile: "/tmp/pi-session.jsonl",
      cli: undefined, // pi
    } as RunningSubagent;

    const backend = makePaneBackend(makeFakeCtx(), {
      launchSubagent: async () => fakeRunning,
      watchSubagent: async () => ({
        name: "n", task: "t", summary: "fin",
        transcriptPath: "/tmp/pi-session.jsonl",
        exitCode: 0, elapsed: 1,
      }) as any,
    });

    const handle = await backend.launch({ name: "n", task: "t" }, true);
    const result = await backend.watch(handle);
    assert.equal(result.sessionKey, "/tmp/pi-session.jsonl");
  });
});
