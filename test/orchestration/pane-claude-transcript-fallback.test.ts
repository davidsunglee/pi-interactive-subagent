import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractLastAssistantMessage } from "../../pi-extension/subagents/index.ts";

describe("extractLastAssistantMessage", () => {
  it("returns the most recent assistant message text from a JSONL transcript", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "first turn" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "more" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "final summary" } }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      }),
    ].join("\n");
    assert.equal(extractLastAssistantMessage(jsonl), "final summary");
  });

  it("handles assistant content as an array of text blocks", () => {
    const jsonl = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
      },
    });
    assert.equal(extractLastAssistantMessage(jsonl), "part one part two");
  });

  it("returns empty string when no assistant messages are present", () => {
    const jsonl = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });
    assert.equal(extractLastAssistantMessage(jsonl), "");
  });

  it("returns empty string for malformed input without throwing", () => {
    assert.equal(extractLastAssistantMessage("not json\n{also bad"), "");
    assert.equal(extractLastAssistantMessage(""), "");
  });
});
