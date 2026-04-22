# Plan Review — Orchestration Lifecycle Expansion v9

## Summary verdict

[Issues Found]

v9 is a strong revision. It clearly addresses the three v8 review points: the `Backend.watch` / `waitForCompletion` seam is now additive instead of replacement-shaped, the resume boundary tests gain a mux-availability seam, and the Claude `sessionId` resume branch now has a much more concrete implementation recipe plus dedicated coverage. The plan is also materially better on backend-real coverage, sync-envelope consistency, and explicit self-review invariants.

I do not think it is execution-ready yet, though. Two execution-relevant problems remain: the plan still never models the spec-required `blocked -> running` transition when a blocked task is actually resumed, and the new `sessionPath` resume-boundary tests in Task 12.2a still cannot reach the watcher/registry path because the real handler's session-file existence gate fires first. There is also one smaller compile-time issue in several prescribed test snippets.

## Review v8 findings and disposition

### 1) `waitForCompletion` / `Backend.watch` seam dropped abort + partial-update behavior
**Disposition:** Resolved

v9 explicitly preserves both existing positional arguments and adds the new hook as a 4th positional parameter only:
- Task 9.5b Part A keeps `Backend.watch(handle, signal?, onUpdate?, hooks?)`
- Task 9.5b Part D keeps `LauncherDeps.waitForCompletion(handle, signal?, onUpdate?, hooks?)`
- Task 9.5b Part H adds regression tests that pin both abort propagation and `onUpdate` behavior on the post-change signature

That addresses the exact structural problem v8 had.

### 2) `subagent_resume` boundary tests were unreachable on no-mux hosts
**Disposition:** Resolved

Task 7b adds `__test__.setMuxAvailableOverride(...)`, and Task 12.2 moves the XOR validation ahead of the mux gate. That makes the no-mux tool-boundary cases executable in the way v8 was missing.

### 3) Claude `sessionId` resume path needed a more concrete implementation recipe
**Disposition:** Resolved

Task 12.2 now spells out the Claude branch in operational detail: sentinel allocation, plugin-dir reuse, `buildClaudeCmdParts({ resumeSessionId })`, Claude-shaped `RunningSubagent` construction, and dedicated non-seamed branch coverage in Step 14.2d. That is materially more concrete than v8.

## Current findings

### 1) Error — The plan still never implements the spec-required `blocked -> running` transition when a task is resumed
**Implicated plan areas:** Task 11.2, Task 12.2, Task 13.4, Task 14.3

**Spec requirement:**
The spec's lifecycle model explicitly includes `blocked -> running` on resume, and its usage/transcript semantics are written in terms of that transition.

**Problem:**
The plan defines `running -> blocked` (`registry.onTaskBlocked`) and then only routes resumed work into either:
- `registry.onResumeTerminal(...)` for terminal completion, or
- `registry.onTaskBlocked(...)` again for recursive re-pings.

There is no task in v9 that marks the owning orchestration slot `running` when `subagent_resume` actually starts, and there is no widget task that clears or converts the virtual blocked row at resume-start time. Task 13.4 explicitly clears virtual blocked rows only on per-task **terminal** transitions, not when a blocked task is resumed.

**Why this matters:**
This is not just vocabulary drift. It leaves the plan short of the spec's lifecycle contract and creates a concrete user-visible mismatch during resumed work:
- the orchestration snapshot remains `blocked` while the resumed child is actively running,
- the blocked widget row can remain visible while the resumed pane is open,
- and the model never has an internal/stateful representation of the spec's `blocked -> running` leg.

The current codebase makes that widget risk concrete: `pi-extension/subagents/index.ts` already registers resumed sessions as real `RunningSubagent` rows, so under the plan as written a resumed task can have a live pane row while its old virtual blocked row is still present until terminal completion.

**What to change in the plan:**
Add an explicit resume-start transition in the registry/tool path (for example, `onResumeStarted(sessionKey)` or equivalent), update the ownership slot back to `state: "running"`, and define widget cleanup/transition behavior at resume start rather than only at terminal time.

### 2) Error — Task 12.2a's `sessionPath` boundary tests still cannot reach the watcher/registry path because the real resume handler rejects nonexistent session files first
**Implicated plan areas:** Task 12.2, Task 12.2a cases 3 and 6

**Codebase reality checked:**
`pi-extension/subagents/index.ts` currently does:
- XOR/mux logic aside,
- `if (!existsSync(params.sessionPath)) return { error: "session not found" }`

before it creates the pane or invokes `watchSubagent(...)`.

**Problem:**
Task 12.2a says the boundary test should exercise the real registered `subagent_resume` tool with watcher overrides and registry assertions, but its `sessionPath` cases seed ownership with strings like `/tmp/owned.jsonl` and `/tmp/stray.jsonl` without creating those files and without adding any seam to bypass the existence check.

That means cases 3 and 6 never reach:
- the watcher override,
- the registry routing block,
- or the asserted `orchestration_complete` / standalone-fallthrough behavior.

They fail earlier with the existing `session not found` guard.

**Why this matters:**
This is still an execution-blocking test-plan defect. v9 fixed the no-mux reachability problem from v8, but the `sessionPath` branch now has a different real gate that the plan does not account for.

**What to change in the plan:**
Either:
- create real temp session files in the `sessionPath` boundary cases, or
- add an explicit test seam for the existence check,
- or restate those cases as higher-level registry tests instead of real tool-boundary tests.

### 3) Warning — Several prescribed test snippets import `subagentsExtension` with the wrong export shape
**Implicated plan areas:** Task 12.2a, Task 14.2, Step 14.2d

**Codebase reality checked:**
`pi-extension/subagents/index.ts` exports `subagentsExtension` as the module's **default** export (`export default function subagentsExtension(...)`), not as a named export.

**Problem:**
Multiple new-file snippets use named-import forms such as:
- `import { subagentsExtension, __test__ } from "../../pi-extension/subagents/index.ts"`
- `import { subagentsExtension } from "../../pi-extension/subagents/index.ts"`

Those snippets will not typecheck as written.

**Why this matters:**
This is easy to fix, so I am not elevating it to an Error, but these tasks are meant to be directly executable. As written, they introduce avoidable compile failures in several new tests.

**What to change in the plan:**
Normalize those snippets to the actual export shape, e.g. `import subagentsExtension, { __test__ } from ...`.

## Strengths

- v9 directly resolves all three v8 review findings.
- The new additive seam design in Task 9 is much stronger and more realistic than the v8 signature rewrite.
- The plan's self-review invariants are substantially sharper, especially around sync-envelope parity, resume XOR validation, and serial-failure continuation gating.
- Backend-real coverage is now much more convincing in both phases.
- The Claude `sessionId` path is no longer hand-wavy; it now has a concrete launch/watch recipe and dedicated coverage.

## Recommended next steps

1. Add an explicit resume-start lifecycle/state task so resumed orchestration slots really transition `blocked -> running`, and update widget behavior accordingly.
2. Fix Task 12.2a's `sessionPath` test setup so the real handler can get past its `existsSync(sessionPath)` gate.
3. Clean up the incorrect `subagentsExtension` import snippets before execution starts.

[Issues Found]
