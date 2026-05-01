### Strengths
- **Good seam extraction:** `pi-extension/subagents/launch-spec.ts` cleanly centralizes launch normalization, which meaningfully reduces pane/headless drift risk.
- **Solid headless event modeling:** `pi-extension/subagents/backends/claude-stream.ts` and `.../headless.ts` do a good job projecting Claude/pi stream events into a shared `TranscriptMessage` boundary, including tool-call/tool-result handling.
- **Test coverage is strong overall:** the combination of `test/integration/orchestration-headless-no-mux.test.ts`, `headless-transcript-archival`, `headless-abort`, `headless-tool-use`, plus focused unit tests around selection, replay, parsing, and launch-spec behavior gives this change much better regression coverage than most backend refactors.
- **Claude skills behavior is handled responsibly:** warning and dropping `skills:` on Claude instead of leaking literal `/skill:` tokens is the right tradeoff for v1.

### Issues

#### Critical (Must Fix)
None.

#### Important (Should Fix)

- **File:** `pi-extension/subagents/launch-spec.ts:227-241,425-441`  
  **What's wrong:** `resolveLaunchSpec()` loads `agentDefs` before it resolves the child’s target cwd/config root, and the default `loadAgentDefaults()` search order is rooted at `process.cwd()/.pi/agents`. When a caller uses `cwd` to launch into another repo/worktree, the subagent can pick up the **parent session’s** agent definition instead of the target repo’s local `.pi/agents/<name>.md`, even though the child process itself later runs with the target cwd / `PI_CODING_AGENT_DIR`.  
  **Why it matters:** This mixes config from two different projects. In practice it can apply the wrong model, CLI, tools, skills, deny-tools, or even fail to find the intended agent. That violates the documented `cwd` contract (“picks up its local .pi/ config”) and undermines the whole “shared launch normalization” goal.  
  **How to fix:** Make agent lookup use the resolved target project root, not the parent process cwd. At minimum, search `<effective child cwd>/.pi/agents` before global/bundled agents; ideally derive agent lookup and `configRootEnv` from the same resolved root so they cannot diverge.

- **File:** `pi-extension/subagents/index.ts:84-99,1005-1068`  
  **What's wrong:** `/reload` cleanup only clears widget timers and the pane poll-loop abort controller. Bare headless `subagent` launches create a per-run `watcherAbort` in the tool execute closure and store it only in the module-local `runningSubagents` map. On reload, that map is replaced, but those abort controllers are never triggered.  
  **Why it matters:** A long-running headless background subagent can survive `/reload` as an orphaned process/watcher that the new module instance can no longer track or cancel. The spec/plan explicitly calls out `/reload` cleanup for headless background work; this implementation only covers `session_shutdown`, not reload.  
  **How to fix:** Store headless run abort controllers in reload-surviving global state (similar to `POLL_ABORT_KEY`), or have the reload bootstrap abort the previous module’s running-subagent registry before discarding it. Add an integration test that launches a long-running headless bare subagent, triggers reload, and asserts it is aborted.

#### Minor (Nice to Have)

- **File:** `pi-extension/subagents/index.ts:1025-1042`  
  **What's wrong:** The bare headless `subagent` completion steer message only includes `result.finalMessage`; it drops `result.error` from both the message body and `details`. For failures like missing CLI binaries or other backend errors, the user gets a generic failure notification without the actual reason.  
  **Why it matters:** Background runs are async; this steer is the main user-facing failure surface. Hiding the real error makes debugging much harder.  
  **How to fix:** Include `result.error` in `details`, and surface it in the steer content whenever present (at least as a fallback when `finalMessage` is empty).

### Recommendations
- Add a dedicated **`/reload` integration test** for long-running headless bare-subagent runs; the current shutdown test is good, but it does not cover the lifecycle gap above.
- Add a **cwd-scoped agent fixture test** proving that agent lookup follows the target child project’s `.pi/agents`, not the parent session cwd.
- Consider deep-copying `usage`/`transcript` in buffered headless partial snapshots to avoid mutation bleed between successive `onUpdate` emissions.

### Assessment

**Ready to merge: With fixes**

**Reasoning:** The backend seam, parsing, and test coverage are strong, but there are still two meaningful correctness/lifecycle gaps: agent resolution can come from the wrong project when `cwd` is used, and bare headless subagents are not actually cleaned up on `/reload`. Those should be fixed before calling this production-ready.
