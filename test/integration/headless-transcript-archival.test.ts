import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
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

describe("headless-transcript-archival [pi]", { skip: !PI_AVAILABLE, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-archival-"));
    copyTestAgents(dir);
  });

  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("archives the pi session file with the task prompt present", async () => {
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      const backend = makeHeadlessBackend({
        sessionManager: {
          getSessionFile: () => join(dir, "parent.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => dir,
        } as any,
        cwd: dir,
      });
      const uniqueMarker = `MARKER_${Math.random().toString(36).slice(2, 10)}`;
      const handle = await backend.launch(
        {
          agent: "test-echo",
          task: `Reply with exactly: OK. (Do not mention ${uniqueMarker}.)`,
        },
        false,
      );
      const result = await backend.watch(handle);

      assert.equal(result.exitCode, 0);
      assert.ok(result.transcriptPath, "transcriptPath must be set");
      assert.ok(existsSync(result.transcriptPath!));

      const possibleRoots = [
        join(homedir(), ".pi", "agent", "sessions"),
        join(dir, ".pi", "agent", "sessions"),
        ...(process.env.PI_CODING_AGENT_DIR
          ? [join(process.env.PI_CODING_AGENT_DIR, "sessions")]
          : []),
      ];
      assert.ok(
        possibleRoots.some((root) => result.transcriptPath!.startsWith(root)),
        `transcriptPath must be under a resolved session root; got ${result.transcriptPath}. Candidates: ${possibleRoots.join(", ")}`,
      );

      const body = readFileSync(result.transcriptPath!, "utf8");
      assert.ok(body.includes(uniqueMarker), "archived transcript must include the task prompt text");
    } finally {
      process.chdir(origCwd);
    }
  });
});

const CLAUDE_AVAILABLE = (() => {
  try {
    execSync("which claude", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe("headless-transcript-archival [claude]", { skip: !CLAUDE_AVAILABLE, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-claude-arch-"));
  });
  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("archives the Claude transcript with session_id + task prompt present in the file body", async () => {
    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    const uniqueMarker = `CLAUDE_MARKER_${Math.random().toString(36).slice(2, 10)}`;
    const taskPrompt = `Reply with exactly: OK. (Context marker: ${uniqueMarker}.)`;
    const handle = await backend.launch(
      { task: taskPrompt, cli: "claude" },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0, `claude run errored: ${result.error}`);
    assert.ok(result.sessionId, "sessionId must be populated from system/init");
    assert.ok(result.transcriptPath, "transcriptPath must be set");
    assert.ok(existsSync(result.transcriptPath!), "archived transcript must exist on disk");

    const archiveRoot = join(homedir(), ".pi", "agent", "sessions", "claude-code");
    assert.ok(
      result.transcriptPath!.startsWith(archiveRoot),
      `transcriptPath must be under ${archiveRoot}, got ${result.transcriptPath}`,
    );
    assert.ok(
      result.transcriptPath!.endsWith(`${result.sessionId}.jsonl`),
      `archived filename must end with <sessionId>.jsonl, got ${result.transcriptPath}`,
    );

    const body = readFileSync(result.transcriptPath!, "utf8");
    assert.ok(
      body.trim().length > 0,
      "archived transcript must be non-empty; an empty or truncated file would mean the copy raced the claude writer",
    );
    assert.ok(
      body.includes(result.sessionId!),
      `archived transcript must contain the run's session id (${result.sessionId}); ` +
        `if it doesn't, findClaudeSessionFile() or archiveClaudeTranscript() copied a stale or wrong-session file ` +
        `that happened to share the same basename.`,
    );
    assert.ok(
      body.includes(uniqueMarker),
      `archived transcript must contain the task prompt marker (${uniqueMarker}); ` +
        `absence means the archive does not correspond to this run even though the filename matches.`,
    );
  });
});
