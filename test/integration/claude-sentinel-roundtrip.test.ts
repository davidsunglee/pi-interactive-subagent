import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getAvailableBackends,
  setBackend,
  restoreBackend,
  createTestEnv,
  cleanupTestEnv,
  PI_TIMEOUT,
  SLOW_LANE_OPT_IN,
  type TestEnv,
} from "./harness.ts";
import { launchSubagent, watchSubagent } from "../../pi-extension/subagents/index.ts";

const CLAUDE_AVAILABLE = (() => {
  try {
    execSync("which claude", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
const PLUGIN_DIR = join(
  new URL("../../pi-extension/subagents/plugin", import.meta.url).pathname,
);
const PLUGIN_PRESENT = existsSync(join(PLUGIN_DIR, "hooks", "on-stop.sh"));
const backends = getAvailableBackends();

// Slow-lane gated: this test launches a real Claude pane and waits for the
// model to call subagent_done, which spends tokens and minutes of wall time
// (review-v1 finding 2). Default `npm run test:integration` should not pay
// that cost; PI_RUN_SLOW=1 opts in via test:integration:slow.
const SHOULD_SKIP =
  !CLAUDE_AVAILABLE || !PLUGIN_PRESENT || backends.length === 0 || !SLOW_LANE_OPT_IN;

if (SHOULD_SKIP) {
  console.log(
    "⚠️  claude-sentinel-roundtrip skipped: " +
      `CLAUDE=${CLAUDE_AVAILABLE} PLUGIN=${PLUGIN_PRESENT} BACKENDS=${backends.length} SLOW=${SLOW_LANE_OPT_IN}`,
  );
}

for (const backend of backends) {
  describe(`claude-sentinel-roundtrip [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 2 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;

    before(() => {
      prevMux = setBackend(backend);
      env = createTestEnv(backend);
    });

    after(() => {
      cleanupTestEnv(env);
      restoreBackend(prevMux);
    });

    it("archives transcriptPath under ~/.pi/agent/sessions/claude-code/ after completion", async () => {
      const ctx = {
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "test-session",
          getSessionDir: () => env.dir,
        },
        cwd: env.dir,
      };

      const running = await launchSubagent(
        {
          name: "ClaudeRoundtrip",
          task: "Reply OK and call subagent_done with message='OK'.",
          agent: "test-claude-autoexit",
        },
        ctx,
      );
      env.surfaces.push(running.surface);

      const abort = new AbortController();
      const result = await watchSubagent(running, abort.signal);

      assert.equal(result.exitCode, 0, `expected clean exit, got ${result.exitCode}`);
      assert.ok(result.summary && result.summary.trim().length > 0, "summary must be non-empty");
      assert.ok(result.transcriptPath, "transcriptPath must be non-null");
      const archiveRoot = join(homedir(), ".pi", "agent", "sessions", "claude-code");
      assert.ok(
        result.transcriptPath!.startsWith(archiveRoot),
        `transcriptPath must be under ${archiveRoot}, got ${result.transcriptPath}`,
      );
      assert.ok(existsSync(result.transcriptPath!), "archived transcript file must exist");

      // Pin plugin-MCP auto-load: the archived Claude transcript MUST contain
      // a `tool_use` block for `subagent_done`. If this fails, plugin-MCP
      // discovery is unreliable on this Claude version and Task 10's
      // --mcp-config fallback must be implemented before proceeding.
      assert.ok(result.transcriptPath, "transcriptPath must be populated");
      const transcript = readFileSync(result.transcriptPath, "utf-8");
      // Tool name on the auto-load path is namespaced (e.g.
      // `mcp__plugin_pi-subagent_pi-subagent__subagent_done`), so accept any
      // tool_use whose name ends with `subagent_done`. Bare `subagent_done`
      // would also match (the manual --mcp-config path).
      const sawSubagentDoneToolUse = transcript
        .split("\n")
        .filter((l) => l.length > 0)
        .some((line) => {
          try {
            const ev = JSON.parse(line);
            const blocks = ev?.message?.content;
            return Array.isArray(blocks) && blocks.some(
              (b: any) =>
                b?.type === "tool_use" &&
                typeof b?.name === "string" &&
                (b.name === "subagent_done" || b.name.endsWith("__subagent_done")),
            );
          } catch { return false; }
        });
      assert.ok(
        sawSubagentDoneToolUse,
        `archived transcript at ${result.transcriptPath} contains no subagent_done tool_use — plugin-MCP auto-load likely failed; implement Task 10`,
      );
    });
  });
}
