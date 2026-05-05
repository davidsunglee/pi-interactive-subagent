import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as Value from "typebox/value";
import { OrchestrationTaskSchema } from "../../pi-extension/orchestration/types.ts";

describe("interactive field is accepted and ignored (schema-level compat)", () => {
  it("OrchestrationTaskSchema validates a task carrying `interactive: true`", () => {
    const task = { agent: "test-echo", task: "do", interactive: true };
    assert.equal(Value.Check(OrchestrationTaskSchema, task), true);
  });

  it("OrchestrationTaskSchema validates a task carrying `interactive: false`", () => {
    const task = { agent: "test-echo", task: "do", interactive: false };
    assert.equal(Value.Check(OrchestrationTaskSchema, task), true);
  });

  it("OrchestrationTaskSchema rejects non-boolean values for `interactive`", () => {
    const task = { agent: "test-echo", task: "do", interactive: "yes" };
    assert.equal(Value.Check(OrchestrationTaskSchema, task), false);
  });

  it("resolveLaunchSpec() surfaces `effectiveInteractive` on the resolved spec", async () => {
    const { resolveLaunchSpec } = await import("../../pi-extension/subagents/launch-spec.ts");
    const ctx = {
      sessionManager: {
        getSessionFile: () => "/tmp/parent.jsonl",
        getSessionId: () => "sess-test",
        getSessionDir: () => "/tmp",
      } as any,
      cwd: "/tmp",
    };
    const withFlag = resolveLaunchSpec(
      { name: "X", task: "t", interactive: true } as any,
      ctx,
    );
    assert.equal(
      withFlag.effectiveInteractive,
      true,
      "params.interactive:true must produce effectiveInteractive:true",
    );
    // No agent => agentDefs is null => autoExit defaults false => effectiveInteractive true
    const withoutFlag = resolveLaunchSpec({ name: "X", task: "t" }, ctx);
    assert.equal(
      withoutFlag.effectiveInteractive,
      true,
      "no agent defaults => effectiveInteractive defaults to true",
    );
  });
});
