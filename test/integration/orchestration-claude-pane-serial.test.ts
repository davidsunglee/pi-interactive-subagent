import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getAvailableBackends, setBackend, restoreBackend,
  createTestEnv, cleanupTestEnv, sendCommand, waitForScreen,
  PI_TIMEOUT, SLOW_LANE_OPT_IN,
  type TestEnv,
} from "./harness.ts";
import { __test__ as subagentsTestHooks } from "../../pi-extension/subagents/index.ts";
import { runSerial } from "../../pi-extension/orchestration/run-serial.ts";
import { makeDefaultDeps } from "../../pi-extension/orchestration/default-deps.ts";

const CLAUDE_AVAILABLE = (() => {
  try { execSync("which claude", { stdio: "pipe" }); return true; }
  catch { return false; }
})();
const PLUGIN_BUILT = existsSync(
  join(new URL("../../pi-extension/subagents/plugin", import.meta.url).pathname, "mcp", "server.js"),
);
const backends = getAvailableBackends();
const SHOULD_SKIP = !CLAUDE_AVAILABLE || !PLUGIN_BUILT || backends.length === 0 || !SLOW_LANE_OPT_IN;
if (SHOULD_SKIP) {
  console.log(`⚠️  orchestration-claude-pane-serial skipped: CLAUDE=${CLAUDE_AVAILABLE} PLUGIN_BUILT=${PLUGIN_BUILT} BACKENDS=${backends.length} SLOW=${SLOW_LANE_OPT_IN}`);
}

/**
 * Wait for a `RunningSubagent` matching `predicate` to appear in the registry.
 * `runSerial` does not surface the launched pane to the caller, so tests that
 * need to drive the pane discover it through the `__test__` registry instead.
 */
async function waitForRunningSubagent(
  predicate: (r: { name: string; surface?: string; backend: string }) => boolean,
  timeoutMs: number,
): Promise<{ surface: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const r of subagentsTestHooks.getRunningSubagents().values()) {
      if (r.backend === "pane" && r.surface && predicate(r)) {
        return { surface: r.surface };
      }
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error("no matching RunningSubagent appeared within timeout");
}

for (const backend of backends) {
  describe(`orchestration-claude-pane-serial [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 3 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    before(() => { prevMux = setBackend(backend); env = createTestEnv(backend); });
    after(() => { cleanupTestEnv(env); restoreBackend(prevMux); });

    it("runSerial with cli=claude, auto-exit=false: parent-facing payload is fully populated", async () => {
      const deps = makeDefaultDeps({
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => env.dir,
        } as any,
        cwd: env.dir,
      });

      // Drive the multi-turn flow concurrently with runSerial. `runSerial`
      // does not return the pane handle, so we discover the live surface via
      // `subagentsTestHooks.getRunningSubagents()` (matched by name), wait
      // for the clarifying-question marker, then send the reply.
      const driver = (async () => {
        const { surface } = await waitForRunningSubagent(
          (r) => r.name === "serial-task",
          20_000,
        );
        env.surfaces.push(surface);
        await waitForScreen(surface, /CLARIFY\?/, 30_000);
        sendCommand(surface, "yes proceed");
      })();

      const out = await runSerial(
        [{
          name: "serial-task",
          agent: "test-claude-interactive",
          task:
            "Ask exactly one clarifying question that ends with the marker " +
            "'CLARIFY?' on its own line. After the user replies, call " +
            "subagent_done with message='SERIAL_DONE'.",
          cli: "claude",
        }],
        {},
        deps,
      );
      // Awaited (not swallowed) so a driver failure — failing to find the
      // surface in the registry, failing to observe the CLARIFY? marker,
      // failing to send the reply — fails the test. This is what makes the
      // multi-turn behavior an actual assertion rather than a side-effect:
      // the model could otherwise call subagent_done directly with the
      // expected final message and we'd never know the question was skipped.
      await driver;

      assert.equal(out.results.length, 1, "exactly one task result");
      assert.equal(out.isError, false);
      const r = out.results[0];

      // Parent-facing payload assertions (acceptance criteria from the spec).
      assert.equal(r.state, "completed", `state must be 'completed', got: ${r.state}`);
      assert.equal(r.exitCode, 0, `exitCode must be 0, got: ${r.exitCode}; finalMessage: ${r.finalMessage}`);
      assert.match(r.finalMessage, /SERIAL_DONE/, `finalMessage must contain SERIAL_DONE, got: ${r.finalMessage}`);
      assert.ok(r.transcriptPath, "transcriptPath must be populated");
      assert.ok(existsSync(r.transcriptPath!), `archived transcript must exist: ${r.transcriptPath}`);
      assert.equal(typeof r.sessionId, "string");
      assert.ok(r.sessionId!.length > 0, "sessionId must be populated for Claude-backed children");
      assert.equal(typeof r.sessionKey, "string");
      assert.ok(r.sessionKey!.length > 0, "sessionKey must be populated");
    });
  });
}
