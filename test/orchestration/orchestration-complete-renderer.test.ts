import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@mariozechner/pi-coding-agent";
import subagentsExtension from "../../pi-extension/subagents/index.ts";
import type { OrchestratedTaskResult } from "../../pi-extension/orchestration/types.ts";

initTheme();

function makeFakePi() {
  const renderers = new Map<string, any>();
  return {
    renderers,
    api: {
      registerTool() {},
      registerCommand() {},
      registerMessageRenderer(type: string, fn: any) { renderers.set(type, fn); },
      sendUserMessage() {},
      sendMessage() {},
      on() {},
    },
  };
}

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

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
      ],
    },
  ],
  usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 1 },
};

const failedTask: OrchestratedTaskResult = {
  name: "task-two",
  index: 1,
  state: "failed",
  exitCode: 1,
  error: "something went wrong",
  usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
};

function getRenderer() {
  const fake = makeFakePi();
  subagentsExtension(fake.api as any);
  const fn = fake.renderers.get("orchestration_complete");
  assert.ok(fn, "orchestration_complete renderer must be registered");
  return fn;
}

function drive(mode: "serial" | "parallel", expanded: boolean): string {
  const renderer = getRenderer();
  const message = {
    details: {
      mode,
      results: [completedTask, failedTask],
      isError: true,
      orchestrationId: "test-id",
    },
  };
  const options = { expanded };
  const result = renderer(message, options, fakeTheme);
  assert.ok(result, "renderer must return a non-null result");
  const lines: string[] = result.render(80);
  return lines.join("\n");
}

describe("orchestration_complete renderer — serial collapsed", () => {
  it("contains task name 'task-one'", () => {
    const output = drive("serial", false);
    assert.ok(output.includes("task-one"), `expected 'task-one' in:\n${output}`);
  });

  it("contains task name 'task-two'", () => {
    const output = drive("serial", false);
    assert.ok(output.includes("task-two"), `expected 'task-two' in:\n${output}`);
  });

  it("contains bash tool call prefix '→ $'", () => {
    const output = drive("serial", false);
    assert.ok(output.includes("→ $"), `expected '→ $' in:\n${output}`);
  });

  it("contains 'Total:' aggregate line", () => {
    const output = drive("serial", false);
    assert.ok(output.includes("Total:"), `expected 'Total:' in:\n${output}`);
  });

  it("starts with a blank line spacer", () => {
    const renderer = getRenderer();
    const message = {
      details: { mode: "serial", results: [completedTask, failedTask], isError: true },
    };
    const lines: string[] = renderer(message, { expanded: false }, fakeTheme).render(80);
    assert.equal(lines[0], "", "first line must be a blank spacer");
  });
});

describe("orchestration_complete renderer — serial expanded", () => {
  it("contains '─── Task ───' divider for expanded task blocks", () => {
    const output = drive("serial", true);
    assert.ok(output.includes("─── Task ───"), `expected '─── Task ───' in:\n${output}`);
  });

  it("contains the finalMessage 'Done!' from task-one", () => {
    const output = drive("serial", true);
    assert.ok(output.includes("Done!"), `expected 'Done!' in:\n${output}`);
  });
});

describe("orchestration_complete renderer — parallel collapsed", () => {
  it("contains task name 'task-one'", () => {
    const output = drive("parallel", false);
    assert.ok(output.includes("task-one"), `expected 'task-one' in:\n${output}`);
  });

  it("contains task name 'task-two'", () => {
    const output = drive("parallel", false);
    assert.ok(output.includes("task-two"), `expected 'task-two' in:\n${output}`);
  });

  it("contains bash tool call prefix '→ $'", () => {
    const output = drive("parallel", false);
    assert.ok(output.includes("→ $"), `expected '→ $' in:\n${output}`);
  });

  it("contains 'Total:' aggregate line", () => {
    const output = drive("parallel", false);
    assert.ok(output.includes("Total:"), `expected 'Total:' in:\n${output}`);
  });
});

describe("orchestration_complete renderer — parallel expanded", () => {
  it("contains '─── Task ───' divider for expanded task blocks", () => {
    const output = drive("parallel", true);
    assert.ok(output.includes("─── Task ───"), `expected '─── Task ───' in:\n${output}`);
  });

  it("contains the finalMessage 'Done!' from task-one", () => {
    const output = drive("parallel", true);
    assert.ok(output.includes("Done!"), `expected 'Done!' in:\n${output}`);
  });
});

describe("orchestration_complete renderer — backwards compat (no mode in details)", () => {
  it("defaults to serial layout when mode is absent", () => {
    const renderer = getRenderer();
    const message = {
      details: {
        results: [completedTask],
        isError: false,
        orchestrationId: "test-compat",
      },
    };
    const result = renderer(message, { expanded: false }, fakeTheme);
    assert.ok(result, "renderer must return non-null even without mode");
    const lines: string[] = result.render(80);
    const output = lines.join("\n");
    assert.ok(output.includes("task-one"), `expected 'task-one' in:\n${output}`);
    assert.ok(output.includes("Total:"), `expected 'Total:' in:\n${output}`);
  });
});
