import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../pi-extension/subagents/backends/headless.ts";
import type { BackendResult } from "../../pi-extension/subagents/backends/types.ts";

const ctx = {
  sessionManager: {
    getSessionFile: () => "/tmp/parent.jsonl",
    getSessionId: () => "sess-test",
    getSessionDir: () => "/tmp",
  } as any,
  cwd: "/tmp",
};

describe("headless backend onUpdate early-partial replay", () => {
  it("delivers a partial emitted before watch() attaches to the first onUpdate after attachment", async () => {
    let emit!: (snap: BackendResult) => void;
    let finish!: (r: BackendResult) => void;

    const backend = __test__.makeHeadlessBackendWithRunner(ctx, ({ emitPartial }) => {
      emit = emitPartial;
      return new Promise<BackendResult>((res) => { finish = res; });
    });

    const handle = await backend.launch({ name: "S", task: "t" } as any, false);

    // Emit BEFORE watch() attaches its onUpdate.
    emit({
      name: "S",
      finalMessage: "early-partial",
      transcriptPath: null,
      exitCode: 0,
      elapsedMs: 5,
    });

    const captured: BackendResult[] = [];
    const watcher = backend.watch(handle, undefined, (p) => captured.push(p));

    // Let watch() settle its attachment + replay microtask.
    await new Promise((r) => setImmediate(r));

    assert.ok(captured.length >= 1,
      `expected at least one replayed partial after attachment; got ${captured.length}`);
    assert.equal(captured[0].finalMessage, "early-partial",
      "first onUpdate call after attachment must be the buffered pre-attach partial");

    finish({
      name: "S",
      finalMessage: "final",
      transcriptPath: null,
      exitCode: 0,
      elapsedMs: 20,
    });
    const result = await watcher;
    assert.equal(result.finalMessage, "final");
  });

  it("continues to deliver partials emitted after attachment", async () => {
    let emit!: (snap: BackendResult) => void;
    let finish!: (r: BackendResult) => void;

    const backend = __test__.makeHeadlessBackendWithRunner(ctx, ({ emitPartial }) => {
      emit = emitPartial;
      return new Promise<BackendResult>((res) => { finish = res; });
    });

    const handle = await backend.launch({ name: "S", task: "t" } as any, false);

    const captured: BackendResult[] = [];
    const watcher = backend.watch(handle, undefined, (p) => captured.push(p));
    await new Promise((r) => setImmediate(r));

    emit({ name: "S", finalMessage: "after-1", transcriptPath: null, exitCode: 0, elapsedMs: 10 });
    emit({ name: "S", finalMessage: "after-2", transcriptPath: null, exitCode: 0, elapsedMs: 15 });

    finish({ name: "S", finalMessage: "final", transcriptPath: null, exitCode: 0, elapsedMs: 20 });
    await watcher;

    const messages = captured.map((c) => c.finalMessage);
    assert.ok(messages.includes("after-1"), `missing after-1 in ${JSON.stringify(messages)}`);
    assert.ok(messages.includes("after-2"), `missing after-2 in ${JSON.stringify(messages)}`);
  });
});
