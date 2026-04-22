import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeStreamEvent, parseClaudeResult } from "../../pi-extension/subagents/backends/claude-stream.ts";

describe("parseClaudeStreamEvent", () => {
  it("transforms tool_use blocks to pi-compatible toolCall shape, lowercased name", () => {
    const result = parseClaudeStreamEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "abc", name: "Read", input: { path: "/tmp/x" } },
        ],
      },
    });
    assert.ok(Array.isArray(result), "parser must return a TranscriptMessage[]");
    assert.equal(result!.length, 1);
    const msg = result![0] as any;
    assert.equal(msg.role, "assistant");
    assert.equal(msg.content[0].type, "text");
    assert.equal(msg.content[1].type, "toolCall");
    assert.equal(msg.content[1].id, "abc");
    assert.equal(msg.content[1].name, "read");
    assert.deepEqual(msg.content[1].arguments, { path: "/tmp/x" });
  });

  it("returns undefined for non-assistant, non-user events", () => {
    assert.equal(parseClaudeStreamEvent({ type: "result", result: "ok" }), undefined);
    assert.equal(parseClaudeStreamEvent({ type: "system", subtype: "init" }), undefined);
  });

  it("passes through text-only assistant messages unchanged in shape", () => {
    const r = parseClaudeStreamEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    })!;
    assert.equal(r.length, 1);
    const msg = r[0];
    assert.equal(msg.role, "assistant");
    assert.equal(msg.content[0].type, "text");
    if (msg.content[0].type === "text") assert.equal(msg.content[0].text, "done");
  });

  it("projects a user event carrying a tool_result block to role: 'toolResult' with toolCallId / isError / normalized content", () => {
    const r = parseClaudeStreamEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_abc",
            is_error: false,
            content: [{ type: "text", text: "file contents" }],
          },
        ],
      },
    })!;
    assert.ok(Array.isArray(r));
    assert.equal(r.length, 1);
    const msg = r[0];
    assert.equal(msg.role, "toolResult",
      "user events with tool_result content must be re-roled to 'toolResult' at the boundary");
    assert.equal(msg.toolCallId, "toolu_abc");
    assert.equal(msg.isError, false);
    assert.equal(msg.content.length, 1);
    assert.equal(msg.content[0].type, "text");
    if (msg.content[0].type === "text") assert.equal(msg.content[0].text, "file contents");
  });

  it("normalizes a tool_result whose content is a bare string into a TextContent block array", () => {
    const r = parseClaudeStreamEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_xyz", is_error: true, content: "bash error output" },
        ],
      },
    })!;
    const msg = r[0];
    assert.equal(msg.role, "toolResult");
    assert.equal(msg.isError, true);
    assert.ok(Array.isArray(msg.content));
    assert.equal(msg.content[0].type, "text");
    if (msg.content[0].type === "text") assert.equal(msg.content[0].text, "bash error output");
  });

  it("emits one TranscriptMessage per tool_result block when a user event batches multiple parallel tool results", () => {
    const r = parseClaudeStreamEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", is_error: false, content: "A" },
          { type: "tool_result", tool_use_id: "toolu_b", is_error: false, content: "B" },
        ],
      },
    })!;
    assert.equal(r.length, 2);
    assert.equal(r[0].toolCallId, "toolu_a");
    assert.equal(r[1].toolCallId, "toolu_b");
  });

  it("returns undefined for user events that carry no tool_result blocks (v1 scope)", () => {
    const r = parseClaudeStreamEvent({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    assert.equal(r, undefined);
  });
});

describe("parseClaudeResult", () => {
  it("extracts usage, cost, turns on success", () => {
    const r = parseClaudeResult({
      type: "result",
      is_error: false,
      subtype: "success",
      result: "OK",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 200,
      },
      total_cost_usd: 0.0012,
      num_turns: 3,
      model: "claude-sonnet-4-6",
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.finalOutput, "OK");
    assert.equal(r.usage.input, 10);
    assert.equal(r.usage.output, 5);
    assert.equal(r.usage.cacheRead, 100);
    assert.equal(r.usage.cacheWrite, 200);
    assert.equal(r.usage.cost, 0.0012);
    assert.equal(r.usage.turns, 3);
    assert.equal(r.usage.contextTokens, 315);
    assert.equal(r.model, "claude-sonnet-4-6");
  });

  it("flags error when is_error=true or subtype!='success'", () => {
    const r1 = parseClaudeResult({ type: "result", is_error: true, usage: {}, result: "oops" });
    assert.equal(r1.exitCode, 1);
    assert.ok(r1.error);
    const r2 = parseClaudeResult({ type: "result", is_error: false, subtype: "rate_limit", usage: {} });
    assert.equal(r2.exitCode, 1);
    assert.ok(r2.error);
  });
});
