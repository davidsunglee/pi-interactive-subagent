import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyTestAgents, getAvailableBackends, SLOW_LANE_OPT_IN } from "./harness.ts";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";
import { makePaneBackend } from "../../pi-extension/subagents/backends/pane.ts";
import { writeOrchestrationTaskArtifact } from "../../pi-extension/orchestration/task-artifact.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKTREE_EXTENSION = resolve(HERE, "../../pi-extension/subagents/index.ts");

/**
 * Build an isolated `pi` agent directory that points at this worktree's
 * orchestration extension. Required because the spawned `pi` child loads
 * packages from the user's global agent dir (`~/.pi/agent/`), which is pinned
 * to the main checkout (`~/Code/pi-interactive-subagent`). The main checkout
 * does not yet contain Wave 1–4 of the result-artifact pipeline, so without
 * this override the child runs the stale `summarize()` (no `artifact:` row)
 * and the coordinator agent has no path to read. We copy `auth.json` from the
 * real agent dir so the spawned `pi` keeps its credentials.
 *
 * Activate via `PI_CODING_AGENT_DIR=<returned dir>`.
 */
function makeIsolatedAgentDir(testDir: string): string {
  const agentDir = join(testDir, ".pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify(
      {
        packages: [],
        extensions: [WORKTREE_EXTENSION],
        skills: [],
      },
      null,
      2,
    ),
  );
  const realAuth = join(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(realAuth)) {
    copyFileSync(realAuth, join(agentDir, "auth.json"));
  }
  return agentDir;
}

const PI_AVAILABLE = (() => {
  try {
    execSync("which pi", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

const SHOULD_SKIP = !PI_AVAILABLE || !SLOW_LANE_OPT_IN;

/**
 * Extract the orchestration artifact path emitted by `subagent_run_serial`'s
 * tool result content text. The headless backend's
 * `projectPiMessageToTranscript` strips `details`, so the only model-visible
 * surface for the artifact path is the per-task row in the `content` text.
 */
function extractArtifactPath(transcript: any[] | undefined): string | undefined {
  for (const msg of transcript ?? []) {
    if (msg.role !== "toolResult" || msg.toolName !== "subagent_run_serial") continue;
    for (const block of msg.content) {
      if ((block as any).type !== "text") continue;
      const m = ((block as any).text as string).match(/—\s*artifact:\s+(\S+\.md)/);
      if (m) return m[1];
    }
  }
  return undefined;
}

describe("coordinator-orchestration-tools", { skip: SHOULD_SKIP, timeout: 600_000 }, () => {
  let origMode: string | undefined;
  let origAgentDir: string | undefined;
  let origCwd: string;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-coord-tools-"));
    copyTestAgents(dir);
    origAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = makeIsolatedAgentDir(dir);
    origCwd = process.cwd();
    process.chdir(dir);
  });

  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    if (origAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = origAgentDir;
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("coordinator with restrictive tools dispatches child via subagent_run_serial and surfaces COORD-CHILD-OK", async () => {
    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    const handle = await backend.launch(
      { name: "coord", agent: "test-coordinator", task: "Run the coordination workflow now." },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);
    assert.ok(
      result.finalMessage.includes("COORD-CHILD-OK"),
      `finalMessage must include COORD-CHILD-OK; got: ${result.finalMessage}`,
    );

    const hasSubagentRunSerial = (result.transcript ?? []).some((msg) =>
      msg.content.some((b) => b.type === "toolCall" && b.name === "subagent_run_serial"),
    );
    assert.ok(
      hasSubagentRunSerial,
      "transcript must contain a toolCall for subagent_run_serial",
    );
  });

  it("parent recovers a multi-finding markdown body via artifactPath without truncation", async () => {
    const reviewBody = [
      "# Review Findings",
      "",
      "## Finding 1: Issue with foo",
      "Severity: high",
      "",
      "## Finding 2: Suggestion for bar",
      "Severity: medium",
      "",
      "## Finding 3: Nit on baz",
      "Severity: low",
      "",
      "$$ literal-dollar test, $& raw, $1 also raw",
      "Final line.",
    ].join("\n");

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
        name: "coord",
        agent: "test-coordinator-md",
        task: `Run subagent_run_serial with one task: agent=test-reviewer-md, task=${JSON.stringify(reviewBody)}. After it returns, parse the artifact path from the tool result's content text (look for the line "- <name>: ... — artifact: <path>"), call the read tool on that path, and emit the file body verbatim as your final assistant message.`,
      },
      false,
    );
    const result = await backend.watch(handle);
    assert.equal(result.exitCode, 0);

    assert.equal(
      result.finalMessage,
      reviewBody,
      "coordinator's finalMessage (artifact body it read) must equal child's finalMessage byte-for-byte",
    );

    const artifactPath = extractArtifactPath(result.transcript);
    assert.ok(artifactPath, "toolResult content text must contain an `artifact: <path>` row");
    rmSync(artifactPath!, { force: true });
  });

  it("round-trips a >= 50KB markdown body through the artifact path", async () => {
    // The coordinator-visible contract is exercised by the preceding real-pi
    // test. This stress case isolates the artifact size invariant so the slow
    // lane does not depend on a model emitting 50KB of assistant text exactly.
    const body = "# Long output\n" + "x".repeat(60_000);
    const artifactPath = writeOrchestrationTaskArtifact({
      artifactDir: join(dir, "artifacts", "parent"),
      orchestrationId: "1234abcd",
      taskIndex: 0,
      finalMessage: body,
    });
    assert.ok(artifactPath, "artifact path must be written for >=50KB body");
    assert.equal(
      readFileSync(artifactPath!, "utf8"),
      body,
      ">=50KB body must round-trip through the artifact path byte-for-byte",
    );
    rmSync(artifactPath!, { force: true });
  });
});

const PANE_BACKENDS = getAvailableBackends();
const PANE_SHOULD_SKIP = !PI_AVAILABLE || !SLOW_LANE_OPT_IN || PANE_BACKENDS.length === 0;

describe("coordinator-orchestration-tools [pane]", { skip: PANE_SHOULD_SKIP, timeout: 300_000 }, () => {
  let origMode: string | undefined;
  let origAgentDir: string | undefined;
  let origCwd: string;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "pane";
    dir = mkdtempSync(join(tmpdir(), "pi-coord-tools-pane-"));
    copyTestAgents(dir);
    origAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = makeIsolatedAgentDir(dir);
    origCwd = process.cwd();
    process.chdir(dir);
  });

  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    if (origAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = origAgentDir;
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("pane backend recovers multi-finding markdown body via artifactPath without truncation", async () => {
    const reviewBody = [
      "# Review Findings",
      "",
      "## Finding 1: Issue with foo",
      "Severity: high",
      "",
      "## Finding 2: Suggestion for bar",
      "Severity: medium",
      "",
      "$$ literal-dollar test, $& raw, $1 also raw",
      "Final line.",
    ].join("\n");

    const backend = makePaneBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    const handle = await backend.launch(
      {
        name: "coord",
        agent: "test-coordinator-md",
        task: `Run subagent_run_serial with one task: agent=test-reviewer-md, task=${JSON.stringify(reviewBody)}. After it returns, parse the artifact path from the tool result's content text and read it; emit the file body verbatim.`,
      },
      false,
    );
    const result = await backend.watch(handle);
    assert.equal(result.exitCode, 0);
    assert.equal(
      result.finalMessage,
      reviewBody,
      "pane coordinator's finalMessage (artifact body it read) must equal child's finalMessage byte-for-byte",
    );

    const artifactPath = extractArtifactPath(result.transcript);
    if (artifactPath) rmSync(artifactPath, { force: true });
  });
});
