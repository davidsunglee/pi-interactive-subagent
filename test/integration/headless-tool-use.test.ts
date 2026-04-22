import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

const CLAUDE_AVAILABLE = (() => {
  try {
    execSync("which claude", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe("headless-tool-use [claude]", { skip: !CLAUDE_AVAILABLE, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-tool-"));
    writeFileSync(join(dir, "marker.txt"), "HEADLESS_TOOL_MARKER_42\n");
  });
  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures the full toolCall + toolResult round-trip in transcript[]", async () => {
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
        task: "Read the file marker.txt in the current directory and print its contents verbatim.",
        cli: "claude",
        tools: "read",
      },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);

    const transcript = result.transcript ?? [];

    const toolCallBlocks = transcript
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c): c is { type: "toolCall"; id: string; name: string; arguments: unknown } =>
        c.type === "toolCall");
    assert.ok(toolCallBlocks.length > 0,
      "transcript[] must include at least one assistant-role message with a toolCall content block");

    const toolResultMessages = transcript.filter((m) => m.role === "toolResult");
    assert.ok(toolResultMessages.length > 0,
      "transcript[] must include at least one toolResult-role message " +
        "(v11 / review-v15: regression surface for Claude tool_result parsing)");

    const callIds = new Set(toolCallBlocks.map((c) => c.id));
    const resultIds = new Set(toolResultMessages.map((m) => m.toolCallId));
    for (const id of callIds) {
      assert.ok(resultIds.has(id),
        `toolCall id ${id} has no matching toolResult.toolCallId; ` +
          `callIds=${JSON.stringify([...callIds])}, resultIds=${JSON.stringify([...resultIds])}`);
    }

    for (const tr of toolResultMessages) {
      assert.ok(Array.isArray(tr.content),
        `toolResult.content must be an array, got ${typeof tr.content}`);
      for (const block of tr.content) {
        assert.ok(typeof block.type === "string" && block.type.length > 0,
          `toolResult.content[].type must be a non-empty string, got ${JSON.stringify(block)}`);
      }
    }
  });
});
