import { describe, it, before, after } from "node:test";
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

describe("makeDefaultDeps backend selection", () => {
  let origMode: string | undefined;
  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
  });
  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
  });

  it("routes to headless backend when PI_SUBAGENT_MODE=headless (abort-before-spawn yields aborted result)", async () => {
    process.env.PI_SUBAGENT_MODE = "headless";
    const deps = makeDefaultDeps({
      sessionManager: {
        getSessionFile: () => "/tmp/fake-session.jsonl",
        getSessionId: () => "test-session",
        getSessionDir: () => "/tmp",
      } as any,
      cwd: process.cwd(),
    });
    // Pre-aborted signal: headless backend short-circuits before spawn and
    // yields an "aborted" BackendResult. This proves routing (pane would
    // have thrown on missing mux) without requiring pi to be absent/present.
    const ac = new AbortController();
    ac.abort();
    const handle = await deps.launch(
      { agent: "x", task: "t" },
      false,
      ac.signal,
    );
    assert.ok(handle.id, "launch must resolve to a handle in headless mode");
    const result = await deps.waitForCompletion(handle);
    assert.equal(result.exitCode, 1);
    assert.equal(result.error, "aborted");
  });
});
