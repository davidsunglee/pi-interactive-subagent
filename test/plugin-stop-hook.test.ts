import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "pi-extension", "subagents", "plugin", "hooks", "on-stop.sh");

function runHook(input: string, env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string> = { ...process.env } as any;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return spawnSync("bash", [HOOK], {
    input,
    env: merged,
    encoding: "utf-8",
  });
}

describe("plugin Stop hook", () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), "pi-hook-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it("exits 0 and writes nothing when PI_CLAUDE_SENTINEL is unset", () => {
    const transcriptPath = join(dir, "fixt-no-env.jsonl");
    writeFileSync(transcriptPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    const sentinel = join(dir, "sentinel-no-env");
    const result = runHook(
      JSON.stringify({ transcript_path: transcriptPath, stop_hook_active: false }),
      { PI_CLAUDE_SENTINEL: undefined },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel), false);
    assert.equal(existsSync(sentinel + ".transcript"), false);
  });

  it("exits 0 immediately and writes nothing when stop_hook_active=true", () => {
    const transcriptPath = join(dir, "fixt-loop.jsonl");
    writeFileSync(transcriptPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    const sentinel = join(dir, "sentinel-loop");
    const result = runHook(
      JSON.stringify({ transcript_path: transcriptPath, stop_hook_active: true }),
      { PI_CLAUDE_SENTINEL: sentinel },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel + ".transcript"), false);
  });

  it("writes the transcript path to ${PI_CLAUDE_SENTINEL}.transcript on a valid input", () => {
    const transcriptPath = join(dir, "fixt-valid.jsonl");
    writeFileSync(transcriptPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    const sentinel = join(dir, "sentinel-valid");
    const result = runHook(
      JSON.stringify({ transcript_path: transcriptPath, stop_hook_active: false }),
      { PI_CLAUDE_SENTINEL: sentinel },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel + ".transcript"), true);
    assert.equal(readFileSync(sentinel + ".transcript", "utf-8").trim(), transcriptPath);
  });

  it("exits 0 and writes nothing when transcript_path is missing or nonexistent", () => {
    const sentinel = join(dir, "sentinel-no-transcript");
    const result = runHook(
      JSON.stringify({ stop_hook_active: false }),
      { PI_CLAUDE_SENTINEL: sentinel },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel + ".transcript"), false);
  });

  it("REGRESSION: a transcript with user_msg_count==1 must NOT cause the sentinel file to appear", () => {
    // This pins the original-bug fix. The deleted heuristic used to write the
    // sentinel file whenever exactly one human-content user message was in the
    // transcript — interpreting "no follow-ups yet" as "task done." Any
    // resurrection of that branch will fail this assertion.
    const transcriptPath = join(dir, "fixt-1user.jsonl");
    writeFileSync(
      transcriptPath,
      '{"type":"user","message":{"role":"user","content":"first turn"}}\n' +
        '{"type":"assistant","message":{"role":"assistant","content":"asking a clarifying question?"}}\n',
    );
    const sentinel = join(dir, "sentinel-1user");
    const result = runHook(
      JSON.stringify({
        transcript_path: transcriptPath,
        stop_hook_active: false,
        last_assistant_message: "asking a clarifying question?",
      }),
      { PI_CLAUDE_SENTINEL: sentinel },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel), false,
      "sentinel must NOT appear after a single-user-turn transcript — that was the original bug");
    // The transcript pointer is still allowed (and expected) to be written.
    assert.equal(existsSync(sentinel + ".transcript"), true);
  });
});
