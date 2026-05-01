import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initTheme, keyHint } from "@mariozechner/pi-coding-agent";
import {
  createSubagentResultRenderer,
} from "../../pi-extension/subagents/ui/subagent-result-renderer.ts";
import type { TranscriptMessage, UsageStats } from "../../pi-extension/subagents/backends/types.ts";

initTheme();

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const fakeOptions = { expanded: false };

describe("subagent_result renderer — pane shape", () => {
  it("renders expand hint for pane-shaped details (no transcript/usage)", () => {
    const message = {
      content: 'Sub-agent "X" completed (12s).\n\nAll done.',
      details: {
        name: "X",
        agent: "code",
        exitCode: 0,
        elapsed: 12,
        sessionFile: "/tmp/x",
      },
    };
    const renderer = createSubagentResultRenderer(message, fakeOptions, fakeTheme);
    assert.ok(renderer, "renderer should not be undefined");
    const lines = renderer!.render(80);
    const output = lines.join("\n");
    const expandHint = keyHint("app.tools.expand", "to expand");
    assert.ok(
      output.includes(expandHint),
      `expected expand hint "${expandHint}" in pane output:\n${output}`,
    );
  });
});

describe("subagent_result renderer — headless shape", () => {
  const transcript: TranscriptMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "ls -la" } },
        { type: "toolCall", id: "call-read", name: "read", arguments: { file_path: "/foo/bar.ts" } },
      ],
    },
  ];
  const usage: UsageStats = {
    input: 1500,
    output: 700,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.002,
    contextTokens: 0,
    turns: 2,
  };

  const message = {
    content: 'Sub-agent "X" completed (12s).\n\nAll done.',
    details: {
      name: "X",
      agent: "code",
      exitCode: 0,
      elapsed: 12,
      transcript,
      usage,
      task: "do thing",
    },
  };

  it("renders success icon ✓ for completed headless subagent", () => {
    const renderer = createSubagentResultRenderer(message, fakeOptions, fakeTheme);
    assert.ok(renderer, "renderer should not be undefined");
    const output = renderer!.render(80).join("\n");
    assert.ok(output.includes("✓"), `expected '✓' in:\n${output}`);
  });

  it("renders input token marker ↑ in headless output", () => {
    const renderer = createSubagentResultRenderer(message, fakeOptions, fakeTheme);
    const output = renderer!.render(80).join("\n");
    assert.ok(output.includes("↑"), `expected '↑' in:\n${output}`);
  });

  it("renders output token marker ↓ in headless output", () => {
    const renderer = createSubagentResultRenderer(message, fakeOptions, fakeTheme);
    const output = renderer!.render(80).join("\n");
    assert.ok(output.includes("↓"), `expected '↓' in:\n${output}`);
  });

  it("renders task name 'X' in headless output", () => {
    const renderer = createSubagentResultRenderer(message, fakeOptions, fakeTheme);
    const output = renderer!.render(80).join("\n");
    assert.ok(output.includes("X"), `expected task name 'X' in:\n${output}`);
  });

  it("renders at least one '→ ' tool-call prefix from transcript", () => {
    const renderer = createSubagentResultRenderer(message, fakeOptions, fakeTheme);
    const output = renderer!.render(80).join("\n");
    assert.ok(output.includes("→ "), `expected '→ ' tool-call prefix in:\n${output}`);
  });
});
