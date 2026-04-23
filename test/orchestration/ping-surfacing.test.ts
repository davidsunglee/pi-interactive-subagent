import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BackendResult } from "../../pi-extension/subagents/backends/types.ts";

describe("BackendResult ping + sessionKey shape", () => {
  it("BackendResult accepts optional ping and sessionKey fields", () => {
    const r: BackendResult = {
      name: "a",
      finalMessage: "",
      transcriptPath: null,
      exitCode: 0,
      elapsedMs: 0,
      sessionKey: "/tmp/my-subagent-session.jsonl",
      ping: { name: "Worker", message: "Not sure which schema to use" },
    };
    assert.equal(r.sessionKey, "/tmp/my-subagent-session.jsonl");
    assert.equal(r.ping?.name, "Worker");
  });
});
