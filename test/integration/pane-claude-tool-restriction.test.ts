import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeCmdParts } from "../../pi-extension/subagents/index.ts";

const CLAUDE_AVAILABLE = (() => {
  try { execSync("which claude", { stdio: "pipe" }); return true; }
  catch { return false; }
})();

function withPrintBeforeSeparator(parts: string[]): string {
  const injected = parts.slice();
  const sepIdx = injected.indexOf("--");
  assert.ok(sepIdx > 0,
    "expected -- separator before the task in buildClaudeCmdParts output; " +
    "a regression that drops the separator would place --print as a positional (v7 finding 2).");
  injected.splice(sepIdx, 0, "--print");
  return injected.join(" ");
}

function makeMarker(dir: string, label: string): { marker: string; file: string } {
  const marker = `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return { marker, file: join(dir, `${marker}.txt`) };
}

describe("pane-claude-tool-restriction", { skip: !CLAUDE_AVAILABLE, timeout: 120_000 }, () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-pane-tool-restrict-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("--tools restricts the built-in set so Bash is unavailable when only read is allowed", () => {
    const { marker, file } = makeMarker(dir, "RESTRICT");
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s-restrict",
      pluginDir: undefined,
      model: "sonnet",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      effectiveTools: "read",
      task:
        `Run this exact bash command and nothing else: echo ${marker} > ${file}. ` +
        `If you cannot run it, say so briefly — do not describe or emulate the command.`,
    });
    const cmd = withPrintBeforeSeparator(parts);
    try { execSync(cmd, { cwd: dir, encoding: "utf8", timeout: 90_000 }); }
    catch { /* refusal-driven non-zero exit is acceptable */ }
    assert.ok(!existsSync(file),
      `--tools restriction failed: Bash wrote ${file}; tool restriction did not hold.`);
  });

  it("same request succeeds when effectiveTools is absent (baseline — rules out generic failure)", () => {
    const { marker, file } = makeMarker(dir, "BASELINE");
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s-baseline",
      pluginDir: undefined,
      model: "sonnet",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task:
        `Run this exact bash command and nothing else: echo ${marker} > ${file}. ` +
        `Do not paraphrase the command; run it as written.`,
    });
    const cmd = withPrintBeforeSeparator(parts);
    execSync(cmd, { cwd: dir, encoding: "utf8", timeout: 90_000 });
    assert.ok(existsSync(file),
      `baseline case failed: Bash was not invoked even though --tools was absent; ${file} does not exist.`);
    const contents = readFileSync(file, "utf8").trim();
    assert.equal(contents, marker,
      `baseline file contents mismatch — expected ${marker}, got ${JSON.stringify(contents)}.`);
  });
});

describe("pane-claude-skills-warning (review-v11 finding 2)", () => {
  it("launchSubagent() emits the warning from the pane Claude branch when effectiveSkills is non-empty", async () => {
    const { launchSubagent } = await import(
      "../../pi-extension/subagents/index.ts"
    );

    let captured = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string | Buffer): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };

    const sessionDir = mkdtempSync(join(tmpdir(), "pi-pane-warn-"));
    try {
      await launchSubagent(
        {
          name: "pane-subagent",
          task: "ignored — test never reaches Claude",
          cli: "claude",
          skills: "plan, code-review",
        } as any,
        {
          sessionManager: {
            getSessionFile: () => join(sessionDir, "parent.jsonl"),
            getSessionId: () => "parent",
            getSessionDir: () => sessionDir,
          },
          cwd: sessionDir,
        } as any,
        { surface: "pi-test-fake-surface" },
      ).catch(() => {
      });
    } finally {
      (process.stderr as any).write = origWrite;
      rmSync(sessionDir, { recursive: true, force: true });
    }

    assert.ok(captured.includes("pane-subagent"),
      `expected subagent name in warning (review-v11 finding 2 regression: pane call site removed); got: ${JSON.stringify(captured)}`);
    assert.ok(captured.includes("ignoring skills=plan, code-review"),
      `expected skills list in warning; got: ${JSON.stringify(captured)}`);
    assert.ok(captured.includes("Claude path"),
      `expected "Claude path" wording so pane + headless match; got: ${JSON.stringify(captured)}`);
  });

  it("launchSubagent() is silent on stderr when skills are empty on the pane Claude branch", async () => {
    const { launchSubagent } = await import(
      "../../pi-extension/subagents/index.ts"
    );

    let captured = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string | Buffer): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };

    const sessionDir = mkdtempSync(join(tmpdir(), "pi-pane-warn-silent-"));
    try {
      await launchSubagent(
        {
          name: "pane-subagent",
          task: "ignored",
          cli: "claude",
        } as any,
        {
          sessionManager: {
            getSessionFile: () => join(sessionDir, "parent.jsonl"),
            getSessionId: () => "parent",
            getSessionDir: () => sessionDir,
          },
          cwd: sessionDir,
        } as any,
        { surface: "pi-test-fake-surface" },
      ).catch(() => { /* mux-less downstream failure — ignored */ });
    } finally {
      (process.stderr as any).write = origWrite;
      rmSync(sessionDir, { recursive: true, force: true });
    }

    assert.equal(captured.includes("ignoring skills="), false,
      `expected no skills-dropped warning when no skills declared; got stderr: ${JSON.stringify(captured)}`);
  });

  it("buildClaudeCmdParts does NOT leak /skill:... tokens into the pane argv (defense in depth)", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s-skills",
      pluginDir: undefined,
      model: "sonnet",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do the real work",
    });
    for (const a of parts) {
      assert.ok(!a.includes("/skill:"),
        `pane argv must not contain /skill:... tokens; got: ${parts.join(" | ")}`);
    }
  });
});
