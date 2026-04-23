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
//
// Budgets: per-event waits use BLOCK_WAIT_MS (default 90s) — tighter than
// PI_TIMEOUT so a stuck ping/resume surfaces a signal within ~3 minutes of
// suite wall-time rather than hogging a full PI_TIMEOUT*3 budget. On wait
// timeout, the test dumps recent sentMessages for diagnostics and calls
// subagent_run_cancel in a finally so the registry doesn't keep orphaned
// panes/processes across tests. Lives in the slow integration lane
// (`npm run test:integration:slow`) — not part of the default gate.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  getAvailableBackends, setBackend, restoreBackend,
  createTestEnv, cleanupTestEnv,
  BLOCK_WAIT_MS, PI_TIMEOUT, SLOW_LANE_OPT_IN,
  waitForSentMessage, summarizeSentMessages, tryCancelOrchestration,
  type TestEnv,
} from "./harness.ts";
import subagentsExtension, { __test__ as subagentsTest } from "../../pi-extension/subagents/index.ts";
import {
  BLOCKED_KIND, ORCHESTRATION_COMPLETE_KIND,
} from "../../pi-extension/orchestration/notification-kinds.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; }
})();
const backends = getAvailableBackends();
// Skip unless the slow lane is opted into (real-backend suite).
const SHOULD_SKIP = !PI_AVAILABLE || backends.length === 0 || !SLOW_LANE_OPT_IN;

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

for (const backend of backends) {
  describe(`orchestration-pane-block-backend [${backend}]`, {
    skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 2,
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
      const cancelTool = fake.tools.get("subagent_run_cancel");
      assert.ok(serial && resume && cancelTool);

      const sessionFile = join(env.dir, "session.jsonl");
      const ctx = {
        sessionManager: {
          getSessionFile: () => sessionFile,
          getSessionId: () => "test-block-session",
          getSessionDir: () => env.dir,
        },
        cwd: env.dir,
      };

      let orchestrationId: string | undefined;
      try {
        const envelope = await serial.execute(
          "pane-block",
          { wait: false, tasks: [{ name: "r1", agent: "test-ping-resumable", task: "hello" }] },
          new AbortController().signal,
          () => {},
          ctx,
        );
        orchestrationId = envelope.details.orchestrationId;
        assert.ok(orchestrationId);

        const blocked = await waitForSentMessage(fake.sentMessages, BLOCKED_KIND, BLOCK_WAIT_MS);
        if (!blocked) {
          assert.fail(
            `expected BLOCKED sendMessage within ${BLOCK_WAIT_MS}ms ` +
            `(orchestrationId=${orchestrationId}, backend=${backend}). ` +
            `Sent messages: ${summarizeSentMessages(fake.sentMessages)}`,
          );
        }
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

        const complete = await waitForSentMessage(fake.sentMessages, ORCHESTRATION_COMPLETE_KIND, BLOCK_WAIT_MS);
        if (!complete) {
          assert.fail(
            `expected orchestration_complete within ${BLOCK_WAIT_MS}ms after resume ` +
            `(orchestrationId=${orchestrationId}, sessionKey=${sessionKey}, backend=${backend}). ` +
            `Sent messages: ${summarizeSentMessages(fake.sentMessages)}`,
          );
        }
        assert.equal(complete!.message.details.results[0].state, "completed");
      } finally {
        // Deterministic teardown: cancel on any path (pass or fail) so a stuck
        // test doesn't leave the registry holding live panes.
        await tryCancelOrchestration(cancelTool, orchestrationId, ctx);
      }
    });
  });
}
