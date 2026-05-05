import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toTaskRows } from "../../pi-extension/subagents/ui/headless-render.ts";
import type { OrchestratedTaskResult } from "../../pi-extension/orchestration/types.ts";

const completedRow: OrchestratedTaskResult = {
  name: "completed-task",
  index: 1,
  state: "completed",
  finalMessage: "Task done",
  transcript: [],
  usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 1 },
};

describe("toTaskRows — sparse arrays", () => {
  it("preserves array length with undefined values", () => {
    const results: (OrchestratedTaskResult | undefined)[] = [undefined, completedRow];
    const rows = toTaskRows(results as OrchestratedTaskResult[]);

    assert.equal(rows.length, 2, "output should have length 2");
    assert.equal(rows[0].state, "pending", "first row should be pending");
    assert.equal(rows[0].name, "task-1", "first row should have placeholder name");
    assert.equal(rows[1].state, completedRow.state, "second row should preserve state");
    assert.equal(rows[1].name, completedRow.name, "second row should preserve name");
  });

  it("handles arrays with real holes (sparse)", () => {
    const results = Array.from({ length: 3 }, () => undefined) as unknown as OrchestratedTaskResult[];
    const rows = toTaskRows(results);

    assert.equal(rows.length, 3, "output should have length 3");
    assert.equal(rows[0].state, "pending", "all rows should be pending");
    assert.equal(rows[1].state, "pending", "all rows should be pending");
    assert.equal(rows[2].state, "pending", "all rows should be pending");
    assert.equal(rows[0].name, "task-1", "first placeholder should be task-1");
    assert.equal(rows[1].name, "task-2", "second placeholder should be task-2");
    assert.equal(rows[2].name, "task-3", "third placeholder should be task-3");
  });

  it("does not throw on mixed undefined and defined values", () => {
    const results: (OrchestratedTaskResult | undefined)[] = [
      completedRow,
      undefined,
      completedRow,
    ];
    assert.doesNotThrow(() => {
      toTaskRows(results as OrchestratedTaskResult[]);
    });
  });
});
