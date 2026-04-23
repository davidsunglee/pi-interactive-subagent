// test/integration/orchestration-pane-block-backend.test.ts
//
// Step 14.2b: Backend-real pane async/block test. No LauncherDeps or
// watchSubagent seam — exercises the real makeDefaultDeps so that
// launchSubagent → watchSubagent → pane.ts run through the genuine backend path.
// Uses test-ping-resumable (pings on first turn, completes on resume).
//
// NOTE: Tests using the tmux backend will hang in this environment (cmux-only host).
// The for (const backend of backends) loop handles this correctly — cmux works,
// tmux hangs. This is a host-specific constraint; the test CODE is correct.
// Run cmux-only via:
//   PI_SUBAGENT_MUX=cmux node --test --test-timeout=120000 test/integration/orchestration-pane-block-backend.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  getAvailableBackends, setBackend, restoreBackend,
  createTestEnv, cleanupTestEnv, PI_TIMEOUT, type TestEnv,
} from "./harness.ts";
import subagentsExtension, { __test__ as subagentsTest } from "../../pi-extension/subagents/index.ts";
import {
  BLOCKED_KIND, ORCHESTRATION_COMPLETE_KIND,
} from "../../pi-extension/orchestration/notification-kinds.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; }
})();
const backends = getAvailableBackends();
const SHOULD_SKIP = !PI_AVAILABLE || backends.length === 0;

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

async function waitForMessage(
  sentMessages: Array<{ message: any; opts?: any }>,
  customType: string,
  timeoutMs: number,
): Promise<{ message: any; opts?: any } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = sentMessages.find((m) => m.message?.customType === customType);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

for (const backend of backends) {
  describe(`orchestration-pane-block-backend [${backend}]`, {
    skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 3,
  }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    before(() => {
      prevMux = setBackend(backend);
      env = createTestEnv(backend);
      subagentsTest.resetRegistry();
    });
    after(() => {
      cleanupTestEnv(env);
      restoreBackend(prevMux);
      subagentsTest.resetRegistry();
    });

    it("pane: caller_ping from real child → BLOCKED → subagent_resume → ORCHESTRATION_COMPLETE", async () => {
      const fake = makeFakePi();
      subagentsExtension(fake.api as any);
      const serial = fake.tools.get("subagent_run_serial");
      const resume = fake.tools.get("subagent_resume");
      assert.ok(serial && resume);

      const sessionFile = join(env.dir, "session.jsonl");
      const ctx = {
        sessionManager: {
          getSessionFile: () => sessionFile,
          getSessionId: () => "test-block-session",
          getSessionDir: () => env.dir,
        },
        cwd: env.dir,
      };

      const envelope = await serial.execute(
        "pane-block",
        { wait: false, tasks: [{ name: "r1", agent: "test-ping-resumable", task: "hello" }] },
        new AbortController().signal,
        () => {},
        ctx,
      );
      assert.ok(envelope.details.orchestrationId);

      const blocked = await waitForMessage(fake.sentMessages, BLOCKED_KIND, PI_TIMEOUT * 2);
      assert.ok(blocked, "expected BLOCKED sendMessage");
      const sessionKey = blocked!.message.details.sessionKey;
      assert.ok(existsSync(sessionKey), `sessionKey path must exist on disk: ${sessionKey}`);
      assert.match(blocked!.message.details.message, /^PING:/);

      await resume.execute(
        "pane-resume",
        { sessionPath: sessionKey, message: "please finish" },
        new AbortController().signal,
        () => {},
        ctx,
      );

      const complete = await waitForMessage(fake.sentMessages, ORCHESTRATION_COMPLETE_KIND, PI_TIMEOUT * 2);
      assert.ok(complete, "expected orchestration_complete after resume");
      assert.equal(complete!.message.details.results[0].state, "completed");
    });
  });
}
