import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  getAvailableBackends,
  setBackend,
  restoreBackend,
  createTestEnv,
  cleanupTestEnv,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";
import subagentsExtension, { __test__ as subagentsTest } from "../../pi-extension/subagents/index.ts";
import { ORCHESTRATION_COMPLETE_KIND } from "../../pi-extension/orchestration/notification-kinds.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; }
})();
const backends = getAvailableBackends();
const SHOULD_SKIP = !PI_AVAILABLE || backends.length === 0;

if (SHOULD_SKIP) {
  console.log(`⚠️  orchestration-pane-async-backend skipped: PI=${PI_AVAILABLE} BACKENDS=${backends.length}`);
}

function makeFakePi() {
  const tools = new Map<string, any>();
  const renderers = new Map<string, any>();
  const sentMessages: Array<{ message: any; opts?: any }> = [];
  return {
    tools,
    sentMessages,
    api: {
      registerTool(spec: any) { tools.set(spec.name, spec); },
      registerCommand() {},
      registerMessageRenderer(type: string, fn: any) { renderers.set(type, fn); },
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

for (const backend of backends) {
  describe(`orchestration-pane-async-backend [${backend}]`, {
    skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 3,
  }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;

    before(() => {
      prevMux = setBackend(backend);
      env = createTestEnv(backend);
      subagentsTest.resetRegistry(); // Isolate module-level registry state.
    });

    after(() => {
      cleanupTestEnv(env);
      restoreBackend(prevMux);
      subagentsTest.resetRegistry();
    });

    it("pane: wait:false serial orchestration completes and delivers orchestration_complete via the real backend", async () => {
      const fake = makeFakePi();
      subagentsExtension(fake.api as any);

      const serial = fake.tools.get("subagent_run_serial");
      assert.ok(serial, "subagent_run_serial tool must be registered");

      const sessionFile = join(env.dir, "session.jsonl");
      const ctx = {
        sessionManager: {
          getSessionFile: () => sessionFile,
          getSessionId: () => "test-session",
          getSessionDir: () => env.dir,
        },
        cwd: env.dir,
      };

      const envelope = await serial.execute(
        "pane-async-serial",
        {
          wait: false,
          tasks: [
            { name: "t1", agent: "test-echo", task: "Reply with exactly: OK" },
            { name: "t2", agent: "test-echo", task: "Reply with exactly: OK" },
          ],
        },
        new AbortController().signal,
        () => {},
        ctx,
      );
      assert.ok(envelope.details.orchestrationId, "envelope must carry orchestrationId");
      assert.equal(envelope.details.tasks.length, 2);
      assert.equal(envelope.details.tasks.every((t: any) => t.state === "pending"), true);

      const completion = await waitForCompletion(fake.sentMessages, PI_TIMEOUT * 2);
      assert.ok(completion, "expected an orchestration_complete sendMessage within timeout");
      assert.equal(completion!.opts?.deliverAs, "steer");
      assert.equal(completion!.opts?.triggerTurn, true);
      const details = completion!.message.details;
      assert.equal(details.kind, ORCHESTRATION_COMPLETE_KIND);
      assert.equal(details.orchestrationId, envelope.details.orchestrationId);
      assert.equal(details.isError, false);
      assert.equal(details.results.length, 2);
      assert.ok(details.results.every((r: any) => r.state === "completed"));
    });

    it("pane: subagent_run_cancel during a wait:false run aborts live panes and emits aggregated completion with all cancelled", async () => {
      const fake = makeFakePi();
      subagentsExtension(fake.api as any);

      const serial = fake.tools.get("subagent_run_serial");
      const cancelTool = fake.tools.get("subagent_run_cancel");
      assert.ok(serial && cancelTool, "serial + cancel tools must be registered");

      const sessionFile = join(env.dir, "session-cancel.jsonl");
      const ctx = {
        sessionManager: {
          getSessionFile: () => sessionFile,
          getSessionId: () => "test-session-cancel",
          getSessionDir: () => env.dir,
        },
        cwd: env.dir,
      };

      const envelope = await serial.execute(
        "pane-async-cancel",
        {
          wait: false,
          tasks: [
            // test-long-running stays alive indefinitely; cancellation is the only exit.
            { name: "t1", agent: "test-long-running", task: "loop forever" },
            { name: "t2", agent: "test-long-running", task: "loop forever" },
          ],
        },
        new AbortController().signal,
        () => {},
        ctx,
      );
      assert.ok(envelope.details.orchestrationId);

      // Give the background runner a chance to launch the first pane.
      await new Promise((r) => setTimeout(r, 2000));

      const cancelResult = await cancelTool.execute(
        "pane-async-cancel-op",
        { orchestrationId: envelope.details.orchestrationId },
        new AbortController().signal,
        () => {},
        ctx,
      );
      assert.equal(cancelResult.details.ok, true);

      const completion = await waitForCompletion(fake.sentMessages, PI_TIMEOUT);
      assert.ok(completion, "expected orchestration_complete after cancel");
      const details = completion!.message.details;
      assert.equal(details.isError, true);
      assert.ok(details.results.every((r: any) => r.state === "cancelled"),
        `expected all cancelled, got ${JSON.stringify(details.results.map((r: any) => r.state))}`);
    });
  });
}
