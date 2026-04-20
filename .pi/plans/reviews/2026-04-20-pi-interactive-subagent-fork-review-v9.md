# Review: `2026-04-20-pi-interactive-subagent-fork-v9.md`

Reviewed: 2026-04-20
Plan: `.pi/plans/2026-04-20-pi-interactive-subagent-fork-v9.md`
Verdict: **Ready to implement**

## Summary

I don't see a remaining blocking issue in v9.

The main v8 blocker is fixed:

- the top-of-file revision history now matches the corrected Task 18 Claude-plugin/degraded-mode story
- the stale "kill the Claude pane directly via the mux" claim is gone
- the document title now matches the file version

More broadly, the plan now hangs together well across code, tests, and docs:

- the orchestration layer stays cleanly isolated under `pi-extension/orchestration/`
- the `launchSubagent` / `watchSubagent` exports and `transcriptPath` contract are specified consistently
- the self-spawn guard parity for `subagent_serial` / `subagent_parallel` is explicit and tested
- the README language now matches the bundled-plugin model and the pane-sentinel fallback behavior

## Non-blocking notes

### 1) Task 10's expected test count looks off by one

`Task 9`'s `run-serial.test.ts` example contains 8 tests:

1. runs tasks in order
2. substitutes `{previous}`
3. substitutes literally
4. stops on first failure
5. respects explicit names
6. defaults `focus=true`
7. launch throw path
8. wait throw path

But `Task 10 Step 2` says:

> Expected: PASS, 7 tests (5 from v3 + 2 v4 throw-path tests).

That should likely say **8 tests**. Not a design problem, just a bookkeeping nit.

### 2) The release-marker tag naming doesn't quite match the package prerelease string

The plan sets `package.json` to:

- `3.3.0-fork.0`

but `Task 19 Step 4` creates:

- `fork-v3.3.0-rc.1`

That's not wrong, but it mixes two prerelease schemes (`fork.0` vs `rc.1`). If you want the release sweep to read more cleanly, you may want those names to follow the same convention.

## Conclusion

v9 looks implementation-ready. I would proceed with this plan as written, with only the minor cleanup notes above if you want to tighten it further.
