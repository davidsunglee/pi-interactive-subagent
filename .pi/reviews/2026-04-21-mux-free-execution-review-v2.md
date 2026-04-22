### Strengths
- The backend seam is well-factored: `launch-spec.ts`, `backends/*`, and the orchestration adapters make the pane/headless split much easier to reason about than the prior monolith.
- The v1 review findings were remediated: target-project agent lookup now has regression coverage, and the `/reload` headless-abort lifecycle gap is explicitly tested.
- Headless transcript/usage capture is thoughtfully implemented, especially the Claude event projection and transcript archival path.
- Test coverage is strong overall, and I verified the unit suite passes locally with `npm test`.

### Issues
#### Critical (Must Fix)
None.

#### Important (Should Fix)

- **Relative `cwd` is still resolved against `process.cwd()`, not the session cwd.**  
  **Files:** `pi-extension/subagents/launch-spec.ts:295-305`, `pi-extension/subagents/launch-spec.ts:446-455`  
  `resolveLaunchSpec()` correctly pre-resolves `params.cwd` against `ctx.cwd` for agent lookup, but `resolveSubagentPaths()` later resolves that same relative `params.cwd` against `process.cwd()`. If the session cwd differs from the Node process cwd, agent defaults are loaded from one target tree while the actual child cwd/session placement/config-root are derived from another. That breaks the shared launch-spec contract and can select the wrong local `.pi` config or start the child in the wrong directory.  
  **Fix:** resolve relative caller-supplied `cwd` from `ctx.cwd` consistently everywhere, not from `process.cwd()`.

- **Pane and headless still disagree on the default working directory when no explicit `cwd` is provided.**  
  **Files:** `pi-extension/subagents/index.ts:629-630`, `pi-extension/subagents/index.ts:752-755`, `pi-extension/subagents/cmux.ts:316-323`, `pi-extension/subagents/cmux.ts:340-342`, `pi-extension/subagents/backends/headless.ts:373-375`, `pi-extension/subagents/backends/headless.ts:511-513`  
  Headless launches fall back to `ctx.cwd`, but pane launches create the surface in `process.cwd()` and only add a `cd` when `spec.effectiveCwd` is non-null. So the same subagent request runs in different directories depending on backend selection. That violates the "shared launch contract" goal and can change local config/extension discovery purely based on mux availability.  
  **Fix:** make pane launches honor `ctx.cwd` as their default cwd too—either by plumbing it into surface creation or by always prefixing pane commands with `cd ${spec.effectiveCwd ?? ctx.cwd}`.

- **Pane Claude still returns a transcript filename as `sessionId`, which breaks the unified resume contract.**  
  **Files:** `pi-extension/subagents/index.ts:796-806`, `pi-extension/subagents/index.ts:863-882`, `pi-extension/subagents/backends/pane.ts:76-84`  
  `copyClaudeSession()` returns the archived filename (for example `abc123.jsonl`), and `watchSubagent()` forwards that as `claudeSessionId`; the pane backend then exposes it as unified `sessionId`. Headless returns the raw Claude session id from `system/init`. The API contract says `resumeSessionId` takes a session ID, so feeding the pane-returned value back into `--resume` includes `.jsonl` and is not the same identifier headless returns.  
  **Fix:** keep `transcriptPath` as the archived filename/path, but strip `.jsonl` and return the raw session id in `claudeSessionId`/`sessionId`.

#### Minor (Nice to Have)
None.

### Recommendations
- Add a regression test where `ctx.cwd !== process.cwd()` and `params.cwd` is relative; the current test only covers the absolute-path case.
- Add a pane-Claude resume round-trip test so `sessionId` format stays aligned with `resumeSessionId`.
- Add one backend-parity test asserting pane and headless launch from the same cwd/config root for the same task.

### Assessment
**Ready to merge: With fixes**  
**Reasoning:** The architecture, parsing, and test coverage are strong, and the previously flagged v1 issues appear to be fixed. But there are still meaningful correctness gaps around cwd normalization/backend parity and pane Claude `sessionId` shape. Those should be resolved before calling this production-ready.
