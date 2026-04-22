import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptMessage } from "../../pi-extension/subagents/backends/types.ts";

describe("TranscriptMessage contract", () => {
  it("accepts an assistant message with text + toolCall blocks (the Claude-path output)", () => {
    const m: TranscriptMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "I will call a tool." },
        { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "/tmp/x" } },
      ],
    };
    assert.equal(m.role, "assistant");
    assert.equal(m.content[0].type, "text");
    assert.equal(m.content[1].type, "toolCall");
  });

  it("accepts a toolResult message with the optional isError / toolCallId / toolName fields", () => {
    const m: TranscriptMessage = {
      role: "toolResult",
      toolCallId: "tc-1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "file contents" }],
    };
    assert.equal(m.role, "toolResult");
    assert.equal(m.toolCallId, "tc-1");
  });

  it("accepts a thinking block with `thinking: string` (not `text: string`)", () => {
    const m: TranscriptMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "let me think..." }],
    };
    const block = m.content[0];
    assert.equal(block.type, "thinking");
    if (block.type === "thinking") {
      assert.equal(block.thinking, "let me think...");
    }
  });

  it("does NOT require api/provider/model/usage/stopReason/timestamp (the v5 lie that v6 fixes)", () => {
    const m: TranscriptMessage = { role: "assistant", content: [] };
    assert.ok(m);
  });
});
