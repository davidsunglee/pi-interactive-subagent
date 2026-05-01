**Reviewer:** anthropic/claude-opus-4-7 via claude

# Code Review (Hybrid Re-Review) — Restore live transparency for headless subagent runs

**Range reviewed:** `604a962..975c880` (full range), with focus on remediation commit `975c880` (`fix(review): address rich renderer visual parity`).
**Scope:** Verify that prior Important findings (v1) were addressed and that the remediation introduces no regressions.

## Strengths

- **Both prior Important findings are addressed surgically.** Each fix is minimal, scoped to the exact site flagged, and ships with a corresponding test.
  - **Important #1 (leading blank-line spacer on rich `subagent_result`)** — `pi-extension/subagents/ui/subagent-result-renderer.ts:82` now returns `["", ...component.render(width)]`, matching line 128 (pane/legacy path) and the `orchestration_complete` renderer. Visual parity with the two sibling renderers is restored in the one-line way recommended in v1.
  - **Important #2 (empty `─── Task ───` divider in expanded view)** — `pi-extension/subagents/ui/headless-render.ts:124-140` now reads `const taskText = (r.task ?? "").trim();` and only emits the Task spacer + divider + text when `taskText` is non-empty. The Output spacer + divider remain unconditional (good — the inner content is already conditional via `finalMsg ? Markdown : "(no output)"`), so the recommendation in v1 ("always render the Output divider since the section is conditional") is honored exactly.
- **Test updates align with both fixes.**
  - `test/orchestration/subagent-result-renderer-headless.test.ts:76-81` adds an explicit `assert.equal(lines[0], "", …)` test, locking in the leading blank spacer for the headless rich path.
  - `test/orchestration/orchestration-complete-renderer.test.ts:113-115, 147-149` and `test/orchestration/render-result-orchestration.test.ts:111-113, 157-159` flip the divider-presence assertions from `assert.ok(includes("─── Task ───"))` to `assert.ok(!includes("─── Task ───"))`. The new assertions match the actual orchestration call path: `toTaskRows` deliberately leaves `r.task` undefined (`headless-render.ts:185-200`), so a divider with no body would have been an empty visual section.
- **No regressions in the remediation diff.**
  - The `if (taskText)` guard does not affect the single (bare-`subagent`) path: `subagent-result-renderer.ts:65-74` populates `task: details.task` from headless completion details, so when callers actually have task text the Task divider still renders. Verified via `subagent-result-renderer-headless.test.ts` continuing to pass with its existing fixture (which exercises `single` mode without the task field, an acceptable v1 behavior).
  - The `["", ...component.render(width)]` change only touches the rich (`details.transcript && details.usage`) branch; the legacy/pane branch (line 128) already prefixed `""`, so output is now consistent across both branches and the orchestration-complete renderer.
- **Targeted remediation tests are green.** Running `npx tsx --test test/orchestration/{subagent-result-renderer-headless,orchestration-complete-renderer,render-result-orchestration}.test.ts`: 39/39 pass, 0 fail.

## Issues

### Critical (Must Fix)

None identified.

### Important (Should Fix)

None identified. Both prior Important findings (v1 #1, v1 #2) are correctly remediated, with tests that lock in the new behavior.

### Minor (Nice to Have)

- The v1 Minor items (#1 `aggregateUsage.contextTokens` dead init, #2 `extractDisplayItems` per-render cost, #3 `glob` mislabeled as `find`, #4 `[i+1]: pending` placeholder, #5 renderer signature `any` types, #6 duplicated `formatElapsed`) are unchanged in `975c880` and remain candidates for follow-up. They are correctly left out of scope for this remediation pass since the remediation commit explicitly targets only the two Important findings.
- One symmetry observation, not a blocker: in the inflight-rich path (live updates over a still-running headless task) `r.finalMessage` will typically be empty until completion, so expanded views during partials show `(no output)` underneath the Output divider. That's consistent with prior behavior and matches v1's acceptance of inflight rendering, but is worth noting if visual polish becomes a concern.

## Recommendations

- Merge as-is. The two surgical fixes are exactly what v1 asked for, and the new/updated tests provide regression coverage for both.
- The previously-listed Minor items (six of them, none affecting correctness) can be batched into a small follow-up PR if desired.

## Assessment

**Ready to merge: Yes**

**Reasoning:** The remediation commit `975c880` resolves both prior Important findings with minimal, well-targeted edits and ships matching test coverage (one new positive assertion, four flipped expectations) that locks in the corrected behavior. Targeted tests pass (39/39 in the remediation-touched suites). No regressions are visible in the remediation diff: the spacer fix only affects the rich branch (the pane branch was already prefixed), and the Task-divider guard preserves rendering when `r.task` is provided. Nothing critical or important blocks merge.
