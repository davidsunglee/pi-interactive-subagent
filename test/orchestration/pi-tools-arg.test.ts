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

  it("preserves custom/extension tool names verbatim alongside reserved lifecycle tools", () => {
    // Upstream a0c089a: pi 0.70+ applies --tools to built-in, extension, and
    // custom tools, so a restrictive `tools:` declaration that names a custom
    // or extension-registered tool must pass that name through verbatim. The
    // previous filter dropped non-builtin/non-orchestration tokens, which
    // silently widened or narrowed the surface. Lifecycle tools must still be
    // reserved.
    const arg = resolvePiToolsArg("read, bash, web_search");
    assert.ok(arg, "must emit a tools arg when at least one tool is requested");
    const set = new Set(arg!.split(",").map((t) => t.trim()));
    assert.ok(set.has("read"));
    assert.ok(set.has("bash"));
    assert.ok(
      set.has("web_search"),
      "custom/extension tool names must survive the allowlist filter",
    );
    assert.ok(set.has("caller_ping"));
    assert.ok(set.has("subagent_done"));
    // No broadening: only requested tools + reserved lifecycle tools.
    assert.deepEqual(
      [...set].sort(),
      ["bash", "caller_ping", "read", "subagent_done", "web_search"],
    );
  });

  it("emits a lifecycle-augmented allowlist even when no token matches a known builtin/orchestration tool", () => {
    // Upstream a0c089a behavior: an agent declaring only extension-registered
    // tools must still get a restrictive --tools so its declaration is
    // honored. The previous behavior returned undefined (unrestricted) for
    // `tools: weird, nonexistent`, which contradicted the user's restriction.
    const arg = resolvePiToolsArg("weird, nonexistent");
    assert.ok(arg !== undefined, "must emit a tools arg even for non-builtin requests");
    const set = new Set(arg!.split(",").map((t) => t.trim()));
    assert.ok(set.has("weird"));
    assert.ok(set.has("nonexistent"));
    assert.ok(set.has("caller_ping"));
    assert.ok(set.has("subagent_done"));
  });

  it("deduplicates lifecycle tools if the caller already listed them", () => {
    const arg = resolvePiToolsArg("read, caller_ping, subagent_done");
    assert.ok(arg, "must emit a tools arg when at least one builtin is present");
    const parts = arg!.split(",");
    assert.equal(parts.filter((t) => t === "caller_ping").length, 1);
    assert.equal(parts.filter((t) => t === "subagent_done").length, 1);
    assert.ok(parts.includes("read"));
  });

  it("keeps orchestration tokens listed in tools alongside builtins", () => {
    const arg = resolvePiToolsArg("read, subagent_run_serial");
    assert.ok(arg, "must emit a tools arg when builtins and orchestration tokens are present");
    const set = new Set(arg!.split(",").map((t) => t.trim()));
    assert.ok(set.has("read"), "read must be present");
    assert.ok(set.has("subagent_run_serial"), "subagent_run_serial must be present");
    assert.ok(set.has("caller_ping"), "caller_ping must be reserved");
    assert.ok(set.has("subagent_done"), "subagent_done must be reserved");
  });

  it("emits a tools list when only an orchestration token is requested", () => {
    const arg = resolvePiToolsArg("subagent_run_serial");
    assert.ok(arg !== undefined, "must emit a tools arg when an orchestration token is present");
    const set = new Set(arg!.split(",").map((t) => t.trim()));
    assert.ok(set.has("subagent_run_serial"), "subagent_run_serial must be present");
    assert.ok(set.has("caller_ping"), "caller_ping must be reserved");
    assert.ok(set.has("subagent_done"), "subagent_done must be reserved");
  });

  it("keeps every SPAWNING_TOOLS member when listed individually", () => {
    const arg = resolvePiToolsArg(
      "subagent, subagents_list, subagent_resume, subagent_run_serial, subagent_run_parallel, subagent_run_cancel",
    );
    assert.ok(arg !== undefined, "must emit a tools arg when orchestration tokens are present");
    const set = new Set(arg!.split(",").map((t) => t.trim()));
    assert.ok(set.has("subagent"), "subagent must be present");
    assert.ok(set.has("subagents_list"), "subagents_list must be present");
    assert.ok(set.has("subagent_resume"), "subagent_resume must be present");
    assert.ok(set.has("subagent_run_serial"), "subagent_run_serial must be present");
    assert.ok(set.has("subagent_run_parallel"), "subagent_run_parallel must be present");
    assert.ok(set.has("subagent_run_cancel"), "subagent_run_cancel must be present");
    assert.ok(set.has("caller_ping"), "caller_ping must be reserved");
    assert.ok(set.has("subagent_done"), "subagent_done must be reserved");
  });
});
