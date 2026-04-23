// test/orchestration/cancel-after-resume.test.ts
//
// Review-v1 finding #2: subagent_run_cancel must abort tasks that are
// currently executing under a standalone subagent_resume. Without this, a
// `blocked -> running (resume)` task keeps writing to disk after the
// orchestration's user-visible state flips to `cancelled`.

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

describe("subagent_run_cancel reaches detached resume sessions (review-v1 #2)", () => {
  let tools: any[];

  beforeEach(() => {
    __test__.resetRegistry();
    const fake = makeFakePi();
    subagentsExtension(fake.api as any);
    tools = fake.tools;

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
  });

  it("cancelling an orchestration aborts the AbortSignal of an in-flight resume watcher", async () => {
    const claudeId = "claude-resume-cancel-target";
    const registry = __test__.getRegistry();

    // Seed: an orchestration with one blocked task owned by `claudeId`.
    const orchId = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    registry.onTaskLaunched(orchId, 0, {});
    registry.updateSessionKey(orchId, 0, claudeId);
    registry.onTaskBlocked(orchId, 0, { sessionKey: claudeId, message: "?" });

    // Watcher seam: long-running fake that resolves only when its signal aborts.
    let receivedSignal: AbortSignal | undefined;
    let resolveStarted: () => void = () => {};
    const watcherStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
    __test__.setWatchSubagentOverride(async (_running, signal) => {
      receivedSignal = signal;
      resolveStarted();
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error("aborted"));
        const onAbort = () => reject(new Error("aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
      }).catch(() => undefined);
      return {
        name: "n", task: "t", summary: "interrupted",
        transcriptPath: null, exitCode: 1, elapsed: 1,
        error: "cancelled",
      } as any;
    });

    const resume = tools.find((t) => t.name === "subagent_resume");
    const cancel = tools.find((t) => t.name === "subagent_run_cancel");
    assert.ok(resume && cancel);

    // Kick off the resume — fire-and-forget background watcher.
    await resume.execute(
      "c-resume",
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

    // Wait until the watcher has actually started (so its signal listener is wired).
    await watcherStarted;
    assert.ok(receivedSignal, "watcher must receive a signal");
    assert.equal(receivedSignal!.aborted, false,
      "signal must not be aborted before cancel() runs");

    // Cancel the owning orchestration. The resume's detached watcher is keyed on
    // `claudeId`, owned by `orchId`. The cancel must reach it.
    await cancel.execute(
      "c-cancel",
      { orchestrationId: orchId },
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

    assert.equal(receivedSignal!.aborted, true,
      "cancel must abort the resume watcher's signal so the in-flight resumed " +
      "child stops mutating files / emitting steer-backs.");
  });
});
