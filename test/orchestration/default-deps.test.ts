import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDefaultDeps } from "../../pi-extension/orchestration/default-deps.ts";

describe("makeDefaultDeps.waitForCompletion", () => {
  it("returns transcriptPath: null (not undefined) when the handle is unknown", async () => {
    const deps = makeDefaultDeps({
      sessionManager: { getSessionFile: () => null } as any,
      cwd: process.cwd(),
    });
    const result = await deps.waitForCompletion({
      id: "does-not-exist",
      name: "ghost",
      startTime: Date.now(),
    });
    assert.equal(result.transcriptPath, null);
    assert.notEqual(result.transcriptPath, undefined);
    assert.equal(result.exitCode, 1);
    assert.ok(result.error);
  });
});
