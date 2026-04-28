import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAvailableBackends, setBackend, restoreBackend,
  createTestEnv, cleanupTestEnv, sendCommand, waitForScreen,
  PI_TIMEOUT, SLOW_LANE_OPT_IN,
  type TestEnv,
} from "./harness.ts";
import { launchSubagent, watchSubagent, extractLastAssistantMessage } from "../../pi-extension/subagents/index.ts";

const CLAUDE_AVAILABLE = (() => {
  try { execSync("which claude", { stdio: "pipe" }); return true; }
  catch { return false; }
})();
const PLUGIN_DIR = join(
  new URL("../../pi-extension/subagents/plugin", import.meta.url).pathname,
);
const PLUGIN_BUILT = existsSync(join(PLUGIN_DIR, "mcp", "server.js"));
const backends = getAvailableBackends();
const SHOULD_SKIP = !CLAUDE_AVAILABLE || !PLUGIN_BUILT || backends.length === 0 || !SLOW_LANE_OPT_IN;
if (SHOULD_SKIP) {
  console.log(`⚠️  pane-claude-interactive skipped: CLAUDE=${CLAUDE_AVAILABLE} PLUGIN_BUILT=${PLUGIN_BUILT} BACKENDS=${backends.length} SLOW=${SLOW_LANE_OPT_IN}`);
}

for (const backend of backends) {
  describe(`pane-claude-interactive [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 2 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    before(() => { prevMux = setBackend(backend); env = createTestEnv(backend); });
    after(() => { cleanupTestEnv(env); restoreBackend(prevMux); });

    function ctx() {
      return {
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "test-session",
          getSessionDir: () => env.dir,
        },
        cwd: env.dir,
      };
    }

    it("interactive: pane stays alive until model calls subagent_done", async () => {
      const running = await launchSubagent(
        {
          name: "interactive",
          agent: "test-claude-interactive",
          task:
            "Ask exactly one clarifying question that ends with the marker " +
            "'CLARIFY?' on its own line. After the user replies, call " +
            "subagent_done with message='all done'.",
        },
        ctx(),
      );
      env.surfaces.push(running.surface);

      // Wait for the first assistant turn to be observable in the pane (the
      // model must have asked its clarifying question). Anchored to the
      // explicit CLARIFY? marker so we don't depend on timing.
      await waitForScreen(running.surface, /CLARIFY\?/, 30_000);

      // Now — having seen a real first assistant turn — assert the sentinel
      // file is still absent. This pins the regression: the deleted
      // user_msg_count heuristic would have written it right after the first
      // assistant turn, so observing the turn first is what makes the
      // assertion meaningful.
      assert.equal(
        existsSync(running.sentinelFile!),
        false,
        "sentinel must not exist after the first assistant turn — the user_msg_count heuristic regressed",
      );

      // Send a turn-2 reply into the pane so the model can complete its task.
      sendCommand(running.surface, "yes please proceed");

      const result = await watchSubagent(running, new AbortController().signal);
      assert.equal(result.exitCode, 0, `exit code: ${result.exitCode}; summary: ${result.summary}`);
      assert.match(result.summary, /all done/, `expected 'all done' in summary, got: ${result.summary}`);
      assert.ok(result.transcriptPath, "transcriptPath must be populated");
      assert.equal(typeof (result as any).claudeSessionId, "string");
      assert.ok((result as any).claudeSessionId.length > 0, "claudeSessionId must be populated");
    });

    it("autonomous-with-MCP: agent that auto-exits completes via the same MCP path", async () => {
      const running = await launchSubagent(
        {
          name: "autonomous",
          agent: "test-claude-autoexit",
          task: "Reply with exactly: AUTO. Then call subagent_done with message='AUTO'.",
        },
        ctx(),
      );
      env.surfaces.push(running.surface);
      const result = await watchSubagent(running, new AbortController().signal);
      assert.equal(result.exitCode, 0);
      assert.match(result.summary, /AUTO/);
      assert.ok(result.transcriptPath, "transcriptPath must be populated");
      assert.equal(typeof (result as any).claudeSessionId, "string");
      assert.ok((result as any).claudeSessionId.length > 0);
    });

    it("empty-message: watcher falls back to transcript JSONL last assistant message (Finding 3 wiring)", async () => {
      // Pin that watchSubagent's fallback chain actually CALLS
      // extractLastAssistantMessage when the sentinel is empty. Without this,
      // the helper could be exported correctly while the watcher silently
      // skipped it and went straight to screen scrape.
      //
      // The model emits a unique probe string somewhere in its turns, then
      // calls subagent_done with NO message argument so the sentinel is
      // empty. The assertion that proves the wiring is byte-for-byte
      // equality between result.summary and extractLastAssistantMessage(JSONL):
      // if the watcher had used the pane scrape instead, the summary would
      // contain pane chrome (prompt glyphs, input echo, status lines, etc.)
      // and would not match the JSONL extraction exactly. The PROBE in the
      // transcript file additionally confirms we picked up the right session.
      //
      // Note: we deliberately do NOT require result.summary to be the probe
      // line itself, because Claude often emits a closing assistant turn after
      // a tool call — which is then the "last" assistant message. That
      // doesn't undermine the wiring proof: byte-for-byte equality with the
      // JSONL helper output is the load-bearing assertion.
      const PROBE = "TRANSCRIPT_FALLBACK_PROBE_xyz123";
      const running = await launchSubagent(
        {
          name: "empty-msg",
          agent: "test-claude-autoexit",
          task:
            `First, output this exact line on its own: ${PROBE}\n` +
            `Then call subagent_done with NO arguments (do not pass message).`,
        },
        ctx(),
      );
      env.surfaces.push(running.surface);
      const result = await watchSubagent(running, new AbortController().signal);
      assert.equal(result.exitCode, 0, `exit: ${result.exitCode}; summary: ${result.summary}`);
      assert.ok(result.transcriptPath, "transcriptPath must be populated");
      const transcriptRaw = readFileSync(result.transcriptPath!, "utf-8");
      assert.match(
        transcriptRaw,
        new RegExp(PROBE),
        `expected probe ${PROBE} somewhere in archived transcript; transcript missing probe means we archived the wrong session`,
      );
      const fromTranscript = extractLastAssistantMessage(transcriptRaw).trim();
      assert.ok(fromTranscript.length > 0, "extractLastAssistantMessage returned empty — bad fixture");
      assert.equal(
        result.summary,
        fromTranscript,
        "summary must equal extractLastAssistantMessage(transcript) — proves the watcher wired the transcript JSONL fallback, not the pane scrape",
      );
    });

    it("autonomous-without-MCP regression: hangs until aborted (model forgot to call tool)", async () => {
      const running = await launchSubagent(
        {
          name: "no-mcp",
          agent: "test-claude-autoexit",
          // Explicit instruction NOT to call the tool — pins the documented
          // "model forgot ⇒ hang" behavior. We rely on the abort path to
          // unblock.
          task: "Reply with: STUCK. Do NOT call any tools, including subagent_done.",
        },
        ctx(),
      );
      env.surfaces.push(running.surface);
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 10_000).unref?.();
      const result = await watchSubagent(running, ctrl.signal);
      assert.equal(result.error, "cancelled");
      assert.equal(result.exitCode, 1);
    });

    it("cancellation mid-question: pane closes cleanly and BackendResult reflects abort", async () => {
      const running = await launchSubagent(
        {
          name: "cancel-mid",
          agent: "test-claude-interactive",
          task:
            "Ask exactly one clarifying question that ends with the marker " +
            "'CLARIFY_MID?' on its own line, then wait for the user. Never " +
            "call subagent_done.",
        },
        ctx(),
      );
      env.surfaces.push(running.surface);
      const ctrl = new AbortController();
      // Drive abort off an observable assistant-turn marker — not a fixed
      // timer — so the test actually covers the "mid-question" state. With a
      // bare timer the abort can fire before Claude has produced any turn.
      const driver = waitForScreen(running.surface, /CLARIFY_MID\?/, 30_000)
        .then(() => ctrl.abort());
      const result = await watchSubagent(running, ctrl.signal);
      await driver; // surface marker/send failures as test failures
      assert.equal(result.error, "cancelled");
    });

    it("user closes pane manually: watcher returns via __SUBAGENT_DONE__ marker", async () => {
      const running = await launchSubagent(
        {
          name: "user-exit",
          agent: "test-claude-interactive",
          task:
            "Greet the user with the marker 'READY' on its own line, then wait. " +
            "Do not call subagent_done.",
        },
        ctx(),
      );
      env.surfaces.push(running.surface);
      // Wait for the first assistant turn to be observable, then send /exit.
      // This is what makes "user closes during a live session" deterministic
      // — without it, /exit could land before Claude even started. Capture
      // the driver promise so a missed marker or send-failure surfaces as a
      // test failure, not a timeout / unhandled background rejection.
      const driver = waitForScreen(running.surface, /READY/, 30_000)
        .then(() => sendCommand(running.surface, "/exit"));
      const result = await watchSubagent(running, new AbortController().signal);
      await driver;
      // Summary should be non-empty: either the transcript fallback picked
      // up the assistant's greeting, or the generic exit-code fallback fired.
      assert.ok(result.summary && result.summary.length > 0, "summary must be non-empty");
    });
  });
}
