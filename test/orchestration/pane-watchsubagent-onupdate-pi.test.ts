import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { total: 0.001 },
      },
      stopReason: "endTurn",
    },
  }) + "\n";
}

function toolResultLine() {
  return JSON.stringify({
    type: "message",
    message: { role: "toolResult", content: "tool ok", toolCallId: "tool-1", toolName: "read" },
  }) + "\n";
}

describe("watchSubagent pane pi onUpdate", () => {
  it("emits accumulated transcript and usage and resolves with them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pane-pi-watch-"));
    try {
      const sessionFile = join(dir, "session.jsonl");
      // Pre-populate the session file BEFORE starting watch so the very first
      // onTick observes the entries and emits an onUpdate. We then signal exit
      // via the .exit sidecar a moment later so pollForExit terminates cleanly.
      writeFileSync(sessionFile, assistantLine("hi") + toolResultLine());
      const running: RunningSubagent = {
        id: "pi-watch",
        name: "PiWatch",
        task: "test",
        backend: "pane",
        surface: "fake-surface",
        sessionFile,
        startTime: Date.now(),
      };
      const updates: any[] = [];

      // Defer exit signaling so pollForExit fires onTick at least once.
      const exitTimer = setTimeout(() => {
        try { writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" })); } catch {}
      }, 1100);

      const result = await watchSubagent(running, new AbortController().signal, {
        onUpdate: (partial) => updates.push(partial),
      });
      clearTimeout(exitTimer);

      assert.ok(updates.length >= 1, "expected at least one onUpdate partial");
      assert.ok(updates.at(-1).transcript.length >= 2);
      assert.equal(updates.at(-1).usage.turns, 1);
      assert.equal(running.usage?.turns, 1);
      assert.ok(result.transcript && result.transcript.length >= 2);
      assert.equal(result.usage?.turns, 1);
      assert.equal(result.usage?.input, 100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
