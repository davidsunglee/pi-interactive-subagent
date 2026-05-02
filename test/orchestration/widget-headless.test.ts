import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../../pi-extension/subagents/index.ts";

describe("subagents widget headless rendering", () => {
  it("renders pane, headless-with-usage, and headless-without-usage rows correctly", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines: string[] = testApi.renderSubagentWidgetLines(
        [
          // pane row: usage present — should render usage stats
          {
            id: "p1",
            name: "PaneAgent",
            task: "",
            backend: "pane",
            startTime: 1_000_000 - 5_000,
            entries: 7,
            bytes: 2048,
            usage: {
              input: 5000,
              output: 300,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0.0010,
              contextTokens: 0,
              turns: 2,
            },
          },
          // headless row: usage present
          {
            id: "h1",
            name: "HeadlessAgent",
            task: "",
            backend: "headless",
            startTime: 1_000_000 - 10_000,
            usage: {
              input: 12000,
              output: 800,
              cacheRead: 5000,
              cacheWrite: 0,
              cost: 0.0042,
              contextTokens: 0,
              turns: 3,
            },
          },
          // headless row: no usage yet, no cli — shows starting…
          {
            id: "h2",
            name: "HeadlessAgent2",
            task: "",
            backend: "headless",
            startTime: 1_000_000 - 3_000,
          },
        ],
        80,
      );

      // lines: [top, pane, headless-with-usage, headless-without-usage, bottom]
      assert.equal(lines.length, 5);

      const paneRow = lines[1];
      const headlessUsageRow = lines[2];
      const headlessNoUsageRow = lines[3];

      // Pane row should contain usage stats (↑/↓ token markers)
      assert.ok(
        paneRow.includes("↑") || paneRow.includes("↓"),
        `pane row should contain usage stats markers — got: ${paneRow}`,
      );
      assert.ok(
        paneRow.includes("2 turns"),
        `pane row should contain "2 turns" — got: ${paneRow}`,
      );

      // Old msgs ( format must NOT appear anywhere
      for (const line of lines) {
        assert.ok(!line.includes("msgs ("), `no row should contain "msgs (" — got: ${line}`);
      }

      // Headless-with-usage should contain formatted usage stats
      assert.ok(
        headlessUsageRow.includes("3 turns"),
        `headless-usage row should contain "3 turns" — got: ${headlessUsageRow}`,
      );
      assert.ok(
        headlessUsageRow.includes("↑12k"),
        `headless-usage row should contain "↑12k" — got: ${headlessUsageRow}`,
      );
      assert.ok(
        headlessUsageRow.includes("↓800"),
        `headless-usage row should contain "↓800" — got: ${headlessUsageRow}`,
      );
      assert.ok(
        headlessUsageRow.includes("$0.0042"),
        `headless-usage row should contain "$0.0042" — got: ${headlessUsageRow}`,
      );

      // Headless-without-usage, no cli — shows starting…
      assert.ok(
        headlessNoUsageRow.includes("starting…"),
        `headless-no-usage row should contain "starting…" — got: ${headlessNoUsageRow}`,
      );
    } finally {
      Date.now = originalNow;
    }
  });
});
