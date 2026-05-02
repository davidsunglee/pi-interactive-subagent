import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../../pi-extension/subagents/index.ts";

describe("subagents widget pane uniform rendering", () => {
  it("renders pane rows with usage, running…, and starting… consistently", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines: string[] = testApi.renderSubagentWidgetLines(
        [
          // pane row with usage — should render usage stats
          {
            id: "p1",
            name: "PaneWithUsage",
            task: "",
            backend: "pane",
            startTime: 1_000_000 - 8_000,
            usage: {
              input: 7000,
              output: 500,
              cacheRead: 1000,
              cacheWrite: 0,
              cost: 0.0021,
              contextTokens: 0,
              turns: 4,
            },
          },
          // pane row, no usage, cli=claude — should show running…
          {
            id: "p2",
            name: "PaneClaude",
            task: "",
            backend: "pane",
            startTime: 1_000_000 - 4_000,
            cli: "claude",
          },
          // pane row, no usage, pi/default cli — should show starting…
          {
            id: "p3",
            name: "PanePi",
            task: "",
            backend: "pane",
            startTime: 1_000_000 - 2_000,
            cli: "pi",
          },
        ],
        80,
      );

      // lines: [top, row1, row2, row3, bottom]
      assert.equal(lines.length, 5);

      const usageRow = lines[1];
      const claudeRow = lines[2];
      const piRow = lines[3];

      // Row with usage shows token markers and turns
      assert.ok(
        usageRow.includes("↑") || usageRow.includes("↓"),
        `usage row should contain token markers — got: ${usageRow}`,
      );
      assert.ok(
        usageRow.includes("4 turns"),
        `usage row should contain "4 turns" — got: ${usageRow}`,
      );

      // Claude row without usage shows running…
      assert.ok(
        claudeRow.includes("running…"),
        `claude-no-usage row should contain "running…" — got: ${claudeRow}`,
      );

      // Pi/default row without usage shows starting…
      assert.ok(
        piRow.includes("starting…"),
        `pi-no-usage row should contain "starting…" — got: ${piRow}`,
      );

      // No row should contain the old msgs ( format
      for (const line of lines) {
        assert.ok(!line.includes("msgs ("), `no row should contain "msgs (" — got: ${line}`);
      }
    } finally {
      Date.now = originalNow;
    }
  });
});
