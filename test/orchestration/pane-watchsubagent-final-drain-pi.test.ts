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

function userLine(text: string) {
  return JSON.stringify({
    type: "message",
    message: { role: "user", content: text },
  }) + "\n";
}

describe("watchSubagent pane pi final drain", () => {
  it("populates transcript/usage when pi run finishes before the first poll tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pane-pi-fast-"));
    try {
      const sessionFile = join(dir, "session.jsonl");
      writeFileSync(sessionFile, assistantLine("done") + userLine("ack"));
      // Pre-write .exit so pollForExit returns on its FIRST iteration before
      // ever firing onTick. The watcher must still drain the session file
      // before resolving.
      writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));

      const running: RunningSubagent = {
        id: "pi-fast",
        name: "PiFast",
        task: "test",
        backend: "pane",
        surface: "fake-surface",
        sessionFile,
        startTime: Date.now(),
        cli: "pi",
      };
      const updates: any[] = [];

      const result = await watchSubagent(running, new AbortController().signal, {
        onUpdate: (partial) => updates.push(partial),
      });

      assert.ok(
        result.transcript && result.transcript.length >= 2,
        `expected transcript populated by final drain, got ${result.transcript?.length ?? 0}`,
      );
      assert.equal(result.usage?.turns, 1);
      assert.equal(result.usage?.input, 100);
      assert.equal(result.usage?.output, 50);
      assert.ok(updates.length >= 1, "expected at least one onUpdate from final drain");
      assert.ok(updates.at(-1).transcript.length >= 2);
      assert.equal(updates.at(-1).usage.turns, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures entries appended between the last tick and process completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pane-pi-final-"));
    try {
      const sessionFile = join(dir, "session.jsonl");
      // Initial entry seen by the first tick.
      writeFileSync(sessionFile, assistantLine("first"));

      const running: RunningSubagent = {
        id: "pi-final-drain",
        name: "PiFinalDrain",
        task: "test",
        backend: "pane",
        surface: "fake-surface",
        sessionFile,
        startTime: Date.now(),
        cli: "pi",
      };
      const updates: any[] = [];

      // After the first tick has fired, append a second assistant entry and
      // write the .exit sidecar in the same step so pollForExit's next
      // iteration short-circuits on .exit BEFORE another onTick runs.
      const finishTimer = setTimeout(() => {
        try {
          appendFileSync(sessionFile, assistantLine("second"));
          writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
        } catch {}
      }, 1100);

      const result = await watchSubagent(running, new AbortController().signal, {
        onUpdate: (partial) => updates.push(partial),
      });
      clearTimeout(finishTimer);

      const assistantTurns = result.transcript?.filter((m) => m.role === "assistant") ?? [];
      assert.equal(
        assistantTurns.length,
        2,
        `expected final drain to capture both assistant entries, got ${assistantTurns.length}`,
      );
      assert.equal(result.usage?.turns, 2);
      assert.equal(result.usage?.input, 200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
