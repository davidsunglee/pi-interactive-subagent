**Reviewer:** anthropic/claude-opus-4-7 via claude

# Code Review — Restore live transparency for headless subagent runs

**Range reviewed:** `604a962..cb2345a` (17 files, +1732 / −111)

## Strengths

- **Plan adherence is high.** All eight functional tasks from the plan land in the diff: shared `format.ts` port, shared `headless-render.ts` component layout, `RunningSubagent.usage` + headless-aware widget rows, headless-lifecycle hooks (`registerHeadlessSubagent` / `updateHeadlessSubagentUsage` / `unregisterHeadlessSubagent`), `renderResult` registration on both orchestration tools, rich `subagent_result`/`orchestration_complete` renderers, registry `mode` plumbing, and slim in-flight summaries.
- **Module boundaries are clean.** `pi-extension/subagents/ui/format.ts` (verbatim port), `headless-render.ts` (component layout), and `subagent-result-renderer.ts` (extracted from `index.ts:2037-2100`) keep the new surface area independently testable. Pulling the renderer body out of `index.ts` reduces the giant file's cognitive load.
- **Backwards compatibility preserved.** The `subagent_result` renderer falls through to the original `Box`-based pane-shape rendering verbatim when `transcript`/`usage` are absent (`subagent-result-renderer.ts:86-128`), and `widget-headless.test.ts` confirms pane rows continue to emit `<entries> msgs (<bytes>)`.
- **Lifecycle plumbing is symmetric.** Headless launches via the bare `subagent` tool (`index.ts:1422-1428`) and via orchestration (`default-deps.ts:49-58, 73-75, 107-111`) both register, push live `usage` partials, and unregister on settle. The orchestration adapter's `try/finally` correctly unregisters on rejection too.
- **Registry `mode` plumbing is minimal and correct.** `OrchestrationCompleteEvent.mode` is populated from `entry.config.mode` inside `tryFinalize` (`registry.ts:167`), and the existing pre-emit `entry.tasks.map(t => ({ ...t }))` clone (line 165) ensures the heavy-field strip on line 185-190 does not race the emitter — emission carries full `transcript`/`usage`.
- **Test coverage is thorough.** Every functional surface gets at least one targeted test; total of 100 passing tests across the 8 added/modified files. Notable: `widget-lifecycle.test.ts` exercises the full `makeDefaultDeps` → headless backend path end-to-end, and `inflight-text-slim.test.ts` proves the `firstLine(finalMessage)` preview is gone for both modes.
- **Typecheck and targeted tests are green.** `npx tsc --noEmit` is clean; `npm run lint` exits 0; the new test suite passes 100/100.

## Issues

### Critical (Must Fix)

None identified.

### Important (Should Fix)

1. **`subagent_result` rich path drops the leading blank-line spacer.**
   - Location: `pi-extension/subagents/ui/subagent-result-renderer.ts:82` returns `component.render(width)`.
   - The legacy/pane path on the same renderer (line 128) returns `["", ...box.render(width)]`, and the `orchestration_complete` renderer (`index.ts:2147`) similarly returns `["", ...component.render(width)]`. Without the leading blank line, the headless rich block butts directly against the prior message, breaking visual parity with the other two surfaces and with the original renderer behavior the plan said should be preserved for non-falling-through cases.
   - Recommendation: prefix the rich return with `""` to match the other surfaces.

2. **Expanded view always renders empty `─── Task ───` / `─── Output ───` dividers when no `task` text is available.**
   - Location: `pi-extension/subagents/ui/headless-render.ts:124-137`.
   - For orchestration callers, `toTaskRows` deliberately leaves `r.task = undefined` (documented gap at `headless-render.ts:182-189`). The expanded block unconditionally appends `Spacer(1)` + `─── Task ───` + `Text(theme.fg("dim", r.task ?? ""))`, producing an empty "Task" section. The Output section is only conditionally non-empty (good), but the empty Task section is rendered regardless.
   - Recommendation: skip the Task divider+content when `r.task` is empty/undefined; always render the Output divider since the section is conditional.

### Minor (Nice to Have)

1. **`aggregateUsage` initializes `contextTokens: 0` but never sums it** (`headless-render.ts:58-77`). Harmless because `formatUsageStats` skips zero values, but the explicit init implies intent that the loop body doesn't follow. Either drop the field from the initializer or leave a comment that summing context tokens across tasks is meaningless (it's a per-task snapshot, not additive).

2. **`extractDisplayItems` is called on every render pass over the full transcript.** Under high-cadence `onUpdate` partials and large transcripts, this rebuilds the full list each call. Not a problem at typical cadence, but worth a comment if any future caller hits perf concerns. Plan's risk section already calls this out as v1-acceptable.

3. **The `find` / `glob` branches both label output as `"find"`** (`format.ts:89-98`). This is a verbatim port from pi-subagent and matches the test's expectation, so it's intentional, but a future reader may be confused that `glob` calls render as `find`. A one-line comment would help.

4. **`run-parallel.ts:226` uses `[${i + 1}]: pending` for unstarted slots.** The task name is known from `tasks[i].name` and could be substituted, giving the user a more useful preview than a numeric placeholder. Minor UX polish.

5. **Type ergonomics in renderer signatures.** Both orchestration `renderResult` callbacks declare `(result: any, { expanded }: { expanded: boolean }, theme: any)` and cast `details` via `result.details as { ... }` (`tool-handlers.ts:131-141, 287-297`). Importing the `ToolDefinition.renderResult` callback type from `@mariozechner/pi-coding-agent` would tighten this. The plan's Self-Review notes `types.d.ts:353` as the authoritative shape.

6. **`subagent-result-renderer.ts:11` reimplements `formatElapsed`** (a near-duplicate of the same helper that already lives in `index.ts`). Tiny duplication, but cheap to consolidate.

## Recommendations

- Address Important #1 (blank-line prefix on the rich `subagent_result`) before merge — it's a visible inconsistency with the two sibling renderers and a one-line fix.
- Address Important #2 (skip empty Task divider) before merge — orchestration expanded-view rendering currently shows an empty section in the common case.
- The Minor items can land as a follow-up; none affect correctness.
- Consider running the headless integration tests (`test/integration/headless-pi-smoke.test.ts`, `test/integration/headless-tool-use.test.ts`) one more time post-fix to validate Task 9 Step 9.4 acceptance.
- The task-prompt context notes that full `npm test` has 14 known pre-existing baseline failures unrelated to this plan; that classification is accepted, but a CHANGELOG/PR-body note documenting the baseline would help future reviewers distinguish a regression from baseline noise.

## Assessment

**Ready to merge: With fixes**

**Reasoning:** The implementation is faithful to a thorough plan, well-modularized, well-tested (100/100 targeted tests pass; typecheck and lint clean), and preserves backwards compatibility for pane-backed callers. The two Important items are visual-parity bugs in the new rich-render path: a missing leading blank line on the headless `subagent_result` and an always-rendered empty `─── Task ───` divider in expanded orchestration views. Both are small, low-risk fixes. Once those land, the change is ready to ship; nothing critical blocks merge from a correctness or architecture standpoint.
