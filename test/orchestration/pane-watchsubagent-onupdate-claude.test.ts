import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchSubagent, type RunningSubagent } from "../../pi-extension/subagents/index.ts";

function assistantEvent(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  }) + "\n";
}

function resultEvent(): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "all done",
    num_turns: 2,
    total_cost_usd: 0.0042,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    },
  }) + "\n";
}

describe("watchSubagent pane Claude onUpdate (live tail)", () => {
  it("tails the active jsonl and fires onUpdate with accumulated transcript and usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pane-claude-watch-"));
    try {
      const jsonl = join(dir, "abc-123.jsonl");
      const sentinel = join(dir, "sentinel");
      const pointer = sentinel + ".transcript";

      // Live data (assistant + result) is in place BEFORE watch starts so the
      // very first onTick observes it and emits a live onUpdate.
      writeFileSync(jsonl, assistantEvent("hi from claude") + resultEvent());
      writeFileSync(pointer, jsonl);

      const running: RunningSubagent = {
        id: "claude-watch",
        name: "ClaudeWatch",
        task: "test",
        backend: "pane",
        surface: "fake-surface",
        sessionFile: join(dir, "ignored-pi-session.jsonl"),
        sentinelFile: sentinel,
        cli: "claude",
        startTime: Date.now(),
      };
      const updates: any[] = [];

      // Defer sentinel creation so pollForExit fires onTick at least once.
      const sentinelTimer = setTimeout(() => {
        try { writeFileSync(sentinel, "all done"); } catch {}
      }, 500);

      const result = await watchSubagent(running, new AbortController().signal, {
        onUpdate: (partial) => updates.push(partial),
      });
      clearTimeout(sentinelTimer);

      assert.ok(updates.length >= 1, "expected at least one onUpdate partial");
      const last = updates.at(-1);
      assert.equal(last.transcript.length, 1, "expected the assistant message");
      assert.equal(last.transcript[0].role, "assistant");
      assert.equal(last.usage.turns, 2, "result event should set turns");
      assert.equal(last.usage.input, 100);
      assert.equal(last.usage.output, 50);
      assert.equal(running.usage?.turns, 2);
      // Final result also carries transcript/usage (success or catch path).
      assert.ok(result.transcript && result.transcript.length === 1);
      assert.equal(result.usage?.turns, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
