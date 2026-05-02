**Reviewer:** openai-codex/gpt-5.5 via pi

### Strengths
- Pane observability is implemented at the right seam: `watchSubagent` now owns live JSONL tailing and pushes data through `SubagentResult`, while `pane.ts` maps those partials into the backend contract.
- The shared tailing helper (`pi-extension/subagents/backends/jsonl-tail.ts`) is robust for production use: it maintains byte offsets, buffers incomplete lines, handles split UTF-8 sequences, and resets cleanly after truncation.
- The pi projection was de-duplicated from headless behavior via `pi-extension/subagents/backends/pi-projection.ts`, reducing drift between headless and pane transcript shapes.
- Claude handling covers both live tailing via the early `SessionStart` pointer and a post-mortem archived-transcript fallback, matching the spec's reliability requirements for one-turn/racy completions.
- Widget behavior now consistently uses usage data when available and falls back to simple running/starting states, which aligns pane display with headless.
- Test coverage is strong and focused: it includes pi and Claude live updates, final-drain behavior, abort partial preservation, resume tail offsets, pane backend plumb-through, JSONL torn writes, and plugin hook behavior.

### Issues

#### Critical (Must Fix)
None found.

#### Important (Should Fix)
None found.

#### Minor (Nice to Have)
None found.

### Recommendations
- Keep the new tailing/projector modules as the single source of truth for future pane/headless observability work; they are good boundaries to extend if additional provider metadata is surfaced later.
- Consider adding an integration test for a real Claude pane resume path when the environment supports it, since the unit coverage already exercises the fallback mechanics but real hook behavior can vary across Claude Code versions.

### Assessment

**Ready to merge: Yes**

**Reasoning:** The implementation matches the requested pane/headless observability parity, is well-covered by targeted tests, and passed `npm test`, `npm run typecheck`, and `npm run lint` during review.
