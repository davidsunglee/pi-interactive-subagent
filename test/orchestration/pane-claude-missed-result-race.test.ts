import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchSubagent, type RunningSubagent } from "../../pi-extension/subagents/index.ts";

function assistantEvent(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  }) + "\n";
}

function resultEvent(): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    num_turns: 3,
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 200,
      output_tokens: 80,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }) + "\n";
}

describe("watchSubagent pane Claude missed-result race", () => {
  it("falls back to archive usage when the live tail observed messages but missed the result event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pane-claude-missed-"));
    try {
      const jsonl = join(dir, "missed.jsonl");
      const sentinel = join(dir, "sentinel");
      const pointer = sentinel + ".transcript";

      // Live tail sees the assistant message before the result is written.
      writeFileSync(jsonl, assistantEvent("partial visible to live tail"));
      writeFileSync(pointer, jsonl);

      const running: RunningSubagent = {
        id: "claude-missed",
        name: "ClaudeMissed",
        task: "test",
        backend: "pane",
        surface: "fake-surface",
        sessionFile: join(dir, "ignored.jsonl"),
        sentinelFile: sentinel,
        cli: "claude",
        startTime: Date.now(),
      };
      const updates: any[] = [];

      // After the first onTick has consumed the assistant line, append the
      // result event AND drop the sentinel together — pollForExit will return
      // "sentinel" on the next iteration without firing onTick again, so the
      // live tail never observes the result. The archive (= same jsonl) does.
      const writeTimer = setTimeout(() => {
        try {
          appendFileSync(jsonl, resultEvent());
          writeFileSync(sentinel, "");
        } catch {}
      }, 500);

      const result = await watchSubagent(running, new AbortController().signal, {
        onUpdate: (partial) => updates.push(partial),
      });
      clearTimeout(writeTimer);

      // First update from live tail: assistant present, no terminal usage yet.
      assert.ok(updates.length >= 2, "expected live + catch-up onUpdate calls");
      const live = updates[0];
      assert.equal(live.transcript.length, 1);
      assert.equal(live.usage.turns, 0, "live tail must not have seen the result event");

      // Catch-up update carries terminal usage from the archived result event,
      // and does not duplicate the already-captured assistant message.
      const last = updates.at(-1);
      assert.equal(last.transcript.length, 1, "catch-up must not duplicate live messages");
      assert.equal(last.usage.turns, 3);
      assert.equal(last.usage.input, 200);
      assert.equal(last.usage.output, 80);
      assert.equal(running.usage?.turns, 3);
      assert.ok(result.transcript && result.transcript.length === 1);
      assert.equal(result.usage?.turns, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
