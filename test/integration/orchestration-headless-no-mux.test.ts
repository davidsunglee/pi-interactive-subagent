import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTestAgents } from "./harness.ts";
import subagentsExtension from "../../pi-extension/subagents/index.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; }
  catch { return false; }
})();

function makeFakePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const renderers = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  const userMessages: string[] = [];
  const sentMessages: Array<{ message: any; opts?: any }> = [];
  return {
    tools,
    commands,
    renderers,
    userMessages,
    sentMessages,
    api: {
      registerTool(spec: any) { tools.set(spec.name, spec); },
      registerCommand(name: string, spec: any) { commands.set(name, spec); },
      registerMessageRenderer(type: string, fn: any) { renderers.set(type, fn); },
      sendUserMessage(message: string) { userMessages.push(message); },
      sendMessage(message: any, opts?: any) { sentMessages.push({ message, opts }); },
      on(event: string, fn: (ev: any, ctx: any) => void) {
        const arr = handlers.get(event) ?? [];
        arr.push(fn); handlers.set(event, arr);
      },
      emit(event: string, payload: any, ctx: any) {
        for (const fn of handlers.get(event) ?? []) fn(payload, ctx);
      },
    },
  };
}

const MUX_ENV_KEYS = [
  "PI_SUBAGENT_MODE",
  "CMUX_SOCKET_PATH",
  "TMUX",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "WEZTERM_UNIX_SOCKET",
];

async function runRegisteredTool(
  toolName: "subagent" | "subagent_run_serial" | "subagent_run_parallel",
  params: unknown,
  dir: string,
) {
  const fake = makeFakePi();
  subagentsExtension(fake.api as any);

  const tool = fake.tools.get(toolName);
  assert.ok(tool, `${toolName} must be registered`);

  const ctx = {
    sessionManager: {
      getSessionFile: () => join(dir, "parent.jsonl"),
      getSessionId: () => "parent",
      getSessionDir: () => dir,
    },
    cwd: dir,
  };
  fake.api.emit("session_start", {}, ctx);

  const origCwd = process.cwd();
  process.chdir(dir);
  try {
    const result = await tool.execute(
      "test-call-id",
      params,
      new AbortController().signal,
      () => {},
      ctx,
    );
    return { fake, result, ctx };
  } finally {
    process.chdir(origCwd);
  }
}

async function waitForSteer(
  fake: ReturnType<typeof makeFakePi>,
  customType: "subagent_result" | "subagent_ping",
  timeoutMs: number,
  opts?: { afterCount?: number },
): Promise<{ message: any; opts?: any }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const matches = fake.sentMessages.filter((m) => m.message?.customType === customType);
    const hit = matches[(opts?.afterCount ?? 0)];
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for steer message of type ${customType}; ` +
    `got: ${JSON.stringify(fake.sentMessages.map((m) => m.message?.customType))}`,
  );
}

async function assertNoAdditionalSteer(
  fake: ReturnType<typeof makeFakePi>,
  customType: "subagent_result" | "subagent_ping",
  count: number,
  timeoutMs: number,
) {
  await new Promise((r) => setTimeout(r, timeoutMs));
  const matches = fake.sentMessages.filter((m) => m.message?.customType === customType);
  assert.equal(matches.length, count,
    `expected no additional ${customType} steer messages after shutdown; got ${matches.length}`);
}

describe("orchestration-headless-no-mux (forced headless)", { skip: !PI_AVAILABLE, timeout: 180_000 }, () => {
  let saved: Record<string, string | undefined>;
  let dir: string;

  before(() => {
    saved = {};
    for (const k of MUX_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-orch-headless-"));
    copyTestAgents(dir);
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("subagent executes through the real registered tool callback under forced headless", async () => {
    const { fake, result } = await runRegisteredTool(
      "subagent",
      { name: "echo-bare", agent: "test-echo", task: "Reply with exactly: OK" },
      dir,
    );

    assert.doesNotMatch(JSON.stringify(result), /mux not available/i,
      "no-mux regression: bare subagent preflight blocked headless dispatch");
    assert.match(JSON.stringify(result.content), /launched/i,
      "bare subagent must return a 'launched in background' ack, not a backend error");

    const steer = await waitForSteer(fake, "subagent_result", 120_000);
    assert.equal(steer.message.details.exitCode, 0,
      `bare subagent headless run errored: ${JSON.stringify(steer.message.details)}`);
    assert.ok(typeof steer.message.content === "string" && steer.message.content.length > 0);
  });

  it("session_shutdown aborts a long-running bare subagent instead of letting it outlive the parent session", async () => {
    const { fake, result, ctx } = await runRegisteredTool(
      "subagent",
      { name: "long-bare", agent: "test-long-running", task: "Stay alive until aborted" },
      dir,
    );

    assert.doesNotMatch(JSON.stringify(result), /mux not available/i,
      "no-mux regression: bare subagent preflight blocked headless dispatch");
    assert.match(JSON.stringify(result.content), /launched/i,
      "bare subagent must launch before shutdown is exercised");

    const beforeShutdown = fake.sentMessages.filter((m) => m.message?.customType === "subagent_result").length;
    fake.api.emit("session_shutdown", {}, ctx);

    const steer = await waitForSteer(fake, "subagent_result", 20_000, { afterCount: beforeShutdown });
    assert.notEqual(steer.message.details?.exitCode, 0,
      `shutdown should abort the tracked bare subagent, not complete successfully: ${JSON.stringify(steer.message.details)}`);
    assert.match(JSON.stringify(steer.message), /abort|error|fail/i,
      `expected aborted/error result after session shutdown; got ${JSON.stringify(steer.message)}`);

    await assertNoAdditionalSteer(fake, "subagent_result", beforeShutdown + 1, 2_000);
  });

  it("/reload aborts a long-running bare headless subagent via the module-surviving abort signal (review finding 2)", async () => {
    // Run #1: extension registers, tool launches, subagent starts polling.
    const { fake, result } = await runRegisteredTool(
      "subagent",
      { name: "reload-bare", agent: "test-long-running", task: "Stay alive until reload" },
      dir,
    );
    assert.match(JSON.stringify(result.content), /launched/i,
      "bare subagent must launch before reload is exercised");

    const beforeReload = fake.sentMessages.filter(
      (m) => m.message?.customType === "subagent_result",
    ).length;

    // Simulate /reload's module-top cleanup path directly: re-import does not
    // run again in-process (a single ESM import is cached), but /reload's
    // runtime semantics are "abort the previous globalThis[POLL_ABORT_KEY] and
    // install a fresh one" — that is the exact signal the headless watcher was
    // composed with, so exercising it here validates the reload-survival fix.
    const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");
    const prev = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    assert.ok(prev, "module-load should have installed POLL_ABORT_KEY on globalThis");
    prev.abort();
    (globalThis as any)[POLL_ABORT_KEY] = new AbortController();

    // The watcher for the bare subagent composed its abort signal with the
    // (now-aborted) module signal, so it should propagate to a SIGTERM on the
    // child and resolve the watch promise with an aborted/error result.
    const steer = await waitForSteer(fake, "subagent_result", 20_000, {
      afterCount: beforeReload,
    });
    assert.notEqual(
      steer.message.details?.exitCode,
      0,
      `/reload should abort the tracked headless subagent, not let it complete: ${JSON.stringify(steer.message.details)}`,
    );
    assert.match(
      JSON.stringify(steer.message),
      /abort|error|fail/i,
      `expected aborted/error result after /reload; got ${JSON.stringify(steer.message)}`,
    );
  });

  it("subagent_run_serial executes through the real registered tool callback under forced headless", async () => {
    const { result } = await runRegisteredTool(
      "subagent_run_serial",
      { tasks: [{ agent: "test-echo", task: "Reply with exactly: OK" }] },
      dir,
    );

    assert.doesNotMatch(JSON.stringify(result), /mux not available/i,
      "no-mux regression: orchestration preflight blocked headless dispatch");
    assert.equal(result.details.isError, false, `serial errored: ${JSON.stringify(result.details)}`);
    assert.equal(result.details.results.length, 1);
    assert.equal(result.details.results[0].exitCode, 0);
    assert.ok(result.details.results[0].finalMessage.trim().length > 0);
  });

  it("subagent_run_parallel executes through the real registered tool callback under forced headless", async () => {
    const { result } = await runRegisteredTool(
      "subagent_run_parallel",
      {
        tasks: [
          { agent: "test-echo", task: "Reply with exactly: A" },
          { agent: "test-echo", task: "Reply with exactly: B" },
        ],
        maxConcurrency: 2,
      },
      dir,
    );

    assert.doesNotMatch(JSON.stringify(result), /mux not available/i);
    assert.equal(result.details.isError, false, `parallel errored: ${JSON.stringify(result.details)}`);
    assert.equal(result.details.results.length, 2);
    for (const r of result.details.results) {
      assert.equal(r.exitCode, 0);
    }
  });
});

describe("orchestration-headless-no-mux (auto + no mux env)", { skip: !PI_AVAILABLE, timeout: 180_000 }, () => {
  let saved: Record<string, string | undefined>;
  let dir: string;

  before(() => {
    saved = {};
    for (const k of MUX_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    assert.equal(process.env.PI_SUBAGENT_MODE, undefined,
      "Case B must exercise the default auto path; PI_SUBAGENT_MODE must be unset (review-v9 finding 2).");
    dir = mkdtempSync(join(tmpdir(), "pi-orch-auto-"));
    copyTestAgents(dir);
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("subagent reaches headless via selectBackend's auto fallback when no mux is present", async () => {
    const { fake, result } = await runRegisteredTool(
      "subagent",
      { name: "echo-bare-auto", agent: "test-echo", task: "Reply with exactly: OK" },
      dir,
    );

    assert.doesNotMatch(JSON.stringify(result), /mux not available/i,
      "auto-mode regression: bare subagent preflight blocked the auto + no-mux path");
    assert.match(JSON.stringify(result.content), /launched/i,
      "bare subagent must return a 'launched in background' ack in auto mode too");

    const steer = await waitForSteer(fake, "subagent_result", 120_000);
    assert.equal(steer.message.details.exitCode, 0,
      `bare subagent auto+no-mux errored: ${JSON.stringify(steer.message.details)}`);
    assert.ok(typeof steer.message.content === "string" && steer.message.content.length > 0);
  });

  it("subagent_run_serial reaches headless via selectBackend's auto fallback when no mux is present", async () => {
    const { result } = await runRegisteredTool(
      "subagent_run_serial",
      { tasks: [{ agent: "test-echo", task: "Reply with exactly: OK" }] },
      dir,
    );

    assert.doesNotMatch(JSON.stringify(result), /mux not available/i,
      "auto-mode regression: orchestration preflight blocked the auto + no-mux path");
    assert.equal(result.details.isError, false, `serial errored: ${JSON.stringify(result.details)}`);
    assert.equal(result.details.results.length, 1);
    assert.equal(result.details.results[0].exitCode, 0);
    assert.ok(result.details.results[0].finalMessage.trim().length > 0);
  });

  it("subagent_run_parallel reaches headless via selectBackend's auto fallback when no mux is present", async () => {
    const { result } = await runRegisteredTool(
      "subagent_run_parallel",
      {
        tasks: [
          { agent: "test-echo", task: "Reply with exactly: A" },
          { agent: "test-echo", task: "Reply with exactly: B" },
        ],
        maxConcurrency: 2,
      },
      dir,
    );

    assert.doesNotMatch(JSON.stringify(result), /mux not available/i,
      "auto-mode regression: orchestration preflight blocked the auto + no-mux path");
    assert.equal(result.details.isError, false, `parallel errored: ${JSON.stringify(result.details)}`);
    assert.equal(result.details.results.length, 2);
    for (const r of result.details.results) {
      assert.equal(r.exitCode, 0);
    }
  });
});
