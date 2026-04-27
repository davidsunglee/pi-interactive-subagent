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

  it("preserves the prior textual summary when the last assistant entry is tool-use-only (review-v1 finding 3)", () => {
    // Real Claude transcripts often look like: assistant emits a summary in
    // one entry, then emits a separate assistant entry that is purely the
    // subagent_done tool_use. The fallback must return the summary, not "".
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "go" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "SPEC_WRITTEN: /tmp/spec.md" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "subagent_done", input: {} },
          ],
        },
      }),
    ].join("\n");
    assert.equal(extractLastAssistantMessage(jsonl), "SPEC_WRITTEN: /tmp/spec.md");
  });

  it("preserves the prior summary when a later assistant entry has empty/whitespace text", () => {
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "real summary" },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "   " }] },
      }),
    ].join("\n");
    assert.equal(extractLastAssistantMessage(jsonl), "real summary");
  });
});
