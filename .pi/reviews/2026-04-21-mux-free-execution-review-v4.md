# Code Review — Mux-Free Execution (v4)

**Date:** 2026-04-22  
**Range:** `0a1a330ff5a0e697b5f7a6973ad52a9c332b2b7e..fa99039c9e552350f18063ea768262fb415ac16f`  
**Primary requirements:** `.pi/specs/2026-04-20-mux-free-execution-design.md`  
**Additional context reviewed:** `.pi/plans/2026-04-20-mux-free-execution-design-v18.md`

## Assessment

**Ready to merge: Yes**

This is a strong change set. The implementation matches the core spec goals: it introduces a real headless backend, centralizes launch-time normalization behind a shared launch-spec layer, preserves the pane path behind a thin adapter, fixes Claude tool restriction on both backends, and adds meaningful unit + integration coverage around the new behavior.

I did not identify any production-blocking issues in the reviewed diff.

## Strengths

- **Backend split is clean and maintainable.** `launch-spec.ts` centralizes the previously duplicated normalization logic, while `backends/pane.ts`, `backends/headless.ts`, and `backends/select.ts` keep transport-specific behavior isolated.
- **Headless result surface is materially useful.** The new headless path returns `usage` and `transcript`, replays buffered partials to late-bound `onUpdate`, and archives Claude transcripts by `sessionId` rather than brittle project-slug reconstruction.
- **Claude path details are handled carefully.** The implementation correctly uses `TranscriptMessage` instead of `pi-ai` `Message`, and correctly uses Claude's `--tools` restriction path rather than `--allowedTools` in bypass-permissions mode.
- **Regression fixes are well integrated.** The shared Claude model normalization, pane default-cwd fix, pane Claude session-id fix, and shared tool-map all reduce pane/headless drift.
- **Verification is strong.** The change adds substantial focused tests and I was able to run both the unit/typecheck gates and several real-CLI targeted integrations successfully.

## Findings

### Critical

- None.

### Important

- None.

### Minor

- None.

## Non-blocking recommendations

These are documentation polish items, not merge blockers:

1. **README task-schema note is stale** — `README.md:243` still says `interactive` is "not plumbed today," but the implementation now accepts it as a vestigial compat field and ignores it at runtime.
2. **Bare tool copy is still pane-centric** — `pi-extension/subagents/index.ts:1013-1024` still describes `subagent` as spawning "in a dedicated terminal multiplexer pane," which is no longer universally true once headless mode is available.

## Verification performed

### Code / diff review

Reviewed the spec, plan, diff stat, full diff, and the main changed implementation files, including:

- `pi-extension/subagents/launch-spec.ts`
- `pi-extension/subagents/backends/headless.ts`
- `pi-extension/subagents/backends/claude-stream.ts`
- `pi-extension/subagents/backends/pane.ts`
- `pi-extension/subagents/backends/select.ts`
- `pi-extension/subagents/index.ts`
- `pi-extension/orchestration/default-deps.ts`
- `pi-extension/orchestration/types.ts`
- `pi-extension/orchestration/run-serial.ts`
- `pi-extension/orchestration/run-parallel.ts`
- `pi-extension/orchestration/tool-handlers.ts`

### Commands run

- `npm run typecheck` ✅
- `npm test` ✅
- `node --test test/integration/headless-pi-smoke.test.ts` ✅
- `node --test test/integration/headless-claude-smoke.test.ts` ✅
- `node --test test/integration/headless-tool-use.test.ts` ✅
- `node --test test/integration/headless-claude-resume.test.ts` ✅
- `node --test test/integration/headless-transcript-archival.test.ts` ✅
- `node --test test/integration/headless-enoent.test.ts` ✅
- `node --test --test-name-pattern='subagent_serial executes through the real registered tool callback under forced headless' test/integration/orchestration-headless-no-mux.test.ts` ✅

## Conclusion

The implementation is in good shape and meets the reviewed requirements. I would merge this as-is.