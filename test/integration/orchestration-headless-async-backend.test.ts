import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { copyTestAgents, PI_TIMEOUT, SLOW_LANE_OPT_IN } from "./harness.ts";
import subagentsExtension, { __test__ as subagentsTest } from "../../pi-extension/subagents/index.ts";
import { ORCHESTRATION_COMPLETE_KIND } from "../../pi-extension/orchestration/notification-kinds.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; }
})();
// Real-backend suite: only runs under the slow lane opt-in.
const SHOULD_SKIP = !PI_AVAILABLE || !SLOW_LANE_OPT_IN;

if (!PI_AVAILABLE) {
  console.log("⚠️  orchestration-headless-async-backend skipped: pi not on PATH");
}

function makeFakePi() {
  const tools = new Map<string, any>();
  const sentMessages: Array<{ message: any; opts?: any }> = [];
  return {
    tools, sentMessages,
    api: {
      registerTool(spec: any) { tools.set(spec.name, spec); },
      registerCommand() {},
      registerMessageRenderer() {},
      sendUserMessage() {},
      sendMessage(message: any, opts?: any) { sentMessages.push({ message, opts }); },
      on() {},
    },
  };
}

async function waitForCompletion(
  sentMessages: Array<{ message: any; opts?: any }>,
  timeoutMs: number,
): Promise<{ message: any; opts?: any } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = sentMessages.find((m) => m.message.customType === "orchestration_complete");
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

describe("orchestration-headless-async-backend", {
  skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 3,
}, () => {
  let prevMode: string | undefined;
  let dir: string;

  before(() => {
    prevMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-integ-headless-async-"));
    copyTestAgents(dir);
    subagentsTest.resetRegistry();
  });

  after(() => {
    if (prevMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = prevMode;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    subagentsTest.resetRegistry();
  });

  it("headless: wait:false parallel orchestration completes and delivers orchestration_complete via the real runPiHeadless", async () => {
    const fake = makeFakePi();
    subagentsExtension(fake.api as any);

    const parallel = fake.tools.get("subagent_run_parallel");
    assert.ok(parallel, "subagent_run_parallel must be registered");

    const sessionFile = join(dir, "session.jsonl");
    const ctx = {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "headless-async-session",
        getSessionDir: () => dir,
      },
      cwd: dir,
    };

    const envelope = await parallel.execute(
      "headless-async-parallel",
      {
        wait: false,
        tasks: [
          { name: "p1", agent: "test-echo", task: "Reply with exactly: OK" },
          { name: "p2", agent: "test-echo", task: "Reply with exactly: OK" },
        ],
      },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.ok(envelope.details.orchestrationId);
    assert.equal(envelope.details.tasks.length, 2);
    assert.equal(envelope.details.tasks.every((t: any) => t.state === "pending"), true);

    const completion = await waitForCompletion(fake.sentMessages, PI_TIMEOUT * 2);
    assert.ok(completion, "expected orchestration_complete within timeout");
    assert.equal(completion!.opts?.deliverAs, "steer");
    assert.equal(completion!.opts?.triggerTurn, true);
    const details = completion!.message.details;
    assert.equal(details.kind, ORCHESTRATION_COMPLETE_KIND);
    assert.equal(details.orchestrationId, envelope.details.orchestrationId);
    assert.equal(details.isError, false);
    assert.equal(details.results.length, 2);
    assert.ok(details.results.every((r: any) => r.state === "completed"));
  });

  it("headless: subagent_run_cancel during a wait:false run aborts live pi children and emits aggregated completion with all cancelled", async () => {
    const fake = makeFakePi();
    subagentsExtension(fake.api as any);

    const serial = fake.tools.get("subagent_run_serial");
    const cancelTool = fake.tools.get("subagent_run_cancel");
    assert.ok(serial && cancelTool);

    const sessionFile = join(dir, "session-cancel.jsonl");
    const ctx = {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "headless-async-cancel-session",
        getSessionDir: () => dir,
      },
      cwd: dir,
    };

    const envelope = await serial.execute(
      "headless-async-cancel",
      {
        wait: false,
        tasks: [
          { name: "t1", agent: "test-long-running", task: "loop forever" },
          { name: "t2", agent: "test-long-running", task: "loop forever" },
        ],
      },
      new AbortController().signal,
      () => {},
      ctx,
    );

    await new Promise((r) => setTimeout(r, 2000));

    const cancelResult = await cancelTool.execute(
      "headless-async-cancel-op",
      { orchestrationId: envelope.details.orchestrationId },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.equal(cancelResult.details.ok, true);

    const completion = await waitForCompletion(fake.sentMessages, PI_TIMEOUT);
    assert.ok(completion);
    const details = completion!.message.details;
    assert.equal(details.isError, true);
    assert.ok(details.results.every((r: any) => r.state === "cancelled"),
      `expected all cancelled, got ${JSON.stringify(details.results.map((r: any) => r.state))}`);
  });
});
