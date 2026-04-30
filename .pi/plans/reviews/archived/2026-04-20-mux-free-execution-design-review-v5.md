# Review: `2026-04-20-mux-free-execution-design-v3.md`

Reviewed: 2026-04-20  
Plan: `.pi/plans/2026-04-20-mux-free-execution-design-v3.md`  
Verdict: **Strong revision, but one execution blocker remains**  
Ready to merge: **No**

## Summary

v3 is a substantial improvement over the earlier drafts, and it addresses the major review-v2/review-v3 concerns in the right places.

In particular:

- the plan now targets the real orchestration preflight seam instead of only `makeDefaultDeps()` (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:11-13,743-941`), which matches how orchestration is actually gated before deps are built today (`pi-extension/orchestration/tool-handlers.ts:24-27,44-49,80-85`; `pi-extension/subagents/index.ts:206-223,1794-1799`)
- the headline no-mux integration test now stubs the init-time `ExtensionAPI` surface that `subagentsExtension(...)` really touches (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:3663-3735`), which lines up with current extension initialization calling `registerTool(...)`, `registerCommand(...)`, and `registerMessageRenderer(...)` (`pi-extension/subagents/index.ts:1612-1779`)
- the transcript-path wording is now aligned with the real session-placement model driven by `getDefaultSessionDirFor(...)` and the effective agent dir rather than a blanket `~/.pi/agent/sessions/...` assumption (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:2408-2503,4215-4219`; `pi-extension/subagents/index.ts:308-332,716-730,875-880`)
- the preflight implementation is now shown in a static-ESM-import shape with a swappable mux probe for deterministic tests (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:835-923`), which is appropriate for this package's ESM setup (`package.json:17`)

I only found **one remaining blocker**: Task 0 still claims it can establish a clean repo-wide `npm run typecheck` baseline before Phase 1, but the proposed repo-root tsconfig already surfaces existing first-party type errors in `pi-extension/subagents/index.ts`. So the command becomes runnable, but the promised green baseline still does not exist as written.

If Task 0 is revised to handle that baseline mismatch explicitly, I do not see any other blockers to executing the plan.

## Strengths

- **The old fake-API blocker is genuinely fixed for Task 23b's intended scope.** The new `makeFakePi()` includes `registerTool`, `registerCommand`, `registerMessageRenderer`, `on`, and `emit` (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:3669-3719`), which is enough to let `subagentsExtension(...)` initialize under the current code path (`pi-extension/subagents/index.ts:1612-1779`). That closes the concrete v2 problem where the test harness could not even boot the extension.
- **The preflight remediation now matches the real architecture.** Task 7b adds a dedicated `preflightOrchestration()` that only requires mux when pane mode is selected (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:743-941`). That is the correct response to the current orchestration tool flow, where preflight runs before deps are constructed (`pi-extension/orchestration/tool-handlers.ts:24-27,44-49,80-85`).
- **The session-root language is now faithful to the current codebase.** The updated archival test and README wording no longer overstate pi transcript placement (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:2408-2503,4215-4219`), matching the current `resolveSubagentPaths(...)` / `getDefaultSessionDirFor(...)` logic (`pi-extension/subagents/index.ts:308-332,716-730,875-880`).
- **The plan is better about deterministic tests.** The new harness helper for copying repo-local test agents keeps integration coverage anchored to fixtures that actually exist in this repo (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:2184-2219`; `test/integration/harness.ts:111-120`).
- **The remaining issue is operational, not architectural.** The launch-resolution extraction, backend-aware preflight, Claude resume parity, and test-harness fixes all now have the right overall shape. What is left is making the first phase gate executable on the current baseline.

## Blocking findings

### 1) Task 0 still does not produce the “clean baseline typecheck” that the rest of the plan depends on

Task 0 creates a repo-root `tsconfig.json`, adds `"typecheck": "tsc --noEmit"`, and then requires `npm run typecheck` to exit cleanly before Phase 1 begins (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:67-140`). The v3 changelog also frames this as the fix for the earlier unrunnable-typecheck review finding (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:4203-4206`).

That only solves half the problem. With the proposed compiler options, the command is now runnable from the repo root, but it immediately reaches existing first-party type errors in `pi-extension/subagents/index.ts`, including:

- unsafe `.text` access on a `TextContent | ImageContent` union (`pi-extension/subagents/index.ts:1323-1324,1434-1435`)
- message renderers that return objects missing the required component shape, specifically `invalidate` (`pi-extension/subagents/index.ts:1654-1719`)

Those failures are especially important here because `pi-extension/subagents/index.ts` is one of the main files this plan later refactors and patches (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:48-56`). So the new gate is not failing in some unrelated external surface; it is failing in the exact core file the plan is trying to protect.

#### Why this blocks

Phase 0 is supposed to establish a trustworthy green baseline before the backend work starts. As written, it cannot do that. The plan currently says:

- add tsconfig
- add the script
- run the script
- expect a clean exit

But the current repo does not satisfy that expectation. The fallback guidance in Task 0 to relax tsconfig settings if errors surface is not a good fit for these particular failures, because they are in first-party implementation code rather than just third-party declaration churn.

So review-v3 blocker 1 is only **partially** remediated: the command becomes runnable, but the promised clean baseline still is not there.

#### Recommended fix

Revise Task 0 so it explicitly handles the real baseline state. I see two viable paths:

1. **Preferred:** add a small baseline-cleanup step that fixes the current `pi-extension/subagents/index.ts` type errors before making `npm run typecheck` a hard green gate
2. **Alternative:** deliberately narrow the initial typecheck scope and say so explicitly, then stop presenting it as a blanket clean baseline for files it excludes

I would strongly prefer the first option, because `pi-extension/subagents/index.ts` is central to this plan and later tasks modify it directly.

## Non-blocking notes

### 1) The mux-environment cleanup in the new tests should also clear `ZELLIJ_SESSION_NAME`

The new env-reset sets in `preflight-orchestration.test.ts` and `select-backend.test.ts` clear `CMUX_SOCKET_PATH`, `TMUX`, `ZELLIJ`, and `WEZTERM_UNIX_SOCKET` (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:765-775,1163-1168`). But current mux detection also treats `ZELLIJ_SESSION_NAME` as zellij runtime state (`pi-extension/subagents/cmux.ts:44-45`).

On a host launched inside zellij, that leftover env var could still pollute supposed “no mux” assertions. Add `ZELLIJ_SESSION_NAME` to the saved/cleared key sets.

### 2) The fake `ExtensionAPI` is sufficient for Task 23b, but not yet for the changelog’s hinted follow-up command tests

The changelog notes that the fake now captures `commands` so future tests could invoke `/iterate`, `/subagent`, and `/plan` (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:4208-4210`). That is directionally useful, but the fake still does not implement `sendUserMessage`, and the current command handlers call it (`pi-extension/subagents/index.ts:1619,1649,1779`).

That does **not** block Task 23b as written, because Task 23b only needs extension initialization and orchestration tool execution. But if the intent is to make future command-path tests drop-in ready, a no-op `sendUserMessage` stub should be added now.

## Conclusion

v3 fixes the substantive architectural and test-harness issues from the earlier reviews:

- the no-mux orchestration path is now aimed at the real entrypoint
- the fake-extension harness is now sufficient for the headline integration test
- the ESM/static-import issue is cleaned up
- the transcript-root wording now matches the current session-placement model

What still keeps this from being implementation-ready is the new Phase 0 gate: the repo does not currently pass the proposed typecheck baseline, so the first “green before proceeding” checkpoint cannot succeed as written.

Fix that baseline-gate mismatch, and I would be comfortable treating the rest of v3 as ready to execute.
