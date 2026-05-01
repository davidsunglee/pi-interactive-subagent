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
          // pane row: entries + bytes present
          {
            id: "p1",
            name: "PaneAgent",
            task: "",
            backend: "pane",
            startTime: 1_000_000 - 5_000,
            entries: 7,
            bytes: 2048,
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
          // headless row: no usage yet
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

      // Pane row should contain entry/bytes format
      assert.ok(paneRow.includes("msgs ("), `pane row should contain "msgs (" — got: ${paneRow}`);

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

      // Headless-without-usage should show running…
      assert.ok(
        headlessNoUsageRow.includes("running…"),
        `headless-no-usage row should contain "running…" — got: ${headlessNoUsageRow}`,
      );
    } finally {
      Date.now = originalNow;
    }
  });
});
