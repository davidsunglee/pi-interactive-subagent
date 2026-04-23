import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSerial } from "../../pi-extension/orchestration/run-serial.ts";
import { runParallel } from "../../pi-extension/orchestration/run-parallel.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

describe("sync orchestration with a pinging child — behavior unchanged", () => {
  const pingDeps: LauncherDeps = {
    async launch(t) {
      return { id: t.task, name: t.name ?? "s", startTime: Date.now() };
    },
    async waitForCompletion(h) {
      return {
        name: h.name,
        finalMessage: "",
        transcriptPath: null,
        exitCode: 0,
        elapsedMs: 1,
        sessionKey: `sess-${h.name}`,
        ping: { name: h.name, message: "need help" },
      };
    },
  };

  it("runSerial (sync, no onBlocked hook) records ping as completed with finalMessage=ping.message", async () => {
    const out = await runSerial(
      [
        { name: "a", agent: "x", task: "t" },
        { name: "b", agent: "x", task: "t2" },
      ],
      {},
      pingDeps,
    );
    assert.equal(out.isError, false);
    assert.equal(out.results[0].state, "completed");
    assert.equal(out.results[0].finalMessage, "need help");
    assert.equal(out.results.length, 2);
    assert.equal(out.results[1].finalMessage, "need help");
  });

  it("runParallel (sync, no onBlocked hook) records ping as completed with finalMessage=ping.message", async () => {
    const out = await runParallel(
      [
        { name: "a", agent: "x", task: "t" },
        { name: "b", agent: "x", task: "t" },
      ],
      {},
      pingDeps,
    );
    assert.equal(out.isError, false);
    assert.equal(out.results.every((r) => r.state === "completed"), true);
    assert.equal(out.results.every((r) => r.finalMessage === "need help"), true);
  });
});
