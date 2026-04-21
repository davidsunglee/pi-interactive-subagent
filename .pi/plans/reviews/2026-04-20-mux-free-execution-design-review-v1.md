# Review: `2026-04-20-mux-free-execution-design-v1.md`

Reviewed: 2026-04-20
Plan: `.pi/plans/2026-04-20-mux-free-execution-design-v1.md`
Verdict: **Needs revision before implementation**

## Summary

The plan has a good overall direction: the backend seam is appropriately narrow, the Claude `--allowedTools` fix is scoped as a discrete upstream-portable patch, and the test coverage ambition is strong.

I do **not** think v1 is implementation-ready yet. There are several production-impacting gaps where the proposed headless path does not actually preserve the current orchestration contract, and one cancellation bug in the proposed process-management code that would make the advertised abort behavior unreliable.

## Assessment

**Ready to merge: No**

The main blockers are:

1. the new headless path is still unreachable from the orchestration tools in the exact no-mux environments the plan is targeting
2. the proposed headless pi implementation bypasses too much of the existing `launchSubagent()` behavior, so agent defaults / session semantics would diverge materially from pane mode
3. the abort escalation logic is incorrect for real `ChildProcess` objects, and the proposed unit test masks that mistake
4. the headless Claude path drops `resumeSessionId`, which is already part of the documented orchestration surface

## Strengths

- The high-level split between `pane.ts` and `headless.ts` is sensible and keeps the orchestration core mostly isolated from transport concerns (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:7,15-39`).
- Treating the Claude tool-restriction fix as a separate named patch is exactly the right shape for later upstreaming (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:35,1781-1919`).
- The plan is unusually concrete about tests, including smoke/integration coverage for both happy paths and ENOENT/abort paths.

## Blocking findings

### 1) The orchestration tools will still reject no-mux sessions before backend selection ever runs

The plan's goal is to make `subagent_serial` / `subagent_parallel` work "in environments without a supported multiplexer" (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:5`). But the implementation scope only rewires `makeDefaultDeps()` through `selectBackend()` (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:7,33-39,615-775`). It does not change the existing orchestration preflight path.

Today, the orchestration tools call `preflight(ctx)` **before** constructing deps (`pi-extension/orchestration/tool-handlers.ts:46-53,90-97`), and `registerOrchestrationTools()` currently wires that preflight to `preflightSubagent` (`pi-extension/subagents/index.ts:1788-1799`). `preflightSubagent()` immediately errors when no mux is available and when no persistent session file exists (`pi-extension/subagents/index.ts:206-223`).

That means the planned headless backend never becomes reachable in the exact CI/headless/IDE scenarios this plan claims to unlock: the tool returns the existing mux/session-file error before `selectBackend()` is even consulted. This is a release blocker because the headline feature would not actually work.

### 2) The proposed headless pi path is not behaviorally equivalent to the current subagent launch contract

The current pane path does much more than spawn `pi` with a task string. It resolves agent defaults (`model/tools/skills/thinking`), role-folder agent roots, `session-mode` / `fork`, child session seeding, prompt wrapping, `subagent-done` loading, deny-tools expansion, auto-exit behavior, and artifact-backed task handoff (`pi-extension/subagents/index.ts:705-910`).

By contrast, the proposed `runPiHeadless()` only builds `--session`, `--output-format`, optional `--model`, optional `--append-system-prompt`, optional `--tools`, and the raw task string, with a very small env prefix (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:1141-1176`). It does **not** preserve:

- `skills`
- agent body / `system-prompt` mode handling
- `fork` / `session-mode` / lineage seeding
- `PI_DENY_TOOLS`
- `PI_SUBAGENT_AUTO_EXIT`
- local `.pi/agent` resolution via `PI_CODING_AGENT_DIR`
- artifact-backed prompt delivery that the current implementation uses outside fork mode
- the `subagent-done.ts` extension load

That is not a backend swap; it is a different execution model with materially different semantics. In practice, headless runs would not behave like pane runs for many existing agents/tasks, despite the plan positioning headless as an alternate backend behind the same orchestration API. This needs to be fixed in the design before implementation starts.

### 3) The proposed SIGTERM→SIGKILL abort logic will not work correctly against real child processes

Both proposed headless runners implement abort escalation as:

- send `SIGTERM`
- after 5s, send `SIGKILL` only if `!proc.killed`

See `.pi/plans/2026-04-20-mux-free-execution-design-v1.md:1245-1256` and `.pi/plans/2026-04-20-mux-free-execution-design-v1.md:2233-2240`.

That check is unsafe for Node `ChildProcess`: `child.killed` becomes true once `kill()` successfully sends a signal, not only after the process has exited. So after the initial `SIGTERM`, the 5-second callback can observe `proc.killed === true` and skip `SIGKILL` even if the child is still alive. A stubborn CLI would then outlive the documented cancellation budget.

Worse, the proposed unit test masks the bug: its fake process only flips `killed=true` on `SIGKILL`, not on `SIGTERM` (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:1409-1416`). So the test would pass while the real implementation remains wrong.

Given that cancellation is part of the tool contract, this needs redesign (for example, track process exit explicitly rather than keying escalation off `proc.killed`).

### 4) The headless Claude design silently drops `resumeSessionId`

`resumeSessionId` is already part of the orchestration task schema (`pi-extension/orchestration/types.ts:21`) and the current Claude pane path threads it into `buildClaudeCmdParts()` (`pi-extension/subagents/index.ts:748-755`).

The proposed `runClaudeHeadless()` argument construction omits it entirely (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:2140-2173`). So any headless Claude orchestration task that asks to resume an existing session would silently start a fresh conversation instead.

That is a real contract regression, especially because the plan also adds `sessionId` to headless results and explicitly frames that as useful for resume workflows. Headless Claude needs parity here before this can be considered production-ready.

## Non-blocking note

### 5) The `@mariozechner/pi-ai` dependency story is still a bit hand-wavy

The plan relies on `@mariozechner/pi-ai` being "already transitively available through upstream" (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:9`) and suggests adding it as a `peerDependency` if resolution fails (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:394-395`). I would tighten that before implementation: if the fork imports the package directly, the plan should be explicit about whether it must be a direct dependency/devDependency rather than assuming transitive layout stability.

## Conclusion

I would not start implementation from v1 as written. The backend seam and test strategy are promising, but the plan first needs to:

- remove or relax the mux/session-file preflight for orchestration when headless is selected
- define how headless preserves the existing `launchSubagent()` semantics instead of bypassing them
- fix the abort escalation design and its test
- add `resumeSessionId` parity to the Claude headless path

Once those are addressed, this should be much closer to implementation-ready.
