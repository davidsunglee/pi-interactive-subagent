import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectPiMessageToTranscript } from "../../pi-extension/subagents/backends/headless.ts";

describe("projectPiMessageToTranscript", () => {
  it("normalizes a pi UserMessage with content: string into a TextContent block array", () => {
    const msg = {
      role: "user",
      content: "hi",
      timestamp: 0,
    } as any;
    const t = projectPiMessageToTranscript(msg);
    assert.equal(t.role, "user");
    assert.ok(Array.isArray(t.content),
      `content must project to an array, got ${typeof t.content}: ${JSON.stringify(t.content)}`);
    assert.equal(t.content.length, 1);
    assert.equal(t.content[0].type, "text");
    if (t.content[0].type === "text") assert.equal(t.content[0].text, "hi");
  });

  it("passes assistant content blocks through without rewriting", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "/x" } },
      ],
      api: "anthropic", provider: "anthropic", model: "m", usage: {}, stopReason: "stop", timestamp: 0,
    } as any;
    const t = projectPiMessageToTranscript(msg);
    assert.equal(t.role, "assistant");
    assert.equal(t.content.length, 2);
    assert.equal(t.content[0].type, "text");
    assert.equal(t.content[1].type, "toolCall");
    assert.equal((t as any).api, undefined);
    assert.equal((t as any).stopReason, undefined);
    assert.equal((t as any).usage, undefined);
  });

  it("preserves toolCallId / toolName / isError for toolResult messages", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "tc-1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "file contents" }],
      timestamp: 0,
    } as any;
    const t = projectPiMessageToTranscript(msg);
    assert.equal(t.role, "toolResult");
    assert.equal(t.toolCallId, "tc-1");
    assert.equal(t.toolName, "read");
    assert.equal(t.isError, false);
    assert.equal(t.content[0].type, "text");
  });

  it("normalizes a toolResult with content: string (defensive — future-proof against pi event shape drift)", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "tc-2",
      toolName: "bash",
      isError: true,
      content: "oops",
      timestamp: 0,
    } as any;
    const t = projectPiMessageToTranscript(msg);
    assert.ok(Array.isArray(t.content));
    assert.equal(t.content[0].type, "text");
    if (t.content[0].type === "text") assert.equal(t.content[0].text, "oops");
    assert.equal(t.isError, true);
  });
});
