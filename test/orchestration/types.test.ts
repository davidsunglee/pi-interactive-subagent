import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AsyncDispatchEnvelope,
  LaunchedHandle,
  OrchestratedTaskResult,
  OrchestrationResult,
  OrchestrationState,
} from "../../pi-extension/orchestration/types.ts";

describe("types", () => {
  it("OrchestratedTaskResult accepts every lifecycle state value", () => {
    const states: OrchestrationState[] = [
      "pending",
      "running",
      "blocked",
      "completed",
      "failed",
      "cancelled",
    ];
    for (const state of states) {
      const r: OrchestratedTaskResult = {
        name: "step-1",
        index: 0,
        state,
        finalMessage: "",
        transcriptPath: null,
        exitCode: 0,
        elapsedMs: 0,
      };
      assert.equal(r.state, state);
    }
  });

  it("AsyncDispatchEnvelope carries an orchestrationId and pending task manifest", () => {
    const env: AsyncDispatchEnvelope = {
      orchestrationId: "7a3f91e2",
      tasks: [
        { name: "step-1", index: 0, state: "pending" },
        { name: "step-2", index: 1, state: "pending" },
      ],
      isError: false,
    };
    assert.equal(env.tasks.length, 2);
    assert.equal(env.tasks[0].state, "pending");
  });

  it("OrchestrationResult exposes optional state, index, sessionKey, and ping", () => {
    const r: OrchestrationResult = {
      name: "s1",
      finalMessage: "",
      transcriptPath: null,
      exitCode: 0,
      elapsedMs: 0,
      state: "completed",
      index: 0,
      sessionKey: "/tmp/s.jsonl",
      ping: { name: "s1", message: "?" },
    };
    assert.equal(r.state, "completed");
    assert.equal(r.index, 0);
    assert.equal(r.sessionKey, "/tmp/s.jsonl");
    assert.equal(r.ping?.message, "?");
  });

  it("LaunchedHandle exposes an optional sessionKey", () => {
    const h: LaunchedHandle = {
      id: "x",
      name: "n",
      startTime: 0,
      sessionKey: "/tmp/s.jsonl",
    };
    assert.equal(h.sessionKey, "/tmp/s.jsonl");
  });
});
