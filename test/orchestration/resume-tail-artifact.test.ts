// test/orchestration/resume-tail-artifact.test.ts
//
// Step 8b of Task 5: verify that the resumed serial-tail uses the ORIGINAL
// orchestration task index (not a local tail index) when writing artifacts.
//
// A 3-step serial blocks on step 1.  After resume the continuation runs step 2
// (startIndex = 2) and must write its artifact to task-2.md, not task-0.md.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import { createRegistry } from "../../pi-extension/orchestration/registry.ts";
import { ORCHESTRATION_COMPLETE_KIND } from "../../pi-extension/orchestration/notification-kinds.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

describe("resume-tail-artifact: offset ensures task-2.md not task-0.md", () => {
  let tmpDir: string;

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resumed continuation writes step-2 artifact to task-2.md, not task-0.md", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "resume-tail-arts-"));
    const sessionManager = { getSessionDir: () => tmpDir, getSessionId: () => "sess1" };

    const sessionKeyForBlocker = "sess-step1-blocker-tail";
    let callCount = 0;

    const deps: LauncherDeps = {
      async launch(t) {
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(), sessionKey: `sess-${t.task}` };
      },
      async waitForCompletion(h) {
        const i = callCount++;
        if (i === 0) {
          // step 0: completes normally
          return { name: h.name, finalMessage: "step-0 body", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
        }
        if (i === 1) {
          // step 1: blocks
          return {
            name: h.name, finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 0,
            sessionKey: sessionKeyForBlocker,
            ping: { name: h.name, message: "need user input" },
          };
        }
        // step 2: completes (called after resume continuation)
        return { name: h.name, finalMessage: "step-2 body", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
      },
    };

    const emitted: any[] = [];
    const registry = createRegistry((p) => emitted.push(p));
    const tools: any[] = [];
    const api = {
      registerTool: (t: any) => tools.push(t),
      on() {}, registerCommand() {}, registerMessageRenderer() {},
      sendMessage() {}, sendUserMessage() {},
    } as any;
    registerOrchestrationTools(api, () => deps, () => true, () => null, () => null, { registry });
    const serial = tools.find((t) => t.name === "subagent_run_serial");

    const env = await serial.execute(
      "resume-tail-offset-test",
      { wait: false, tasks: [
        { name: "step-a", agent: "x", task: "t0" },
        { name: "step-b", agent: "x", task: "t1" },
        { name: "step-c", agent: "x", task: "t2" },
      ] },
      new AbortController().signal,
      () => {},
      { sessionManager, cwd: tmpDir },
    );

    // Give the async IIFE time to run step 0 and block on step 1
    await new Promise((r) => setTimeout(r, 80));

    const orchId = env.details.orchestrationId;
    const artifactsBase = join(tmpDir, "artifacts", "sess1", "orchestrations", orchId);

    // step 0 should have written its artifact at task-0.md
    const task0Path = join(artifactsBase, "task-0.md");
    assert.ok(existsSync(task0Path), "task-0.md must exist after step 0 completes");
    assert.equal(readFileSync(task0Path, "utf8"), "step-0 body",
      "task-0.md must contain step 0's finalMessage");

    // No completion yet — still blocked on step 1
    assert.equal(emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND), undefined,
      "orchestration must not complete while blocked");

    // Simulate resume: mark resume started, then terminal with completed result
    registry.onResumeStarted(sessionKeyForBlocker);
    registry.onResumeTerminal(sessionKeyForBlocker, {
      name: "step-b", index: 1, state: "completed", finalMessage: "step-1-resumed",
      exitCode: 0, elapsedMs: 5, sessionKey: sessionKeyForBlocker,
    });

    // Give the continuation time to run step 2 and finalize
    await new Promise((r) => setTimeout(r, 100));

    // task-2.md must exist with step 2's body (using ORIGINAL index 2, not local index 0)
    const task2Path = join(artifactsBase, "task-2.md");
    assert.ok(existsSync(task2Path),
      "task-2.md must exist — resumed tail must use original task index 2, not local tail index 0");
    assert.equal(readFileSync(task2Path, "utf8"), "step-2 body",
      "task-2.md must contain step 2's finalMessage byte-for-byte");

    // task-0.md must still have step 0's content — the resumed tail must not have collided
    assert.equal(readFileSync(task0Path, "utf8"), "step-0 body",
      "task-0.md must still contain step-0 body — resumed tail must not overwrite it");

    // Verify completion fired
    const complete = emitted.find((e) => e.kind === ORCHESTRATION_COMPLETE_KIND);
    assert.ok(complete, "aggregated completion must fire after full resume");
    assert.equal(complete.results[0].state, "completed");
    assert.equal(complete.results[2].state, "completed");
  });
});
