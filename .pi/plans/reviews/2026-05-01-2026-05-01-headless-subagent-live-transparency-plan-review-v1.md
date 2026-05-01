**Reviewer:** openai-codex/gpt-5.5 via pi

### Status

**[Approved]**

### Issues

**[Warning] — Task 2: `TaskRow`/`RichMode` export instructions conflict with acceptance criteria**
- **What:** Step 2.1 says to declare `interface TaskRow` and `type RichMode` locally, while the acceptance criterion requires `headless-render.ts` to export `renderRichSubagentResult`, `TaskRow`, `RichMode`, and `toTaskRows` and verifies with a grep for `^export (function|type|interface) ...`.
- **Why it matters:** An implementer following the step literally could create non-exported types and then fail the task's own verify recipe even though the implementation otherwise works.
- **Recommendation:** Make the Task 2 step language match the acceptance criterion by explicitly requiring `export interface TaskRow` and `export type RichMode`.

**[Warning] — Task 2: Collapsed text-item rendering instructions are internally contradictory**
- **What:** Step 2.4 first says, "For text items, collapsed shows first 3 lines; expanded shows full text," but later in the same bullet says, "Skip text items entirely in collapsed view (matches pi-subagent's collapsed path)."
- **Why it matters:** This gives two different collapsed-rendering behaviors for the same content, which could lead different workers to implement different UI output and cause tests or manual parity checks to disagree.
- **Recommendation:** Choose one collapsed behavior in Task 2.4. Based on the spec's collapsed-view requirement and the parenthetical parity note, the plan should state only the intended tool-call-only collapsed behavior if that is the target.

**[Suggestion] — Tasks 1 and 2: `extractDisplayItems` export location is inconsistent between the file structure and task body**
- **What:** The File Structure section says `pi-extension/subagents/ui/headless-render.ts` also exports `extractDisplayItems`, while Task 1 Step 1.4 and Task 1 acceptance criteria require `extractDisplayItems` to be exported from `pi-extension/subagents/ui/format.ts`. Task 2 then uses `extractDisplayItems` without explicitly saying it imports it from `format.ts`.
- **Why it matters:** This is unlikely to block implementation, but it may cause churn over which module owns the helper or whether it should be re-exported.
- **Recommendation:** Clarify whether `extractDisplayItems` lives only in `format.ts`, is re-exported from `headless-render.ts`, or should be moved to `headless-render.ts`.

### Summary

The plan is comprehensive and closely matches the spec's chosen approach: rich detail is routed through `renderResult` and custom-message renderers, the headless widget lifecycle is covered, pane behavior is preserved, and every acceptance criterion has a concrete `Verify:` recipe. I found 0 errors, 2 warnings, and 1 suggestion, all centered on Task 2 wording/export consistency rather than missing coverage or dependency failures. The plan is ready for execution, though tightening those Task 2 instructions would reduce ambiguity for implementers.
