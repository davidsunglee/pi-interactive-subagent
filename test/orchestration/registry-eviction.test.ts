// test/orchestration/registry-eviction.test.ts
//
// Review-v1 finding #4 (minor): completed async orchestrations must not
// retain heavy per-task payloads (full headless transcripts, usage arrays)
// in memory after the aggregated completion has been emitted. The aggregated
// completion is the sole delivery mechanism in v1; once it's out the door,
// retaining transcript[] / usage on the registry entry is dead weight.
//
// Lightweight bookkeeping (state, name, index, finalMessage, transcriptPath,
// sessionKey, exit metadata) is kept as a tiny tombstone so post-mortem
// inspection and idempotent cancel-on-terminal semantics keep working.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, type RegistryEmitter } from "../../pi-extension/orchestration/registry.ts";
import type { TranscriptMessage, UsageStats } from "../../pi-extension/subagents/backends/types.ts";

function makeEmitterSpy(): { emitter: RegistryEmitter; emitted: any[] } {
  const emitted: any[] = [];
  return { emitted, emitter: (p) => { emitted.push(p); } };
}

const heavyTranscript: TranscriptMessage[] = Array.from({ length: 100 }, (_, i) => ({
  role: "assistant",
  content: [{ type: "text", text: `line ${i} ${"x".repeat(200)}` }],
}));
const heavyUsage: UsageStats = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 1000, turns: 5,
};

describe("registry sheds heavy per-task payloads after completion (review-v1 #4)", () => {
  it("transcript and usage are dropped from the entry after the aggregated completion fires", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskLaunched(id, 0, { sessionKey: "s0" });
    reg.onTaskTerminal(id, 0, {
      name: "a", index: 0, state: "completed",
      finalMessage: "ok",
      transcriptPath: "/tmp/transcript.jsonl",
      exitCode: 0, elapsedMs: 1,
      transcript: heavyTranscript,
      usage: heavyUsage,
    });

    // The emitted aggregated completion still carries the full payload — the
    // parent has the heavy fields delivered exactly once.
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].results[0].transcript?.length, 100,
      "emitted aggregated completion includes the full transcript");
    assert.ok(emitted[0].results[0].usage,
      "emitted aggregated completion includes usage");

    // The registry entry sheds the heavy fields. Bookkeeping is preserved.
    const snap = reg.getSnapshot(id);
    assert.ok(snap, "lightweight tombstone retained for post-mortem inspection");
    assert.equal(snap!.tasks[0].state, "completed");
    assert.equal(snap!.tasks[0].finalMessage, "ok");
    assert.equal(snap!.tasks[0].transcriptPath, "/tmp/transcript.jsonl");
    assert.equal(snap!.tasks[0].transcript, undefined,
      "heavy transcript[] must be stripped from the registry entry after completion.");
    assert.equal(snap!.tasks[0].usage, undefined,
      "heavy usage payload must be stripped from the registry entry after completion.");
  });

  it("cancel after completion still returns alreadyTerminal:true (idempotent on the tombstone)", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskTerminal(id, 0, {
      name: "a", index: 0, state: "completed", exitCode: 0, elapsedMs: 1,
      transcript: heavyTranscript,
    });
    assert.equal(emitted.length, 1);
    const res = reg.cancel(id);
    assert.deepEqual(res, { ok: true, alreadyTerminal: true });
    assert.equal(emitted.length, 1, "no duplicate completion event");
  });
});
