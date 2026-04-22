import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  thinkingToEffort,
  buildClaudeCmdParts,
  shellEscape,
} from "../../pi-extension/subagents/index.ts";
import { resolveLaunchSpec } from "../../pi-extension/subagents/launch-spec.ts";

describe("thinkingToEffort", () => {
  it("maps off/minimal/low to low", () => {
    assert.equal(thinkingToEffort("off"), "low");
    assert.equal(thinkingToEffort("minimal"), "low");
    assert.equal(thinkingToEffort("low"), "low");
  });
  it("maps medium to medium", () => {
    assert.equal(thinkingToEffort("medium"), "medium");
  });
  it("maps high to high", () => {
    assert.equal(thinkingToEffort("high"), "high");
  });
  it("maps xhigh to max", () => {
    assert.equal(thinkingToEffort("xhigh"), "max");
  });
  it("returns undefined for unknown values", () => {
    assert.equal(thinkingToEffort("bogus"), undefined);
    assert.equal(thinkingToEffort(""), undefined);
    assert.equal(thinkingToEffort(undefined), undefined);
  });
});

describe("buildClaudeCmdParts", () => {
  it("includes --effort when thinking is set", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: "high",
      task: "do things",
    });
    assert.ok(parts.includes("--effort"));
    assert.equal(parts[parts.indexOf("--effort") + 1], "high");
  });
  it("maps xhigh to max", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: "xhigh",
      task: "do things",
    });
    assert.equal(parts[parts.indexOf("--effort") + 1], "max");
  });
  it("omits --effort when thinking is absent", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do things",
    });
    assert.equal(parts.includes("--effort"), false);
  });
  it("omits --effort when thinking is unknown (maps to undefined)", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: "bogus",
      task: "do things",
    });
    assert.equal(parts.includes("--effort"), false);
  });

  it("emits --tools with mapped Claude tool names when effectiveTools is set", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      effectiveTools: "read, bash, find, ls, unknown",
      task: "do things",
    });
    const idx = parts.indexOf("--tools");
    assert.notEqual(idx, -1, "--tools must be present");
    const raw = parts[idx + 1].replace(/^'|'$/g, "");
    const mapped = new Set(raw.split(","));
    assert.ok(mapped.has("Read"));
    assert.ok(mapped.has("Bash"));
    assert.ok(mapped.has("Glob"));
    assert.ok(!mapped.has("unknown"), "unmapped tools must be dropped, not passed through");
    assert.equal(parts.includes("--allowedTools"), false,
      "must not emit --allowedTools (that is a permission rule ignored in bypassPermissions mode)");
  });

  it("omits --tools when effectiveTools is absent (no regression for agents without tools: frontmatter)", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do things",
    });
    assert.equal(parts.includes("--tools"), false);
    assert.equal(parts.includes("--allowedTools"), false);
  });

  it("appends task separated by -- so variadic --tools does not consume it (review-v6 blocker 1)", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      effectiveTools: "read, bash",
      task: "Write a plan for X.",
    });
    const toolsIdx = parts.indexOf("--tools");
    const sepIdx = parts.lastIndexOf("--");
    const taskIdx = parts.indexOf(shellEscape("Write a plan for X."));
    assert.ok(toolsIdx >= 0, "expected --tools in parts");
    assert.ok(sepIdx > toolsIdx, `expected -- separator after --tools (got sepIdx=${sepIdx}, toolsIdx=${toolsIdx})`);
    assert.equal(taskIdx, sepIdx + 1, "task must appear immediately after --");
    assert.equal(parts.length - 1, taskIdx, "task must be the final argv entry");
  });

  it("omits -- separator when task is empty (matches upstream pi-subagent behavior)", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "",
    });
    assert.equal(parts.includes("--"), false, "empty task should not emit -- separator");
  });

  it("uses spec.identity (agent body first) — not params.systemPrompt first (v10, review-v11 finding 1)", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: "AGENT_BODY_IDENTITY",
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "just do the task",
    });
    const idx = parts.indexOf("--append-system-prompt");
    assert.ok(idx >= 0, "expected --append-system-prompt for default mode");
    assert.equal(parts[idx + 1], shellEscape("AGENT_BODY_IDENTITY"),
      "review-v11 finding 1 regression: pane-Claude must use spec.identity");
  });

  it("emits --system-prompt (not --append-system-prompt) when systemPromptMode=replace", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: "REPLACE_IDENTITY",
      systemPromptMode: "replace",
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do",
    });
    assert.ok(parts.includes("--system-prompt"),
      "replace mode must emit --system-prompt on the pane path");
    assert.equal(parts.includes("--append-system-prompt"), false);
  });

  it("does NOT embed identity text in the task argv — identity goes via the flag only", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: "SECRET_IDENTITY_XYZ",
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "the real task, no identity leakage here",
    });
    const identityOccurrences = parts.filter((p) =>
      p.includes("SECRET_IDENTITY_XYZ"),
    );
    assert.equal(identityOccurrences.length, 1,
      `identity must appear exactly once (after --append-system-prompt); got ${identityOccurrences.length}`);
  });

  it("uses resolveLaunchSpec().claudeModelArg so provider-prefixed Claude models match headless behavior (v18 / review-v21 blocker)", () => {
    const spec = resolveLaunchSpec(
      { name: "PaneModel", task: "do", cli: "claude", model: "anthropic/claude-haiku-4-5" },
      {
        sessionManager: {
          getSessionFile: () => "/tmp/parent.jsonl",
          getSessionId: () => "sess-test",
          getSessionDir: () => "/tmp",
        } as any,
        cwd: "/tmp",
      },
    );
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: spec.claudeModelArg,
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do",
    });
    const idx = parts.indexOf("--model");
    assert.equal(parts[idx + 1], shellEscape("claude-haiku-4-5"),
      "pane-Claude must consume the shared normalized model arg from resolveLaunchSpec()");
  });
});
