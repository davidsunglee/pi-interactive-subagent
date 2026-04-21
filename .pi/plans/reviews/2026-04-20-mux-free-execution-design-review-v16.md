# Plan review: `2026-04-20-mux-free-execution-design-v11.md`

## Verdict

[Issues Found]

## What is strong

- The plan now clearly covers the spec’s three no-mux entrypoints: `subagent`, `subagent_serial`, and `subagent_parallel`.
- The shared launch-resolution work is materially stronger than the original spec and should reduce pane/headless drift.
- The Claude-side design is much tighter than earlier revisions: shared tool mapping, `--tools`, identity/task-body separation, transcript discovery by session id, and explicit Claude-skills handling are all good improvements.
- The testing story is broad and generally well sequenced, especially around transcript archival, resume, tool-use parsing, and no-mux entrypoint reachability.

## Findings

### Error — Task 7b’s bare `subagent` headless branch drops the existing shutdown/reload lifecycle tracking

**Plan locations:**
- Task 7b Step 4b
- Phase 1 intro / architecture text describing the bare `subagent` rewrite
- Task 23b (headline no-mux tests)

**Problem:** The proposed bare `subagent` headless path launches a fresh `makeHeadlessBackend(ctx)`, creates a local `watcherAbort`, and fire-and-forgets `backend.watch(...)`, but the plan never registers that background run with the existing subagent lifecycle machinery.

In the current codebase, background subagents are tracked in the module-level `runningSubagents` map and are aborted on `session_shutdown` (and `/reload` cleanup) via each entry’s `abortController`. Task 7b Step 4b explicitly omits widget integration for headless mode, but it also omits any replacement registration/cleanup path.

**Why this matters:** In no-mux mode, a bare `subagent` started from the real tool callback can outlive the parent session with no planned abort path. That is not just a cosmetic difference from pane mode — it risks leaking child processes/watchers and producing late steer messages after the session has already shut down.

**Concrete fix direction:** Extend the Task 7b design so headless bare-subagent launches are tracked in the same lifecycle registry as pane launches, or add an equivalent headless-only registry that `session_shutdown` / reload cleanup aborts. Task 23b should then assert the shutdown behavior, not just successful completion.

### Warning — Task 26’s `onUpdate` design is structurally racy against the earlier launch model

**Plan locations:**
- Task 11 / Task 19 (`makeHeadlessBackend.launch()` starts the process and promise immediately)
- Task 26 Steps 2–4

**Problem:** The headless process is started in `launch()`, but Task 26 only injects `onUpdate` later from `watch()` / `waitForCompletion()`. The proposed accessor-based wiring (`setOnUpdate`, `() => onUpdate`) does not buffer or replay early partials.

That means any stream events emitted between `deps.launch(...)` and `deps.waitForCompletion(..., onUpdate)` are dropped. For fast tasks, that can mean zero live updates even though the plan and spec describe per-event `onUpdate` streaming as a headless-path win.

**Why this matters:** This is not just a missing test. It is a sequencing flaw in the proposed design: `onUpdate` is attached after the child may already have produced output.

**Concrete fix direction:** Either:
1. move `onUpdate` attachment to launch time, or
2. buffer partial snapshots inside the headless launch entry and replay the latest buffered state when `watch()` attaches.

Also add at least one focused test that proves a partial emitted before `waitForCompletion()` registration is still observable.

### Warning — Two compatibility/audit “gates” are host-dependent enough to silently skip the check they are supposed to enforce

**Plan locations:**
- Task 17 Step 6
- Task 25 Step 4

**Problem:** Both steps point at external `pi-config/...` trees and explicitly accept `|| echo "pi-config not on this host"` as an expected outcome. In practice, that means these checks can pass without validating anything about tool-restriction fallout or caller compatibility.

**Why this matters:** The surrounding prose treats these as invariants/gates (“verify via grep”, “sweep callers”), but on a host without that external tree they degrade to no-op status. That weakens the confidence the plan claims around backward compatibility.

**Concrete fix direction:** Either convert these into clearly-labeled manual audits outside the phase gates, or replace them with repo-local/checked-in fixtures so the checks always validate something when the plan is executed.

## Simplification opportunities

### 1. Fold Task 12b into the first headless integration-test task or the harness section

`copyTestAgents(dir)` is useful, but as a standalone task it adds ceremony out of proportion to its size. It would read more cleanly as a short harness subsection under the first headless integration task.

### 2. Move repeated review-history/rationale blocks out of the main task flow

Tasks 17, 19, and 26 still carry a lot of long-form historical/review context inline. The rationale is valuable, but it now materially lengthens the execution path. A shorter task statement plus a brief note or appendix reference would preserve intent while making implementation easier to scan.

### 3. Consolidate the host-dependent audit commands into one final manual checklist

The `pi-config not on this host` checks are better presented together as a final operator checklist than as scattered pseudo-gates inside implementation tasks. That would shorten the plan and make the automated vs. manual boundaries clearer.

## Overall assessment

This is a strong revision and materially better than the original spec in several areas. The remaining problems are narrower and fixable, but at least one is structural: the bare `subagent` headless path still needs a real shutdown/reload lifecycle story, and the `onUpdate` wiring needs a non-racy attachment model if it is meant to satisfy the spec’s streaming-progress goal.
