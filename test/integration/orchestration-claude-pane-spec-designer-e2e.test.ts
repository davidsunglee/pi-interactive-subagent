import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
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
  console.log(`⚠️  orchestration-claude-pane-spec-designer-e2e skipped: CLAUDE=${CLAUDE_AVAILABLE} PLUGIN_BUILT=${PLUGIN_BUILT} BACKENDS=${backends.length} SLOW=${SLOW_LANE_OPT_IN}`);
}

for (const backend of backends) {
  describe(`orchestration-claude-pane-spec-designer-e2e [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 4 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    before(() => { prevMux = setBackend(backend); env = createTestEnv(backend); });
    after(() => { cleanupTestEnv(env); restoreBackend(prevMux); });

    it("dispatches through runSerial; observes Q1 then Q2; parent payload carries SPEC_ARTIFACT", async () => {
      const SPEC_PATH = join(env.dir, "SPEC.md");
      const deps = makeDefaultDeps({
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => env.dir,
        } as any,
        cwd: env.dir,
      });

      const driver = (async () => {
        // Discover the Claude pane surface via the registry instead of polling
        // env.surfaces — runSerial does not propagate the surface back to the
        // caller. Match by the child task `name` set on the runSerial input.
        const start = Date.now();
        let surface: string | undefined;
        while (Date.now() - start < 20_000) {
          for (const r of subagentsTestHooks.getRunningSubagents().values()) {
            if (r.backend === "pane" && r.surface && r.name === "spec-designer") {
              surface = r.surface;
              break;
            }
          }
          if (surface) break;
          await new Promise((res) => setTimeout(res, 200));
        }
        if (!surface) throw new Error("no Claude surface appeared for spec-designer");
        env.surfaces.push(surface);

        // Wait for Q1 marker, then send answer 1.
        await waitForScreen(surface, /Q1\?/, 30_000);
        sendCommand(surface, "Use TypeScript and ES modules.");

        // Wait for Q2 marker, then send answer 2.
        await waitForScreen(surface, /Q2\?/, 30_000);
        sendCommand(surface, "Print 'hello world' to stdout.");
      })();

      // Build the task prompt with the REAL absolute SPEC_PATH interpolated —
      // the parent-facing contract is `SPEC_ARTIFACT: <abs path>`, so the test
      // string must contain the actual path, not the literal placeholder.
      const taskPrompt =
        "Help me draft a SPEC.md for a hello-world Node script. Ask exactly " +
        "two clarifying questions: end the first one with the marker 'Q1?' " +
        "on its own line, end the second with 'Q2?' on its own line. After " +
        `both answers, write SPEC.md to ${SPEC_PATH}, then call ` +
        `subagent_done with message="SPEC_ARTIFACT: ${SPEC_PATH}".`;

      const out = await runSerial(
        [{
          name: "spec-designer",
          agent: "test-claude-spec-designer", cli: "claude",
          task: taskPrompt,
        }],
        {},
        deps,
      );
      // Awaited (not swallowed): the driver must observe Q1?, send answer 1,
      // observe Q2?, send answer 2. If the model skips a question and calls
      // subagent_done with the SPEC_ARTIFACT message anyway, the driver's
      // waitForScreen for the missing marker times out and fails the test —
      // pinning the multi-turn workflow contract end-to-end.
      await driver;

      assert.equal(out.results.length, 1);
      assert.equal(out.isError, false);
      const r = out.results[0];

      // Parent-facing payload assertions (acceptance criteria). The parent
      // workflow contract is `SPEC_ARTIFACT: <abs path>` — assert both the
      // prefix and the actual path are present in `finalMessage` so the
      // test fails if the model omits the path or returns the placeholder.
      assert.equal(r.state, "completed", `state must be 'completed', got: ${r.state}`);
      assert.equal(r.exitCode, 0, `exit ${r.exitCode}; finalMessage: ${r.finalMessage}`);
      assert.match(r.finalMessage, /SPEC_ARTIFACT:/);
      assert.ok(
        r.finalMessage.includes(SPEC_PATH),
        `finalMessage must include the absolute SPEC path '${SPEC_PATH}', got: ${r.finalMessage}`,
      );
      assert.ok(r.transcriptPath && existsSync(r.transcriptPath), "archived transcript must exist");
      assert.ok(typeof r.sessionId === "string" && r.sessionId.length > 0);
      assert.ok(typeof r.sessionKey === "string" && r.sessionKey.length > 0);

      // Side-effect: the SPEC.md the model wrote must exist with non-empty content.
      assert.ok(existsSync(SPEC_PATH), "SPEC.md must have been written");
      assert.ok(readFileSync(SPEC_PATH, "utf-8").length > 0, "SPEC.md must be non-empty");
    });

    it("spec-designer existing-spec-branch emits absolute SPEC_ARTIFACT marker for relative input path", async () => {
      const WORKING_DIR = env.dir;
      const RELATIVE_SPEC_PATH = 'docs/specs/test-relative-input-fixture.md';
      const EXPECTED_ABS_PATH = path.resolve(WORKING_DIR, RELATIVE_SPEC_PATH);

      fs.mkdirSync(path.dirname(EXPECTED_ABS_PATH), { recursive: true });
      fs.writeFileSync(EXPECTED_ABS_PATH, '# Test Spec\n\nFixture for relative-input absolute-marker e2e test.\n');

      const deps = makeDefaultDeps({
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => env.dir,
        } as any,
        cwd: WORKING_DIR,
      });

      try {
        const taskPrompt =
          `Open the existing spec at the relative path "${RELATIVE_SPEC_PATH}" (relative to your current working directory). ` +
          `Add a "## Notes" section to its end containing a single line "Updated by relative-input e2e test." ` +
          `Then emit your SPEC_ARTIFACT marker per the spec-design procedure (Step 9 / subagent branch), ` +
          `which mandates the marker line carries the absolute path of the written file even when the input path was relative. ` +
          `As your terminal tool action, call subagent_done with the SPEC_ARTIFACT marker line as the message argument.`;

        const out = await runSerial(
          [{
            name: "spec-designer",
            agent: "test-claude-spec-designer", cli: "claude",
            task: taskPrompt,
          }],
          {},
          deps,
        );

        assert.equal(out.results.length, 1);
        assert.equal(out.isError, false);
        const r = out.results[0];

        assert.match(r.finalMessage, /SPEC_ARTIFACT: \/[^\n]*\/docs\/specs\/test-relative-input-fixture\.md\b/);
        assert.ok(r.finalMessage.includes(`SPEC_ARTIFACT: ${EXPECTED_ABS_PATH}`), 'final message must contain marker with the absolute fixture path');
        assert.ok(!/SPEC_ARTIFACT: docs\/specs\//.test(r.finalMessage), 'final message must not contain a relative-path SPEC_ARTIFACT marker');
      } finally {
        fs.rmSync(EXPECTED_ABS_PATH, { force: true });
      }
    });
  });
}
