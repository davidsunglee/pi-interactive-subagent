import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCmdParts } from "../../pi-extension/subagents/index.ts";

const MCP_TOOL = "mcp__pi-subagent__subagent_done";

function getToolsArg(parts: string[]): string | null {
  const idx = parts.indexOf("--tools");
  if (idx < 0 || idx + 1 >= parts.length) return null;
  // shellEscape wraps args in single quotes; strip them for asserting on the list
  return parts[idx + 1].replace(/^'|'$/g, "");
}

describe("buildClaudeCmdParts injects subagent_done MCP tool into --tools", () => {
  it("includes mcp__pi-subagent__subagent_done alongside mapped builtins when --tools is emitted", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/sentinel-1",
      pluginDir: "/tmp/plugin",
      model: "sonnet",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      effectiveTools: "read, bash",
      task: "do",
    });
    const arg = getToolsArg(parts);
    assert.ok(arg, "--tools must be emitted when effectiveTools is set");
    const tools = new Set(arg!.split(","));
    assert.ok(tools.has("Read"), "expected mapped Read");
    assert.ok(tools.has("Bash"), "expected mapped Bash");
    assert.ok(tools.has(MCP_TOOL), `expected ${MCP_TOOL} to be injected`);
  });

  it("omits --tools entirely when effectiveTools is unset (Claude's default permits MCP tools)", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/sentinel-2",
      pluginDir: "/tmp/plugin",
      model: "sonnet",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do",
    });
    assert.equal(parts.includes("--tools"), false);
  });

  it("emits --tools with only the MCP tool when no builtins map (e.g. effectiveTools='unknown')", () => {
    // Today, an effectiveTools list with zero recognized builtins yields no
    // --tools flag. Spec change: lifecycle MCP tool MUST still be allowlisted
    // so the model can call subagent_done — emit --tools with just the MCP tool.
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/sentinel-3",
      pluginDir: "/tmp/plugin",
      model: "sonnet",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      effectiveTools: "unmapped-tool-name",
      task: "do",
    });
    const arg = getToolsArg(parts);
    assert.ok(arg, "--tools must still be emitted when an MCP tool needs allowlisting");
    assert.equal(arg, MCP_TOOL);
  });
});
