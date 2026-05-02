import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, truncateSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  tailJsonlLines,
  type JsonlTailState,
} from "../../pi-extension/subagents/backends/jsonl-tail.ts";

// The Claude pane tail path in pi-extension/subagents/index.ts shares this
// helper with the Pi tailer, so a regression here covers both the Pi tail
// helper and the Claude pane tail path's torn-write fault tolerance for
// non-ASCII content.
describe("tailJsonlLines (shared by Pi tail + Claude pane tail)", () => {
  it("returns complete lines and stashes incomplete trailing line", () => {
    const dir = mkdtempSync(join(tmpdir(), "jsonl-tail-"));
    const file = join(dir, "stream.jsonl");
    try {
      writeFileSync(file, `{"a":1}\n{"b":2}\n{"c":`);
      const state: JsonlTailState = { offset: 0, pendingTail: "" };
      const r = tailJsonlLines(file, state);
      assert.deepEqual(r.lines, [`{"a":1}`, `{"b":2}`]);
      assert.equal(state.pendingTail, `{"c":`);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("torn-write multibyte: split mid-UTF-8 sequence, decoder buffers partial bytes", () => {
    // Mirrors the Claude transcript scenario: a JSONL line ending in a 4-byte
    // emoji that gets read across two ticks. A naive `buf.toString('utf8')`
    // call decodes the leading 2 bytes of 🌍 (U+1F30D) as U+FFFD, which then
    // gets concatenated with later bytes — so the JSON.parse call on the
    // assembled line fails permanently. StringDecoder must hold those 2
    // bytes until the rest arrives.
    const dir = mkdtempSync(join(tmpdir(), "jsonl-tail-utf8-"));
    const file = join(dir, "claude.jsonl");
    try {
      const claudeLine = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "résumé 🌍 done" }] },
      }) + "\n";
      const bytes = Buffer.from(claudeLine, "utf8");
      const earthIdx = bytes.indexOf(0xf0);
      assert.ok(earthIdx > 0, "expected 4-byte 🌍 lead byte present");
      const splitAt = earthIdx + 2; // mid-multibyte: 2 of 4 bytes available

      writeFileSync(file, bytes.subarray(0, splitAt));
      const state: JsonlTailState = { offset: 0, pendingTail: "" };
      const r1 = tailJsonlLines(file, state);
      assert.equal(r1.lines.length, 0, "no complete line yet, mid-multibyte tail");
      assert.ok(
        !state.pendingTail.includes("�"),
        "pendingTail must not contain U+FFFD from a partial-multibyte decode",
      );
      // Offset advanced past read bytes so we don't re-read them.
      assert.equal(state.offset, splitAt);

      appendFileSync(file, bytes.subarray(splitAt));
      const r2 = tailJsonlLines(file, state);
      assert.equal(r2.lines.length, 1);
      const parsed = JSON.parse(r2.lines[0]);
      assert.equal(parsed.message.content[0].text, "résumé 🌍 done");
      assert.equal(state.pendingTail, "");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("truncation resets decoder so stale partial bytes don't poison new content", () => {
    const dir = mkdtempSync(join(tmpdir(), "jsonl-tail-trunc-"));
    const file = join(dir, "stream.jsonl");
    try {
      // Fill with a line that ends mid-emoji so the decoder buffers partial
      // bytes after tick 1.
      const long = JSON.stringify({ pad: "x".repeat(64), msg: "hi 🌍" }) + "\n";
      const longBytes = Buffer.from(long, "utf8");
      const earthIdx = longBytes.indexOf(0xf0);
      const splitAt = earthIdx + 2;
      writeFileSync(file, longBytes.subarray(0, splitAt));

      const state: JsonlTailState = { offset: 0, pendingTail: "" };
      tailJsonlLines(file, state);
      assert.equal(state.offset, splitAt);

      // Truncate to zero and replace with shorter, fully-ASCII content. Size
      // shrinks below state.offset → tailJsonlLines must reset offset, tail,
      // AND decoder. If the decoder is NOT reset, its 2 leftover bytes prepend
      // a U+FFFD onto the first new character.
      truncateSync(file, 0);
      const fresh = `{"msg":"clean"}\n`;
      writeFileSync(file, fresh);
      assert.ok(Buffer.byteLength(fresh) < splitAt);

      const r = tailJsonlLines(file, state);
      assert.deepEqual(r.lines, [`{"msg":"clean"}`]);
      assert.ok(!state.pendingTail.includes("�"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("missing path returns empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "jsonl-tail-miss-"));
    try {
      const state: JsonlTailState = { offset: 0, pendingTail: "" };
      const r = tailJsonlLines(join(dir, "nope.jsonl"), state);
      assert.deepEqual(r.lines, []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
