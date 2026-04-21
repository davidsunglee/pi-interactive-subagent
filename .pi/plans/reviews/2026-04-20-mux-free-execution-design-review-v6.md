# Review: `2026-04-20-mux-free-execution-design-v4.md`

Reviewed: 2026-04-21  
Plan: `.pi/plans/2026-04-20-mux-free-execution-design-v4.md`  
Verdict: **Strong revision, but three execution blockers remain**  
Ready to merge: **No**

## Summary

v4 is materially better than the earlier drafts.

The big architectural moves are now pointed at the right seams:

- the plan keeps the launch-contract extraction above the transport seam instead of re-implementing launch semantics inside the new backend (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:11-17,1317-1562`), which matches where the current complexity actually lives in `launchSubagent()` (`pi-extension/subagents/index.ts:697-965`)
- the no-mux orchestration fix is finally aimed at the real production path — the registered tool callbacks and their preflight/deps flow (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:15,804-1017,3726-3931`; `pi-extension/orchestration/tool-handlers.ts:27-105`; `pi-extension/subagents/index.ts:1794-1799`)
- Phase 0 now acknowledges and fixes the existing first-party typecheck failures before treating `npm run typecheck` as a gate (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:64-206`), which was the right remediation to the previous review blocker

So the overall direction looks right.

I still found **three blockers** that keep this from being implementation-ready as written:

1. the pane-Claude `--allowedTools` patch still misses the required `--` task separator after a variadic option
2. the proposed headless Claude transcript-archive path is reconstructed incorrectly and will not match the current on-disk Claude project layout
3. the new backend interface is still typed in terms of `OrchestrationTask`, but several planned headless tests intentionally launch without an `agent`, so the plan does not typecheck as written

## Assessment

**Ready to merge: No**

If those three items are corrected, I would be comfortable with this as the implementation plan.

## Strengths

- **The backend seam is now in the right place.** Extracting a shared `resolveLaunchSpec()` before backend dispatch (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:11-17,1317-1562`) is the correct response to the current `launchSubagent()` shape, where launch normalization and pane transport are still intertwined (`pi-extension/subagents/index.ts:697-965`).
- **The no-mux orchestration coverage is finally end-to-end.** Task 23b no longer settles for unit-level backend invocation; it exercises the real `subagent_serial` / `subagent_parallel` registrations (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:3726-3931`), which is what matters given the current tool-handler preflight/deps flow (`pi-extension/orchestration/tool-handlers.ts:46-53,90-97`).
- **Phase 0 is much more honest now.** v4 no longer pretends the repo already has a clean TS baseline; it explicitly cleans the pre-existing `pi-extension/subagents/index.ts` failures before using `npm run typecheck` as a gate (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:70-206`).
- **The plan is better about host determinism.** Clearing `ZELLIJ_SESSION_NAME` and filling out the fake extension API were both the right fixes for the prior test fragility (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:7,804-1017,3726-3931`; `pi-extension/subagents/cmux.ts:37-45`; `pi-extension/subagents/index.ts:1125-1779`).

## Blocking findings

### 1) The pane-Claude `--allowedTools` patch is still incomplete because it does not add the required `--` separator before the task

**Severity: Major**

The plan’s Task 17 patches `buildClaudeCmdParts()` to emit `--allowedTools`, but the proposed change still leaves the task appended as a bare final positional (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:2671-2733`). That matches the current helper shape in `pi-extension/subagents/index.ts:656-688`, which also appends the task directly.

That is a real correctness hole on Claude. In the upstream `pi-subagent` implementation, there is an explicit regression test documenting why the separator is required: Claude declares `--allowedTools` as a variadic option, so without `--`, the prompt can be consumed as another tool name instead of the task (`../pi-subagent/test/claude-args.test.ts:302-316`).

#### Why this blocks

Task 17 is presented as the security/correctness fix for Claude tool restriction in both backends (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:17,2616-2755`). As written, the pane-side patch can still break Claude launches exactly when `tools:` frontmatter is present — the precise path this task is supposed to harden.

So the plan would “fix” the restriction regression while still leaving tool-restricted Claude runs vulnerable to malformed argv construction.

#### Recommended fix

Amend Task 17 so `buildClaudeCmdParts()` ports the same separator rule already captured upstream:

- after all options are emitted, append `"--"` before the task text
- add a regression test equivalent to `../pi-subagent/test/claude-args.test.ts:302-316`
- keep that test in the same named Task 17 commit, since it is part of the portability/correctness patch

### 2) The proposed headless Claude transcript archival logic reconstructs the source path incorrectly and is too brittle to rely on

**Severity: Major**

Task 19 proposes to archive Claude transcripts by synthesizing a source directory as `~/.claude/projects/-${cwdSlug}-/` (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:3241-3250`). That differs from the current production Claude path in this fork, which deliberately avoids guessing and instead consumes the exact transcript pointer written by the bundled plugin stop hook (`pi-extension/subagents/index.ts:977-987`; `README.md:208-216`).

There are two problems here:

1. the specific formula shown in the plan is wrong for the current on-disk Claude layout — it adds a trailing hyphen that does not exist in real project directories
2. even without that typo, reconstructing the path from `cwd` is materially more brittle than using an exact pointer or a session-id-based discovery pass

On this machine, the actual Claude project directories under `~/.claude/projects/` are shaped like `-Users-david-Code-pi-config/…`, not `-Users-david-Code-pi-config-/…`, so the Task 19 implementation would never find the source jsonl for that cwd.

#### Why this blocks

The headless Claude path is supposed to populate `transcriptPath` and power the archival/resume-related tests in Tasks 20, 22, and 22b (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:3289-3369,3468-3543,3544-3636`). With the source path synthesized incorrectly, those tests either fail outright or only go green when skipped.

This is especially important because the current fork’s pane-Claude path already uses a safer mechanism: the plugin writes the exact transcript path, and `watchSubagent()` copies from that pointer (`pi-extension/subagents/index.ts:977-987`). The new headless path should not regress to a brittle heuristic without much stronger proof.

#### Recommended fix

Revise Task 19’s archival step so it does **not** depend on `join(homedir(), ".claude", "projects", `-${cwdSlug}-`)`.

Safer options:

- discover by `sessionId` under `~/.claude/projects/*/${sessionId}.jsonl` instead of guessing the project-dir slug
- or, if Claude exposes a transcript/session path in stream-json metadata, capture that directly
- add a focused test for the discovery helper itself so the plan asserts the real path shape instead of hardcoding an unverified convention

### 3) The new backend interface is still typed as `OrchestrationTask`, but multiple planned headless launches intentionally omit `agent`, so the plan will not typecheck as written

**Severity: Major**

Task 4 defines `Backend.launch()` in terms of `OrchestrationTask` (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:492-531`). In the current repo, `OrchestrationTaskSchema` still requires `agent: string` (`pi-extension/orchestration/types.ts:4-27`).

But several later tasks intentionally exercise the backend directly **without** an agent:

- Task 20 headless Claude smoke uses `{ task: "Reply with exactly: OK", cli: "claude" }` (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:3331-3345`)
- Task 21 headless tool-use uses `{ task: ..., cli: "claude", tools: "read" }` (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:3427-3444`)
- Task 23 abort integration uses direct fields with no agent (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:3679-3698`)

Those examples are architecturally reasonable — `resolveLaunchSpec()` and the bare `subagent` tool already support launches without an agent — but they do not line up with the type the plan says the backend should accept.

#### Why this blocks

The plan repeatedly treats `npm run typecheck` as a hard gate. With the current `OrchestrationTask` shape, the direct-backend tests above do not satisfy the proposed API contract, so the plan is not self-consistent enough to execute cleanly.

This is not just a comment/docs mismatch; it affects the actual backend interface introduced in Phase 1.

#### Recommended fix

Pick one model and make the plan consistent:

1. **Preferred:** define a dedicated backend launch type that mirrors the full `SubagentParams` surface (`agent` optional), and use that for `Backend.launch()` / `makeHeadlessBackend()` direct tests
2. **Alternative:** make `agent` optional in `OrchestrationTaskSchema` too — but only if that change is truly acceptable for the public orchestration tools, which would be a larger API shift

I would prefer a separate backend launch type so orchestration-tool validation can stay as-is unless you explicitly want to widen it.

## Non-blocking note

### 1) Be careful not to ship the Phase 1 preflight change as a standalone release increment

Phase 1 intentionally makes no-mux orchestration preflight backend-aware before the real headless implementation lands (`.pi/plans/2026-04-20-mux-free-execution-design-v4.md:479-484,804-1212`). On a long-lived branch that is fine, but if Tasks 7b/8 were released independently, no-mux users would stop getting the current clear mux error and start falling into the Phase 1 “headless backend not implemented yet” stub instead.

That is a sequencing concern, not a design blocker. I’d just call it out explicitly in the plan: do not merge/release the preflight unblocking without the real Phase 2 backend behind it.

## Conclusion

v4 is close. The baseline cleanup, shared launch-spec extraction, and real orchestration-entrypoint testing are all good improvements.

What still keeps it from being implementation-ready are three concrete holes:

- the pane-Claude `--allowedTools` patch still needs the `--` separator regression fix
- the headless Claude transcript archival path should not be guessed with the current incorrect slug formula
- the new backend interface needs to stop pretending every direct backend launch has an `agent`

Address those, and I think this plan is ready to execute.