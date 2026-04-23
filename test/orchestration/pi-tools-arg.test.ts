import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePiToolsArg } from "../../pi-extension/subagents/launch-spec.ts";

// review-v6 blocker: pi-backed headless subagents could not enter the `blocked`
// lifecycle because `--tools` was filtered to builtins only — stripping
// `caller_ping` and `subagent_done`, the two tools injected by the
// `subagent-done.ts` extension that together drive the block/done contract.
// These tests lock in: whenever we emit a restrictive `--tools` list for pi,
// the two lifecycle tools MUST be reserved so block/done always work.

describe("resolvePiToolsArg", () => {
  it("appends caller_ping and subagent_done when a restrictive builtin allowlist is requested", () => {
    const arg = resolvePiToolsArg("read, bash");
    assert.ok(arg, "must emit a tools arg when builtins are present");
    const tools = new Set(arg!.split(","));
    assert.ok(tools.has("read"));
    assert.ok(tools.has("bash"));
    assert.ok(
      tools.has("caller_ping"),
      "caller_ping must be reserved so pi-backed subagents can emit blocked state",
    );
    assert.ok(
      tools.has("subagent_done"),
      "subagent_done must be reserved so pi-backed subagents can signal completion",
    );
  });

  it("returns undefined when effectiveTools is absent (no regression on unrestricted agents)", () => {
    assert.equal(resolvePiToolsArg(undefined), undefined);
  });

  it("returns undefined when every effectiveTools entry is unmapped (avoids emitting an empty --tools)", () => {
    // Matches the Claude builder's contract: empty --tools means "no tools at
    // all". An agent declaring only extension-registered tools should get
    // unrestricted access, not a lockout, so we emit nothing rather than a
    // lifecycle-only allowlist.
    assert.equal(resolvePiToolsArg("weird, nonexistent"), undefined);
  });

  it("deduplicates lifecycle tools if the caller already listed them", () => {
    const arg = resolvePiToolsArg("read, caller_ping, subagent_done");
    assert.ok(arg, "must emit a tools arg when at least one builtin is present");
    const parts = arg!.split(",");
    assert.equal(parts.filter((t) => t === "caller_ping").length, 1);
    assert.equal(parts.filter((t) => t === "subagent_done").length, 1);
    assert.ok(parts.includes("read"));
  });
});
