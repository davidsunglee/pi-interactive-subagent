import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../../pi-extension/subagents/index.ts";
import { createStatusState, observeStatus } from "../../pi-extension/subagents/status.ts";

const testApi = (subagentsModule as any).__test__;

describe("widget right-label precedence and formatting", () => {
  const originalNow = Date.now;

  afterEach(() => {
    Date.now = originalNow;
    testApi.setStatusConfig({ enabled: true, lineLimit: 4 });
  });

  it("blocked row renders blocked label regardless of statusState", () => {
    Date.now = () => 1_000_000;
    const lines: string[] = testApi.renderSubagentWidgetLines(
      [
        {
          id: "b1",
          name: "BlockedAgent",
          task: "",
          backend: "pane",
          startTime: 1_000_000 - 5_000,
          blocked: { orchestrationId: "orch1", taskIndex: 0, message: "some block reason" },
        },
      ],
      80,
    );
    assert.equal(lines.length, 3);
    assert.ok(
      lines[1].includes(" blocked — awaiting parent "),
      `blocked row should contain " blocked — awaiting parent " — got: ${lines[1]}`,
    );
  });

  it("Pi row with active status renders active label", () => {
    Date.now = () => 1_000_000;
    let statusState = createStatusState({ source: "pi", startTimeMs: 1_000_000 - 30_000 });
    statusState = observeStatus(statusState, {
      snapshot: "present",
      updatedAt: 1_000_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 1_000_000 - 10_000,
      activityLabel: "SomeTool",
    }, 1_000_000);
    const lines: string[] = testApi.renderSubagentWidgetLines(
      [
        {
          id: "p1",
          name: "PiAgent",
          task: "",
          backend: "pane",
          startTime: 1_000_000 - 30_000,
          statusState,
        },
      ],
      80,
    );
    assert.equal(lines.length, 3);
    assert.ok(
      lines[1].includes(" active · "),
      `active Pi row should contain " active · " — got: ${lines[1]}`,
    );
  });

  it("Claude row renders running label with elapsed time", () => {
    Date.now = () => 1_000_000;
    const statusState = createStatusState({ source: "claude", startTimeMs: 1_000_000 - 5_000 });
    const lines: string[] = testApi.renderSubagentWidgetLines(
      [
        {
          id: "c1",
          name: "ClaudeAgent",
          task: "",
          backend: "headless",
          startTime: 1_000_000 - 5_000,
          cli: "claude",
          statusState,
        },
      ],
      80,
    );
    assert.equal(lines.length, 3);
    assert.ok(
      lines[1].includes(" running ") && lines[1].includes("s "),
      `claude row should contain " running …s " pattern — got: ${lines[1]}`,
    );
  });

  it("falls back to starting… and running… when statusConfig.enabled is false", () => {
    Date.now = () => 1_000_000;
    testApi.setStatusConfig({ enabled: false, lineLimit: 4 });
    const piStatusState = createStatusState({ source: "pi", startTimeMs: 1_000_000 - 5_000 });
    const claudeStatusState = createStatusState({ source: "claude", startTimeMs: 1_000_000 - 5_000 });
    const lines: string[] = testApi.renderSubagentWidgetLines(
      [
        {
          id: "p1",
          name: "PiAgent",
          task: "",
          backend: "pane",
          startTime: 1_000_000 - 5_000,
          statusState: piStatusState,
        },
        {
          id: "c1",
          name: "ClaudeAgent",
          task: "",
          backend: "pane",
          startTime: 1_000_000 - 5_000,
          cli: "claude",
          statusState: claudeStatusState,
        },
      ],
      80,
    );
    assert.equal(lines.length, 4); // top + 2 rows + bottom
    assert.ok(
      lines[1].includes("starting…"),
      `Pi row with disabled status should fall back to "starting…" — got: ${lines[1]}`,
    );
    assert.ok(
      lines[2].includes("running…"),
      `Claude row with disabled status should fall back to "running…" — got: ${lines[2]}`,
    );
  });
});
