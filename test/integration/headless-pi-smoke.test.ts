import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTestAgents } from "./harness.ts";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

const PI_AVAILABLE = (() => {
  try {
    execSync("which pi", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe("headless-pi-smoke", { skip: !PI_AVAILABLE, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-smoke-"));
    copyTestAgents(dir);          // ← seeds <dir>/.pi/agents/test-echo.md so loadAgentDefaults finds it
  });

  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a trivial pi task and returns non-empty usage + transcript + archived session file", async () => {
    const origCwd = process.cwd();
    process.chdir(dir);            // loadAgentDefaults reads from process.cwd()/.pi/agents/
    try {
      const backend = makeHeadlessBackend({
        sessionManager: {
          getSessionFile: () => join(dir, "parent.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => dir,
        } as any,
        cwd: dir,
      });
      const handle = await backend.launch(
        {
          agent: "test-echo",
          task: "Reply with exactly: OK",
        },
        false,
      );
      const result = await backend.watch(handle);

      assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);
      assert.ok(result.finalMessage.trim().length > 0, "finalMessage must be non-empty");
      assert.ok(result.usage, "usage must be set on headless result");
      assert.ok(result.usage!.turns >= 1, `usage.turns must be >=1, got ${result.usage!.turns}`);
      assert.ok(result.transcript && result.transcript.length > 0, "transcript array must be non-empty");
      assert.ok(result.transcriptPath, "transcriptPath must be set");
      assert.ok(existsSync(result.transcriptPath!), "archived session file must exist");
    } finally {
      process.chdir(origCwd);
    }
  });
});
