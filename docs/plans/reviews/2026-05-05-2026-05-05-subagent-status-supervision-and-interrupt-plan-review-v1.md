**Reviewer:** openai-codex/gpt-5.5 via pi

### Outcome

**Verdict:** Approved

**Reasoning:** The plan covers the spec requirements end-to-end, has actionable tasks with one-to-one `Verify:` recipes for every acceptance criterion, and is buildable as written. No Critical or Important issues were found.

### Strengths

- Tasks 1–2 cleanly separate the upstream verbatim ports (`activity.ts`, `status.ts`) from local integration work, with concrete constants and export surfaces to verify.
- Tasks 4, 6, and 7 explicitly account for local fork divergences: headless Pi activity files, Claude exclusions, blocked virtual rows, reload/session cleanup, and preservation of existing auto-exit semantics.
- Task 9 gives precise interrupt behavior for id/name resolution, pane-Pi-only validation, Escape failure handling, and orchestration-owned slots.
- Acceptance criteria are consistently paired with specific `Verify:` lines naming files, commands, grep patterns, or observable outcomes.

### Issues

#### Critical (Must Fix)

_None._

#### Important (Should Fix)

_None._

#### Minor (Nice to Have)

- **Dependencies: Task 2 dependency wording is contradictory**
  - **What:** The dependency section says `Task 2 depends on: Task 1 (no — they're independent file ports...)`.
  - **Why it matters:** This is unlikely to break execution, but it may unnecessarily serialize two independent port tasks or confuse a wave planner.
  - **Recommendation:** Clarify that Task 2 has no hard dependency on Task 1, unless the executor intentionally wants sequential porting for simplicity.

### Recommendations

_None._
