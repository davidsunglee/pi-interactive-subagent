import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { thinkingToEffort } from "../../pi-extension/subagents/index.ts";

describe("thinkingToEffort", () => {
  it("maps off/minimal/low to low", () => {
    assert.equal(thinkingToEffort("off"), "low");
    assert.equal(thinkingToEffort("minimal"), "low");
    assert.equal(thinkingToEffort("low"), "low");
  });
  it("maps medium to medium", () => {
    assert.equal(thinkingToEffort("medium"), "medium");
  });
  it("maps high to high", () => {
    assert.equal(thinkingToEffort("high"), "high");
  });
  it("maps xhigh to max", () => {
    assert.equal(thinkingToEffort("xhigh"), "max");
  });
  it("returns undefined for unknown values", () => {
    assert.equal(thinkingToEffort("bogus"), undefined);
    assert.equal(thinkingToEffort(""), undefined);
    assert.equal(thinkingToEffort(undefined), undefined);
  });
});
