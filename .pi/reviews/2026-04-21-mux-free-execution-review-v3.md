### Strengths
- The remaining pane/orchestration code is still coherent enough to run: I verified the current unit suite passes locally with `npm test`.
- Pane Claude transcript archiving is still present, so successful pane Claude runs can continue to preserve an archived transcript path.
- The launch path still has some useful factoring (`buildPiPromptArgs`, deny-tool expansion, session seeding), which will make a corrected follow-up easier than rebuilding from scratch.

### Issues
#### Critical (Must Fix)
- **The mux-free/headless implementation was effectively removed, so the primary requirement of this work is no longer met.**  
  **Files:** `pi-extension/subagents/index.ts:206-223`, `pi-extension/subagents/index.ts:1179-1183`, `pi-extension/subagents/index.ts:1794-1799`, `pi-extension/orchestration/default-deps.ts:43-73`, `pi-extension/orchestration/types.ts:31-39`  
  `preflightSubagent()` now hard-fails when no mux is available, both the bare `subagent` tool and the orchestration tools route through that mux-only preflight again, and `makeDefaultDeps()` only dispatches to the pane launch/watch primitives. In the same review range, the dedicated headless backend/selector/launch-spec files were deleted entirely, and the headless-only `usage` / `transcript` result fields were removed from `OrchestrationResult`. That sends CI / headless SSH / IDE-terminal callers back to the original “mux required” failure mode and drops the core mux-free contract defined by the spec and plan.

#### Important (Should Fix)
- **Relative caller `cwd` is still resolved from `process.cwd()` instead of the session cwd, so the v2 cwd bug remains unfixed.**  
  **Files:** `pi-extension/subagents/index.ts:308-316`  
  `resolveSubagentPaths()` still joins a relative caller-supplied `params.cwd` against `process.cwd()`. If the pi session was started from a different directory than the Node process cwd, the subagent can pick up the wrong project-local `.pi` config, place its session under the wrong root, and run in a different directory than the caller intended. This was an Important finding in v2 and it is still present.

- **Pane Claude still reports the archived transcript filename as `claudeSessionId`, so resume remains broken.**  
  **Files:** `pi-extension/subagents/index.ts:977-987`, `pi-extension/subagents/index.ts:1044-1063`  
  `copyClaudeSession()` returns the archived filename (for example `abc123.jsonl`), and `watchSubagent()` forwards that string as `claudeSessionId`. The API surface advertises `resumeSessionId` as a session ID, not an archive filename, so feeding the returned value back into `--resume` still uses the wrong identifier. This was the other surviving Important finding from v2 and it is still unremediated.

- **Claude command construction regressed: it no longer normalizes provider-prefixed model names and no longer enforces agent `tools:` restrictions.**  
  **Files:** `pi-extension/subagents/index.ts:666-688`, `pi-extension/subagents/index.ts:741-759`, `agents/scout.md:4-6`, `agents/planner.md:1-4`  
  `buildClaudeCmdParts()` now forwards `input.model` verbatim and has no `tools` handling at all. But bundled agents still declare provider-prefixed Claude models like `anthropic/claude-haiku-4-5` and `anthropic/claude-opus-4-6`, which the Claude CLI does not consume in the normalized form this branch previously introduced. At the same time, agents such as `scout` that declare `tools:` lose the intended Claude tool restriction entirely. That reopens both a correctness regression (bad model argv) and the explicit tool-restriction regression this effort was supposed to fix.

#### Minor (Nice to Have)
- **The automated verification harness regressed substantially, which makes the runtime regressions above easier to miss.**  
  **Files:** `package.json:18-20`, `test/integration/claude-sentinel-roundtrip.test.ts:21-33`  
  The review range removed the `typecheck` script/tsconfig gate and turned the Claude roundtrip test back into an explicit scaffold that only asserts `true`. `npm test` is still green, but the branch no longer automatically exercises several of the behaviors this rereview was supposed to validate.

### Recommendations
- Restore the backend seam and headless implementation rather than documenting the regression away; the spec’s headline requirement is mux-free execution.
- Fix the two v2 findings that are still live: resolve relative `cwd` from `ctx.cwd`, and return a raw Claude session ID separately from the archived transcript filename/path.
- Reintroduce the Claude launch-contract fixes together: shared model normalization plus Claude `tools:` restriction handling.
- Bring back the deleted automated coverage before merge so the restored behavior is actually guarded.

### Assessment
**Ready to merge: No**

**Reasoning:** The rereview does not just leave a couple of earlier issues unresolved; it regresses the branch away from the spec’s primary deliverable by removing mux-free/headless execution altogether. On top of that, two Important findings from v2 remain unfixed (`cwd` normalization and Claude resume ID shape), and the Claude command builder has regressed on model normalization/tool restriction behavior. The remaining pane path is testable and some functionality still works, but this diff is not production-ready for the requirements in the cited spec and plan.
