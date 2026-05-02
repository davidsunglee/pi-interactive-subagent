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
const HOOK = join(HERE, "..", "pi-extension", "subagents", "plugin", "hooks", "on-session-start.sh");

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

describe("plugin SessionStart hook", () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), "pi-session-start-hook-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it("exits 0 and writes nothing when PI_CLAUDE_SENTINEL is unset", () => {
    const transcriptPath = join(dir, "fixt-no-env.jsonl");
    writeFileSync(transcriptPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    const sentinel = join(dir, "sentinel-no-env");
    const result = runHook(
      JSON.stringify({ transcript_path: transcriptPath }),
      { PI_CLAUDE_SENTINEL: undefined },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel + ".transcript"), false);
  });

  it("writes the transcript path to ${PI_CLAUDE_SENTINEL}.transcript on a valid input", () => {
    const transcriptPath = join(dir, "fixt-valid.jsonl");
    writeFileSync(transcriptPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    const sentinel = join(dir, "sentinel-valid");
    const result = runHook(
      JSON.stringify({ transcript_path: transcriptPath }),
      { PI_CLAUDE_SENTINEL: sentinel },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel + ".transcript"), true);
    assert.equal(readFileSync(sentinel + ".transcript", "utf-8").trim(), transcriptPath);
  });

  it("exits 0 and writes nothing when transcript_path is missing", () => {
    const sentinel = join(dir, "sentinel-no-transcript");
    const result = runHook(
      JSON.stringify({}),
      { PI_CLAUDE_SENTINEL: sentinel },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel + ".transcript"), false);
  });

  it("exits 0 and pointer file content is unchanged when re-fired with same transcript", () => {
    const transcriptPath = join(dir, "fixt-idempotent.jsonl");
    writeFileSync(transcriptPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    const sentinel = join(dir, "sentinel-idempotent");
    // First fire
    runHook(
      JSON.stringify({ transcript_path: transcriptPath }),
      { PI_CLAUDE_SENTINEL: sentinel },
    );
    // Second fire (idempotent)
    const result = runHook(
      JSON.stringify({ transcript_path: transcriptPath }),
      { PI_CLAUDE_SENTINEL: sentinel },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel + ".transcript"), true);
    assert.equal(readFileSync(sentinel + ".transcript", "utf-8").trim(), transcriptPath);
  });
});
