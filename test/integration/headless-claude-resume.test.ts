import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

const CLAUDE_AVAILABLE = (() => {
  try { execSync("which claude", { stdio: "pipe" }); return true; }
  catch { return false; }
})();

describe("headless-claude-resume", { skip: !CLAUDE_AVAILABLE, timeout: 180_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-claude-resume-"));
  });
  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("resumes the same Claude session id on a second launch when resumeSessionId is set", async () => {
    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    const marker = `MARK_${Math.random().toString(36).slice(2, 10)}`;
    const first = await backend.watch(
      await backend.launch(
        { task: `Acknowledge marker ${marker}. Reply with: OK`, cli: "claude" },
        false,
      ),
    );
    assert.equal(first.exitCode, 0, `first launch error=${first.error}`);
    assert.ok(first.sessionId, "first launch must report a sessionId");

    const second = await backend.watch(
      await backend.launch(
        {
          task: `Repeat the marker you received in the previous turn.`,
          cli: "claude",
          resumeSessionId: first.sessionId,
        },
        false,
      ),
    );
    assert.equal(second.exitCode, 0, `second launch error=${second.error}`);
    assert.equal(second.sessionId, first.sessionId,
      "resumed launch must report the same sessionId");
    assert.ok(second.transcriptPath && existsSync(second.transcriptPath));
    const body = readFileSync(second.transcriptPath!, "utf8");
    assert.ok(body.includes(marker), "resumed transcript must reflect the prior turn's content");
  });
});
