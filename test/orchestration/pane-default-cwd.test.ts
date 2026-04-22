import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPaneCdPrefix, launchSubagent } from "../../pi-extension/subagents/index.ts";

describe("buildPaneCdPrefix (review-v2 finding 2)", () => {
  // Pane and headless must agree on the default working directory. Headless
  // falls back to ctx.cwd via `spec.effectiveCwd ?? ctx.cwd`; pane used to
  // skip the cd prefix entirely when spec.effectiveCwd was null, inheriting
  // the surface's cwd (wezterm/zellij create panes in process.cwd()).
  it("prefers spec.effectiveCwd when set", () => {
    const prefix = buildPaneCdPrefix("/target/dir", "/session/root");
    assert.equal(prefix, "cd '/target/dir' && ");
  });

  it("falls back to session cwd when spec.effectiveCwd is null", () => {
    const prefix = buildPaneCdPrefix(null, "/session/root");
    assert.equal(
      prefix,
      "cd '/session/root' && ",
      "pane must honor ctx.cwd as its default so pane + headless launch from the same directory",
    );
  });

  it("shell-escapes directory paths with spaces and quotes", () => {
    const prefix = buildPaneCdPrefix("/with space/it's", "/unused");
    assert.equal(prefix, "cd '/with space/it'\\''s' && ");
  });
});

describe("launchSubagent pane command uses ctx.cwd when params.cwd absent (review-v2 finding 2)", () => {
  // End-to-end proof that both pane callsites (Claude + Pi) wire buildPaneCdPrefix
  // to ctx.cwd — not process.cwd() and not empty. Uses a fake surface so the
  // downstream sendCommand fails without a mux, but sendLongCommand writes the
  // script file synchronously first and we can inspect it.
  async function captureLaunchScript(cli: "pi" | "claude"): Promise<string> {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-pane-cwd-test-"));
    // Intentionally point ctx.cwd at a distinct directory so process.cwd()
    // (which is the repo root) cannot accidentally satisfy the assertion.
    const ctxCwd = mkdtempSync(join(tmpdir(), "pi-pane-cwd-ctx-"));
    try {
      await launchSubagent(
        { name: "cwd-probe", task: "irrelevant", cli } as any,
        {
          sessionManager: {
            getSessionFile: () => join(sessionDir, "parent.jsonl"),
            getSessionId: () => "parent",
            getSessionDir: () => sessionDir,
          },
          cwd: ctxCwd,
        } as any,
        { surface: "pi-test-fake-surface" },
      ).catch(() => { /* mux-less sendCommand throws — we only need the script */ });

      // Walk the artifact tree to find the launch script that was written.
      const scriptsRoot = join(sessionDir, "artifacts");
      const found: string[] = [];
      const walk = (dir: string) => {
        let names: string[] = [];
        try { names = readdirSync(dir); } catch { return; }
        for (const name of names) {
          const p = join(dir, name);
          try {
            if (statSync(p).isDirectory()) walk(p);
            else if (name.endsWith(".sh")) found.push(p);
          } catch {}
        }
      };
      walk(scriptsRoot);
      assert.equal(found.length, 1, `expected exactly one launch script, got ${found.join(", ")}`);
      const script = readFileSync(found[0], "utf8");
      assert.ok(
        script.includes(`cd '${ctxCwd}' && `),
        `expected "cd '${ctxCwd}' && " prefix in pane ${cli} script, got:\n${script}`,
      );
      return ctxCwd;
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
      rmSync(ctxCwd, { recursive: true, force: true });
    }
  }

  it("pane Pi launch prefixes `cd <ctx.cwd>` when params.cwd is absent", async () => {
    await captureLaunchScript("pi");
  });

  it("pane Claude launch prefixes `cd <ctx.cwd>` when params.cwd is absent", async () => {
    await captureLaunchScript("claude");
  });
});
