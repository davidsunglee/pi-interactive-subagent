import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyClaudeSession } from "../../pi-extension/subagents/index.ts";

describe("copyClaudeSession (review-v2 finding 3)", () => {
  // Pane Claude used to surface the archived .jsonl filename as the unified
  // `sessionId`. Headless returns the raw session id from system/init, so
  // feeding the pane value back into --resume broke the contract. The fix:
  // return a structured record with sessionId stripped of the extension, and
  // the archived path as a separate field.
  it("returns { sessionId, archivedPath } with sessionId lacking the .jsonl extension", () => {
    const root = mkdtempSync(join(tmpdir(), "pane-claude-session-"));
    try {
      const sourceDir = join(root, "claude-projects");
      mkdirSync(sourceDir, { recursive: true });
      const sourcePath = join(sourceDir, "abc-123.jsonl");
      writeFileSync(sourcePath, '{"type":"system"}\n', "utf8");

      const sentinel = join(root, "sentinel");
      writeFileSync(sentinel, "done\n", "utf8");
      writeFileSync(sentinel + ".transcript", sourcePath, "utf8");

      const archiveRoot = join(root, "archive");
      const result = copyClaudeSession(sentinel, archiveRoot);
      assert.ok(result, "copyClaudeSession must return a result when source transcript exists");
      assert.equal(
        result!.sessionId,
        "abc-123",
        "sessionId must be the raw Claude session id (no .jsonl extension) so pane matches headless",
      );
      assert.equal(
        result!.archivedPath,
        join(archiveRoot, "abc-123.jsonl"),
        "archivedPath must point to the archived jsonl file",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when the sentinel's transcript pointer is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pane-claude-session-miss-"));
    try {
      const sentinel = join(root, "sentinel");
      writeFileSync(sentinel, "done\n", "utf8");
      // No .transcript pointer alongside the sentinel.
      const result = copyClaudeSession(sentinel, join(root, "archive"));
      assert.equal(result, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
