# Review: `2026-04-20-mux-free-execution-design-v2.md`

Reviewed: 2026-04-21  
Plan: `.pi/plans/2026-04-20-mux-free-execution-design-v2.md`  
Verdict: **Promising revision, but not implementation-ready yet**  
Ready to merge: **No**

## Summary

This is a materially better plan than v1.

The four earlier blockers are addressed in the right places:

- the plan now attacks the real orchestration preflight path instead of only `makeDefaultDeps()` (`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:11,665-819,3512-3682`), which matches how the current tools gate execution before deps are built (`pi-extension/orchestration/tool-handlers.ts:46-53,90-97`; `pi-extension/subagents/index.ts:206-223,1794-1799`)
- the `resolveLaunchSpec()` extraction is the right response to how much behavior is currently buried inside `launchSubagent()` (`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:9,1134-1355`; `pi-extension/subagents/index.ts:705-930`)
- the abort redesign now correctly keys escalation off an explicit exit signal rather than `proc.killed` (`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:33,1635-1655,4017-4019`)
- Claude resume parity is explicitly restored in the headless design (`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:43,2743-3055,4021-4024`), which is consistent with the current pane path already threading `resumeSessionId` through `buildClaudeCmdParts()` (`pi-extension/subagents/index.ts:666-685,748-755`)

So architecturally, v2 is much closer.

I still would not start implementation from this document as-is, because two of the plan's own verification gates are not executable in the current repository. Both are fixable, but they are important enough that I do not consider the plan implementation-ready until they are corrected.

## Strengths

- **The shared launch-resolution seam is now correctly placed.** The plan recognizes that the current pane path resolves much more than transport — agent defaults, cwd/config-root, session placement, system-prompt behavior, deny-tools, auto-exit, artifact handoff, and skill prompts are all embedded in `launchSubagent()` today (`pi-extension/subagents/index.ts:705-930`). Moving that into `resolveLaunchSpec()` is the right way to preserve behavior across backends (`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:9,1134-1355`).
- **The no-mux story now targets the actual user-facing entrypoint.** The new `preflightOrchestration()` plus the real registered-tool integration test is the right scope for the headline feature (`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:11,665-819,3512-3682`). That is a direct improvement over v1.
- **The abort fix is technically sound.** The plan now explicitly calls out the `proc.killed` trap and replaces it with `exit`/`close`-driven state (`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:1635-1655,1898-1903,4017-4019`).
- **Test determinism is much better.** Switching from host-dependent agents like `scout` to the repo-local fixtures is the right move (`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:2067,4013-4015`). Those fixtures actually exist and encode the expected behavior (`test/integration/agents/test-echo.md:2-8`, `test/integration/agents/test-ping.md:2-7`).
- **The Claude tool-restriction patch remains nicely isolated for upstreaming.** Keeping that change discrete in `pi-extension/subagents/index.ts` is still the right house style (`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:13,47-50`).

## Blocking findings

### 1) The repeated `npx tsc --noEmit` gates are not runnable in this repository, so several phase checks cannot pass as written

The plan treats `npx tsc --noEmit` as a hard pass/fail gate in multiple places (`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:417,458,586,1883,3065,3741`). In the current repo, that command is not wired up:

- there is no `tsconfig.json` / `tsconfig*.json` in the repository root
- `package.json` defines only `test` and `test:integration` scripts, with no typecheck entrypoint (`package.json:18-20`)
- running `npx tsc --noEmit` in the repo currently exits non-zero and prints the TypeScript help banner instead of typechecking files

#### Why this blocks

This plan is heavily phase-gated. If one of the main verification steps is impossible in the current repo, an implementer cannot tell whether a task actually passed or just hit a tooling hole. Because this shows up in six separate tasks across the plan, it is not just a docs nit — it breaks the execution path of the plan itself.

#### Recommended fix

Pick one concrete typecheck strategy and update every gate to use it consistently:

- add a real `tsconfig.json` and a `typecheck` script to `package.json`, then use `npm run typecheck`
- or replace the `tsc` commands with an explicit file list / project path that works in this repo
- or, if a full TypeScript compile is intentionally out of scope, remove the `tsc` expectations and replace them with the real runnable verification you want people to use

Until that is fixed, several "Expected: no errors" steps are impossible to satisfy.

---

### 2) The headline no-mux integration test cannot initialize the extension because its fake `ExtensionAPI` is missing required methods

Task 23b is supposed to be the proof that `subagent_serial` / `subagent_parallel` reach headless mode through the real registered-tool path (`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:3512-3682`). But the proposed `makeFakePi()` only implements:

- `registerTool`
- `on`
- `emit`

(`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:3543-3558`)

That is not enough for `subagentsExtension(...)`. During extension initialization, the real entrypoint also calls:

- `pi.registerCommand(...)` (`pi-extension/subagents/index.ts:1612-1622,1624-1652,1755-1778`)
- `pi.registerMessageRenderer(...)` (`pi-extension/subagents/index.ts:1654-1717,1719-1753`)

So `subagentsExtension(fake.api as any)` will throw before the orchestration tools are even registered.

#### Why this blocks

This is the plan's primary end-to-end proof for review finding 1. If the test harness cannot even boot the extension, the plan does not currently contain an executable verification of the headline no-mux path.

#### Recommended fix

Either:

- extend the fake API with no-op `registerCommand` and `registerMessageRenderer` methods (and any other init-time methods the extension touches), or
- reuse a fuller extension test harness already used elsewhere in the repo, so Task 23b validates the actual registration path instead of a partial shim

I would treat this as must-fix, because the whole point of Task 23b is to verify the exact entrypoint that v1 missed.

## Non-blocking notes

### 1) `preflightOrchestration.ts` should not be introduced with `require()` in an ESM package

The sample implementation for `preflightOrchestration()` uses a dynamic `require("./cmux.ts")` (`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:770-801`), while the package is explicitly ESM (`package.json:17`).

The plan does acknowledge this immediately below and says to switch to a static import if needed, so I do not consider this blocking. But the plan should just show the final static-import form up front; otherwise the first code block people paste in is the wrong one.

### 2) The transcript-path wording is too global for the current session-placement model

The plan's pi archival test and README copy describe pi transcripts as living under `~/.pi/agent/sessions/...` (`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:2286-2289,2355-2359,3941-3949`). That is broader than the current implementation model supports.

Today, session placement is derived from `getDefaultSessionDirFor(targetCwd, effectiveAgentDir)`, and `effectiveAgentDir` can be a project-local `.pi/agent` or a propagated `PI_CODING_AGENT_DIR`, not only `~/.pi/agent` (`pi-extension/subagents/index.ts:308-326,716-730,875-880`).

I would update the test/doc wording to say "under the resolved session root" for pi, and reserve the hardcoded `~/.pi/agent/sessions/claude-code/` statement for the Claude archival path only.

### 3) One preflight unit test is still host-dependent on `tmux` being installed

`preflight-orchestration.test.ts`'s pane-mode/no-session case sets `process.env.TMUX = "/tmp/tmux-fake"` and expects the code to behave as if mux is available (`.pi/plans/2026-04-20-mux-free-execution-design-v2.md:722-727`). But current mux detection also requires the command to exist on PATH (`pi-extension/subagents/cmux.ts:40-42,68-79`).

So that test will behave differently on hosts without `tmux`. I would mock the mux probe or test only deterministic env-controlled branches there.

## Conclusion

v2 is a real improvement. The earlier architectural blockers look addressed:

- backend-aware orchestration preflight is now in scope
- launch parity is handled via shared resolution rather than backend-specific reimplementation
- abort semantics are corrected
- Claude resume parity is explicitly covered

What keeps this from being implementation-ready are two plan-execution issues, not a fundamental architecture problem:

1. the repeated TypeScript verification gates are not runnable in the current repo
2. the headline no-mux integration test uses an incomplete fake `ExtensionAPI` and will fail during extension initialization

Fix those, tighten the couple of doc/test mismatches above, and I would be comfortable treating this plan as ready to execute.
