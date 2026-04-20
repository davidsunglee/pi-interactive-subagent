import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const CLAUDE_AVAILABLE = (() => {
  try {
    execSync("which claude", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

const PLUGIN_DIR = join(
  new URL("../../pi-extension/subagents/plugin", import.meta.url).pathname,
);
const PLUGIN_PRESENT = existsSync(join(PLUGIN_DIR, "hooks", "on-stop.sh"));

// NOTE (v4): this is a SCAFFOLD, not a roundtrip test. It exists so the
// integration test-runner has something to discover on fresh checkouts and
// so the skip condition for a future real harness is already wired. The
// actual Claude Stop-hook → archived-transcript verification is run
// manually via the README "Manual smoke test" checklist; when an automated
// harness is added, it will live inside the `it()` body below and assert:
//   - SubagentResult.transcriptPath is non-null and under
//     ~/.pi/agent/sessions/claude-code/
//   - existsSync(transcriptPath) === true after sentinel cleanup
describe("claude sentinel scaffold (local only)", { skip: !CLAUDE_AVAILABLE || !PLUGIN_PRESENT }, () => {
  it("scaffold present; real roundtrip harness is future work (see README smoke test)", () => {
    assert.ok(true);
  });
});
