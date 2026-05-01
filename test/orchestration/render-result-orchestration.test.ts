import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@mariozechner/pi-coding-agent";
import {
  renderRichSubagentResult,
  toTaskRows,
  type TaskRow,
  type RichMode,
} from "../../pi-extension/subagents/ui/headless-render.ts";
import type { OrchestratedTaskResult } from "../../pi-extension/orchestration/types.ts";

initTheme();

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

// Two synthetic task results: one completed with transcript+usage, one running
const completedTask: OrchestratedTaskResult = {
  name: "task-one",
  index: 0,
  state: "completed",
  finalMessage: "Done!",
  transcript: [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "ls -la" } },
        { type: "toolCall", id: "call-read", name: "read", arguments: { file_path: "/foo/bar.ts" } },
        { type: "toolCall", id: "call-grep", name: "grep", arguments: { pattern: "todo", path: "." } },
      ],
    },
  ],
  usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 1 },
};

const runningTask: OrchestratedTaskResult = {
  name: "task-two",
  index: 1,
  state: "running",
  transcript: [],
  usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
};

function renderToString(mode: RichMode, expanded: boolean): string {
  const component = renderRichSubagentResult({
    mode,
    results: toTaskRows([completedTask, runningTask]),
    expanded,
    theme: fakeTheme,
  });
  return component.render(80).join("\n");
}

describe("renderRichSubagentResult", () => {
  it("returns a Component whose render(80) is callable", () => {
    const component = renderRichSubagentResult({
      mode: "serial" as RichMode,
      results: [] as TaskRow[],
      expanded: false,
      theme: fakeTheme,
    });
    assert.equal(typeof component.render, "function");
    const lines = component.render(80);
    assert.ok(Array.isArray(lines));
  });

  it("toTaskRows is exported and maps an empty list", () => {
    assert.equal(typeof toTaskRows, "function");
    assert.deepEqual(toTaskRows([]), []);
  });
});

describe("renderRichSubagentResult — serial collapsed", () => {
  it("contains both task names", () => {
    const output = renderToString("serial", false);
    assert.ok(output.includes("task-one"), `expected 'task-one' in:\n${output}`);
    assert.ok(output.includes("task-two"), `expected 'task-two' in:\n${output}`);
  });

  it("contains both state icons ✓ and ⏳", () => {
    const output = renderToString("serial", false);
    assert.ok(output.includes("✓"), `expected '✓' in:\n${output}`);
    assert.ok(output.includes("⏳"), `expected '⏳' in:\n${output}`);
  });

  it("contains a bash tool call prefix '→ $'", () => {
    const output = renderToString("serial", false);
    assert.ok(output.includes("→ $"), `expected '→ $' in:\n${output}`);
  });

  it("contains a read tool call prefix '→ read'", () => {
    const output = renderToString("serial", false);
    assert.ok(output.includes("→ read"), `expected '→ read' in:\n${output}`);
  });

  it("contains per-task '↑1.0k' token count from task-one usage", () => {
    const output = renderToString("serial", false);
    assert.ok(output.includes("↑1.0k"), `expected '↑1.0k' in:\n${output}`);
  });

  it("contains 'Total:' aggregate line", () => {
    const output = renderToString("serial", false);
    assert.ok(output.includes("Total:"), `expected 'Total:' in:\n${output}`);
  });
});

describe("renderRichSubagentResult — serial expanded", () => {
  it("contains '─── Task ───' divider for expanded task blocks", () => {
    const output = renderToString("serial", true);
    assert.ok(output.includes("─── Task ───"), `expected '─── Task ───' in:\n${output}`);
  });

  it("contains the finalMessage 'Done!' from task-one", () => {
    const output = renderToString("serial", true);
    assert.ok(output.includes("Done!"), `expected 'Done!' in:\n${output}`);
  });
});

describe("renderRichSubagentResult — parallel collapsed", () => {
  it("contains both task names", () => {
    const output = renderToString("parallel", false);
    assert.ok(output.includes("task-one"), `expected 'task-one' in:\n${output}`);
    assert.ok(output.includes("task-two"), `expected 'task-two' in:\n${output}`);
  });

  it("contains both state icons ✓ and ⏳", () => {
    const output = renderToString("parallel", false);
    assert.ok(output.includes("✓"), `expected '✓' in:\n${output}`);
    assert.ok(output.includes("⏳"), `expected '⏳' in:\n${output}`);
  });

  it("contains a bash tool call prefix '→ $'", () => {
    const output = renderToString("parallel", false);
    assert.ok(output.includes("→ $"), `expected '→ $' in:\n${output}`);
  });

  it("contains a read tool call prefix '→ read'", () => {
    const output = renderToString("parallel", false);
    assert.ok(output.includes("→ read"), `expected '→ read' in:\n${output}`);
  });

  it("contains per-task '↑1.0k' token count from task-one usage", () => {
    const output = renderToString("parallel", false);
    assert.ok(output.includes("↑1.0k"), `expected '↑1.0k' in:\n${output}`);
  });

  it("contains 'Total:' aggregate line", () => {
    const output = renderToString("parallel", false);
    assert.ok(output.includes("Total:"), `expected 'Total:' in:\n${output}`);
  });
});

describe("renderRichSubagentResult — parallel expanded", () => {
  it("contains '─── Task ───' divider for expanded task blocks", () => {
    const output = renderToString("parallel", true);
    assert.ok(output.includes("─── Task ───"), `expected '─── Task ───' in:\n${output}`);
  });

  it("contains the finalMessage 'Done!' from task-one", () => {
    const output = renderToString("parallel", true);
    assert.ok(output.includes("Done!"), `expected 'Done!' in:\n${output}`);
  });
});
