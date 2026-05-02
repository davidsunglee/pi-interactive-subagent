import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSerial } from "../../pi-extension/orchestration/run-serial.ts";
import type { LauncherDeps, OrchestrationResult } from "../../pi-extension/orchestration/types.ts";

describe("runSerial inflight state stamping", () => {
  it("stamps state: 'running' and index on in-flight partial in onUpdate", async () => {
    const capturedUpdates: Array<{ content: { type: "text"; text: string }[]; details: any }> = [];

    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle, _signal, onUpdate) {
        // Emit an in-flight update with usage but no state field
        const partial: OrchestrationResult = {
          name: handle.name,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 50,
          usage: { turns: 1, inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 },
        };
        onUpdate?.(partial);

        // Return success after the update
        return {
          name: handle.name,
          finalMessage: "done",
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
          capturedUpdates.push(update);
        },
      },
      deps,
    );

    // Should have at least one captured update from step-1
    assert.ok(capturedUpdates.length > 0, "onUpdate should have been called");

    // Find the first update (from step-1)
    const firstUpdate = capturedUpdates[0];
    assert.ok(firstUpdate, "first update should exist");

    // The inflight results array should have the in-flight step with state: "running"
    const inflightResults = firstUpdate.details.results;
    assert.ok(inflightResults, "inflight results should exist in details");
    assert.equal(inflightResults.length, 1, "should have 1 in-flight step");

    // The in-flight step should have explicit state and index
    const inflightStep = inflightResults[0];
    assert.equal(inflightStep.state, "running", "in-flight step should have state: 'running'");
    assert.equal(inflightStep.index, 0, "in-flight step should have index: 0");
  });

  it("emits 'step-N: running' in summary text for in-flight step", async () => {
    const capturedUpdates: Array<{ content: { type: "text"; text: string }[]; details: any }> = [];

    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle, _signal, onUpdate) {
        const partial: OrchestrationResult = {
          name: handle.name,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 50,
          usage: { turns: 1, inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 },
        };
        onUpdate?.(partial);

        return {
          name: handle.name,
          finalMessage: "done",
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
          capturedUpdates.push(update);
        },
      },
      deps,
    );

    assert.ok(capturedUpdates.length > 0, "onUpdate should have been called");

    const firstUpdate = capturedUpdates[0];
    const text = firstUpdate.content[0].text;

    // Should contain "step-1: running"
    assert.ok(text.includes("step-1: running"), `text should contain "step-1: running", got: ${text}`);
    // Should NOT contain "step-1: pending"
    assert.equal(
      text.includes("step-1: pending"),
      false,
      `text should not contain "step-1: pending", got: ${text}`,
    );
  });

  it("preserves terminal state in results when second step starts", async () => {
    const capturedUpdates: Array<{ content: { type: "text"; text: string }[]; details: any }> = [];
    let step2Started = false;

    const deps: LauncherDeps = {
      async launch(task) {
        if (task.name === "step-2") {
          step2Started = true;
        }
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle, _signal, onUpdate) {
        if (handle.name === "step-1") {
          // Emit in-flight update for step-1
          const partial: OrchestrationResult = {
            name: handle.name,
            finalMessage: "",
            transcriptPath: null,
            exitCode: 0,
            elapsedMs: 50,
            usage: { turns: 1, inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 },
          };
          onUpdate?.(partial);
        } else if (handle.name === "step-2") {
          // When step-2 is running, emit its in-flight update
          const partial: OrchestrationResult = {
            name: handle.name,
            finalMessage: "",
            transcriptPath: null,
            exitCode: 0,
            elapsedMs: 50,
            usage: { turns: 1, inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 },
          };
          onUpdate?.(partial);
        }

        return {
          name: handle.name,
          finalMessage: "done",
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
          capturedUpdates.push(update);
        },
      },
      deps,
    );

    // Find the second update (from step-2)
    const step2Updates = capturedUpdates.filter((u) => {
      const results = u.details.results;
      return results.length === 2; // When step-2 starts, we have 2 results in inflight
    });

    assert.ok(step2Updates.length > 0, "should have captured update when step-2 starts");

    const step2Update = step2Updates[0];
    const results = step2Update.details.results;

    // First result (step-1) should be completed
    assert.equal(results[0].state, "completed", "step-1 should be completed in results");
    assert.equal(results[0].index, 0, "step-1 should have index 0");

    // Second result (step-2) should be running
    assert.equal(results[1].state, "running", "step-2 should be running");
    assert.equal(results[1].index, 1, "step-2 should have index 1");
  });
});
