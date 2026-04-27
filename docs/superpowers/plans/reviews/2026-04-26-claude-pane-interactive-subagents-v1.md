# Review: Claude Pane Interactive Subagents Implementation Plan

## Verdict
[Issues Found]

The plan is technically aligned with the spec in most of the core architecture: explicit MCP-based completion, Stop-hook simplification, Claude system-prompt addendum, `--tools` injection, and transcript-first summary fallback are all represented. Task ordering is also mostly sensible: runtime/build plumbing first, then hook/server changes, then launch-path changes, then tests.

However, there is one Error-level coverage gap and several Warning-level plan-quality gaps that should be fixed before execution starts. As written, the plan could deliver the lower-level mechanism while still missing the actual parent-facing `subagent_run_serial` / `subagent_run_parallel` workflow the spec is trying to protect.

## Strengths
- The plan’s architecture summary matches the spec closely.
- File-level decomposition is concrete and buildable.
- The Stop-hook simplification is correctly scoped.
- The plan preserves the spec’s non-goals instead of expanding into headless Claude or pi-path changes.
- Testing is taken seriously; most major code paths have at least one planned test.

## Issues

### 1) Error — Task 11 / Task 12 do not exercise the actual parent-facing orchestration path the spec targets
**Conflict:** The spec’s target use case is `define-spec` dispatching a Claude pane child via `subagent_run_serial`, and the spec’s testing section explicitly calls for orchestration coverage at that layer. The plan’s Task 11 adds only delayed `runSerial` / `runParallel` tests with fake `LauncherDeps`, and Task 12’s “spec-designer-style” smoke test calls `launchSubagent` / `watchSubagent` directly instead of going through the parent-facing orchestration entrypoint.

**Which is better:** **Spec is better.** The spec protects the real public contract and target workflow. The plan currently proves the pane backend and watcher behavior, but it can still miss bugs in orchestration payload mapping, agent resolution on the real path, state propagation, or the actual `subagent_run_serial` / `subagent_run_parallel` integration.

**Why this matters:** This feature exists specifically because a parent workflow should stay blocked until the interactive Claude child explicitly finishes. If the plan never runs the real orchestration path end-to-end, the most important user-visible regression can still slip through.

**Required fix:**
- Add at least one real orchestration test for `subagent_run_serial` with `cli: claude, auto-exit: false`.
- Add the parallel analogue for `subagent_run_parallel`.
- Change the workflow-level smoke test so the parent dispatches the child through the orchestration layer and asserts the parent receives the expected terminal payload.

### 2) Warning — Task 10 and Task 12 use fixed delays instead of observing the assistant turns the spec wants to pin
**Conflict:** The spec’s key regression test is “the pane stays alive after the first assistant turn,” and the workflow smoke expects two clarifying questions in two turns. In Task 10, the happy-path test only waits 4 seconds and asserts the sentinel has not appeared; it does **not** confirm that the first assistant turn actually happened before making that assertion. Task 12 similarly sends answers after fixed 4s / 12s delays without first verifying that question 1 and question 2 were actually asked.

**Which is better:** **Spec is better.** The spec’s version is behaviorally anchored to the turns that matter. The plan’s timer-based version is weaker and can pass without ever observing the target interaction.

**Why this matters:** If Claude is slow to produce its first question, the Task 10 test can pass while never proving “survives first assistant turn.” Likewise, the Task 12 test can become flaky or fail to prove a true two-turn clarification loop.

**Recommended fix:**
- In Task 10, wait until the first assistant question is visible (pane scrape or transcript artifact), then assert the sentinel is still absent.
- In Task 12, wait for question 1 before sending answer 1, and wait for question 2 before sending answer 2.
- Prefer observable turn milestones over hardcoded sleep windows wherever the regression claim depends on turn count.

### 3) Warning — Acceptance-criteria coverage is incomplete for the parent-facing terminal payload
**Conflict:** The spec’s acceptance criteria explicitly call out `finalMessage`, `exitCode`, `state`, `transcriptPath`, and `sessionId` / `sessionKey` where applicable. The plan checks some of these in lower-level tests, but no planned test clearly asserts the full parent-facing payload shape. In particular, `state` is not visibly asserted anywhere in the plan.

**Which is better:** **Spec is better.** It keeps the output contract explicit. The plan currently proves partial behavior but not the full acceptance contract.

**Why this matters:** This change is not just about pane lifetime; it is also about what the parent receives when the child completes. Missing payload assertions can let a contract regression ship unnoticed.

**Recommended fix:**
- Extend the orchestration/API-level tests to assert `state` explicitly.
- Assert `transcriptPath` and `sessionId` / `sessionKey` on the parent-facing result where the spec says they should appear.
- Keep lower-level `summary` assertions, but do not treat them as a substitute for parent-facing payload validation.

### 4) Warning — The spec’s plugin auto-load fallback risk is not turned into an execution decision point
**Conflict:** The spec explicitly says plugin-MCP auto-load via `--plugin-dir` must be empirically verified during implementation, and if it proves unreliable, the implementation should fall back to emitting `--mcp-config`. The plan adds manifests and tests that would reveal failure, but it does not add a contingency task or decision gate if the first Claude smoke test shows the MCP tool was not discovered.

**Which is better:** **Spec is better.** It keeps the cross-version Claude compatibility risk visible. The plan currently assumes the manifest route works and leaves the fallback implicit.

**Why this matters:** If plugin auto-load fails in the first live run, the child hangs because the model never gets `subagent_done`. Without an explicit contingency step, execution can stall or improvise mid-plan.

**Recommended fix:**
- After the first live Claude integration smoke, add a decision checkpoint:
  - if plugin auto-load works, continue as planned;
  - if not, implement the generated `--mcp-config` fallback in `buildClaudeCmdParts` and add coverage for it.

### 5) Suggestion — Task 13.5 / 13.6 over-scope into source-TODO closure
**Conflict:** The spec is about Claude pane completion behavior; it does not require deleting `.pi/todos/fca9feda.md`. The plan adds repo housekeeping outside the feature surface.

**Which is better:** **Spec is better** on scope discipline. The plan’s TODO closure may still be desirable, but it is not part of the feature contract.

**Why this matters:** It introduces an unrelated file mutation into a plan that is otherwise tightly scoped.

**Recommended fix:** Move TODO closure to a separate follow-up step or make it explicitly conditional on local repo convention / user approval.

## Overall assessment
This is a strong plan at the architecture and file-change level, but it under-specifies validation of the exact workflow the design is trying to save. The main correction is to make the orchestration layer—not just `launchSubagent` / `watchSubagent`—a first-class test target.

## Required fixes before execution
1. Add real `subagent_run_serial` / `subagent_run_parallel` coverage for the interactive Claude path.
2. Rework Task 10 and Task 12 to observe assistant turns instead of relying on blind time delays.
3. Add explicit parent-facing payload assertions for `state` and session metadata.
4. Add an explicit plugin auto-load fallback decision point tied to the first live Claude smoke.

If those fixes are made, the plan should be ready to execute.
