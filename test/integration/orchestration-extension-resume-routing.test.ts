// test/integration/orchestration-extension-resume-routing.test.ts
//
// Step 14.2: Extension-level resume-routing e2e tests. Uses the real
// subagentsExtension(fakePi) wired with __test__ seams to drive:
//   Test A — ping-during-resume: resumed child pings again → second BLOCKED_KIND fires
//   Test B — terminal resume: resumed child completes → ORCHESTRATION_COMPLETE_KIND fires
//
// These tests prove that subagent_resume's production handler routes re-pings
// to registry.onTaskBlocked (recursion) and terminal outcomes to
// registry.onResumeTerminal (cross-orch re-ingestion) without mocking the registry.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentsExtension, { __test__ as subagentsTest } from "../../pi-extension/subagents/index.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";
import {
  BLOCKED_KIND,
  ORCHESTRATION_COMPLETE_KIND,
} from "../../pi-extension/orchestration/notification-kinds.ts";

function makeFakePi() {
  const tools = new Map<string, any>();
  const sentMessages: Array<{ message: any; opts?: any }> = [];
  return {
    tools,
    sentMessages,
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
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

async function waitForNthMessage(
  sentMessages: Array<{ message: any; opts?: any }>,
  customType: string,
  n: number,
  timeoutMs: number,
): Promise<{ message: any; opts?: any } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = sentMessages.filter((m) => m.message?.customType === customType);
    if (found.length >= n) return found[n - 1];
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

// ── Test A: ping-during-resume recursion ──────────────────────────────────────

describe("subagent_resume routing — ping-during-resume recursion", () => {
  let fake: ReturnType<typeof makeFakePi>;
  let serial: any;
  let resume: any;
  let scratchDir: string;
  let sessionKey: string;

  before(() => {
    subagentsTest.resetRegistry();
    scratchDir = mkdtempSync(join(tmpdir(), "ext-resume-routing-A-"));
    sessionKey = join(scratchDir, "sess-a.jsonl");
    // Create the session file on disk so existsSync passes in subagent_resume.execute
    writeFileSync(sessionKey, "", "utf8");

    // LauncherDeps that immediately blocks with a ping
    const pingDeps: LauncherDeps = {
      async launch(t) {
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(), sessionKey };
      },
      async waitForCompletion(h) {
        return {
          name: h.name,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 0,
          sessionKey,
          ping: { name: h.name, message: "need help" },
        };
      },
    };
    subagentsTest.setLauncherDepsOverride(pingDeps);
    subagentsTest.setMuxAvailableOverride(true);
    subagentsTest.setSurfaceOverrides({
      createSurface: () => "test-surface-a",
      sendLongCommand: () => {},
    });

    fake = makeFakePi();
    subagentsExtension(fake.api as any);
    serial = fake.tools.get("subagent_run_serial");
    resume = fake.tools.get("subagent_resume");
    assert.ok(serial, "subagent_run_serial must be registered");
    assert.ok(resume, "subagent_resume must be registered");
  });

  after(() => {
    subagentsTest.setLauncherDepsOverride(null);
    subagentsTest.setWatchSubagentOverride(null);
    subagentsTest.setMuxAvailableOverride(null);
    subagentsTest.setSurfaceOverrides(null);
    subagentsTest.resetRegistry();
    try { rmSync(scratchDir, { recursive: true, force: true }); } catch {}
  });

  it("ping-during-resume routes via registry.onTaskBlocked so the orchestration re-blocks (recursion)", async () => {
    // 1. Dispatch async serial with one task — it immediately pings via launcherDepsOverride
    const ctx = {
      sessionManager: {
        getSessionFile: () => join(scratchDir, "parent.jsonl"),
        getSessionId: () => "parent-session-a",
        getSessionDir: () => scratchDir,
      },
      cwd: scratchDir,
    };

    await serial.execute(
      "resume-routing-A",
      { wait: false, tasks: [{ name: "task-a", agent: "x", task: "do-work" }] },
      new AbortController().signal,
      () => {},
      ctx,
    );

    // 2. Wait for the first BLOCKED_KIND steer-back
    const firstBlocked = await waitForMessage(fake.sentMessages, BLOCKED_KIND, 500);
    assert.ok(firstBlocked, "expected initial BLOCKED steer-back");
    assert.equal(firstBlocked!.message.details.taskIndex, 0);
    assert.equal(firstBlocked!.message.details.message, "need help");
    const resolvedSessionKey = firstBlocked!.message.details.sessionKey;

    // 3. Override watchSubagent so the RESUMED child also pings (recursion test)
    subagentsTest.setWatchSubagentOverride(async () => ({
      name: "task-a",
      task: "do-work",
      transcriptPath: null,
      exitCode: 0,
      elapsed: 0,
      ping: { name: "task-a", message: "need help again" },
    } as any));

    // 4. Invoke subagent_resume for the blocked session
    await resume.execute(
      "resume-call-A",
      { sessionPath: resolvedSessionKey, message: "try again" },
      new AbortController().signal,
      () => {},
      ctx,
    );

    // 5. Wait for a SECOND BLOCKED_KIND — evidence that registry.onTaskBlocked was
    //    called from inside the resume handler (recursion path)
    const secondBlocked = await waitForNthMessage(fake.sentMessages, BLOCKED_KIND, 2, 500);
    assert.ok(secondBlocked,
      `expected a second BLOCKED steer-back (recursion), ` +
      `got: ${JSON.stringify(fake.sentMessages.map((m) => m.message?.customType))}`);
    assert.equal(secondBlocked!.message.details.message, "need help again");
  });
});

// ── Test B: terminal resume → orchestration_complete ─────────────────────────

describe("subagent_resume routing — terminal resume feeds back to orchestration_complete", () => {
  let fake: ReturnType<typeof makeFakePi>;
  let serial: any;
  let resume: any;
  let scratchDir: string;
  let sessionKey: string;

  before(() => {
    subagentsTest.resetRegistry();
    scratchDir = mkdtempSync(join(tmpdir(), "ext-resume-routing-B-"));
    sessionKey = join(scratchDir, "sess-b.jsonl");
    writeFileSync(sessionKey, "", "utf8");

    const pingDeps: LauncherDeps = {
      async launch(t) {
        return { id: t.task, name: t.name ?? "s", startTime: Date.now(), sessionKey };
      },
      async waitForCompletion(h) {
        return {
          name: h.name,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 0,
          sessionKey,
          ping: { name: h.name, message: "need help" },
        };
      },
    };
    subagentsTest.setLauncherDepsOverride(pingDeps);
    subagentsTest.setMuxAvailableOverride(true);
    subagentsTest.setSurfaceOverrides({
      createSurface: () => "test-surface-b",
      sendLongCommand: () => {},
    });

    fake = makeFakePi();
    subagentsExtension(fake.api as any);
    serial = fake.tools.get("subagent_run_serial");
    resume = fake.tools.get("subagent_resume");
    assert.ok(serial, "subagent_run_serial must be registered");
    assert.ok(resume, "subagent_resume must be registered");
  });

  after(() => {
    subagentsTest.setLauncherDepsOverride(null);
    subagentsTest.setWatchSubagentOverride(null);
    subagentsTest.setMuxAvailableOverride(null);
    subagentsTest.setSurfaceOverrides(null);
    subagentsTest.resetRegistry();
    try { rmSync(scratchDir, { recursive: true, force: true }); } catch {}
  });

  it("terminal resume of a blocked task feeds back through subagent_resume into aggregated completion", async () => {
    const ctx = {
      sessionManager: {
        getSessionFile: () => join(scratchDir, "parent.jsonl"),
        getSessionId: () => "parent-session-b",
        getSessionDir: () => scratchDir,
      },
      cwd: scratchDir,
    };

    // 1. Dispatch async serial with one task — it immediately pings
    await serial.execute(
      "resume-routing-B",
      { wait: false, tasks: [{ name: "task-b", agent: "x", task: "do-work-b" }] },
      new AbortController().signal,
      () => {},
      ctx,
    );

    // 2. Wait for the initial BLOCKED_KIND
    const blocked = await waitForMessage(fake.sentMessages, BLOCKED_KIND, 500);
    assert.ok(blocked, "expected initial BLOCKED steer-back");
    const resolvedSessionKey = blocked!.message.details.sessionKey;

    // 3. Override watchSubagent so the resumed child completes terminally (no ping)
    subagentsTest.setWatchSubagentOverride(async () => ({
      name: "task-b",
      task: "do-work-b",
      transcriptPath: null,
      exitCode: 0,
      elapsed: 0,
      summary: "done",
      ping: undefined,
    } as any));

    // 4. Invoke subagent_resume
    await resume.execute(
      "resume-call-B",
      { sessionPath: resolvedSessionKey, message: "finish" },
      new AbortController().signal,
      () => {},
      ctx,
    );

    // 5. ORCHESTRATION_COMPLETE_KIND must fire (via registry.onResumeTerminal)
    const complete = await waitForMessage(fake.sentMessages, ORCHESTRATION_COMPLETE_KIND, 500);
    assert.ok(complete,
      `expected ORCHESTRATION_COMPLETE_KIND, ` +
      `got: ${JSON.stringify(fake.sentMessages.map((m) => m.message?.customType))}`);
    assert.equal(complete!.message.details.results[0].state, "completed",
      `task 0 should be completed, got ${complete!.message.details.results[0].state}`);
    assert.equal(complete!.message.details.isError, false);
  });
});
