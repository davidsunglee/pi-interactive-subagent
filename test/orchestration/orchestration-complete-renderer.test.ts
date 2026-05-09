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
  it("omits an empty '─── Task ───' divider for orchestration rows without task text", () => {
    const output = drive("serial", true);
    assert.ok(!output.includes("─── Task ───"), `expected no empty task divider in:\n${output}`);
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
  it("omits an empty '─── Task ───' divider for orchestration rows without task text", () => {
    const output = drive("parallel", true);
    assert.ok(!output.includes("─── Task ───"), `expected no empty task divider in:\n${output}`);
  });

  it("contains the finalMessage 'Done!' from task-one", () => {
    const output = drive("parallel", true);
    assert.ok(output.includes("Done!"), `expected 'Done!' in:\n${output}`);
  });
});

describe("orchestration_complete renderer — bg wrap", () => {
  const markerTheme = {
    fg: (_color: string, text: string) => text,
    bg: (color: string, text: string) => `__BG_${color}__${text}__/BG__`,
    bold: (text: string) => text,
  };

  it("wraps aggregate output in toolSuccessBg when isError is falsy", () => {
    const renderer = getRenderer();
    const message = {
      details: {
        mode: "serial",
        results: [completedTask],
        isError: false,
        orchestrationId: "test-id",
      },
    };
    const output = renderer(message, { expanded: false }, markerTheme).render(80).join("\n");
    assert.ok(
      output.includes("__BG_toolSuccessBg__"),
      `expected toolSuccessBg marker in:\n${output}`,
    );
    assert.ok(
      !output.includes("__BG_toolErrorBg__"),
      `did not expect toolErrorBg marker in:\n${output}`,
    );
  });

  it("wraps aggregate output in toolErrorBg when isError is true", () => {
    const renderer = getRenderer();
    const message = {
      details: {
        mode: "parallel",
        results: [completedTask, failedTask],
        isError: true,
        orchestrationId: "test-id",
      },
    };
    const output = renderer(message, { expanded: false }, markerTheme).render(80).join("\n");
    assert.ok(
      output.includes("__BG_toolErrorBg__"),
      `expected toolErrorBg marker in:\n${output}`,
    );
    assert.ok(
      !output.includes("__BG_toolSuccessBg__"),
      `did not expect toolSuccessBg marker in:\n${output}`,
    );
  });

  it("preserves leading blank-line spacer outside the bg wrap", () => {
    const renderer = getRenderer();
    const message = {
      details: {
        mode: "serial",
        results: [completedTask],
        isError: false,
        orchestrationId: "test-id",
      },
    };
    const lines: string[] = renderer(message, { expanded: false }, markerTheme).render(80);
    assert.equal(lines[0], "", "first line must remain a blank spacer outside the bg wrap");
    assert.ok(
      !lines[0].includes("__BG_"),
      "leading spacer must not be inside the colored block",
    );
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
