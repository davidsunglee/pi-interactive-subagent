import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentDefaults, resolveLaunchSpec } from "../../pi-extension/subagents/launch-spec.ts";

const baseCtx = {
  sessionManager: {
    getSessionFile: () => "/tmp/parent.jsonl",
    getSessionId: () => "sess-test",
    getSessionDir: () => "/tmp",
  } as any,
  cwd: "/tmp",
};

describe("resolveLaunchSpec", () => {
  it("propagates direct fields when no agent is given", () => {
    const spec = resolveLaunchSpec(
      {
        name: "S1",
        task: "do",
        model: "anthropic/claude-haiku-4-5",
        thinking: "medium",
        cli: "pi",
        tools: "read,bash",
      },
      baseCtx,
    );
    assert.equal(spec.effectiveModel, "anthropic/claude-haiku-4-5");
    assert.equal(spec.effectiveThinking, "medium");
    assert.equal(spec.effectiveCli, "pi");
    assert.equal(spec.effectiveTools, "read,bash");
    assert.equal(spec.sessionMode, "standalone");
    assert.equal(spec.taskDelivery, "artifact");
    assert.equal(spec.autoExit, false);
    assert.deepEqual([...spec.denySet], []);
  });

  it("computes a shared claudeModelArg once so pane + headless Claude stay in sync", () => {
    const prefixed = resolveLaunchSpec(
      { name: "C1", task: "do", cli: "claude", model: "anthropic/claude-haiku-4-5" },
      baseCtx,
    );
    assert.equal(prefixed.effectiveModel, "anthropic/claude-haiku-4-5");
    assert.equal(prefixed.claudeModelArg, "claude-haiku-4-5");

    const bare = resolveLaunchSpec(
      { name: "C2", task: "do", cli: "claude", model: "claude-sonnet-4-6" },
      baseCtx,
    );
    assert.equal(bare.claudeModelArg, "claude-sonnet-4-6");
  });

  it("loads agent defaults and lets params override them", () => {
    const spec = resolveLaunchSpec(
      { name: "S2", task: "ping", agent: "test-echo", model: "anthropic/claude-sonnet-4-5" },
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    assert.equal(spec.effectiveModel, "anthropic/claude-sonnet-4-5");
    assert.equal(spec.effectiveTools, "read, bash, write, edit");
    assert.equal(spec.autoExit, true);
    assert.ok(spec.denySet.has("subagent_serial"));
  });

  it("flips taskDelivery to direct only when fork (or agent session-mode=fork) is set", () => {
    const a = resolveLaunchSpec({ name: "X", task: "t" }, baseCtx);
    assert.equal(a.taskDelivery, "artifact");
    const b = resolveLaunchSpec({ name: "X", task: "t", fork: true }, baseCtx);
    assert.equal(b.taskDelivery, "direct");
    assert.equal(b.sessionMode, "fork");
  });

  it("expands skill names into /skill: prompts in spec.skillPrompts", () => {
    const spec = resolveLaunchSpec(
      { name: "X", task: "t", skills: "foo, bar" },
      baseCtx,
    );
    assert.deepEqual(spec.skillPrompts, ["/skill:foo", "/skill:bar"]);
  });

  it("threads resumeSessionId through unchanged", () => {
    const spec = resolveLaunchSpec(
      { name: "X", task: "t", resumeSessionId: "abc-123" },
      baseCtx,
    );
    assert.equal(spec.resumeSessionId, "abc-123");
  });

  it("system-prompt mode 'replace' marks identityInSystemPrompt with --system-prompt flag", () => {
    const spec = resolveLaunchSpec(
      { name: "X", task: "t", systemPrompt: "you are a sentinel" },
      baseCtx,
    );
    assert.equal(spec.identity, "you are a sentinel");
    assert.equal(spec.identityInSystemPrompt, false);
    assert.match(spec.fullTask, /you are a sentinel/);
  });

  it("resolves identity as agentDefs.body first when both agent body and caller systemPrompt are set", () => {
    const spec = resolveLaunchSpec(
      {
        name: "X",
        task: "t",
        agent: "test-echo",
        systemPrompt: "CALLER_PROMPT_SHOULD_NOT_WIN",
      },
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    assert.ok(spec.identity, "identity must be non-null when agent body present");
    assert.notEqual(spec.identity, "CALLER_PROMPT_SHOULD_NOT_WIN",
      "review-v11 finding 1 regression: pane-Claude inverted precedence (params.systemPrompt first) leaked into the spec");
  });

  it("exposes claudeTaskBody without the roleBlock for Claude backends to consume", () => {
    const blank = resolveLaunchSpec(
      { name: "X", task: "do-task", systemPrompt: "you are Y" },
      baseCtx,
    );
    assert.match(blank.fullTask, /you are Y/);
    assert.doesNotMatch(blank.claudeTaskBody, /you are Y/,
      "review-v11 finding 1 regression: identity text leaked into claudeTaskBody — Claude would see it via the flag AND the task body");
    assert.match(blank.claudeTaskBody, /do-task/);

    const fork = resolveLaunchSpec(
      { name: "X", task: "do-task", systemPrompt: "you are Y", fork: true },
      baseCtx,
    );
    assert.equal(fork.claudeTaskBody, "do-task");
  });

  it("places subagentSessionFile under getDefaultSessionDirFor(targetCwd, agentDir)", () => {
    const spec = resolveLaunchSpec({ name: "X", task: "t" }, baseCtx);
    assert.match(spec.subagentSessionFile, /\.jsonl$/);
    assert.match(spec.subagentSessionFile, /sessions\/--tmp--\//);
  });

  it("resolves agent defaults from the target project's .pi/agents/ when params.cwd points into another repo (review finding 1)", () => {
    const parentRoot = mkdtempSync(join(tmpdir(), "ls-parent-"));
    const targetRoot = mkdtempSync(join(tmpdir(), "ls-target-"));
    try {
      // Seed two different agents with the same name at the two roots so we
      // can prove which one won.
      mkdirSync(join(parentRoot, ".pi", "agents"), { recursive: true });
      mkdirSync(join(targetRoot, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(parentRoot, ".pi", "agents", "contested.md"),
        "---\nmodel: parent-model\ntools: read\n---\nparent body\n",
        "utf8",
      );
      writeFileSync(
        join(targetRoot, ".pi", "agents", "contested.md"),
        "---\nmodel: target-model\ntools: bash\n---\ntarget body\n",
        "utf8",
      );

      const ctx = {
        sessionManager: baseCtx.sessionManager,
        cwd: parentRoot,
      };
      const spec = resolveLaunchSpec(
        { name: "Z", task: "t", agent: "contested", cwd: targetRoot },
        ctx,
      );
      assert.equal(
        spec.effectiveModel,
        "target-model",
        "agent lookup must follow params.cwd target, not parent ctx.cwd",
      );
      assert.equal(spec.effectiveTools, "bash");
    } finally {
      rmSync(parentRoot, { recursive: true, force: true });
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it("resolves relative params.cwd against ctx.cwd, not process.cwd() (review-v2 finding 1)", () => {
    // Regression: resolveSubagentPaths used to resolve relative params.cwd
    // against process.cwd(). If the session cwd differs from the Node process
    // cwd, that split the launch-spec contract: agent lookup followed one tree
    // while session placement/config-root followed another.
    const sessionRoot = mkdtempSync(join(tmpdir(), "ls-session-"));
    try {
      const ctx = {
        sessionManager: baseCtx.sessionManager,
        cwd: sessionRoot,
      };
      const spec = resolveLaunchSpec(
        { name: "R", task: "t", cwd: "sub/dir" },
        ctx,
      );
      assert.equal(
        spec.effectiveCwd,
        join(sessionRoot, "sub", "dir"),
        "relative params.cwd must resolve against ctx.cwd",
      );
      // And session placement must follow the same root — the session path
      // is keyed on effectiveCwd, so if this passes, the derived session dir
      // is under the ctx.cwd tree too.
      const expectedSegment = `--${sessionRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}-sub-dir--`;
      assert.ok(
        spec.subagentSessionFile.includes(expectedSegment),
        `session file must be keyed on ctx.cwd-relative path, got ${spec.subagentSessionFile}`,
      );
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });

  it("loadAgentDefaults({ projectRoot }) searches the specified root before global/bundled", () => {
    const root = mkdtempSync(join(tmpdir(), "ls-agent-root-"));
    try {
      mkdirSync(join(root, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(root, ".pi", "agents", "fixture-only.md"),
        "---\nmodel: local-model\n---\nlocal body\n",
        "utf8",
      );
      const defs = loadAgentDefaults("fixture-only", { projectRoot: root });
      assert.ok(defs, "defs should be loaded from explicit projectRoot");
      assert.equal(defs!.model, "local-model");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
