import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { findClaudeSessionFile } from "../../pi-extension/subagents/backends/headless.ts";

describe("findClaudeSessionFile", () => {
  let fakeHome: string;
  let origHome: string | undefined;

  before(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "pi-claude-arch-"));
    origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    assert.equal(homedir(), fakeHome);
  });
  after(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("finds <sessionId>.jsonl under an arbitrary project-slug directory (no trailing hyphen)", async () => {
    const projectsRoot = join(fakeHome, ".claude", "projects");
    const slugDir = join(projectsRoot, "-Users-david-Code-pi-config");
    mkdirSync(slugDir, { recursive: true });
    const sessionId = "0f2d5442-1141-43f4-bfa1-3daa44e65382";
    const sessionFile = join(slugDir, `${sessionId}.jsonl`);
    writeFileSync(sessionFile, "{}\n");

    const found = await findClaudeSessionFile(sessionId, 500);
    assert.equal(found, sessionFile,
      "discovery must locate the real file regardless of slug shape — NOT reconstruct a `-<cwdSlug>-/` guess");
  });

  it("returns null when the sessionId has no match anywhere under ~/.claude/projects/", async () => {
    const projectsRoot = join(fakeHome, ".claude", "projects");
    mkdirSync(join(projectsRoot, "-some-other-project"), { recursive: true });
    writeFileSync(
      join(projectsRoot, "-some-other-project", "unrelated-uuid.jsonl"),
      "{}\n",
    );
    const found = await findClaudeSessionFile("nonexistent-id", 200);
    assert.equal(found, null);
  });

  it("tolerates a missing projects root (first Claude run ever) by returning null", async () => {
    rmSync(join(fakeHome, ".claude"), { recursive: true, force: true });
    const found = await findClaudeSessionFile("any-id", 200);
    assert.equal(found, null);
  });
});
