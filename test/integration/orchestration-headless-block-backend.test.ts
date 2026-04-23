// test/integration/orchestration-headless-block-backend.test.ts
//
// Step 14.2c: Backend-real headless async/block test. Exercises runPiHeadless's
// .exit sidecar detection (Task 9.5) end-to-end. Dispatches via headless; resume
// requires mux (the resume handler hard-requires isMuxAvailable()), so the test
// skips unless both `pi` AND at least one mux backend are present.
//
// Uses test-ping-resumable: pings on first turn, completes normally on resume.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { copyTestAgents, getAvailableBackends, PI_TIMEOUT } from "./harness.ts";
import subagentsExtension, { __test__ as subagentsTest } from "../../pi-extension/subagents/index.ts";
import {
  BLOCKED_KIND, ORCHESTRATION_COMPLETE_KIND,
} from "../../pi-extension/orchestration/notification-kinds.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; }
})();
const backends = getAvailableBackends();
// Resume requires a mux backend — skip if no mux available
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

describe("orchestration-headless-block-backend", {
  skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 3,
}, () => {
  let prevMode: string | undefined;
  let dir: string;

  before(() => {
    prevMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-integ-headless-block-"));
    copyTestAgents(dir);
    subagentsTest.resetRegistry();
  });

  after(() => {
    if (prevMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = prevMode;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    subagentsTest.resetRegistry();
  });

  it("headless: caller_ping from real child → BLOCKED → subagent_resume (pane) → ORCHESTRATION_COMPLETE", async () => {
    const fake = makeFakePi();
    subagentsExtension(fake.api as any);

    const serial = fake.tools.get("subagent_run_serial");
    const resume = fake.tools.get("subagent_resume");
    assert.ok(serial, "subagent_run_serial must be registered");
    assert.ok(resume, "subagent_resume must be registered");

    const sessionFile = join(dir, "session.jsonl");
    const ctx = {
      sessionManager: {
        getSessionFile: () => sessionFile,
        getSessionId: () => "headless-block-session",
        getSessionDir: () => dir,
      },
      cwd: dir,
    };

    const envelope = await serial.execute(
      "headless-block",
      { wait: false, tasks: [{ name: "h1", agent: "test-ping-resumable", task: "hello-headless" }] },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.ok(envelope.details.orchestrationId, "orchestrationId must be present");

    // Wait for the BLOCKED_KIND steer-back from the headless ping sidecar
    const blocked = await waitForMessage(fake.sentMessages, BLOCKED_KIND, PI_TIMEOUT * 2);
    assert.ok(blocked, "expected BLOCKED sendMessage from headless ping sidecar");

    const sessionKey = blocked!.message.details.sessionKey;
    assert.ok(sessionKey, "sessionKey must be present in blocked details");

    // Verify the session file exists on disk
    assert.ok(existsSync(sessionKey), `sessionKey path must exist on disk: ${sessionKey}`);

    // Verify the .exit sidecar was cleaned up (Task 9.5 cleanup contract)
    assert.equal(existsSync(sessionKey + ".exit"), false,
      "the .exit sidecar file must have been cleaned up after ping propagation");

    // Now resume via the pane backend (resume tool requires mux)
    await resume.execute(
      "headless-resume",
      { sessionPath: sessionKey, message: "please finish" },
      new AbortController().signal,
      () => {},
      ctx,
    );

    // Wait for ORCHESTRATION_COMPLETE_KIND
    const complete = await waitForMessage(fake.sentMessages, ORCHESTRATION_COMPLETE_KIND, PI_TIMEOUT * 2);
    assert.ok(complete, "expected orchestration_complete after resume");
    assert.equal(complete!.message.details.results[0].state, "completed",
      `task 0 should be completed, got: ${complete!.message.details.results[0].state}`);
  });
});
