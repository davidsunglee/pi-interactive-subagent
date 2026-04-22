import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

const CLAUDE_AVAILABLE = (() => {
  try {
    execSync("which claude", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe("headless-claude-smoke", { skip: !CLAUDE_AVAILABLE, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-claude-"));
  });
  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a unique-marker Claude task with non-zero cost, sessionId, archived transcript", async () => {
    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    const marker = `HEADLESS_CLAUDE_SMOKE_${randomUUID()}`;
    const handle = await backend.launch(
      { task: `Reply with exactly: ${marker}`, cli: "claude" },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);
    assert.ok(result.finalMessage.trim().length > 0, "finalMessage must be non-empty");
    assert.ok(result.finalMessage.includes(marker),
      `finalMessage must include the unique cache-busting marker ${marker}; got: ${JSON.stringify(result.finalMessage)}`);
    assert.ok(result.usage, "usage must be set");
    assert.ok(
      result.usage!.cost > 0,
      `usage.cost must be > 0 for the unique-marker, non-cached Claude task; got ${result.usage!.cost}. ` +
        `A zero cost here means either the cache-busting marker stopped being unique, ` +
        `parseClaudeResult() is not reading total_cost_usd, or the terminal 'result' event is being dropped.`,
    );
    assert.ok(result.usage!.turns >= 1, `usage.turns must be >=1, got ${result.usage!.turns}`);
    assert.ok(result.sessionId, "sessionId must be populated from system/init event");
    assert.ok(result.transcript && result.transcript.length > 0, "transcript array must be non-empty");
    assert.equal((result as any).messages, undefined,
      "BackendResult must not expose `messages` (v5 shape); v6 exposes `transcript` (review-v7 finding 2)");

    // Guard: the terminal `result` event must NOT also be appended to transcript[]
    // as a second assistant turn — the streamed `assistant` event already carried it.
    const finalText = result.finalMessage.trim();
    const textOnlyAssistantMatches = result.transcript!
      .filter((m) => m.role === "assistant")
      .map((m) => {
        if (!Array.isArray(m.content)) return "";
        return m.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");
      })
      .filter((t) => t.trim() === finalText);
    assert.ok(
      textOnlyAssistantMatches.length <= 1,
      `transcript[] must contain the final assistant message at most once; ` +
        `found ${textOnlyAssistantMatches.length} assistant messages whose concatenated text ` +
        `equals finalMessage. Regression: the 'result' event branch of runClaudeHeadless is ` +
        `appending terminalResult.finalOutput even though the streamed 'assistant' event already did.`,
    );

    assert.ok(result.transcriptPath, "transcriptPath must be set");
    const archiveRoot = join(homedir(), ".pi", "agent", "sessions", "claude-code");
    assert.ok(
      result.transcriptPath!.startsWith(archiveRoot),
      `transcriptPath must be under ${archiveRoot}, got ${result.transcriptPath}`,
    );
    assert.ok(existsSync(result.transcriptPath!), "archived transcript must exist");
  });
});
