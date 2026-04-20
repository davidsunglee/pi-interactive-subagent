# Review: `2026-04-20-pi-interactive-subagent-fork-v7.md`

Reviewed: 2026-04-20
Plan: `.pi/plans/2026-04-20-pi-interactive-subagent-fork-v7.md`
Verdict: **Needs one more revision before implementation**

## Summary

v7 fixes the concrete v6 gaps:

- orchestration task schema now regains parity with the already-supported `subagent` inputs
- the fake widget-cancel wording is gone
- the `cli` / `thinking` validation stance is now explicit instead of implied

So the plan is closer.

I do still see one remaining blocker: the new Claude-plugin README section does not match the current implementation path. In two separate ways, it describes behavior the code does not actually have.

## Blocking finding

### 1) Task 18's Claude-plugin story is still inconsistent with the codebase

The new README section in **Task 18 Step 3** says two things:

1. users must manually install the Claude plugin once (`claude plugin install ...` / `~/.claude/plugins/...`), and
2. without that install, Claude completion hangs indefinitely because no sentinel is ever written

Both parts conflict with the current implementation.

#### a) The code already auto-loads the repo-local plugin via `--plugin-dir`

Today, the Claude launch path in `pi-extension/subagents/index.ts` already does this:

- computes `pluginDir = join(..., "plugin")`
- checks `existsSync(pluginDir)`
- appends `--plugin-dir <that path>` to the `claude` command

That means the runtime model is currently **"plugin shipped in the repo and passed directly to Claude"**, not **"user must install the plugin globally first"**.

v7 keeps that behavior in Task 6 as well: `buildClaudeCmdParts(...)` still receives `pluginDir` and appends `--plugin-dir` when present.

So the planned README would tell users to perform a manual installation step that the code path is not actually relying on.

#### b) Missing plugin does **not** imply an infinite wait in the current watcher logic

Even if the Stop-hook file sentinel is absent, `pollForExit(...)` in `pi-extension/subagents/cmux.ts` still has a fallback completion path:

- it reads the terminal screen
- it looks for `__SUBAGENT_DONE_(\d+)__`

And the Claude command built in `launchSubagent()` ends with:

```sh
; echo '__SUBAGENT_DONE_'$?'__'
```

So normal Claude process exit is still observable from the pane output even without the plugin.

What the plugin adds is the **clean summary + transcript pointer/archive path** (`PI_CLAUDE_SENTINEL` and `.transcript`), not the only completion signal.

That means the README/deferred-work text in v7 is currently overstating the failure mode. Without the plugin, the likely degradation is:

- no archived Claude transcript / no `claudeSessionId`
- `transcriptPath` ends up `null`
- summary falls back to screen scraping instead of Stop-hook output

—not an automatic infinite wait that requires killing panes and ending the whole pi session.

## Recommended fix

Pick one model and make the plan/docs match it:

### Option A: bundled plugin, auto-loaded at runtime

This is what the code already looks like today.

If that's the intended model, then:

- remove the "install manually once" language from Task 18
- describe the plugin as **bundled in the repo and passed via `--plugin-dir`**
- rewrite the failure-mode docs to say the Stop hook is needed for transcript capture / cleaner completion metadata, not basic completion detection
- update Deferred work accordingly

### Option B: manual plugin installation is truly required

If that is the intended UX instead, then the implementation plan should say so explicitly and change the code to match, e.g.:

- stop passing the repo-local `--plugin-dir`
- add a real installation-health check / dedicated error path
- only then document manual install as required

Given the current code, **Option A** looks like the correct revision.

## Non-blocking note

### 2) Task 13's new `default-deps.test.ts` rationale overstates what it proves

The proposed test uses the "unknown handle" branch in `makeDefaultDeps.waitForCompletion()` and says that exercises the same mapping path guarding `watchSubagent`'s `transcriptPath: null` contract.

It does verify that `waitForCompletion()` can return `null` instead of `undefined`, which is useful.

But it does **not** actually exercise the real `watchSubagent(...) -> OrchestrationResult` mapping path that Task 7 is changing.

I would either:

- keep the test but narrow its explanation, or
- add a small stubbed `watchSubagent` test later if you want the real mapping contract covered

## Bottom line

v7 fixed the earlier structural issues, but the new Claude-plugin docs are still not implementation-true.

I would revise Task 18 (and the matching Deferred-work language) so the plugin installation model and the missing-plugin behavior match what the code actually does today, then this plan should be in much better shape.