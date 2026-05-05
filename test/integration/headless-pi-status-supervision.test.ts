// test/integration/headless-pi-status-supervision.test.ts
//
// Task 11.3: status supervision over a real headless-Pi child.
//
// Mirrors pane-pi-status-supervision but uses makeHeadlessBackend(ctx).launch
// directly and registers the entry into the supervision registry via
// registerHeadlessSubagent. Confirms the LaunchedHandle.activityFile matches
// the canonical getSubagentActivityFile(artifactDir, id) shape and that the
// supervision loop reads from that same file.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { copyTestAgents } from "./harness.ts";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";
import subagentsExtension, {
  __test__ as subagentsTest,
  registerHeadlessSubagent,
  unregisterHeadlessSubagent,
  type RunningSubagent,
} from "../../pi-extension/subagents/index.ts";
import { classifyStatus, SNAPSHOT_STALLED_AFTER_MS } from "../../pi-extension/subagents/status.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; }
})();
const SHOULD_SKIP = !PI_AVAILABLE;

if (SHOULD_SKIP) {
  console.log(`⚠️  headless-pi-status-supervision skipped: PI=${PI_AVAILABLE}`);
}

function makeStubPi() {
  const sentMessages: Array<{ message: any; opts?: any }> = [];
  const tools = new Map<string, any>();
  return {
    sentMessages,
    tools,
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

async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

describe("headless-pi-status-supervision", { skip: SHOULD_SKIP, timeout: 120_000 }, () => {
  let dir: string;
  let origMode: string | undefined;
  let origCwd: string;
  let prevConfig: any;

  before(() => {
    origCwd = process.cwd();
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-supervision-"));
    copyTestAgents(dir);
    process.chdir(dir);
    prevConfig = subagentsTest.statusConfig;
    subagentsTest.setStatusConfig({ enabled: true, lineLimit: 4 });
    subagentsTest.resetRegistry();
  });

  after(() => {
    process.chdir(origCwd);
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    subagentsTest.getRunningSubagents().clear();
    subagentsTest.resetRegistry();
    subagentsTest.setStatusConfig(prevConfig);
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches activityFile path, observes child file, supervision loop emits subagent_status on stall", async () => {
    const stub = makeStubPi();
    subagentsExtension(stub.api as any);

    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });

    const handle = await backend.launch(
      { agent: "test-long-running", task: "loop forever", name: "HeadlessSupervision" },
      false,
    );

    let registered = false;
    try {
      // The headless pi LaunchedHandle exposes an activityFile path conforming
      // to the canonical getSubagentActivityFile(artifactDir, id) shape:
      // <artifactDir>/subagent-activity/<id>.json.
      assert.ok(handle.activityFile, "headless pi handle must carry activityFile");
      assert.equal(basename(handle.activityFile!), `${handle.id}.json`,
        `activityFile must be named <id>.json: got ${handle.activityFile}`);
      assert.match(handle.activityFile!, /\/subagent-activity\/[^/]+\.json$/,
        `activityFile must live under subagent-activity/: got ${handle.activityFile}`);

      // Register the running entry so the supervision loop sees it. This is
      // what the headless branch of the `subagent` tool does in production.
      registerHeadlessSubagent({
        id: handle.id,
        name: handle.name,
        task: "loop forever",
        agent: "test-long-running",
        cli: "pi",
        startTime: handle.startTime,
        activityFile: handle.activityFile,
        source: "pi",
      });
      registered = true;

      const map = subagentsTest.getRunningSubagents();
      const running = map.get(handle.id) as RunningSubagent | undefined;
      assert.ok(running, "running entry must be in the registry");
      assert.equal(running!.activityFile, handle.activityFile,
        "RunningSubagent.activityFile must match LaunchedHandle.activityFile");

      // Wait for the child to actually write its activity file.
      const sawFile = await waitFor(() => existsSync(handle.activityFile!), 60_000);
      assert.ok(sawFile, `child must write activity file at ${handle.activityFile}`);

      // Compress stall window via state mutation (no real-time wait of 60s).
      const past = Date.now() - (SNAPSHOT_STALLED_AFTER_MS + 5_000);
      running!.statusState!.startTimeMs = past;
      running!.statusState!.firstObservationAtMs = past;
      running!.statusState!.lastActivityAtMs = null;
      running!.statusState!.lastActivitySequence = null;
      running!.statusState!.snapshotProblemSinceMs = past;
      running!.statusState!.activeNow = false;
      running!.statusState!.activeSinceMs = null;
      running!.statusState!.activeScope = null;
      running!.statusState!.waitingSinceMs = null;
      running!.statusState!.phase = null;
      // Drop activityFile so the supervision tick records snapshot=missing
      // instead of overwriting our seeded "stalled" state with a fresh read.
      running!.activityFile = undefined;

      // Confirm pre-tick classification is already "stalled" — this ensures
      // the supervision loop has the necessary state to fire a transition.
      const preSnapshot = classifyStatus(running!.statusState!, Date.now());
      assert.equal(preSnapshot.kind, "stalled", "pre-tick classification must be stalled");

      // Drive the supervision loop directly (1s tick).
      subagentsTest.startStatusRefresh(stub.api as any);

      const gotStatus = await waitFor(
        () => stub.sentMessages.some((m) => m.message?.customType === "subagent_status"),
        5000,
      );
      assert.ok(gotStatus, `expected subagent_status within 5s; got: ${stub.sentMessages.map((m) => m.message?.customType).join(",") || "(none)"}`);

      const statusMsg = stub.sentMessages.find((m) => m.message?.customType === "subagent_status")!;
      assert.match(String(statusMsg.message.customType), /^subagent_status$/);

      // currentKind progressed to "stalled" via advanceStatusState in the tick.
      assert.equal(running!.statusState!.currentKind, "stalled");
    } finally {
      if (registered) {
        try { unregisterHeadlessSubagent(handle.id); } catch {}
      }
      // Cancel the headless child so the test doesn't leak a long-running pi.
      try {
        // backend.watch wires the abort signal; we attach a fresh abort here.
        const abort = new AbortController();
        const watching = backend.watch(handle, abort.signal).catch(() => {});
        abort.abort();
        await watching;
      } catch {}
    }
  });
});
