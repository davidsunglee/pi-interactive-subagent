// review-v6 blocker: runPiHeadless must reserve `caller_ping` and
// `subagent_done` in the `--tools` allowlist so pi-backed async orchestrations
// can actually emit the `blocked` lifecycle state even when the agent
// frontmatter declares a restrictive `tools:` list.
//
// This test pins the contract at the spawn boundary: whatever a future refactor
// does inside `runPiHeadless`, the argv handed to pi must carry the lifecycle
// tools in the `--tools` arg.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("runPiHeadless tools arg reserves lifecycle tools", () => {
  let backendModule: any;
  let lastSpawn: { cmd: string; args: string[] } | null = null;

  function makeFakeProc() {
    const ee = new EventEmitter() as any;
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.killed = false;
    ee.kill = () => true;
    queueMicrotask(() => {
      ee.emit("exit", 0);
      ee.emit("close", 0);
    });
    return ee;
  }

  before(async () => {
    backendModule = await import("../../pi-extension/subagents/backends/headless.ts");
    backendModule.__test__.setSpawn((cmd: string, args: string[]) => {
      lastSpawn = { cmd, args };
      return makeFakeProc();
    });
  });

  after(() => {
    backendModule.__test__.restoreSpawn();
  });

  const ctx = {
    sessionManager: {
      getSessionFile: () => "/tmp/fake.jsonl",
      getSessionId: () => "test",
      getSessionDir: () => "/tmp",
    } as any,
    cwd: "/tmp",
  };

  it("argv includes caller_ping and subagent_done in the --tools allowlist when tools is restrictive", async () => {
    lastSpawn = null;
    const backend = backendModule.makeHeadlessBackend(ctx);
    const handle = await backend.launch(
      { name: "t", task: "hello", cli: "pi", tools: "read, bash" },
      false,
    );
    await backend.watch(handle);

    assert.ok(lastSpawn, "pi should have been spawned");
    assert.equal(lastSpawn!.cmd, "pi");
    const idx = lastSpawn!.args.indexOf("--tools");
    assert.notEqual(idx, -1, "--tools must be present on the restrictive path");
    const tools = new Set(lastSpawn!.args[idx + 1].split(","));
    assert.ok(tools.has("read"));
    assert.ok(tools.has("bash"));
    assert.ok(
      tools.has("caller_ping"),
      "caller_ping must be in --tools so pi-backed headless children can ping the parent and enter the blocked lifecycle",
    );
    assert.ok(
      tools.has("subagent_done"),
      "subagent_done must be in --tools so pi-backed headless children can signal terminal completion",
    );
  });

  it("does not emit --tools when the caller specified no tool restriction", async () => {
    lastSpawn = null;
    const backend = backendModule.makeHeadlessBackend(ctx);
    const handle = await backend.launch(
      { name: "t", task: "hello", cli: "pi" },
      false,
    );
    await backend.watch(handle);

    assert.ok(lastSpawn, "pi should have been spawned");
    assert.equal(
      lastSpawn!.args.includes("--tools"),
      false,
      "unrestricted launches must not emit --tools (lifecycle tools are already available under pi defaults)",
    );
  });

  it("argv includes orchestration token in the --tools allowlist when tools requests one", async () => {
    lastSpawn = null;
    const backend = backendModule.makeHeadlessBackend(ctx);
    const handle = await backend.launch(
      { name: "t", task: "hello", cli: "pi", tools: "read, subagent_run_serial" },
      false,
    );
    await backend.watch(handle);
    assert.ok(lastSpawn);
    const idx = lastSpawn!.args.indexOf("--tools");
    assert.notEqual(idx, -1);
    const tools = new Set(lastSpawn!.args[idx + 1].split(","));
    assert.ok(tools.has("read"));
    assert.ok(tools.has("subagent_run_serial"));
    assert.ok(tools.has("caller_ping"));
    assert.ok(tools.has("subagent_done"));
  });

  it("headless launch rejects when spawning: false collides with an orchestration token in tools:", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-tools-conflict-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "bad-coord.md"),
        "---\nname: bad-coord\ntools: subagent_run_serial\nspawning: false\n---\nbad coord body\n",
        "utf8",
      );
      lastSpawn = null;
      const backend = backendModule.makeHeadlessBackend(ctx);
      await assert.rejects(
        () => backend.launch({ name: "t", task: "hi", cli: "pi", agent: "bad-coord", cwd: root }, false),
        /subagent_run_serial/,
      );
      assert.equal(lastSpawn, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
