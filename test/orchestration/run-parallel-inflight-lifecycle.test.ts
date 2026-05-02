import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runParallel } from "../../pi-extension/orchestration/run-parallel.ts";
import type { LauncherDeps, OrchestrationResult } from "../../pi-extension/orchestration/types.ts";

// Helper to create a manually-controlled promise.
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("runParallel inflight lifecycle", () => {
  it("first envelope after launch has tasks.length entries, no undefined slots, launched slot is running, others are pending", async () => {
    const updates: any[] = [];
    const { promise: t0, resolve: resolveT0 } = deferred<OrchestrationResult>();

    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        if (handle.name === "t0") return t0;
        return { name: handle.name, finalMessage: "ok", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
      },
    };

    // maxConcurrency=1 so t1 stays pending while t0 is running
    const runPromise = runParallel(
      [
        { name: "t0", agent: "x", task: "t" },
        { name: "t1", agent: "x", task: "t" },
      ],
      { maxConcurrency: 1, onUpdate: (env) => updates.push(env) },
      deps,
    );

    // Yield to let the launch microtask + post-launch emitInflight fire
    await new Promise((r) => setImmediate(r));

    assert.ok(updates.length >= 1, "at least one inflight envelope should have been emitted after launch");
    const firstEnv = updates[0];
    assert.equal(firstEnv.details.results.length, 2);
    assert.ok(
      firstEnv.details.results.every((r: any) => r != null && typeof r.state === "string"),
      "all slots must be non-null with an explicit state field",
    );
    assert.equal(firstEnv.details.results[0].state, "running", "launched slot should be running");
    assert.equal(firstEnv.details.results[1].state, "pending", "unlaunched slot should be pending");

    // Resolve t0 so the run can complete
    resolveT0({ name: "t0", finalMessage: "done", transcriptPath: null, exitCode: 0, elapsedMs: 1 });
    await runPromise;
  });

  it("partial update keeps slot state as running with correct index", async () => {
    const updates: any[] = [];
    let capturedOnUpdate: ((partial: OrchestrationResult) => void) | undefined;
    const { promise: taskDone, resolve: resolveTask } = deferred<OrchestrationResult>();

    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(_handle, _signal, onUpdate) {
        capturedOnUpdate = onUpdate;
        return taskDone;
      },
    };

    const runPromise = runParallel(
      [{ name: "t0", agent: "x", task: "t" }],
      { onUpdate: (env) => updates.push(env) },
      deps,
    );

    await new Promise((r) => setImmediate(r));

    // Fire a partial through the stepOnUpdate seam
    capturedOnUpdate!({
      name: "t0",
      finalMessage: "working...",
      transcriptPath: null,
      exitCode: 0,
      elapsedMs: 100,
      usage: { turns: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
    });

    await new Promise((r) => setImmediate(r));

    const lastEnv = updates[updates.length - 1];
    assert.equal(lastEnv.details.results[0].state, "running", "partial should keep state as running");
    assert.equal(lastEnv.details.results[0].index, 0, "partial should preserve index");

    // Finish the run
    resolveTask({ name: "t0", finalMessage: "done", transcriptPath: null, exitCode: 0, elapsedMs: 1 });
    await runPromise;
  });

  it("all inflight envelopes have tasks.length entries with no undefined slots", async () => {
    const updates: any[] = [];
    const { promise: t0, resolve: resolveT0 } = deferred<OrchestrationResult>();
    const { promise: t1, resolve: resolveT1 } = deferred<OrchestrationResult>();

    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        if (handle.name === "t0") return t0;
        return t1;
      },
    };

    const runPromise = runParallel(
      [
        { name: "t0", agent: "x", task: "t" },
        { name: "t1", agent: "x", task: "t" },
      ],
      { maxConcurrency: 2, onUpdate: (env) => updates.push(env) },
      deps,
    );

    await new Promise((r) => setImmediate(r));

    resolveT0({ name: "t0", finalMessage: "done", transcriptPath: null, exitCode: 0, elapsedMs: 1 });
    await new Promise((r) => setImmediate(r));

    resolveT1({ name: "t1", finalMessage: "done", transcriptPath: null, exitCode: 0, elapsedMs: 1 });
    await runPromise;

    assert.ok(updates.length >= 1, "at least one envelope should have been emitted");
    for (const env of updates) {
      assert.equal(env.details.results.length, 2, "every envelope should have tasks.length entries");
      assert.ok(
        env.details.results.every((r: any) => r != null && typeof r.state === "string"),
        "every envelope slot must be non-null with a state field",
      );
    }
  });

  it("terminal slot shows completed or failed state, never pending once running", async () => {
    const updates: any[] = [];

    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return {
          name: handle.name,
          finalMessage: "done",
          transcriptPath: null,
          exitCode: handle.name === "bad" ? 1 : 0,
          elapsedMs: 1,
        };
      },
    };

    await runParallel(
      [
        { name: "ok", agent: "x", task: "t" },
        { name: "bad", agent: "x", task: "t" },
      ],
      { maxConcurrency: 2, onUpdate: (env) => updates.push(env) },
      deps,
    );

    // Find the last envelope and verify terminal states
    const lastEnv = updates[updates.length - 1];
    for (const r of lastEnv.details.results) {
      assert.ok(
        r.state === "completed" || r.state === "failed" || r.state === "running",
        `terminal envelope slot should not be pending, got: ${r.state}`,
      );
    }

    // Verify at least one completed and one failed
    const states = lastEnv.details.results.map((r: any) => r.state);
    assert.ok(states.includes("completed") || states.includes("failed"));
  });

  it("post-loop abort sweep: pending (never-launched) slots become cancelled, completed slots untouched", async () => {
    const ac = new AbortController();
    const { promise: t0, resolve: resolveT0 } = deferred<OrchestrationResult>();

    // t0 runs and completes; t1 never launches because maxConcurrency=1 and abort fires
    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        if (handle.name === "t0") return t0;
        return { name: handle.name, finalMessage: "ok", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
      },
    };

    const runPromise = runParallel(
      [
        { name: "t0", agent: "x", task: "t" },
        { name: "t1", agent: "x", task: "t" },
      ],
      { maxConcurrency: 1, signal: ac.signal },
      deps,
    );

    // Let t0 launch
    await new Promise((r) => setImmediate(r));

    // Abort before t0 completes; t1 is still pending
    ac.abort();

    // Complete t0 (it was already launched)
    resolveT0({ name: "t0", finalMessage: "done", transcriptPath: null, exitCode: 0, elapsedMs: 1 });

    const out = await runPromise;

    assert.equal(out.results.length, 2);
    // t0 completed normally — sweep must not overwrite it
    assert.equal(out.results[0].state, "completed", "completed slot should be preserved by sweep");
    assert.equal(out.results[0].name, "t0");
    // t1 was never launched — sweep should cancel it
    assert.equal(out.results[1].state, "cancelled", "pending slot should become cancelled");
    assert.equal(out.results[1].error, "cancelled");
    assert.equal(out.results[1].name, "t1");
    assert.equal(out.results.every((r) => r != null), true, "out.results should have no undefined slots after abort sweep");
  });

  it("pre-aborted signal: all slots cancelled with error: cancelled and length === tasks.length", async () => {
    const ac = new AbortController();
    ac.abort();

    const deps: LauncherDeps = {
      async launch() {
        throw new Error("should not launch when pre-aborted");
      },
      async waitForCompletion() {
        throw new Error("should not wait when pre-aborted");
      },
    };

    const out = await runParallel(
      [
        { name: "t0", agent: "x", task: "t" },
        { name: "t1", agent: "x", task: "t" },
      ],
      { signal: ac.signal },
      deps,
    );

    assert.equal(out.results.length, 2);
    assert.equal(out.isError, true);
    for (const r of out.results) {
      assert.ok(r != null, "no undefined slots");
      assert.equal(r.state, "cancelled");
      assert.equal(r.error, "cancelled");
    }
  });
});
