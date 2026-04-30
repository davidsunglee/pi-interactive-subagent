# Plan Review — Orchestration Lifecycle Expansion v10

## Summary verdict

[Issues Found]

v10 is materially stronger than v9. It explicitly fixes all three v9 review findings: the plan now models the spec-required `blocked -> running` resume-start transition, the `sessionPath` boundary tests account for the real `existsSync(...)` gate by creating temp files, and the `subagentsExtension` imports were normalized to the module's actual default-export shape. The plan is also better on backend-real coverage, sync-envelope consistency, and the additive `Backend.watch` / `waitForCompletion` seam design.

I do not think it is execution-ready yet. Two execution-level issues remain in the resume path, and there are two smaller but still real test-plan mismatches that should be cleaned up before implementation starts.

## v9 findings: resolved vs still open

### 1) Missing spec-required `blocked -> running` transition on resume
**Disposition:** Resolved

v10 adds this directly and repeatedly:
- Key decision / invariant section now makes `registry.onResumeStarted(sessionKey)` load-bearing.
- Task 3 adds `onResumeStarted` to the registry API plus tests for the owned-blocked, unowned, and non-blocked cases.
- Task 12 places `registry.onResumeStarted(sessionKey)` in the real `subagent_resume` path immediately after the resumed pane is registered.
- Task 13 wires that transition into widget cleanup so the virtual blocked row is removed at resume start, not only at terminal completion.

That closes the exact lifecycle gap called out in v9.

### 2) `sessionPath` boundary tests could not reach the watcher / registry because of the real `existsSync(sessionPath)` gate
**Disposition:** Resolved

Task 12.2a now explicitly calls out the `existsSync(params.sessionPath)` guard in the real handler and instructs the test to create real temp files for the `sessionPath` cases before invoking `subagent_resume`. That addresses the concrete reachability issue from v9.

Note: there is still a different real-handler gate the plan now misses — the `sessionManager.getSessionId()` / `getSessionDir()` reads discussed in Finding #2 below. That is a new issue, not the original v9 `existsSync(...)` issue.

### 3) Several prescribed snippets imported `subagentsExtension` with the wrong export shape
**Disposition:** Resolved

The v10 snippets consistently use the module's actual export shape (`import subagentsExtension ...` with named `__test__` only where needed), which matches the current codebase (`pi-extension/subagents/index.ts` exports `subagentsExtension` as default and `__test__` as a named export).

## Remaining issues

### 1) Error — The real `subagent_resume` re-ingestion path still collapses cancelled resumes into `failed`
**Implicated plan areas:** Task 12.2, Step 11.5b, self-review invariants covering cancelled resume behavior

**Codebase reality checked:**
`watchSubagent(...)` currently represents cancellation as a terminal result with `exitCode: 1` and `error: "cancelled"` (`pi-extension/subagents/index.ts`, cancellation return in the `signal.aborted` branch).

**Problem:**
The Task 12.2 routing snippet for the real `subagent_resume` handler re-ingests terminal results with:

```ts
state: result.exitCode === 0 && !result.error ? "completed" : "failed"
```

That means a cancelled resumed child will be recorded as `failed`, not `cancelled`.

**Why this matters:**
This is not a cosmetic mismatch. The spec and the plan's own invariants explicitly distinguish `failed` from `cancelled`, and Step 11.5b adds regression coverage for cancelled resume outcomes — but only at the registry level via direct `registry.onResumeTerminal(...)` calls. As written, the real tool path that Task 12 is supposed to wire will never produce `state: "cancelled"`, so the execution path the user actually uses does not satisfy the lifecycle contract the plan claims.

**What to change in the plan:**
Specify how the real `subagent_resume` handler maps a cancelled / aborted watcher result to `state: "cancelled"` rather than `failed`, and add at least one real tool-path test that exercises that mapping instead of covering cancellation only through direct registry calls.

### 2) Error — The new `subagent_resume` boundary tests still will not reach the watcher / registry because their fake tool context omits required `sessionManager` methods
**Implicated plan areas:** Step 12.2a cases 3–6, Step 14.2d

**Codebase reality checked:**
The current `subagent_resume.execute(...)` path reads:
- `ctx.sessionManager.getSessionId()`
- `ctx.sessionManager.getSessionDir()`

before it writes resume artifacts and before it starts the watcher (`pi-extension/subagents/index.ts`, immediately after building the `pi --session ...` parts).

**Problem:**
The proposed boundary-test helper in Step 12.2a is:

```ts
function toolCtx() {
  return { sessionManager: {} as any, cwd: "/tmp" };
}
```

That context is missing both methods the real handler calls before the watcher override is ever consulted. So cases 3–6, and the Claude-branch test in Step 14.2d, still fail earlier than the routing logic they are trying to validate.

**Why this matters:**
This is execution-blocking. v10 correctly fixed the `existsSync(sessionPath)` reachability problem from v9, but the real handler has another pre-watcher dependency that the plan still does not model. As written, the prescribed tests cannot actually exercise the new resume-routing branches.

**What to change in the plan:**
Either:
- provide a realistic `sessionManager` stub in those tests (`getSessionId()`, `getSessionDir()`, and anything else the refactored handler will need), or
- explicitly add a refactor / seam that removes those reads from the boundary-tested path.

Without that, the new coverage remains unreachable.

### 3) Warning — Task 7b's registry seam contract test assumes `__test__.getRegistry()` works before `subagentsExtension(...)` has run
**Implicated plan areas:** Step 7b.1, Step 7b.4

**Problem:**
Step 7b.1's contract test calls `__test__.getRegistry()` immediately after importing the module, with no `subagentsExtension(fakePi)` bootstrap. But Step 7b.4 simultaneously describes `getRegistry()` as exposing "the internal registry singleton constructed in `subagentsExtension`" and says production initialization stays unchanged.

Those two statements do not line up: if registry construction still happens inside `subagentsExtension`, the contract test cannot assume a live registry exists before bootstrapping the extension.

**Why this matters:**
This is a smaller issue than the two resume-path errors above, but it is still a real execution mismatch in a foundational seam task.

**What to change in the plan:**
Either:
- bootstrap `subagentsExtension(...)` in the Step 7b.1 contract test before calling `getRegistry()`, or
- explicitly move registry initialization to module scope and say so.

### 4) Warning — Task 9.5b Part H's abort-regression test aborts the wrong signal for the planned async implementation
**Implicated plan areas:** Step 7.4, Step 9.5b Part H

**Problem:**
Task 7.4 explicitly changes async `wait:false` dispatches to use `registry.getAbortSignal(orchestrationId)` when calling `runSerial` / `runParallel`. But the new Part H regression test launches `wait:false` and then aborts the original tool-call `AbortController` (`ac.abort()`). That is no longer the signal the async background runner is waiting on.

So the test, as written, does not actually validate the post-9.5b abort path it claims to pin.

**Why this matters:**
This is a test-plan mismatch, not a product-architecture gap, so I am not elevating it to an Error. But it is still likely to fail during implementation and send the work down the wrong debugging path.

**What to change in the plan:**
Reframe that case to either:
- exercise `wait:true` / direct runner abort propagation, or
- cancel the async run via `subagent_run_cancel(...)` and assert that the registry-owned signal observed by `waitForCompletion(...)` aborts.

## Regressions introduced in v10

I do **not** see regressions on the three specific v9 findings; those are all addressed.

The remaining problems are new / adjacent:
- the real resume-tool path still lacks a `cancelled` mapping,
- and the revised boundary tests now miss the resume handler's `sessionManager` dependency even though they fixed the earlier `existsSync(...)` dependency.

## Strengths

- v10 directly addresses all three v9 review findings.
- The additive seam design around `Backend.watch(..., signal?, onUpdate?, hooks?)` / `LauncherDeps.waitForCompletion(..., signal?, onUpdate?, hooks?)` is much more credible than the earlier signature rewrite.
- The plan is much sharper about the unified public result envelope, especially the `index` requirement for sync `wait:true` returns.
- The registry / widget story is materially stronger now that `blocked -> running` is modeled explicitly instead of only `blocked -> terminal`.
- Backend-real coverage is strong in both phases, especially the explicit pane/headless async-path tests and the dedicated `caller_ping` fixtures.
- The plan is careful about preserving existing abort and partial-update semantics while extending the backend seam.

## Recommended next steps

1. Fix the real `subagent_resume` terminal-state mapping so cancelled resumed sessions remain `cancelled` end-to-end, not `failed`.
2. Fix the Step 12.2a / 14.2d tool contexts so the boundary tests satisfy the real handler's `sessionManager` requirements before the watcher override is expected to run.
3. Tighten the two smaller seam-test mismatches in Task 7b and Task 9.5b Part H.

[Issues Found]
