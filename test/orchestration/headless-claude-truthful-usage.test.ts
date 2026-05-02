import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

// ── Test 1: runner-injection path (makeHeadlessBackendWithRunner) ─────────────

describe("headless Claude backend: truthful usage via runner injection", () => {
  it("partial with no usage emitted before any events has usage === undefined", async () => {
    let emit!: (snap: BackendResult) => void;
    let finish!: (r: BackendResult) => void;

    const backend = __test__.makeHeadlessBackendWithRunner(ctx, ({ emitPartial }) => {
      emit = emitPartial;
      return new Promise<BackendResult>((res) => { finish = res; });
    });

    const handle = await backend.launch({ name: "T", task: "t" } as any, false);

    const captured: BackendResult[] = [];
    const watcher = backend.watch(handle, undefined, (p) => captured.push(p));
    await new Promise((r) => setImmediate(r));

    // Simulate the initial state: no real usage yet — emit without usage field.
    emit({
      name: "T",
      finalMessage: "",
      transcriptPath: null,
      exitCode: 0,
      elapsedMs: 1,
    });
    await new Promise((r) => setImmediate(r));

    assert.ok(captured.length >= 1, `expected at least one partial; got ${captured.length}`);
    assert.equal(
      captured[captured.length - 1].usage,
      undefined,
      "partial emitted before any real usage event must have usage === undefined",
    );

    finish({ name: "T", finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 10 });
    await watcher;
  });

  it("partials after assistant events carry incrementing turns with zeroed token counts", async () => {
    let emit!: (snap: BackendResult) => void;
    let finish!: (r: BackendResult) => void;

    const backend = __test__.makeHeadlessBackendWithRunner(ctx, ({ emitPartial }) => {
      emit = emitPartial;
      return new Promise<BackendResult>((res) => { finish = res; });
    });

    const handle = await backend.launch({ name: "T", task: "t" } as any, false);

    const captured: BackendResult[] = [];
    const watcher = backend.watch(handle, undefined, (p) => captured.push(p));
    await new Promise((r) => setImmediate(r));

    // Simulate three assistant events — turns increment, token counts stay zero.
    for (let n = 1; n <= 3; n++) {
      emit({
        name: "T",
        finalMessage: `turn ${n}`,
        transcriptPath: null,
        exitCode: 0,
        elapsedMs: n * 100,
        usage: { turns: n, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
      });
      await new Promise((r) => setImmediate(r));
      const last = captured[captured.length - 1];
      assert.ok(last.usage, `partial after assistant event ${n} must have usage`);
      assert.equal(last.usage!.turns, n, `turns must be ${n} after ${n} assistant events`);
      assert.equal(last.usage!.input, 0, `input must be 0 mid-stream`);
      assert.equal(last.usage!.cost, 0, `cost must be 0 mid-stream`);
    }

    finish({ name: "T", finalMessage: "", transcriptPath: null, exitCode: 0, elapsedMs: 500 });
    await watcher;
  });

  it("partial after result event carries full token/cost usage", async () => {
    let emit!: (snap: BackendResult) => void;
    let finish!: (r: BackendResult) => void;

    const backend = __test__.makeHeadlessBackendWithRunner(ctx, ({ emitPartial }) => {
      emit = emitPartial;
      return new Promise<BackendResult>((res) => { finish = res; });
    });

    const handle = await backend.launch({ name: "T", task: "t" } as any, false);

    const captured: BackendResult[] = [];
    const watcher = backend.watch(handle, undefined, (p) => captured.push(p));
    await new Promise((r) => setImmediate(r));

    // Simulate the result event — full usage now available.
    emit({
      name: "T",
      finalMessage: "done",
      transcriptPath: null,
      exitCode: 0,
      elapsedMs: 200,
      usage: { turns: 3, input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 150 },
    });
    await new Promise((r) => setImmediate(r));

    const last = captured[captured.length - 1];
    assert.ok(last.usage, "partial after result event must have usage");
    assert.ok(last.usage!.input > 0, `input must be > 0 after result event; got ${last.usage!.input}`);
    assert.ok(last.usage!.cost > 0, `cost must be > 0 after result event; got ${last.usage!.cost}`);

    finish({ name: "T", finalMessage: "done", transcriptPath: null, exitCode: 0, elapsedMs: 500 });
    await watcher;
  });
});

// ── Test 2: production code path (makeHeadlessBackend with setSpawn) ──────────

describe("headless Claude backend: truthful usage end-to-end via fake spawn", () => {
  let backendModule: any;
  let lastFakeProc: any;

  function makeFakeProc() {
    const ee = new EventEmitter() as any;
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.killed = false;
    ee.kill = () => true;
    ee._send = (line: string) => {
      ee.stdout.emit("data", Buffer.from(line + "\n"));
    };
    ee._close = (code: number) => {
      ee.emit("exit", code);
      ee.emit("close", code);
    };
    lastFakeProc = ee;
    return ee;
  }

  before(async () => {
    backendModule = await import("../../pi-extension/subagents/backends/headless.ts");
    backendModule.__test__.setSpawn(() => makeFakeProc());
  });

  after(() => {
    backendModule.__test__.restoreSpawn();
  });

  it("emits truthful usage: turns increment on assistant events, input/cost from result event", async () => {
    const backend = backendModule.makeHeadlessBackend(ctx);

    const handle = await backend.launch({ name: "C", task: "do it", cli: "claude" } as any, false);
    await new Promise((r) => setImmediate(r));

    const captured: BackendResult[] = [];
    const watchPromise = backend.watch(handle, undefined, (p: BackendResult) => captured.push(p));
    await new Promise((r) => setImmediate(r));

    // 3 assistant events
    for (let i = 0; i < 3; i++) {
      lastFakeProc._send(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `turn ${i + 1}` }] },
      }));
      await new Promise((r) => setImmediate(r));
    }

    // Check that after the first assistant event, turns=1 and input=0
    const afterFirstAssistant = captured.find((p) => p.usage?.turns === 1);
    assert.ok(afterFirstAssistant, "must have a partial with usage.turns === 1 after first assistant event");
    assert.equal(afterFirstAssistant!.usage!.input, 0, "input must be 0 after first assistant event");

    // result event with full usage
    lastFakeProc._send(JSON.stringify({
      type: "result",
      subtype: "success",
      result: "completed",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      total_cost_usd: 0.005,
      num_turns: 3,
    }));
    await new Promise((r) => setImmediate(r));

    // Check partial after result event has input=100
    const afterResult = captured.find((p) => (p.usage?.input ?? 0) > 0);
    assert.ok(afterResult, "must have a partial with usage.input > 0 after result event");
    assert.equal(afterResult!.usage!.input, 100, "input must be 100 from result event");

    // Close the process
    lastFakeProc._close(0);
    const finalResult = await watchPromise;

    assert.equal(finalResult.usage?.input, 100, "final BackendResult must have usage.input === 100");
    assert.ok((finalResult.usage?.turns ?? 0) >= 1, "final BackendResult must have usage.turns >= 1");
  });
});
