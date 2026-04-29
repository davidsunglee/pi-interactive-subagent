import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTestAgents, SLOW_LANE_OPT_IN } from "./harness.ts";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

const PI_AVAILABLE = (() => {
  try {
    execSync("which pi", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

const SHOULD_SKIP = !PI_AVAILABLE || !SLOW_LANE_OPT_IN;

describe("coordinator-orchestration-tools", { skip: SHOULD_SKIP, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let origCwd: string;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-coord-tools-"));
    copyTestAgents(dir);
    origCwd = process.cwd();
    process.chdir(dir);
  });

  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("coordinator with restrictive tools dispatches child via subagent_run_serial and surfaces COORD-CHILD-OK", async () => {
    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    const handle = await backend.launch(
      { name: "coord", agent: "test-coordinator", task: "Run the coordination workflow now." },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);
    assert.ok(
      result.finalMessage.includes("COORD-CHILD-OK"),
      `finalMessage must include COORD-CHILD-OK; got: ${result.finalMessage}`,
    );

    const hasSubagentRunSerial = (result.transcript ?? []).some((msg) =>
      msg.content.some((b) => b.type === "toolCall" && b.name === "subagent_run_serial"),
    );
    assert.ok(
      hasSubagentRunSerial,
      "transcript must contain a toolCall for subagent_run_serial",
    );
  });
});
