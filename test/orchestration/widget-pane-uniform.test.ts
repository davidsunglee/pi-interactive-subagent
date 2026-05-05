import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../../pi-extension/subagents/index.ts";
import { createStatusState } from "../../pi-extension/subagents/status.ts";

describe("subagents widget pane uniform rendering", () => {
  it("renders pane rows with statusState, running…, and starting… consistently", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines: string[] = testApi.renderSubagentWidgetLines(
        [
          // pane Pi row with usage — usage is no longer in right-label; status label shown instead
          {
            id: "p1",
            name: "PaneWithUsage",
            task: "",
            backend: "pane",
            startTime: 1_000_000 - 8_000,
            statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 8_000 }),
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
          // pane row, cli=claude — should show running… with elapsed time
          {
            id: "p2",
            name: "PaneClaude",
            task: "",
            backend: "pane",
            startTime: 1_000_000 - 4_000,
            cli: "claude",
            statusState: createStatusState({ source: "claude", startTimeMs: 1_000_000 - 4_000 }),
          },
          // pane row, pi/default cli — should show starting…
          {
            id: "p3",
            name: "PanePi",
            task: "",
            backend: "pane",
            startTime: 1_000_000 - 2_000,
            cli: "pi",
            statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 2_000 }),
          },
        ],
        80,
      );

      // lines: [top, row1, row2, row3, bottom]
      assert.equal(lines.length, 5);

      const usageRow = lines[1];
      const claudeRow = lines[2];
      const piRow = lines[3];

      // Pi row with usage: usage no longer shown in right-label; shows starting… (fresh Pi status)
      assert.ok(
        usageRow.includes("starting…"),
        `pi-with-usage row should contain "starting…" (not usage stats) — got: ${usageRow}`,
      );

      // Claude row shows running with elapsed time
      assert.ok(
        claudeRow.includes("running"),
        `claude row should contain "running" — got: ${claudeRow}`,
      );

      // Pi/default row with fresh status shows starting…
      assert.ok(
        piRow.includes("starting…"),
        `pi-no-usage row should contain "starting…" — got: ${piRow}`,
      );

      // No row should contain the old msgs ( format
      for (const line of lines) {
        assert.ok(!line.includes("msgs ("), `no row should contain "msgs (" — got: ${line}`);
      }

      // Usage stats must NOT appear in right-label slots any more
      for (const line of [usageRow, claudeRow, piRow]) {
        assert.ok(!line.includes("↑") && !line.includes("turns"),
          `usage stats must not appear in right-label — got: ${line}`);
      }
    } finally {
      Date.now = originalNow;
    }
  });
});
