# Review: `2026-04-20-pi-interactive-subagent-fork-v8.md`

Reviewed: 2026-04-20
Plan: `.pi/plans/2026-04-20-pi-interactive-subagent-fork-v8.md`
Verdict: **Needs one more revision before implementation**

## Summary

v8 fixes the real v7 blocker well:

- the README now matches the actual bundled-plugin model (`--plugin-dir`, no manual install)
- the degraded-without-plugin path is now described correctly in Task 18 Step 3
- the `default-deps.test.ts` rationale is narrowed honestly

So the task bodies are in much better shape.

I do still see one remaining blocker: the **top-of-file revision history now contradicts the corrected v8 behavior** in two places. That matters because the revision notes are the first thing an implementer/reviewer will read, and right now they reintroduce the exact Claude-path confusion v8 just fixed later in the plan.

## Blocking finding

### 1) The carried-forward/revision notes at the top are stale and now contradict both Task 18 and the code

The main task body now correctly says:

- the bundled Claude plugin is auto-loaded via `--plugin-dir`
- if that plugin directory is missing, completion is still observed via the pane sentinel (`__SUBAGENT_DONE_<code>__`)
- what degrades is transcript capture / `claudeSessionId` / structured summary quality

That matches the codebase:

- `launchSubagent()` appends `; echo '__SUBAGENT_DONE_'$?'__'` to the Claude command
- `pollForExit()` scans the pane screen for `__SUBAGENT_DONE_(\d+)__`

But the **top notes** still preserve two older claims that are no longer true.

#### a) The “Carried from v4” note still says missing plugin means the wait hangs until external cancel/timeout

This bullet is still present near the top:

> The "times out after ~30s" sentence on missing Claude plugin is rewritten to describe the actually-implemented behavior (the sentinel wait hangs until the external timeout/cancel path fires — no dedicated 30s guard exists in this plan).

That is now incompatible with the corrected v8 Task 18 Step 3 text and with the actual code path.

Without the plugin, the Stop-hook sentinel is missing, but the pane sentinel fallback still exists. So the dominant degraded behavior is **loss of transcript/archive metadata**, not “automatic hang until cancellation”.

#### b) The v7 revision note still names “kill the Claude pane directly via the mux” as a recovery path

Another top note says the rewritten sentence now describes these recovery paths:

- end the pi session / restart
- kill the Claude pane directly via the mux

The second part is not actually reliable in the current code.

Why:

- `watchSubagent()` calls `pollForExit(...)`
- when `readScreenAsync(surface, ...)` fails, `pollForExit()` catches that and only checks for a `<sessionFile>.exit` sidecar
- Claude runs do **not** produce that `.exit` file path

So if you kill the Claude pane directly and there is no Stop-hook sentinel / no `__SUBAGENT_DONE_...__` visible anymore, the watcher does **not** have a clean completion path from that action alone. The one clearly supported abort path today remains `session_shutdown`.

That means the top note is not just stale wording — it suggests a recovery lever the implementation does not actually guarantee.

## Recommended fix

Update the top revision-history section so it matches the corrected task body and current code:

- replace the old “missing plugin hangs until cancel/timeout” wording with the new degraded-mode story from Task 18 Step 3
- remove “kill the Claude pane directly via the mux” as a claimed recovery path unless the implementation is also changed to make that true
- more generally: when a later revision supersedes earlier Claude-plugin notes, either rewrite those carried-forward bullets or drop them, rather than preserving now-false historical summaries

Once the top notes stop contradicting the body, this plan looks much closer to implementation-ready.

## Non-blocking note

### 2) The document title still says `(v7)`

The file is `...-v8.md`, but the first heading is still:

```md
# pi-interactive-subagent Fork Implementation Plan (v7)
```

That should be updated to `v8` to avoid confusion when cross-referencing reviews.
