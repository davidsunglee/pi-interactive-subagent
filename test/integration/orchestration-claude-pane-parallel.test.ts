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
import { runParallel } from "../../pi-extension/orchestration/run-parallel.ts";
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
  console.log(`⚠️  orchestration-claude-pane-parallel skipped: CLAUDE=${CLAUDE_AVAILABLE} PLUGIN_BUILT=${PLUGIN_BUILT} BACKENDS=${backends.length} SLOW=${SLOW_LANE_OPT_IN}`);
}

for (const backend of backends) {
  describe(`orchestration-claude-pane-parallel [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 3 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    before(() => { prevMux = setBackend(backend); env = createTestEnv(backend); });
    after(() => { cleanupTestEnv(env); restoreBackend(prevMux); });

    it("runParallel with two cli=claude tasks: each child gets its own sessionKey + payload", async () => {
      const deps = makeDefaultDeps({
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => env.dir,
        } as any,
        cwd: env.dir,
      });

      // Drive both surfaces concurrently. Each child has a stable `name`
      // (`alpha` / `beta`); we discover the live `RunningSubagent.surface`
      // for each via `subagentsTestHooks.getRunningSubagents()`, wait for
      // its `CLARIFY-<name>?` marker, then send the matching reply.
      const driveOne = async (childName: "alpha" | "beta") => {
        const start = Date.now();
        let surface: string | undefined;
        while (Date.now() - start < 30_000) {
          for (const r of subagentsTestHooks.getRunningSubagents().values()) {
            if (r.backend === "pane" && r.surface && r.name === childName) {
              surface = r.surface;
              break;
            }
          }
          if (surface) break;
          await new Promise((res) => setTimeout(res, 200));
        }
        if (!surface) throw new Error(`no surface for ${childName}`);
        env.surfaces.push(surface);
        await waitForScreen(surface, new RegExp(`CLARIFY-${childName}\\?`), 30_000);
        sendCommand(surface, `proceed-${childName}`);
      };
      const driver = Promise.all([driveOne("alpha"), driveOne("beta")]);

      const out = await runParallel(
        [
          {
            name: "alpha", agent: "test-claude-interactive", cli: "claude",
            task:
              "Ask exactly one clarifying question that ends with the marker " +
              "'CLARIFY-alpha?' on its own line. After the user replies, call " +
              "subagent_done with message='PARA_ALPHA'.",
          },
          {
            name: "beta", agent: "test-claude-interactive", cli: "claude",
            task:
              "Ask exactly one clarifying question that ends with the marker " +
              "'CLARIFY-beta?' on its own line. After the user replies, call " +
              "subagent_done with message='PARA_BETA'.",
          },
        ],
        {},
        deps,
      );
      // Awaited (not swallowed): both child drivers must succeed. If either
      // child's CLARIFY-<name>? marker never appears, or the reply send
      // fails, the test fails — proving multi-turn behavior on both
      // children rather than just the final payload shape.
      await driver;

      assert.equal(out.results.length, 2);
      assert.equal(out.isError, false);
      const byName = Object.fromEntries(out.results.map((r) => [r.name, r]));
      for (const name of ["alpha", "beta"] as const) {
        const r = byName[name];
        assert.ok(r, `result for ${name} must exist`);
        assert.equal(r.state, "completed", `${name} state must be 'completed', got: ${r.state}`);
        assert.equal(r.exitCode, 0);
        assert.match(r.finalMessage, name === "alpha" ? /PARA_ALPHA/ : /PARA_BETA/);
        assert.ok(r.transcriptPath && existsSync(r.transcriptPath));
        assert.ok(typeof r.sessionId === "string" && r.sessionId.length > 0);
        assert.ok(typeof r.sessionKey === "string" && r.sessionKey.length > 0);
      }
      // sessionKey uniqueness — two children must not share a key.
      assert.notEqual(byName["alpha"].sessionKey, byName["beta"].sessionKey);
    });
  });
}
