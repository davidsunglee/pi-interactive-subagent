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

import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchSubagent } from "../../pi-extension/subagents/index.ts";

/**
 * Capture the launch script Claude would have run, with optional agent
 * fixtures seeded under the temp `ctx.cwd` so `launchSubagent`'s agent lookup
 * resolves them. Without seeding, `<ctxCwd>/.pi/agents/<name>.md` does not
 * exist and `agentDefs` resolves to null, which would silently break any
 * test that depends on agent frontmatter (e.g. `auto-exit: true`).
 */
async function captureClaudeLaunchScript(
  subagentParams: Record<string, unknown>,
  opts: { agents?: Record<string, string> } = {},
): Promise<string> {
  const sessionDir = mkdtempSync(join(tmpdir(), "pane-addendum-"));
  const ctxCwd = mkdtempSync(join(tmpdir(), "pane-addendum-ctx-"));
  if (opts.agents) {
    const agentsDir = join(ctxCwd, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    for (const [name, body] of Object.entries(opts.agents)) {
      writeFileSync(join(agentsDir, `${name}.md`), body);
    }
  }
  try {
    await launchSubagent(
      { cli: "claude", ...subagentParams } as any,
      {
        sessionManager: {
          getSessionFile: () => join(sessionDir, "parent.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => sessionDir,
        },
        cwd: ctxCwd,
      } as any,
      { surface: "pi-test-fake-surface" },
    ).catch(() => { /* mux dispatch fails harmlessly under fake surface */ });
    const scriptsRoot = join(sessionDir, "artifacts");
    const found: string[] = [];
    const walk = (d: string) => {
      let names: string[] = [];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names) {
        const p = join(d, n);
        try {
          if (statSync(p).isDirectory()) walk(p);
          else if (n.endsWith(".sh")) found.push(p);
        } catch {}
      }
    };
    walk(scriptsRoot);
    assert.equal(found.length, 1, `expected one launch script, got ${found.join(", ")}`);
    return readFileSync(found[0], "utf-8");
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(ctxCwd, { recursive: true, force: true });
  }
}

describe("Claude pane launch folds claudeCompletionAddendum into the system prompt", () => {
  it("emits --append-system-prompt with the addendum when identity is null", async () => {
    const script = await captureClaudeLaunchScript({ name: "no-id", task: "hi" });
    const m = script.match(/--append-system-prompt '([^']+)'/);
    assert.ok(m, `expected --append-system-prompt in launch script:\n${script}`);
    assert.match(m![1], /interactive subagent/);
    assert.match(m![1], /call `subagent_done`/);
  });

  it("emits --append-system-prompt with identity then a blank-line separator then the addendum", async () => {
    const script = await captureClaudeLaunchScript({
      name: "with-id",
      task: "hi",
      systemPrompt: "You are Sherlock Holmes.",
    });
    const m = script.match(/--append-system-prompt '([^']+)'/);
    assert.ok(m, `expected --append-system-prompt in launch script:\n${script}`);
    const value = m![1];
    assert.match(value, /^You are Sherlock Holmes\./);
    assert.match(value, /interactive subagent/);
    // The identity must come BEFORE the addendum and there must be a blank-line separator.
    const idIdx = value.indexOf("You are Sherlock Holmes.");
    const addIdx = value.indexOf("interactive subagent");
    assert.ok(idIdx >= 0 && addIdx > idIdx);
    const between = value.slice(idIdx + "You are Sherlock Holmes.".length, addIdx);
    assert.match(between, /\n\s*\n/, "must have a blank-line separator between identity and addendum");
  });

  it("uses the autoExit=true wording when the agent declares auto-exit:true", async () => {
    // Seed an auto-exit:true agent fixture under <ctxCwd>/.pi/agents so
    // agent lookup finds it. Without seeding, agentDefs resolves null and
    // autoExit is false, which would mask the implementation behavior.
    const script = await captureClaudeLaunchScript(
      { name: "auto", task: "hi", agent: "test-echo" },
      {
        agents: {
          "test-echo":
            "---\nauto-exit: true\n---\n\n" +
            "Auto-exit fixture for launch-path tests.\n",
        },
      },
    );
    const m = script.match(/--append-system-prompt '([^']+)'/);
    assert.ok(m);
    assert.match(m![1], /one-shot subagent/);
  });
});
