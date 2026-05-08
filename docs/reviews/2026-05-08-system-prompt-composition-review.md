REVIEWER_PROVENANCE: code-reviewer openai-codex/gpt-5.5 xhigh TODO-dd074bb7 full-uncommitted-diff review 2026-05-08

### Outcome

**Verdict:** Approved

**Reasoning:** The diff implements the required deterministic identity composition without changing unrelated handoff/completion workflows, and it preserves the Pi/Claude transport split. I verified the targeted orchestration tests, skipped default integration behavior, typecheck, lint, and diff whitespace successfully.

### Strengths

- `pi-extension/subagents/launch-spec.ts:613-630` cleanly trims both prompt sources, drops whitespace-only inputs, composes agent body first with a blank-line separator, and keeps `identityInSystemPrompt` as a transport decision.
- `test/orchestration/launch-spec.test.ts:105-250` adds focused coverage for body-only, caller-only, body+caller, whitespace-only, trimming, ordering, and Claude task-body non-duplication behavior.
- `test/orchestration/launch-spec.test.ts:538-609`, `test/orchestration/claude-event-transform.test.ts:255-284`, and `test/orchestration/thinking-effort.test.ts:263-375` cover the Pi artifact/role-block paths and both Claude `--append-system-prompt` / `--system-prompt` transports with no duplicate task-body leakage.
- `test/integration/headless-prompt-composition.test.ts:21-199` provides slow opt-in headless coverage for both Pi and Claude children observing both prompt parts, and `package.json:22` includes it in the slow integration lane.

### Issues

#### Critical (Must Fix)

_None._

#### Important (Should Fix)

_None._

#### Minor (Nice to Have)

_None._

### Recommendations

_None._
