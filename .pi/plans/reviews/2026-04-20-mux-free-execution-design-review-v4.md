# Review: `2026-04-20-mux-free-execution-design-v3.md`

Reviewed: 2026-04-21  
Plan: `.pi/plans/2026-04-20-mux-free-execution-design-v3.md`  
Verdict: **Very close, but not implementation-ready yet**  
Ready to merge: **No**

## Summary

This is the strongest revision so far.

The major v2 issues are addressed in the right places:

- the plan now targets the real orchestration preflight seam instead of only `makeDefaultDeps()` (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:11-13,743-941`), which matches the current repo's actual mux gate in `preflightSubagent()` and the current orchestration registration wiring (`pi-extension/subagents/index.ts:206-223,1794-1799`)
- the headline no-mux integration test now stubs the init-time `ExtensionAPI` surface that `subagentsExtension(...)` really touches (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:3663-3735`; `pi-extension/subagents/index.ts:1125-1139,1612-1779`)
- the transcript-path wording is now aligned with the current session-placement model driven by `resolveSubagentPaths()` and `getDefaultSessionDirFor(...)` (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:2408-2503`; `pi-extension/subagents/index.ts:308-326`)

So architecturally, I think v3 has the right shape.

I found **one remaining blocking issue**: Task 0 still makes `npm run typecheck` a required clean gate before Phase 1, but with the proposed repo-root tsconfig the command already reaches existing first-party type errors in the current codebase, so the gate cannot pass as written.

## Assessment

**Ready to merge: No**

If Task 0 is amended to account for the current baseline TypeScript failures — either by fixing them explicitly in scope or by narrowing the initial gate until that baseline is cleaned up — I do not see any other blockers to executing this plan.

## Strengths

- **The preflight fix is now aimed at the real production seam.** The plan explicitly replaces orchestration's hard mux requirement with backend-aware preflight (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:743-941`), which is the correct response to how the current repo gates `subagent_serial` / `subagent_parallel` today (`pi-extension/subagents/index.ts:206-223,1794-1799`).
- **The no-mux integration test is now grounded in the actual extension initialization path.** v3 correctly noticed that `subagentsExtension(...)` does more than register tools, and the proposed fake API now covers `on`, `registerCommand`, and `registerMessageRenderer` too (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:3663-3735`). That matches the current init-time behavior in `subagentsExtension(...)` (`pi-extension/subagents/index.ts:1125-1139,1612-1779`).
- **The session-root language is finally faithful to the current codebase.** The updated archival test accepts the resolved session root rather than hardcoding `~/.pi/agent/sessions` (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:2408-2503`), which matches the current `effectiveAgentDir` + `getDefaultSessionDirFor(...)` logic (`pi-extension/subagents/index.ts:308-326`).
- **The new harness helper is a good cleanup.** Adding `copyTestAgents(dir)` is the right way to keep headless integration tests deterministic without coupling them to mux-only setup (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:2184-2219`; `test/integration/harness.ts:111-120`).

## Blocking findings

### 1) Task 0's new `npm run typecheck` gate still cannot pass on the current repo baseline, but the blocker is existing first-party type errors rather than missing Node typings

Task 0 creates a root `tsconfig.json` with `"types": ["node"]`, adds a `typecheck` script, and then requires Step 4 to end with a **clean exit (code 0), no errors** (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:79-99,123-138`). Re-checking that assumption against the current repo changes the diagnosis from my previous review: the repo root already has `node_modules/@types/node/package.json`, and running the proposed config from the repo root does **not** stop on missing Node typings.

Instead, the proposed gate reaches existing type errors in first-party code under `pi-extension/subagents/index.ts`, including unsafe access to `.text` on `TextContent | ImageContent` (`pi-extension/subagents/index.ts:1323,1434`) and message renderers whose returned object is missing the required `invalidate` method (`pi-extension/subagents/index.ts:1654,1719`). Those are real repo-code failures surfaced by the new gate, not an environment bootstrap problem.

#### Why this blocks

v3 explicitly makes `npm run typecheck` the new phase gate for the rest of the plan (`.pi/plans/2026-04-20-mux-free-execution-design-v3.md:63-65,130-138`). As written, Step 4 says that gate should already be green before Phase 1 starts, but the current codebase does not satisfy that expectation. The fallback guidance in Task 0 to "relax the corresponding option in `tsconfig.json`" is not a good fit for these failures because they are in first-party implementation code the plan is trying to protect, not just upstream declaration churn.

#### Recommended fix

Amend Task 0 so it acknowledges the real baseline and makes one of these paths explicit:

- **Preferred:** add a short baseline-cleanup step that fixes the current `pi-extension/subagents/index.ts` type errors before treating `npm run typecheck` as a hard gate
- **Alternative:** narrow the initial typecheck scope to the files or surface area changed by this plan, then expand it to the full repo once the existing baseline errors are addressed

Either way, the review should no longer claim that the blocker is missing `@types/node`; the real blocker is that the proposed typecheck gate is stricter than the current repo baseline can satisfy.

## Conclusion

v3 fixes the substantive architectural and test-harness problems from the earlier reviews. I only found one remaining blocker, but the root cause is different than I previously called out: the proposed typecheck bootstrap does resolve Node typings from the repo root, yet it immediately surfaces existing first-party TypeScript errors, so the very first phase gate still cannot pass yet.

Fix the baseline-gate mismatch, and this plan looks ready to execute.
