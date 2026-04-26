import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeCompletionAddendum,
  resolveLaunchSpec,
} from "../../pi-extension/subagents/launch-spec.ts";

const baseCtx = {
  sessionManager: {
    getSessionFile: () => "/tmp/parent.jsonl",
    getSessionId: () => "sess-test",
    getSessionDir: () => "/tmp",
  } as any,
  cwd: "/tmp",
};

describe("buildClaudeCompletionAddendum", () => {
  it("returns the autonomous form for autoExit=true", () => {
    const text = buildClaudeCompletionAddendum(true);
    assert.match(text, /one-shot subagent/);
    assert.match(text, /without asking the user questions/);
    assert.match(text, /call `subagent_done`/);
  });

  it("returns the interactive form for autoExit=false", () => {
    const text = buildClaudeCompletionAddendum(false);
    assert.match(text, /interactive subagent/);
    assert.match(text, /ask clarifying questions/);
    assert.match(text, /call `subagent_done`/);
  });
});

describe("resolveLaunchSpec.claudeCompletionAddendum", () => {
  it("is populated with the autoExit=false form for cli=claude when no agent or auto-exit:false agent", () => {
    const spec = resolveLaunchSpec(
      { name: "C", task: "do", cli: "claude" },
      baseCtx,
    );
    assert.ok(spec.claudeCompletionAddendum, "addendum must be populated for Claude pane path");
    assert.match(spec.claudeCompletionAddendum!, /interactive subagent/);
  });

  it("is populated with the autoExit=true form when agent declares auto-exit:true", () => {
    const spec = resolveLaunchSpec(
      { name: "C", task: "do", agent: "test-echo" }, // test-echo declares auto-exit: true
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    // test-echo also declares cli: pi by default — assert against the
    // autoExit value rather than the cli, then re-resolve with cli forced.
    const claudeSpec = resolveLaunchSpec(
      { name: "C", task: "do", agent: "test-echo", cli: "claude" },
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    assert.equal(claudeSpec.autoExit, true);
    assert.ok(claudeSpec.claudeCompletionAddendum);
    assert.match(claudeSpec.claudeCompletionAddendum!, /one-shot subagent/);
    void spec;
  });

  it("is null when effectiveCli is not 'claude'", () => {
    const spec = resolveLaunchSpec({ name: "P", task: "do", cli: "pi" }, baseCtx);
    assert.equal(spec.claudeCompletionAddendum, null);
  });

  it("is null when no cli is specified (defaults to pi)", () => {
    const spec = resolveLaunchSpec({ name: "P", task: "do" }, baseCtx);
    assert.equal(spec.effectiveCli, "pi");
    assert.equal(spec.claudeCompletionAddendum, null);
  });
});
