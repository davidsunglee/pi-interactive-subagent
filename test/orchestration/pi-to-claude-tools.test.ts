import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PI_TO_CLAUDE_TOOLS } from "../../pi-extension/subagents/backends/tool-map.ts";

const PI_BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

describe("PI_TO_CLAUDE_TOOLS", () => {
  it("covers every pi built-in tool the pane path already recognizes", () => {
    const missing: string[] = [];
    for (const tool of PI_BUILTIN_TOOLS) {
      if (!(tool in PI_TO_CLAUDE_TOOLS)) missing.push(tool);
    }
    assert.equal(missing.length, 0,
      `Missing Claude mappings for pi built-in tools: ${missing.join(", ")}. ` +
      `Add them to pi-extension/subagents/backends/tool-map.ts so headless/pane Claude ` +
      `do not silently drop them under tool restriction.`);
  });

  it("is exported from the single shared module both builders import from", async () => {
    const index = await import("../../pi-extension/subagents/index.ts");
    const claudeStream = await import("../../pi-extension/subagents/backends/claude-stream.ts");
    assert.equal((index as any).PI_TO_CLAUDE_TOOLS, undefined,
      "index.ts must not re-export a local copy; import from backends/tool-map.ts");
    assert.equal((claudeStream as any).PI_TO_CLAUDE_TOOLS, undefined,
      "claude-stream.ts must not re-export a local copy; import from backends/tool-map.ts");
  });

  it("is a frozen/read-only object so a caller cannot mutate the shared map at runtime", () => {
    assert.throws(() => {
      (PI_TO_CLAUDE_TOOLS as any).extra = "Nope";
    }, "map must be frozen so no caller can mutate it");
  });
});
