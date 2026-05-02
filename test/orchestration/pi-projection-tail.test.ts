import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tailPiSessionEntries } from "../../pi-extension/subagents/backends/pi-projection.ts";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ASSISTANT_LINE = JSON.stringify({ type: "message", message: { role: "assistant", content: "hi", usage: {} } });
const USER_LINE = JSON.stringify({ type: "message", message: { role: "user", content: "hello" } });
const TOOL_LINE = JSON.stringify({ type: "message", message: { role: "toolResult", content: "result", toolCallId: "tc-1", toolName: "read", isError: false } });

describe("tailPiSessionEntries", () => {
  it("clean read: returns all three messages and advances offset", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tail-"));
    const file = join(dir, "session.jsonl");
    try {
      writeFileSync(file, `${ASSISTANT_LINE}\n${USER_LINE}\n${TOOL_LINE}\n`);
      const state = { offset: 0, pendingTail: "" };
      const result = tailPiSessionEntries(file, state);
      assert.equal(result.messages.length, 3);
      assert.equal(result.assistantMessages.length, 1);
      assert.equal(result.assistantMessages[0].role, "assistant");
      const fileSize = Buffer.byteLength(`${ASSISTANT_LINE}\n${USER_LINE}\n${TOOL_LINE}\n`);
      assert.equal(state.offset, fileSize);
      assert.equal(state.pendingTail, "");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("torn-write tail preservation: stashes incomplete line, completes on next call", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tail-"));
    const file = join(dir, "session.jsonl");
    try {
      const prefix = ASSISTANT_LINE.slice(0, 20);
      writeFileSync(file, `${USER_LINE}\n${TOOL_LINE}\n${prefix}`);
      const state = { offset: 0, pendingTail: "" };
      const result1 = tailPiSessionEntries(file, state);
      assert.equal(result1.messages.length, 2);
      assert.equal(state.pendingTail, prefix);

      const suffix = ASSISTANT_LINE.slice(20);
      appendFileSync(file, `${suffix}\n`);
      const result2 = tailPiSessionEntries(file, state);
      assert.equal(result2.messages.length, 1);
      assert.equal(result2.messages[0].role, "assistant");
      assert.equal(state.pendingTail, "");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("malformed line skipped: bad JSON is skipped, valid line is returned", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tail-"));
    const file = join(dir, "session.jsonl");
    try {
      const validLine = JSON.stringify({ type: "message", message: { role: "user", content: "ok" } });
      writeFileSync(file, `garbage{not json\n${validLine}\n`);
      const state = { offset: 0, pendingTail: "" };
      let result: ReturnType<typeof tailPiSessionEntries>;
      assert.doesNotThrow(() => { result = tailPiSessionEntries(file, state); });
      assert.equal(result!.messages.length, 1);
      assert.equal(result!.messages[0].content, "ok");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("empty file: returns empty arrays and does not throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tail-"));
    try {
      const nonExistent = join(dir, "nonexistent.jsonl");
      const state = { offset: 0, pendingTail: "" };
      let result: ReturnType<typeof tailPiSessionEntries>;
      assert.doesNotThrow(() => { result = tailPiSessionEntries(nonExistent, state); });
      assert.equal(result!.messages.length, 0);
      assert.equal(result!.assistantMessages.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
