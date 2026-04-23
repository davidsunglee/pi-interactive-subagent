# Orchestration Lifecycle Expansion Review v3

## Git range reviewed
`b88d10..7845af`

## Spec used
`.pi/specs/2026-04-22-orchestration-lifecycle-expansion-design-v2.md`

## Strengths
- The async registry architecture is generally strong: task lifecycle state is explicit, cancellation is idempotent, and the per-task terminal hooks make the widget cleanup behavior easy to reason about. In particular, `pi-extension/orchestration/registry.ts:155-188` trims heavy payloads after completion, which is a good production-readiness improvement for long-lived parent sessions.
- The serial async/block/resume flow is thoughtfully implemented. `continueSerialFromIndex()` plus `Registry.onResumeTerminal()` preserves the `{previous}` causal chain and correctly keeps downstream steps pending while blocked (`pi-extension/orchestration/tool-handlers.ts:8-58`, `pi-extension/orchestration/registry.ts:303-347`).
- Test coverage is broad for the pi-backed path: async dispatch, cancel, block/resume, resume routing, widget behavior, and registry lifecycle all have focused tests. I also verified the branch with `npm test` and `npm run typecheck` in a detached worktree for `7845af`; both completed successfully.

## Issues

### Critical (Must Fix)
- None.

### Important (Should Fix)
1. **Async parallel runs can incorrectly cancel still-pending siblings after a block when the worker pool is exhausted.**
   - **Where:** `pi-extension/orchestration/run-parallel.ts:125-145`, `pi-extension/orchestration/tool-handlers.ts:287-296`
   - **Why it matters:** In async mode, a blocked task causes the worker to `return` immediately instead of continuing to claim more work. If `maxConcurrency: 1` and task 0 blocks, the only worker exits, `runParallel()` finishes, and the post-run cleanup sweep cancels the remaining pending tasks as “not launched”. That violates the spec’s required behavior for parallel runs (“one task blocks; siblings continue and aggregated completion waits for the resume”). I reproduced this with `subagent_run_parallel({ wait:false, maxConcurrency:1 })`: task 0 became `blocked` and task 1 was incorrectly swept to `cancelled`.
   - **What to change:** Keep blocked slots registry-owned without terminating the worker pool for unclaimed tasks. A worker should continue claiming later indices after reporting a block, or the dispatcher should spawn replacement workers so pending siblings still launch.

2. **Claude-backed `caller_ping` is not implemented end-to-end, so the phase-2 blocked/resume behavior does not work for Claude tasks.**
   - **Where:** `pi-extension/subagents/index.ts:947-999`, `pi-extension/subagents/backends/headless.ts:577-601`, `pi-extension/subagents/backends/headless.ts:679-699`, `pi-extension/subagents/plugin/hooks/on-stop.sh:59-66`
   - **Why it matters:** The spec requires blocked-state surfacing and resume routing for orchestration-owned sessions regardless of backend. That path is incomplete for Claude:
     - the pane watcher’s Claude branch returns a `SubagentResult` without propagating `result.ping` (`index.ts:947-999`),
     - the headless Claude path records `session_id` and terminal result events but has no ping-detection path and no mid-run `onSessionKey` hook (`headless.ts:577-601`, `679-699`), and
     - the Claude stop hook only writes transcript/final-message sentinels, not any structured ping sentinel (`plugin/hooks/on-stop.sh:59-66`).
   - **User impact:** A Claude child inside `subagent_run_serial` / `subagent_run_parallel` cannot reliably enter `blocked` and be resumed back into the owning orchestration as specified.
   - **What to change:** Either add structured Claude ping signaling end-to-end (plugin/watcher/headless hook chain) or explicitly scope the feature down before merge. As written, the code advertises behavior it does not actually provide.

### Minor (Nice to Have)
1. **README result-shape docs still describe `sessionId`, but the public orchestration payload now exposes `sessionKey`.**
   - **Where:** `README.md:76-91`, `pi-extension/orchestration/tool-handlers.ts:400-413`
   - **Why it matters:** The docs now diverge from the actual returned object shape, which makes resume guidance confusing for Claude results and increases the odds of downstream consumer breakage.
   - **What to change:** Update the table to document `sessionKey` (and, if desired, explicitly call out any remaining `sessionId` compatibility behavior).

## Spec Divergences
1. **`subagent_resume` is no longer “unchanged”; it now has a new XOR surface of `sessionPath` vs `sessionId`.**
   - **Where:** `pi-extension/subagents/index.ts:1572-1623`
   - **What differs:** The spec’s API summary says `subagent_resume` is pre-existing/unchanged, but the implementation adds a new `sessionId` parameter and explicit XOR validation.
   - **Should change:** **Spec should change.**
   - **Why:** The new surface is clearer and necessary to make Claude resume addressable without overloading a path-shaped field.

2. **The ownership map was folded into `registry.ts` instead of a separate `ownership-map.ts` module.**
   - **Where:** `pi-extension/orchestration/registry.ts:131-137`, `211-235`, `303-347`
   - **What differs:** The spec’s code-placement section calls for a distinct `ownership-map.ts`; the implementation embeds that responsibility inside the registry.
   - **Should change:** **Spec should change.**
   - **Why:** This is an internal organization choice, not a product behavior difference. The merged implementation is still coherent.

3. **Sync orchestration results no longer preserve Claude `sessionId` as a public field; they are normalized to `sessionKey`.**
   - **Where:** `pi-extension/orchestration/tool-handlers.ts:400-413`
   - **What differs:** The spec’s backward-compat section says sync result changes are additive only, but `toPublicResults()` drops the old `sessionId` field from the returned payload.
   - **Should change:** **Code should change** (or the spec must explicitly bless the break).
   - **Why:** Carrying both `sessionId` and `sessionKey` would preserve the additive-compat promise while still enabling the new lifecycle model.

4. **Phase-2 Claude blocked/resume behavior described by the spec is not actually implemented.**
   - **Where:** `pi-extension/subagents/index.ts:947-999`, `pi-extension/subagents/backends/headless.ts:577-601`, `679-699`, `pi-extension/subagents/plugin/hooks/on-stop.sh:59-66`
   - **What differs:** The spec describes blocked-state surfacing and resume routing for orchestration-owned sessions, but the Claude path lacks the signaling necessary to emit `blocked` and re-ingest resumed outcomes reliably.
   - **Should change:** **Code should change.**
   - **Why:** This is a core functional requirement of phase 2, not an implementation-detail preference.

## Recommendations
- Fix the parallel blocked-worker scheduling bug before merge; it is easy to hit with `maxConcurrency: 1` and will produce incorrect cancellations in a valid configuration.
- Decide whether Claude blocked/resume is truly in scope for this release. If yes, finish the plugin/watcher/headless plumbing; if no, narrow the spec/README/tool guidance so users are not promised unsupported behavior.
- Once the payload shape is finalized, align the docs and consider whether sync results should carry both `sessionId` and `sessionKey` for a transition period.

## Assessment
- **Ready to merge:** With fixes
- **Reasoning:** The core async registry and pi-backed orchestration flow look solid, and the branch passes the available automated verification I ran (`npm test`, `npm run typecheck`). But there are still two notable correctness gaps: parallel async runs can cancel pending siblings after a block in valid configurations, and the Claude blocked/resume path required by the spec is not complete. Those should be addressed before calling this production-ready.
