# Review: `2026-04-20-pi-interactive-subagent-fork-v2.md`

Reviewed: 2026-04-20
Plan: `.pi/plans/2026-04-20-pi-interactive-subagent-fork-v2.md`
Verdict: **Needs revision before implementation**

## Summary

v2 fixes several real issues from the first review, especially per-tool registration gating, dropping the dead `sentinel-wait.ts` primitive, and removing the unwired orchestration schema fields.

However, two important implementation problems are still baked into the plan:

1. the Claude transcript/result unification path is still inconsistent in the real execution order, and
2. the orchestration path will not actually light up the existing subagent widget for the first launched task.

I would revise those before executing the plan.

## Blocking findings

### 1) `watchSubagent()` cleanup still races with `readTranscript(running)` on the Claude path

The architecture section and Task 15 say the production deps should:

- launch with `launchSubagent()`
- wait with `watchSubagent()`
- then call `readTranscript(running)` to derive a uniform `finalMessage` + `transcriptPath`

That still does not work against the current code shape.

In the current `pi-extension/subagents/index.ts`, the Claude branch of `watchSubagent()`:

- reads the sentinel file
- copies the Claude transcript via `copyClaudeSession(...)`
- deletes `sentinelFile`
- deletes `sentinelFile + ".transcript"`
- returns only summary / exitCode / optional `claudeSessionId`

But Task 14's `readTranscript(running)` implementation for Claude depends on those exact files still existing:

- sentinel file → `finalMessage`
- `sentinelFile + ".transcript"` → source transcript path

So in the real default-deps flow from Task 15, calling `readTranscript(running)` **after** `watchSubagent()` will typically produce:

- `finalMessage: ""`
- `transcriptPath: null`

for Claude tasks, with fallback only to `sub.summary` for the message. That means the plan still does **not** actually deliver the promised uniform Claude `transcriptPath`.

This also means the proposed `transcript-read.test.ts` only verifies an isolated pre-cleanup helper, not the real production order.

**Recommended fix:** choose one owner for Claude result extraction.

Either:

- extend `watchSubagent()` to return `transcriptPath` directly and drop the post-watch Claude read, or
- move transcript extraction ahead of cleanup and have `watchSubagent()` expose the raw pointer/source path needed by orchestration, or
- have `watchSubagent()` return enough Claude metadata for orchestration to reconstruct both `finalMessage` and `transcriptPath` without re-reading deleted files.

As written, Task 15's completion path is still broken for Claude.

### 2) The orchestration path will not start the live subagent widget

The plan says both orchestration modes should feed through the existing widget via the shared `runningSubagents` map.

But in the current implementation, simply inserting entries into `runningSubagents` is not enough. The visible widget loop only starts when `startWidgetRefresh()` is called.

Today that happens in the async tool wrappers:

- `subagent.execute(...)` calls `startWidgetRefresh()` after `launchSubagent(...)`
- `subagent_resume.execute(...)` does the same

Task 15's `makeDefaultDeps()` launches directly through `launchSubagent(...)`, but the plan does **not** export or call `startWidgetRefresh()` (or any equivalent helper) from the orchestration path.

So unless some other subagent already started the refresh interval earlier in the session, the first `subagent_serial` / `subagent_parallel` launch will populate `runningSubagents` but not render the widget.

That contradicts the architecture section's claim that the wrappers feed through the existing widget.

**Recommended fix:** make widget startup an explicit reusable primitive.

Examples:

- export a small `ensureWidgetRefreshRunning()` helper and call it from `makeDefaultDeps.launch(...)`, or
- move widget-start responsibility into `launchSubagent()` itself so every caller gets consistent behavior.

Without that change, the plan's user-visible behavior is incomplete.

## Non-blocking findings

### 3) `{previous}` substitution should not use raw string replacement semantics

Task 10 implements:

```ts
task: raw.task.replace(/\{previous\}/g, previous)
```

In JavaScript, replacement strings interpret `$` sequences (`$$`, `$&`, `$1`, etc.). Since `previous` is arbitrary assistant output, certain contents can be rewritten unexpectedly during substitution.

Safer options:

- `raw.task.replace(/\{previous\}/g, () => previous)`, or
- `raw.task.split("{previous}").join(previous)`

Not a reason to block the whole plan, but worth fixing while the core is still small.

### 4) The README rebrand is still only partial

Task 1 updates `package.json` metadata and adds a fork notice, but the current README also contains upstream-facing branding that the plan does not explicitly clean up, for example:

- title `# pi-interactive-subagents`
- install command pointing at `HazAT/pi-interactive-subagents`
- the `What's Included` count / table copy that will become stale once two new tools are added

Since rebranding is part of the stated goal, I'd tighten the README task so the public docs match the forked package name and repo URL throughout.

### 5) Orchestration tools should probably mirror the bare tool's prerequisite checks

The base `subagent` tool gives clear, user-facing failures for:

- no supported mux backend
- no persistent session file

The new orchestration tool handlers rely on `launchSubagent()` throwing and then stringify the error in a catch block.

That is workable, but it will produce rougher UX and less consistent error messages than the existing tool. If you want parity, add the same preflight checks in the orchestration handlers (or share a common helper).

## Recommended revisions

1. **Fix the Claude completion path for real execution order**
   - Do not rely on `readTranscript(running)` after `watchSubagent()` unless `watchSubagent()` stops deleting the files `readTranscript()` needs.
   - Prefer a single source of truth for Claude transcript extraction.

2. **Make widget startup reusable from orchestration**
   - Export and call an explicit widget-start helper, or move that responsibility into `launchSubagent()`.

3. **Harden `{previous}` substitution**
   - Use a function replacer or split/join so arbitrary assistant output is inserted literally.

4. **Tighten the README rebrand scope**
   - Update title, install command, tool counts, and any fork-facing repo references, not just `package.json` metadata and a fork notice.

## Bottom line

v2 is materially better than v1, but I still would not execute it unchanged.

The remaining blockers are:

- the Claude post-watch transcript path is still not actually recoverable the way Task 15 describes, and
- orchestration does not currently start the widget refresh loop it claims to reuse.

Once those are fixed, the rest of the plan looks much closer to implementation-ready.
