import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchSubagent, type RunningSubagent } from "../../pi-extension/subagents/index.ts";

function assistantLine(text: string) {
  return JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: {
        input: 120,
        output: 60,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 180,
        cost: { total: 0.002 },
      },
      stopReason: "endTurn",
    },
  }) + "\n";
}

describe("watchSubagent pane pi abort returns accumulated partials", () => {
  it("abort after first tick: result has error=cancelled, transcript, and usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pane-pi-abort-"));
    try {
      const sessionFile = join(dir, "session.jsonl");
      // Pre-populate two assistant messages so the first tick accumulates them.
      writeFileSync(sessionFile, assistantLine("first") + assistantLine("second"));

      const running: RunningSubagent = {
        id: "pi-abort-test",
        name: "PiAbortTest",
        task: "test abort",
        backend: "pane",
        surface: "fake-surface",
        sessionFile,
        startTime: Date.now(),
      };

      const controller = new AbortController();
      const updates: any[] = [];

      // Abort after the first poll tick (interval=1000ms) fires and processes entries.
      const abortTimer = setTimeout(() => controller.abort(), 1200);

      const result = await watchSubagent(running, controller.signal, {
        onUpdate: (partial) => updates.push(partial),
      });
      clearTimeout(abortTimer);

      assert.equal(result.error, "cancelled", "error should be 'cancelled'");
      assert.ok(Array.isArray(result.transcript), "transcript should be an array");
      assert.ok((result.transcript?.length ?? 0) >= 2, `transcript.length should be >= 2, got ${result.transcript?.length}`);
      assert.ok((result.usage?.turns ?? 0) >= 1, `usage.turns should be >= 1, got ${result.usage?.turns}`);
      assert.ok((result.usage?.input ?? 0) > 0, `usage.input should be > 0, got ${result.usage?.input}`);
      assert.ok(updates.length >= 1, `at least one onUpdate should have fired, got ${updates.length}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
