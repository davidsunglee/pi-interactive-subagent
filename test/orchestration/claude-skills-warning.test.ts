import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { warnClaudeSkillsDropped } from "../../pi-extension/subagents/index.ts";

describe("warnClaudeSkillsDropped", () => {
  let captured: string;
  let origWrite: typeof process.stderr.write;

  beforeEach(() => {
    captured = "";
    origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string | Buffer): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
  });
  afterEach(() => {
    (process.stderr as any).write = origWrite;
  });

  it("writes a single-line warning when effectiveSkills is non-empty", () => {
    warnClaudeSkillsDropped("my-subagent", "plan, code-review");
    assert.ok(
      captured.includes("ignoring skills=plan, code-review"),
      `expected skills list in warning; got: ${JSON.stringify(captured)}`,
    );
    assert.ok(
      captured.includes("my-subagent"),
      `expected subagent name in warning; got: ${JSON.stringify(captured)}`,
    );
    assert.ok(
      captured.includes("Claude path"),
      `expected "Claude path" phrasing so pane + headless share exact wording; got: ${JSON.stringify(captured)}`,
    );
    assert.equal(captured.split("\n").filter(Boolean).length, 1,
      "warning must be a single line — multiple lines indicate a shadow emit path");
  });

  it("is a no-op when effectiveSkills is undefined", () => {
    warnClaudeSkillsDropped("my-subagent", undefined);
    assert.equal(captured, "");
  });

  it("is a no-op when effectiveSkills is the empty string or whitespace-only", () => {
    warnClaudeSkillsDropped("my-subagent", "");
    warnClaudeSkillsDropped("my-subagent", "   ");
    assert.equal(captured, "");
  });
});
