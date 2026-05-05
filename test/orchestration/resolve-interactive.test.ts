import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../pi-extension/subagents/index.ts";

const { resolveEffectiveInteractive } = __test__;

describe("resolveEffectiveInteractive", () => {
  const base = { name: "X", task: "t" };

  it("returns false when autoExit: true and no interactive override", () => {
    assert.equal(resolveEffectiveInteractive(base, { autoExit: true }), false);
  });

  it("returns true when autoExit: false and no interactive override", () => {
    assert.equal(resolveEffectiveInteractive(base, { autoExit: false }), true);
  });

  it("returns true when agentDefs is empty object (no autoExit)", () => {
    assert.equal(resolveEffectiveInteractive(base, {}), true);
  });

  it("returns true when agentDefs is null", () => {
    assert.equal(resolveEffectiveInteractive(base, null), true);
  });

  it("agent frontmatter interactive:true overrides autoExit:true", () => {
    assert.equal(resolveEffectiveInteractive(base, { autoExit: true, interactive: true }), true);
  });

  it("agent frontmatter interactive:false overrides autoExit:false", () => {
    assert.equal(resolveEffectiveInteractive(base, { autoExit: false, interactive: false }), false);
  });

  it("params.interactive:false wins over agentDefs interactive:true", () => {
    assert.equal(
      resolveEffectiveInteractive(
        { ...base, interactive: false },
        { autoExit: false, interactive: true },
      ),
      false,
    );
  });

  it("params.interactive:true wins over agentDefs interactive:false and autoExit:true", () => {
    assert.equal(
      resolveEffectiveInteractive(
        { ...base, interactive: true },
        { autoExit: true, interactive: false },
      ),
      true,
    );
  });
});
