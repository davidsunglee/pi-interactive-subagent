/**
 * TODO-dd074bb7: integration coverage for per-call `systemPrompt` composition.
 *
 * Drives both backends end-to-end with an agent that has a non-empty body AND
 * a per-call `systemPrompt`, then asserts the child observed BOTH prompt parts
 * (not just one). Headless-only and gated by:
 *   - PI_AVAILABLE / CLAUDE_AVAILABLE (per-backend)
 *   - PI_RUN_SLOW=1 (slow lane opt-in, mirrors the existing convention)
 *
 * Run with: npm run test:integration:slow (or PI_RUN_SLOW=1 node --test <this file>)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SLOW_LANE_OPT_IN } from "./harness.ts";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; } catch { return false; }
})();
const CLAUDE_AVAILABLE = (() => {
  try { execSync("which claude", { stdio: "pipe" }); return true; } catch { return false; }
})();

const PI_SHOULD_SKIP = !PI_AVAILABLE || !SLOW_LANE_OPT_IN;
const CLAUDE_SHOULD_SKIP = !CLAUDE_AVAILABLE || !SLOW_LANE_OPT_IN;

if (PI_SHOULD_SKIP) {
  console.log(`⚠️  headless-prompt-composition (pi) skipped: PI=${PI_AVAILABLE} SLOW=${SLOW_LANE_OPT_IN}`);
}
if (CLAUDE_SHOULD_SKIP) {
  console.log(`⚠️  headless-prompt-composition (claude) skipped: CLAUDE=${CLAUDE_AVAILABLE} SLOW=${SLOW_LANE_OPT_IN}`);
}

// Markers chosen to be unique strings the model can be instructed to echo.
// The agent body sets the AGENT_MARKER (its base role); the per-call
// systemPrompt adds the PER_CALL_MARKER instruction. Only a child that
// observed BOTH prompt parts can produce a final message containing both.
const AGENT_MARKER = "AGENT_BODY_MARKER_dd074bb7";
const PER_CALL_MARKER = "PER_CALL_MARKER_dd074bb7";

function seedAgent(dir: string, name: string, frontmatter: string, body: string) {
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, `${name}.md`),
    `---\n${frontmatter}\n---\n\n${body}\n`,
    "utf8",
  );
}

describe("headless-prompt-composition (pi)", { skip: PI_SHOULD_SKIP, timeout: 180_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-prompt-compose-"));
    seedAgent(
      dir,
      "compose-pi-agent",
      [
        "name: compose-pi-agent",
        "model: anthropic/claude-haiku-4-5",
        "tools: read, bash, write, edit",
        "auto-exit: true",
        "disable-model-invocation: true",
      ].join("\n"),
      // Agent body declares AGENT_MARKER. Per-call systemPrompt will add PER_CALL_MARKER.
      `You are a test agent for prompt composition. Your role marker is ${AGENT_MARKER}. ` +
        `When asked to echo your role marker, include it verbatim.`,
    );
  });

  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("pi-backed child observes BOTH agent body and per-call systemPrompt", async () => {
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
      const handle = await backend.launch(
        {
          agent: "compose-pi-agent",
          task:
            "Reply with exactly two lines, no extra prose: " +
            "line 1 is your role marker (from the agent body), " +
            "line 2 is your per-call instruction marker (from the system prompt I just gave you).",
          systemPrompt:
            `Your per-call instruction marker is ${PER_CALL_MARKER}. ` +
            `When asked, include it verbatim.`,
        },
        false,
      );
      const result = await backend.watch(handle);
      assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);
      const final = result.finalMessage ?? "";
      assert.ok(
        final.includes(AGENT_MARKER),
        `pi-backed child must observe agent body (${AGENT_MARKER}); finalMessage=${JSON.stringify(final)}`,
      );
      assert.ok(
        final.includes(PER_CALL_MARKER),
        `pi-backed child must observe per-call systemPrompt (${PER_CALL_MARKER}); finalMessage=${JSON.stringify(final)}`,
      );
      assert.ok(result.transcriptPath && existsSync(result.transcriptPath),
        "archived transcript file must exist");
    } finally {
      process.chdir(origCwd);
    }
  });
});

describe("headless-prompt-composition (claude)", { skip: CLAUDE_SHOULD_SKIP, timeout: 180_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-claude-prompt-compose-"));
    seedAgent(
      dir,
      "compose-claude-agent",
      [
        "name: compose-claude-agent",
        "model: anthropic/claude-haiku-4-5",
        "system-prompt: append",
        "auto-exit: true",
        "disable-model-invocation: true",
        "cli: claude",
      ].join("\n"),
      `You are a Claude-backed test agent for prompt composition. Your role marker is ${AGENT_MARKER}. ` +
        `When asked to echo your role marker, include it verbatim.`,
    );
  });

  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("claude-backed child observes BOTH agent body and per-call systemPrompt via the system-prompt transport", async () => {
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
      const handle = await backend.launch(
        {
          agent: "compose-claude-agent",
          task:
            "Reply with exactly two lines, no extra prose: " +
            "line 1 is your role marker (from the agent body), " +
            "line 2 is your per-call instruction marker (from the system prompt I just gave you).",
          systemPrompt:
            `Your per-call instruction marker is ${PER_CALL_MARKER}. ` +
            `When asked, include it verbatim.`,
        },
        false,
      );
      const result = await backend.watch(handle);
      assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);
      const final = result.finalMessage ?? "";
      assert.ok(
        final.includes(AGENT_MARKER),
        `claude-backed child must observe agent body (${AGENT_MARKER}); finalMessage=${JSON.stringify(final)}`,
      );
      assert.ok(
        final.includes(PER_CALL_MARKER),
        `claude-backed child must observe per-call systemPrompt (${PER_CALL_MARKER}); finalMessage=${JSON.stringify(final)}`,
      );
    } finally {
      process.chdir(origCwd);
    }
  });
});
