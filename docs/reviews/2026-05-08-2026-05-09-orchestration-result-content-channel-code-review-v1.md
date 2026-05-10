**Reviewer:** openai-codex/gpt-5.5 via pi

### Outcome

**Verdict:** Approved

**Reasoning:** The diff implements the required sync and async content-channel changes without altering details payloads, blocked messages, or bare subagent content. Added coverage verifies full multi-line finalMessage propagation for serial and parallel paths.

### Strengths

- `pi-extension/orchestration/tool-handlers.ts:460-469` preserves the existing aggregate header and now appends each task block with `r.finalMessage ?? ""`, avoiding truncation and keeping input result order.
- `pi-extension/subagents/index.ts:1788-1803` mirrors the sync layout for `orchestration_complete` steer messages while keeping `customType`, `display`, `details`, and send options unchanged.
- `test/orchestration/tool-handlers.test.ts:391-498` adds focused sync coverage for both orchestration tools, including multiline content, aggregate header, task order, and unchanged details shape.
- `test/integration/orchestration-extension-async.test.ts:76-217` adds async real-extension wiring coverage for both serial and parallel `wait:false` completion messages.

### Issues

#### Critical (Must Fix)

_None._

#### Important (Should Fix)

_None._

#### Minor (Nice to Have)

_None._

### Recommendations

_None._
