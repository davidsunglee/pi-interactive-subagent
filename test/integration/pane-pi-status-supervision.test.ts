// test/integration/pane-pi-status-supervision.test.ts
//
// Task 11.2: status supervision over a real pane-Pi child.
//
// Approach: launch a real pane-Pi subagent (test-long-running so its activity
// file is genuinely written to disk by the child). Then compress the 60s stall
// threshold by mutating the seeded RunningSubagent.statusState's startTimeMs +
// firstObservationAtMs into the past. Drive the supervision loop by calling
// __test__.startStatusRefresh(stubPi); the 1s tick observes the activity file
// and classifies the entry as `stalled`, which emits a `subagent_status`
// steer message. Skips cleanly when pi/mux is not available on the runner.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  getAvailableBackends, setBackend, restoreBackend,
  createTestEnv, cleanupTestEnv,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";
import subagentsExtension, {
  __test__ as subagentsTest,
  launchSubagent,
  type RunningSubagent,
} from "../../pi-extension/subagents/index.ts";
import { classifyStatus, SNAPSHOT_STALLED_AFTER_MS } from "../../pi-extension/subagents/status.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; }
})();
const backends = getAvailableBackends();
const SHOULD_SKIP = !PI_AVAILABLE || backends.length === 0;

if (SHOULD_SKIP) {
  console.log(`⚠️  pane-pi-status-supervision skipped: PI=${PI_AVAILABLE} BACKENDS=${backends.length}`);
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

for (const backend of backends) {
  describe(`pane-pi-status-supervision [${backend}]`, {
    skip: SHOULD_SKIP, timeout: PI_TIMEOUT,
  }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    let prevConfig: any;

    before(() => {
      prevMux = setBackend(backend);
      env = createTestEnv(backend);
      prevConfig = subagentsTest.statusConfig;
      subagentsTest.setStatusConfig({ enabled: true, lineLimit: 4 });
      subagentsTest.resetRegistry();
    });

    after(() => {
      // Drain any seeded running entries so the next test starts clean.
      const map = subagentsTest.getRunningSubagents();
      for (const [, entry] of map) {
        try { entry.abortController?.abort(); } catch {}
      }
      map.clear();
      subagentsTest.resetRegistry();
      subagentsTest.setStatusConfig(prevConfig);
      cleanupTestEnv(env);
      restoreBackend(prevMux);
    });

    it("emits subagent_status (stalled) and progresses widget right strings starting → stalled", async () => {
      const stub = makeStubPi();
      subagentsExtension(stub.api as any);

      const ctx = {
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "supervision-test",
          getSessionDir: () => env.dir,
        },
        cwd: env.dir,
      };

      // Capture the initial widget right string ("starting…") before any
      // observation has been recorded. The widget label depends only on the
      // RunningSubagent.statusState, which is created before launch returns.
      const running: RunningSubagent = await launchSubagent(
        { name: "PaneSupervision", task: "loop forever", agent: "test-long-running", interactive: false },
        ctx,
      );
      env.surfaces.push(running.surface!);

      try {
        assert.equal(running.backend, "pane");
        assert.ok(running.activityFile, "pane-pi child must carry activityFile");

        // Sample 1 (starting): the freshly created entry has currentKind: starting.
        const t0Snapshot = classifyStatus(running.statusState!, Date.now());
        const right0 = subagentsTest.formatWidgetRightLabel(t0Snapshot);
        assert.match(right0, /starting/, `expected starting widget, got: ${right0}`);

        // Wait for the child to actually write its activity file. This proves
        // that the supervision loop will be reading a real, child-produced
        // file rather than a synthetic stub.
        const sawFile = await waitFor(() => existsSync(running.activityFile!), PI_TIMEOUT / 2);
        assert.ok(sawFile, `child must write activity file at ${running.activityFile}`);

        // Compress the stall window: rewrite the entry's status timing into
        // the past so the next supervision tick will classify it as stalled.
        // We push start/firstObservation back beyond SNAPSHOT_STALLED_AFTER_MS.
        // Force snapshotState to "missing" so classifyProblemState applies.
        const past = Date.now() - (SNAPSHOT_STALLED_AFTER_MS + 5_000);
        running.statusState!.startTimeMs = past;
        running.statusState!.firstObservationAtMs = past;
        running.statusState!.lastActivityAtMs = null;
        running.statusState!.lastActivitySequence = null;
        running.statusState!.snapshotProblemSinceMs = past;
        // Discard any activityFile so observeRunningSubagent records "missing"
        // rather than reading the (recent) child snapshot back over our seed.
        running.activityFile = undefined;

        // Sample 2 (mid): pre-tick snapshot already classifies as stalled.
        const tMidSnapshot = classifyStatus(running.statusState!, Date.now());
        const rightMid = subagentsTest.formatWidgetRightLabel(tMidSnapshot);
        assert.match(rightMid, /stalled/, `expected stalled widget mid, got: ${rightMid}`);

        // Drive the supervision loop. startStatusRefresh is idempotent — it
        // schedules a 1s interval that runs advanceStatusState + emits
        // subagent_status on stall transitions.
        subagentsTest.startStatusRefresh(stub.api as any);

        const gotStatus = await waitFor(
          () => stub.sentMessages.some((m) => m.message?.customType === "subagent_status"),
          5000,
        );
        assert.ok(
          gotStatus,
          `expected subagent_status emission within 5s, got: ${stub.sentMessages.map((m) => m.message?.customType).join(", ") || "(none)"}`,
        );

        // (a) at least one sendMessage carried customType subagent_status.
        const statusMsg = stub.sentMessages.find((m) => m.message?.customType === "subagent_status");
        assert.ok(statusMsg, "subagent_status message must be present");
        assert.match(String(statusMsg!.message.customType), /^subagent_status$/);

        // (b) the running entry's currentKind ended at "stalled".
        assert.equal(running.statusState!.currentKind, "stalled");

        // Sample 3 (after tick): widget right shows stalled.
        const tEndSnapshot = classifyStatus(running.statusState!, Date.now());
        const rightEnd = subagentsTest.formatWidgetRightLabel(tEndSnapshot);
        assert.match(rightEnd, /stalled/, `expected stalled widget end, got: ${rightEnd}`);
      } finally {
        try { running.abortController?.abort(); } catch {}
      }
    });
  });
}
