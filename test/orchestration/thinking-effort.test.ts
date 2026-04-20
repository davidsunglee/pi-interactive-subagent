import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { thinkingToEffort, buildClaudeCmdParts } from "../../pi-extension/subagents/index.ts";

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
      appendSystemPrompt: undefined,
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
      appendSystemPrompt: undefined,
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
      appendSystemPrompt: undefined,
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
      appendSystemPrompt: undefined,
      resumeSessionId: undefined,
      effectiveThinking: "bogus",
      task: "do things",
    });
    assert.equal(parts.includes("--effort"), false);
  });
});
