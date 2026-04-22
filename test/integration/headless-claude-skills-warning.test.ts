import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

const CLAUDE_AVAILABLE = (() => {
  try { execSync("which claude", { stdio: "pipe" }); return true; }
  catch { return false; }
})();

describe("headless-claude-skills-warning", { skip: !CLAUDE_AVAILABLE, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let dir: string;
  let originalStderrWrite: typeof process.stderr.write;
  let stderrCapture: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-claude-skills-"));
  });
  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits the documented stderr warning and does not leak /skill: tokens into the task or response", async () => {
    stderrCapture = "";
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
      stderrCapture += typeof chunk === "string" ? chunk : chunk.toString();
      return originalStderrWrite(chunk, ...rest);
    };
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
          task: "Reply with exactly the single word: OK",
          cli: "claude",
          skills: "plan, code-review",
        },
        false,
      );
      const result = await backend.watch(handle);

      assert.equal(result.exitCode, 0, `Claude should still complete cleanly; error=${result.error}`);

      assert.match(stderrCapture, /ignoring skills=.*on Claude path/i,
        `expected skills-drop warning in stderr; got:\n${stderrCapture}`);

      assert.ok(!result.finalMessage.includes("/skill:"),
        `Claude response contains /skill: literal — indicates skill tokens leaked into task body.\nfinalMessage: ${result.finalMessage}`);

      const textBlocks = (result.transcript ?? [])
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text);
      for (const t of textBlocks) {
        assert.ok(!t.includes("/skill:"),
          `transcript text block contains /skill: literal: ${t}`);
      }
    } finally {
      (process.stderr as any).write = originalStderrWrite;
    }
  });
});
