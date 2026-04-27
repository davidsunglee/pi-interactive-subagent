import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCmdParts } from "../../pi-extension/subagents/index.ts";

// Both names cover the two MCP loading paths Claude can use:
//   - bare name (mcp__<server>__<tool>): --mcp-config fallback path
//   - plugin-namespaced (mcp__plugin_<plugin>_<server>__<tool>): --plugin-dir
// The allowlist must include both so completion does not silently break
// depending on how the plugin happens to be loaded (review-v1 finding 1).
const MCP_TOOL_BARE = "mcp__pi-subagent__subagent_done";
const MCP_TOOL_PLUGIN = "mcp__plugin_pi-subagent_pi-subagent__subagent_done";

function getToolsArg(parts: string[]): string | null {
  const idx = parts.indexOf("--tools");
  if (idx < 0 || idx + 1 >= parts.length) return null;
  // shellEscape wraps args in single quotes; strip them for asserting on the list
  return parts[idx + 1].replace(/^'|'$/g, "");
}

describe("buildClaudeCmdParts injects subagent_done MCP tool into --tools", () => {
  it("includes both bare and plugin-namespaced MCP tool names alongside mapped builtins when --tools is emitted", () => {
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
    assert.ok(tools.has(MCP_TOOL_BARE), `expected ${MCP_TOOL_BARE} to be injected (--mcp-config path)`);
    assert.ok(tools.has(MCP_TOOL_PLUGIN), `expected ${MCP_TOOL_PLUGIN} to be injected (--plugin-dir path)`);
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

  it("emits --tools with only the lifecycle MCP tool names when no builtins map (e.g. effectiveTools='unknown')", () => {
    // Today, an effectiveTools list with zero recognized builtins yields no
    // --tools flag. Spec change: lifecycle MCP tools MUST still be allowlisted
    // so the model can call subagent_done — emit --tools with just those names.
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
    assert.ok(arg, "--tools must still be emitted when MCP tools need allowlisting");
    const tools = arg!.split(",");
    assert.deepEqual(
      [...tools].sort(),
      [MCP_TOOL_BARE, MCP_TOOL_PLUGIN].sort(),
      "with no mapped builtins, --tools must contain exactly both lifecycle MCP tool names",
    );
  });
});
