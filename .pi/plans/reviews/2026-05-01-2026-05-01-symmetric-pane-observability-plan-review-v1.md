**Reviewer:** openai-codex/gpt-5.5 via pi

### Status

**[Issues Found]**

### Issues

**[Warning] — Task 1: `tailPiSessionEntries` return shape is inconsistent between File Structure and task details**
- **What:** The File Structure section says `tailPiSessionEntries(running, state)` returns `{ messages: PiStreamMessage[], usageDelta }`, but Task 1 Step 1.2 and its acceptance criteria define `tailPiSessionEntries(sessionFile: string, state: PiTailState): PiTailDelta` returning `{ messages, assistantMessages }` with no `usageDelta`.
- **Why it matters:** An implementer could follow the File Structure summary and create a different helper signature/return shape than Tasks 1 and 3 expect, causing cross-task integration failures when `watchSubagent` tries to consume `delta.assistantMessages`.
- **Recommendation:** Make the File Structure entry match the detailed task contract: `tailPiSessionEntries(sessionFile, state)` returns `PiTailDelta` with `messages` and `assistantMessages`; usage is accumulated by `watchSubagent` from assistant messages.

**[Warning] — Task 4: Risk Assessment contradicts the planned Claude post-mortem catch-up guard**
- **What:** Task 4 Step 4.3 correctly plans the final catch-up to run when `transcript.length === 0 || claudeFinalUsage === null || usage.turns === 0`, covering the missed-terminal-result race. However, the Risk Assessment says post-mortem "runs unconditionally when `transcript.length === 0`" and also says it "short-circuits because `transcript.length > 0`; post-mortem only runs when the live tail saw nothing."
- **Why it matters:** This directly contradicts Requirement #4 coverage for the result-event race and the task's own Step 4.3/4.7. A worker using the Risk Assessment as guidance could implement the older `transcript.length === 0` guard and miss terminal usage when live transcript was observed but the result event was not.
- **Recommendation:** Update the Risk Assessment to match Task 4 Step 4.3: final catch-up should also run when terminal usage/result was missed, not only when the live tail saw no transcript.

### Summary

The plan is largely well-structured, honors the spec's chosen approach of embedding file-tail observability inside `watchSubagent`'s existing 1Hz `pollForExit.onTick` lifecycle, and covers all numbered requirements with concrete implementation tasks and tests. Acceptance criteria include one-to-one `Verify:` recipes throughout. I found 0 errors, 2 warnings, and 0 suggestions. The plan is close to execution-ready, but the two internal contradictions should be corrected to prevent implementers from following stale summary/risk guidance instead of the detailed task contracts.
