import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    result: "fin",
    num_turns: 1,
    total_cost_usd: 0.001,
    usage: {
      input_tokens: 7,
      output_tokens: 3,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }) + "\n";
}

describe("watchSubagent pane Claude post-mortem catch-up", () => {
  it("re-parses the archived jsonl when the live tail saw nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pane-claude-postmortem-"));
    try {
      const jsonl = join(dir, "post-mortem-id.jsonl");
      const sentinel = join(dir, "sentinel");
      const pointer = sentinel + ".transcript";

      // Pre-create the sentinel so pollForExit returns "sentinel" on the very
      // first iteration without ever firing onTick — guaranteeing the live
      // tail captures nothing. The pointer + jsonl appear inside the bounded
      // wait that the success path performs after pollForExit returns.
      writeFileSync(sentinel, "");

      const writeTimer = setTimeout(() => {
        try {
          writeFileSync(jsonl, assistantEvent("only-in-archive") + resultEvent());
          writeFileSync(pointer, jsonl);
        } catch {}
      }, 100);

      const running: RunningSubagent = {
        id: "claude-postmortem",
        name: "ClaudePostMortem",
        task: "test",
        backend: "pane",
        surface: "fake-surface",
        sessionFile: join(dir, "ignored.jsonl"),
        sentinelFile: sentinel,
        cli: "claude",
        startTime: Date.now(),
      };
      const updates: any[] = [];

      const result = await watchSubagent(running, new AbortController().signal, {
        onUpdate: (partial) => updates.push(partial),
      });
      clearTimeout(writeTimer);

      // Catch-up must produce exactly one onUpdate, with the archived assistant
      // message and the terminal usage parsed from the archived result event.
      assert.ok(updates.length >= 1, "post-mortem catch-up must fire onUpdate");
      const last = updates.at(-1);
      assert.equal(last.transcript.length, 1);
      assert.equal(last.transcript[0].role, "assistant");
      assert.equal(last.usage.turns, 1);
      assert.equal(last.usage.input, 7);
      assert.equal(last.usage.output, 3);
      assert.ok(result.transcript && result.transcript.length === 1);
      assert.equal(result.usage?.turns, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
