import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  preflightOrchestration,
  __test__ as preflightTest,
} from "../../pi-extension/subagents/preflight-orchestration.ts";
import { __test__ as selectTest } from "../../pi-extension/subagents/backends/select.ts";

const MUX_KEYS = ["CMUX_SOCKET_PATH", "TMUX", "ZELLIJ", "ZELLIJ_SESSION_NAME", "WEZTERM_UNIX_SOCKET"];
const sessionOk = { sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" } };
const sessionMissing = { sessionManager: { getSessionFile: () => null } };

describe("preflightOrchestration", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of [...MUX_KEYS, "PI_SUBAGENT_MODE"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    selectTest.resetWarnedValues();
    preflightTest.resetMuxProbe();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    preflightTest.resetMuxProbe();
  });

  it("returns null in headless mode even when mux is absent", () => {
    process.env.PI_SUBAGENT_MODE = "headless";
    preflightTest.setMuxProbe(() => false);
    assert.equal(preflightOrchestration(sessionOk), null);
  });

  it("returns null in auto mode when mux is absent (selector resolves headless)", () => {
    preflightTest.setMuxProbe(() => false);
    assert.equal(preflightOrchestration(sessionOk), null);
  });

  it("returns mux-error in pane mode when mux is absent", () => {
    process.env.PI_SUBAGENT_MODE = "pane";
    preflightTest.setMuxProbe(() => false);
    const result = preflightOrchestration(sessionOk);
    assert.ok(result, "must return an error result");
    assert.match(result!.details.error, /mux not available/);
  });

  it("returns no-session-file error in headless mode when getSessionFile returns null", () => {
    process.env.PI_SUBAGENT_MODE = "headless";
    preflightTest.setMuxProbe(() => false);
    const result = preflightOrchestration(sessionMissing);
    assert.ok(result);
    assert.match(result!.details.error, /no session file/);
  });

  it("returns no-session-file error in pane mode (mux present) when getSessionFile returns null", () => {
    process.env.PI_SUBAGENT_MODE = "pane";
    preflightTest.setMuxProbe(() => true);
    const result = preflightOrchestration(sessionMissing);
    assert.ok(result);
    assert.match(result!.details.error, /no session file/);
  });
});
