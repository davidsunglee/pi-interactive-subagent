// test/integration/orchestration-blocked-supervision.test.ts
//
// Task 11.4: the supervision loop must not throw on synthetic blocked virtual
// rows (id `virt-…`, no statusState, no activityFile) and must not emit
// subagent_status for them — the BLOCKED notification is the steer signal
// for that case, not the supervision loop. Live children alongside should
// continue to be supervised normally.
//
// Approach: seed the runningSubagents map directly with (a) a synthetic
// blocked virtual row (the same shape registryEmitter installs on
// BLOCKED_KIND) and (b) a live row (no statusState wired by the orchestration
// path, mirroring what we want to assert "still present"). Then call
// __test__.startStatusRefresh once and confirm:
//   - it does not throw on the virtual row
//   - both rows remain in runningSubagents
//   - no `subagent_status` message is emitted for the virtual row
//
// We gate on PI_AVAILABLE so the test is consistent with the rest of the
// supervision suite, but the exercise is registry-only: pi/mux is not
// strictly required to drive the supervision tick.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { isMuxAvailable } from "../../pi-extension/subagents/cmux.ts";
import subagentsExtension, {
  __test__ as subagentsTest,
  type RunningSubagent,
} from "../../pi-extension/subagents/index.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; }
})();
const MUX_AVAILABLE = isMuxAvailable();
const SHOULD_SKIP = !PI_AVAILABLE || !MUX_AVAILABLE;

if (SHOULD_SKIP) {
  console.log(`⚠️  orchestration-blocked-supervision skipped: PI=${PI_AVAILABLE} MUX=${MUX_AVAILABLE}`);
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

describe("orchestration-blocked-supervision", { skip: SHOULD_SKIP, timeout: 30_000 }, () => {
  let prevConfig: any;

  before(() => {
    prevConfig = subagentsTest.statusConfig;
    subagentsTest.setStatusConfig({ enabled: true, lineLimit: 4 });
    subagentsTest.resetRegistry();
    subagentsTest.getRunningSubagents().clear();
  });

  after(() => {
    subagentsTest.getRunningSubagents().clear();
    subagentsTest.resetRegistry();
    subagentsTest.setStatusConfig(prevConfig);
  });

  it("supervision tick skips virtual blocked rows and does not emit subagent_status for them", async () => {
    const stub = makeStubPi();
    subagentsExtension(stub.api as any);

    const map = subagentsTest.getRunningSubagents();

    // Seed a synthetic virtual blocked row identical in shape to what
    // registryEmitter installs on BLOCKED_KIND: id prefix `virt-`,
    // `blocked: { orchestrationId, taskIndex, message }`, no statusState,
    // no activityFile.
    const virtualId = "virt-orch-1:0";
    const virtual: RunningSubagent = {
      id: virtualId,
      name: "blocked-task",
      task: "",
      backend: "pane",
      startTime: Date.now(),
      blocked: {
        orchestrationId: "orch-1",
        taskIndex: 0,
        message: "PING: please respond",
      },
    };
    map.set(virtualId, virtual);

    // Seed a separate live row to ensure the loop's iteration over the map
    // still keeps it present after the tick. We give it no statusState
    // (mirroring the legacy / unsupervised path) so the loop will skip it
    // for transition emission too — the goal here is "no subagent_status
    // emitted for the virtual row", not to also hit a transition.
    const liveId = "live-row-1";
    const live: RunningSubagent = {
      id: liveId,
      name: "live-child",
      task: "do stuff",
      backend: "pane",
      startTime: Date.now(),
    };
    map.set(liveId, live);

    // Drive the supervision loop. The 1s interval is started here; the
    // assertion is that it does NOT throw (synchronously or asynchronously)
    // when a `virt-…` row with no statusState is encountered, and that no
    // `subagent_status` message is emitted for it.
    let unhandled: unknown = null;
    const onUnhandled = (err: unknown) => { unhandled = err; };
    process.once("uncaughtException", onUnhandled);

    subagentsTest.startStatusRefresh(stub.api as any);

    // Wait long enough for ≥1 tick of the 1s interval.
    await new Promise((r) => setTimeout(r, 1_500));
    process.removeListener("uncaughtException", onUnhandled as any);

    assert.equal(unhandled, null, `supervision tick must not throw on virtual blocked row: ${unhandled}`);

    // Both rows remain in the registry.
    assert.ok(map.get(virtualId), "virtual blocked row must remain in runningSubagents");
    assert.ok(map.get(liveId), "live row must remain in runningSubagents");

    // No `subagent_status` message emitted for the virtual row. Per the loop
    // contract, virtual rows are skipped before any sendMessage is built;
    // since the live row has no statusState either, no subagent_status
    // should fire at all in this scenario.
    const noSubagentStatusEmitted =
      stub.sentMessages.findIndex((m) => m.message?.customType === "subagent_status") === -1;
    assert.equal(
      noSubagentStatusEmitted,
      true,
      `virtual blocked rows must not trigger subagent_status; sent: ${stub.sentMessages.map((m) => m.message?.customType).join(",") || "(none)"}`,
    );
  });
});
