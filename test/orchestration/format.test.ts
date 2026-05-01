import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatTokens,
  formatToolCall,
  formatUsageStats,
  extractDisplayItems,
  getFinalOutput,
  COLLAPSED_ITEM_COUNT,
} from "../../pi-extension/subagents/ui/format.ts";
import type { TranscriptMessage } from "../../pi-extension/subagents/backends/types.ts";

describe("format module", () => {
  describe("formatTokens", () => {
    it("formats 0 as '0'", () => {
      assert.equal(formatTokens(0), "0");
    });

    it("formats 999 as '999'", () => {
      assert.equal(formatTokens(999), "999");
    });

    it("formats 1500 as '1.5k'", () => {
      assert.equal(formatTokens(1500), "1.5k");
    });

    it("formats 15000 as '15k'", () => {
      assert.equal(formatTokens(15000), "15k");
    });

    it("formats 1500000 as '1.5M'", () => {
      assert.equal(formatTokens(1500000), "1.5M");
    });
  });

  describe("formatUsageStats", () => {
    it("formats usage with turns, input, output, and cost", () => {
      const result = formatUsageStats({
        input: 1000,
        output: 500,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.001234,
        turns: 2,
      });
      assert(result.includes("2 turns"));
      assert(result.includes("↑1.0k"));
      assert(result.includes("↓500"));
      assert(result.includes("$0.0012"));
    });
  });

  describe("formatToolCall", () => {
    const fakeTheme = {
      fg: (color: string, text: string) => text,
    };

    it("formats bash command with truncation", () => {
      const result = formatToolCall(
        "bash",
        { command: "echo hello world this is a very long command" },
        fakeTheme as any,
      );
      assert(result.includes("echo hello world this is a very long command"));
    });

    it("formats bash command with 60-char truncation", () => {
      const longCmd = "a".repeat(70);
      const result = formatToolCall("bash", { command: longCmd }, fakeTheme as any);
      // Should include the first 60 chars truncated with ...
      assert(result.includes("..."));
    });

    it("formats read with file_path", () => {
      const result = formatToolCall(
        "read",
        { file_path: "/tmp/test.txt", offset: 1, limit: 10 },
        fakeTheme as any,
      );
      assert(result.includes("read"));
      assert(result.includes("test.txt"));
      assert(result.includes(":1-10"));
    });

    it("formats write with line count", () => {
      const result = formatToolCall(
        "write",
        { file_path: "/tmp/test.txt", content: "line1\nline2\nline3" },
        fakeTheme as any,
      );
      assert(result.includes("write"));
      assert(result.includes("test.txt"));
      assert(result.includes("3 lines"));
    });

    it("formats edit", () => {
      const result = formatToolCall(
        "edit",
        { file_path: "/tmp/test.txt", old_string: "old", new_string: "new" },
        fakeTheme as any,
      );
      assert(result.includes("edit"));
      assert(result.includes("test.txt"));
    });

    it("formats ls", () => {
      const result = formatToolCall("ls", { path: "/tmp" }, fakeTheme as any);
      assert(result.includes("ls"));
      assert(result.includes("/tmp"));
    });

    it("formats find", () => {
      const result = formatToolCall(
        "find",
        { pattern: "*.ts", path: "/tmp" },
        fakeTheme as any,
      );
      assert(result.includes("find"));
      assert(result.includes("*.ts"));
      assert(result.includes("/tmp"));
    });

    it("formats glob", () => {
      const result = formatToolCall(
        "glob",
        { pattern: "**/*.ts", path: "/tmp" },
        fakeTheme as any,
      );
      assert(result.includes("find"));
      assert(result.includes("**/*.ts"));
      assert(result.includes("/tmp"));
    });

    it("formats grep", () => {
      const result = formatToolCall(
        "grep",
        { pattern: "hello", path: "/tmp" },
        fakeTheme as any,
      );
      assert(result.includes("grep"));
      assert(result.includes("/hello/"));
      assert(result.includes("/tmp"));
    });

    it("formats default tool with args truncation", () => {
      const result = formatToolCall(
        "custom_tool",
        { param1: "value1", param2: "value2" },
        fakeTheme as any,
      );
      assert(result.includes("custom_tool"));
    });

    it("formats default tool with long args", () => {
      const longArg = "x".repeat(60);
      const result = formatToolCall(
        "custom_tool",
        { param: longArg },
        fakeTheme as any,
      );
      assert(result.includes("..."));
    });
  });

  describe("extractDisplayItems", () => {
    it("extracts text and tool calls from transcript", () => {
      const transcript: TranscriptMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "user message" }],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "assistant response" },
            {
              type: "toolCall",
              id: "1",
              name: "bash",
              arguments: { command: "ls" },
            },
          ],
        },
      ];

      const items = extractDisplayItems(transcript);
      assert.equal(items.length, 2);
      assert.equal(items[0].type, "text");
      assert.equal((items[0] as any).text, "assistant response");
      assert.equal(items[1].type, "toolCall");
      assert.equal((items[1] as any).name, "bash");
    });

    it("skips non-assistant messages", () => {
      const transcript: TranscriptMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "user message" }],
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "tool result" }],
        },
      ];

      const items = extractDisplayItems(transcript);
      assert.equal(items.length, 0);
    });
  });

  describe("getFinalOutput", () => {
    it("returns text from last assistant message", () => {
      const transcript: TranscriptMessage[] = [
        {
          role: "assistant",
          content: [{ type: "text", text: "first response" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "user follow up" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "final response" }],
        },
      ];

      const result = getFinalOutput(transcript);
      assert.equal(result, "final response");
    });

    it("returns empty string if no assistant messages", () => {
      const transcript: TranscriptMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "user message" }],
        },
      ];

      const result = getFinalOutput(transcript);
      assert.equal(result, "");
    });

    it("skips non-text content in final assistant message", () => {
      const transcript: TranscriptMessage[] = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "1", name: "bash", arguments: {} },
            { type: "text", text: "final text" },
          ],
        },
      ];

      const result = getFinalOutput(transcript);
      assert.equal(result, "final text");
    });
  });

  describe("COLLAPSED_ITEM_COUNT", () => {
    it("is exported as 10", () => {
      assert.equal(COLLAPSED_ITEM_COUNT, 10);
    });
  });
});
