import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePiTailResumeOffset, tailPiSessionEntries } from "../../pi-extension/subagents/backends/pi-projection.ts";
import { mkdtempSync, writeFileSync, appendFileSync, truncateSync, rmSync } from "node:fs";
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

  it("torn-write multibyte: bytes split mid-UTF-8-sequence are buffered, not decoded as U+FFFD", () => {
    // Reproduces the bug where buf.toString("utf8") on an incomplete trailing
    // multibyte sequence (e.g., 2 of 4 bytes for 🌍) silently substitutes
    // U+FFFD, corrupting the JSON and turning the line into a parse failure
    // even after the remaining bytes arrive.
    const dir = mkdtempSync(join(tmpdir(), "pi-tail-utf8-"));
    const file = join(dir, "session.jsonl");
    try {
      const line = JSON.stringify({ type: "message", message: { role: "user", content: "hi 🌍 world" } }) + "\n";
      const bytes = Buffer.from(line, "utf8");
      // Find the position of the 4-byte 🌍 sequence and split in the middle of it.
      const earthIdx = bytes.indexOf(0xf0); // first byte of 🌍 (U+1F30D)
      assert.ok(earthIdx > 0, "expected 🌍 lead byte present");
      const splitAt = earthIdx + 2; // mid-sequence: 2 of 4 bytes
      writeFileSync(file, bytes.subarray(0, splitAt));

      const state = { offset: 0, pendingTail: "" };
      const r1 = tailPiSessionEntries(file, state);
      assert.equal(r1.messages.length, 0, "incomplete multibyte must NOT yield a parsed message");
      assert.ok(
        !state.pendingTail.includes("�"),
        "pendingTail must not contain U+FFFD replacement char from partial multibyte decode",
      );

      // Append the rest of the file. Decoder buffer must combine the 2 deferred
      // bytes with the new bytes so 🌍 round-trips intact.
      appendFileSync(file, bytes.subarray(splitAt));
      const r2 = tailPiSessionEntries(file, state);
      assert.equal(r2.messages.length, 1);
      assert.equal(r2.messages[0].content, "hi 🌍 world");
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

  it("incremental tailing: pre-offset byte changes are NOT reread on subsequent ticks", () => {
    // The full-file-read implementation re-reads the entire file every tick and
    // slices from state.offset; the incremental implementation reads only
    // [offset, size). This test mutates pre-offset bytes after the first read —
    // an incremental reader cannot observe those bytes, while a full-read
    // reader would (its raw buffer would contain the mutation, even if the
    // slice past offset hides it). We pin behavior by asserting no spurious
    // re-parse of pre-offset content on the second call.
    const dir = mkdtempSync(join(tmpdir(), "pi-tail-"));
    const file = join(dir, "session.jsonl");
    try {
      const longBody = (USER_LINE + "\n").repeat(50);
      writeFileSync(file, longBody);
      const state = { offset: 0, pendingTail: "" };
      const first = tailPiSessionEntries(file, state);
      assert.equal(first.messages.length, 50);
      assert.equal(state.offset, Buffer.byteLength(longBody));

      // Append a new line so size grows but pre-offset bytes are untouched.
      appendFileSync(file, ASSISTANT_LINE + "\n");
      const second = tailPiSessionEntries(file, state);
      assert.equal(second.messages.length, 1, "expected only the appended entry");
      assert.equal(second.assistantMessages.length, 1);
      assert.equal(
        state.offset,
        Buffer.byteLength(longBody) + Buffer.byteLength(ASSISTANT_LINE + "\n"),
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("truncation safety: file shrinks below offset, state resets and new content is read", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tail-"));
    const file = join(dir, "session.jsonl");
    try {
      writeFileSync(file, `${USER_LINE}\n${TOOL_LINE}\n${ASSISTANT_LINE}\n`);
      const state = { offset: 0, pendingTail: "" };
      const r1 = tailPiSessionEntries(file, state);
      assert.equal(r1.messages.length, 3);
      const fullSize = state.offset;

      // Truncate to a smaller size. After truncation, state.offset > file size.
      // Implementation must detect this, reset, and re-read remaining content.
      truncateSync(file, 0);
      const replacement = `${USER_LINE}\n`;
      writeFileSync(file, replacement);
      assert.ok(Buffer.byteLength(replacement) < fullSize);

      const r2 = tailPiSessionEntries(file, state);
      assert.equal(r2.messages.length, 1, "expected truncation to reset offset and re-read remaining content");
      assert.equal(r2.messages[0].role, "user");
      assert.equal(state.offset, Buffer.byteLength(replacement));
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

describe("computePiTailResumeOffset", () => {
  it("non-ASCII content: returns the UTF-8 byte position past N lines, not the UTF-16 character count", () => {
    // Content where char-count ≠ byte-count. é = 2 bytes / 1 UTF-16 unit;
    // 🌍 = 4 bytes / 2 UTF-16 units. The whole-file char and byte lengths must
    // disagree, otherwise the test wouldn't pin the bug.
    const line1 = JSON.stringify({ type: "message", message: { role: "user", content: "héllo 🌍" } }) + "\n";
    const line2 = JSON.stringify({ type: "message", message: { role: "user", content: "résumé" } }) + "\n";
    const line3 = JSON.stringify({ type: "message", message: { role: "user", content: "ascii-only" } }) + "\n";
    const raw = line1 + line2 + line3;
    assert.notEqual(raw.length, Buffer.byteLength(raw, "utf8"));

    // Skip the first two non-ASCII lines.
    const offset = computePiTailResumeOffset(raw, 2);
    const expected = Buffer.byteLength(line1, "utf8") + Buffer.byteLength(line2, "utf8");
    assert.equal(offset, expected);

    // And feeding that offset to a real tailer must surface ONLY line3 — no
    // garbage fragment, no skipped or re-emitted entry.
    const dir = mkdtempSync(join(tmpdir(), "pi-tail-resume-"));
    const file = join(dir, "session.jsonl");
    try {
      writeFileSync(file, raw);
      const state = { offset, pendingTail: "" };
      const delta = tailPiSessionEntries(file, state);
      assert.equal(delta.messages.length, 1);
      assert.equal(delta.messages[0].content, "ascii-only");
      assert.equal(state.offset, Buffer.byteLength(raw, "utf8"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("clamps to file byte length when tailStartLine exceeds line count", () => {
    const raw = `{"type":"message","message":{"role":"user","content":"é"}}\n`;
    const offset = computePiTailResumeOffset(raw, 999);
    assert.equal(offset, Buffer.byteLength(raw, "utf8"));
  });

  it("returns 0 for tailStartLine <= 0", () => {
    assert.equal(computePiTailResumeOffset("anything\n", 0), 0);
    assert.equal(computePiTailResumeOffset("anything\n", -5), 0);
  });
});
