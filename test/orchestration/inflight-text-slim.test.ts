import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSerial } from "../../pi-extension/orchestration/run-serial.ts";
import { runParallel } from "../../pi-extension/orchestration/run-parallel.ts";
import type { LauncherDeps, OrchestrationResult } from "../../pi-extension/orchestration/types.ts";

describe("in-flight text slim", () => {
  it("runSerial does not include finalMessage preview in inflight updates", async () => {
    let capturedUpdate: { content: { type: "text"; text: string }[]; details: any } | null = null;

    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle, _signal, onUpdate) {
        // Emit an in-flight update with a long finalMessage
        const partial: OrchestrationResult = {
          name: handle.name,
          finalMessage: "this is a long message that should NOT appear in the inflight text",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 100,
        };
        onUpdate?.(partial);

        // Return success after the update
        return {
          name: handle.name,
          finalMessage: "this is a long message that should NOT appear in the inflight text",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 100,
        };
      },
    };

    await runSerial(
      [
        { name: "step-1", agent: "x", task: "t1" },
        { name: "step-2", agent: "x", task: "t2" },
      ],
      {
        onUpdate: (update) => {
          capturedUpdate = update;
        },
      },
      deps,
    );

    assert.ok(capturedUpdate, "onUpdate should have been called");
    const text = capturedUpdate!.content[0].text;

    // Assert the header is present
    assert.match(text, /serial orchestration \(in-flight\): \d+ task\(s\)/, "should contain serial header");

    // Assert state tokens are present (either "running" for in-flight or the abbreviated form)
    assert.ok(text.includes("step-1:") || text.includes("step-1 "), "should reference step-1");

    // Assert the long message is NOT in the text
    assert.ok(
      !text.includes("long message"),
      `inflight text should not include finalMessage preview. Got: ${text}`,
    );
  });

  it("runParallel does not include finalMessage preview in inflight updates", async () => {
    let capturedUpdate: { content: { type: "text"; text: string }[]; details: any } | null = null;

    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle, _signal, onUpdate) {
        // Emit an in-flight update with a long finalMessage
        const partial: OrchestrationResult = {
          name: handle.name,
          finalMessage: "this is a long message that should NOT appear in the inflight text",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 100,
        };
        onUpdate?.(partial);

        // Return success after the update
        return {
          name: handle.name,
          finalMessage: "this is a long message that should NOT appear in the inflight text",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 100,
        };
      },
    };

    await runParallel(
      [
        { name: "task-1", agent: "x", task: "t1" },
        { name: "task-2", agent: "x", task: "t2" },
      ],
      {
        onUpdate: (update) => {
          capturedUpdate = update;
        },
      },
      deps,
    );

    assert.ok(capturedUpdate, "onUpdate should have been called");
    const text = capturedUpdate!.content[0].text;

    // Assert the header is present
    assert.match(text, /parallel orchestration \(in-flight\):/, "should contain parallel header");

    // Assert state tokens are present
    assert.ok(text.includes("task-1") || text.includes("[1]"), "should reference task-1 or [1]");

    // Assert the long message is NOT in the text
    assert.ok(
      !text.includes("long message"),
      `inflight text should not include finalMessage preview. Got: ${text}`,
    );
  });
});
