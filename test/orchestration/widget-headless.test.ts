import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../../pi-extension/subagents/index.ts";
import { createStatusState } from "../../pi-extension/subagents/status.ts";

describe("subagents widget headless rendering", () => {
  it("renders pane, headless-with-status, and headless-without-status rows correctly", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines: string[] = testApi.renderSubagentWidgetLines(
        [
          // pane row: Pi source with statusState — right-label shows status, not usage
          {
            id: "p1",
            name: "PaneAgent",
            task: "",
            backend: "pane",
            startTime: 1_000_000 - 5_000,
            entries: 7,
            bytes: 2048,
            statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 5_000 }),
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
          // headless row: Pi source with statusState and usage — right-label shows status, not usage
          {
            id: "h1",
            name: "HeadlessAgent",
            task: "",
            backend: "headless",
            startTime: 1_000_000 - 10_000,
            statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 10_000 }),
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
          // headless row: no statusState, no cli — shows starting… fallback
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

      // lines: [top, pane, headless-with-status, headless-without-status, bottom]
      assert.equal(lines.length, 5);

      const paneRow = lines[1];
      const headlessStatusRow = lines[2];
      const headlessNoStatusRow = lines[3];

      // Pane row: Pi with fresh statusState — shows starting…
      assert.ok(
        paneRow.includes("starting…"),
        `pane row should contain "starting…" (status-based label) — got: ${paneRow}`,
      );

      // Old msgs ( format must NOT appear anywhere
      for (const line of lines) {
        assert.ok(!line.includes("msgs ("), `no row should contain "msgs (" — got: ${line}`);
      }

      // Usage stats must NOT appear in right-label slots (usage flows through transcript, not widget)
      for (const line of [paneRow, headlessStatusRow]) {
        assert.ok(!line.includes("turns"), `usage stats must not appear in right-label — got: ${line}`);
      }

      // Headless-with-status (Pi source, fresh): shows starting…
      assert.ok(
        headlessStatusRow.includes("starting…"),
        `headless-status row should contain "starting…" — got: ${headlessStatusRow}`,
      );

      // Headless-without-status, no cli — shows starting… fallback
      assert.ok(
        headlessNoStatusRow.includes("starting…"),
        `headless-no-status row should contain "starting…" — got: ${headlessNoStatusRow}`,
      );
    } finally {
      Date.now = originalNow;
    }
  });
});
