# Review: `2026-04-20-mux-free-execution-design-v10.md`

Reviewed: 2026-04-21  
Plan: `.pi/plans/2026-04-20-mux-free-execution-design-v10.md`

## Summary

v10 is materially stronger than the earlier revisions. The Claude-side contract is much tighter now: the plan explicitly unifies identity precedence and placement across pane and headless (`.pi/plans/2026-04-20-mux-free-execution-design-v10.md:7-13`), the pane-Claude warning test finally traverses the real launch path instead of only the helper (`.pi/plans/2026-04-20-mux-free-execution-design-v10.md:11,101`), and the shared `PI_TO_CLAUDE_TOOLS` module is the right cleanup for a security-sensitive mapping (`.pi/plans/2026-04-20-mux-free-execution-design-v10.md:13,83,91`).

However, I do **not** think the plan is production-ready yet. The core pi headless path is still specified against a protocol that the current pi CLI does not expose, and the follow-on parser/test design is therefore anchored to the wrong event model. Those are implementation-shaping issues, not editorial nits.

## Strengths

- **The Claude system-prompt contract is finally internally consistent.** v10’s new `spec.claudeTaskBody` split and shared `spec.identity` precedence remove a real pane/headless divergence from v9 (`.pi/plans/2026-04-20-mux-free-execution-design-v10.md:9,63-67`). That lines up with the behavior concentration in the current `launchSubagent()` path, where system-prompt, agent-body, task wrapping, and Claude argv construction are still all interleaved in one place (`pi-extension/subagents/index.ts:697-858`).
- **The pane-Claude warning coverage is much more believable now.** Rewriting the integration case to call `launchSubagent(..., { surface })` instead of only invoking `warnClaudeSkillsDropped(...)` directly is the right fix for the v11 review gap (`.pi/plans/2026-04-20-mux-free-execution-design-v10.md:11,101,3905-3906`).
- **The no-mux orchestration gate remains well targeted.** Keeping both forced-headless and auto/no-mux coverage continues to protect the actual user-default selector path rather than only the forced override (`.pi/plans/2026-04-20-mux-free-execution-design-v10.md:25,93,5181-5199,5385-5455`).

## Prioritized findings

### [Critical] The Phase 2 pi headless design still targets a CLI/protocol surface that the current pi installation does not provide

The central Phase 2 implementation still launches pi with `--output-format stream-json` (`.pi/plans/2026-04-20-mux-free-execution-design-v10.md:5,2245-2249`). That is not the current pi CLI contract in this repo’s installed dependency set. The shipped pi docs expose `--mode json` and `--mode rpc` as the process-integration surfaces, not `--output-format stream-json` (`/opt/homebrew/Cellar/pi-coding-agent/0.67.68/libexec/lib/node_modules/@mariozechner/pi-coding-agent/README.md:477-482`). The JSON integration doc likewise documents `pi --mode json "Your prompt"` as the event-stream entrypoint (`/opt/homebrew/Cellar/pi-coding-agent/0.67.68/libexec/lib/node_modules/@mariozechner/pi-coding-agent/docs/json.md:1-7`).

This is not just a naming nit. It affects the entire Phase 2 implementation shape:

- command construction in Task 11 (`.pi/plans/2026-04-20-mux-free-execution-design-v10.md:2245-2249`)
- protocol framing assumptions in the line-buffer/parser work (`.pi/plans/2026-04-20-mux-free-execution-design-v10.md:88,1900-1907,2321-2365`)
- the test plan for the pi headless smoke path (`.pi/plans/2026-04-20-mux-free-execution-design-v10.md:94,1940-1947`)

As written, the plan is asking implementers to build against a pi subprocess mode that is not documented in the current codebase or installed CLI.

**Recommended fix:** re-base Task 11 and every pi-headless test/spec reference on one real contract before implementation starts: either `pi --mode json` or `pi --mode rpc` (the latter is explicitly documented as the process-integration mode in `/opt/homebrew/.../docs/rpc.md:1-12`). Until that choice is made and threaded through the task text, the plan’s main deliverable is not implementable as written.

### [Moderate] Even after fixing the launch flag, the pi event parser is still specified against the wrong event schema

Task 11 repeatedly describes pi “stream-json” payloads in terms of `message_end` plus `tool_result_end`, and the proposed parser pushes transcript entries from both branches (`.pi/plans/2026-04-20-mux-free-execution-design-v10.md:17,29,2139-2141,2325-2363`). But the current pi JSON event contract is different:

- message lifecycle events are `message_start` / `message_update` / `message_end`
- tool execution lifecycle events are `tool_execution_start` / `tool_execution_update` / `tool_execution_end`

That is documented in the current JSON mode docs (`/opt/homebrew/Cellar/pi-coding-agent/0.67.68/libexec/lib/node_modules/@mariozechner/pi-coding-agent/docs/json.md:27-42`) and the packaged `AgentEvent` type (`/opt/homebrew/Cellar/pi-coding-agent/0.67.68/libexec/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-agent-core/dist/types.d.ts:325-329`). There is no documented `tool_result_end` event carrying `event.message`.

That matters because the current plan’s transcript logic is not just using the wrong string constant; it is modeling the wrong payload shape. A naive implementation of `.pi/plans/...:2358-2363` will either:

- miss tool-result information entirely because the event never arrives, or
- get “fixed” ad hoc later in a way that risks double-counting tool-result transcript entries if the implementer starts reading both `message_end` and `tool_execution_end` without first pinning the actual JSON contract.

**Recommended fix:** rewrite the pi-headless parser spec and its tests against the documented current event model before implementation. Concretely, the plan should say exactly which event(s) populate `transcript`, which event(s) update usage, and whether tool results are sourced from `message_end`, `turn_end.toolResults`, or both. Right now that contract is still underspecified and partially wrong.

### [Minor] The new `pi-to-claude-tools` coverage test does not actually prove the invariant it claims to prove

The top-level v10 summary and File Structure claim the new test will fail if “a new pi tool” is added without a Claude mapping (`.pi/plans/2026-04-20-mux-free-execution-design-v10.md:13,91`). But the actual test design hardcodes `PI_BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"])` and only leaves a comment saying to keep it in sync with `launchSubagent()` (`.pi/plans/2026-04-20-mux-free-execution-design-v10.md:3454-3465,3506`).

The current pane path really does define that built-in set locally in `launchSubagent()` (`pi-extension/subagents/index.ts:861-868`). So if that production set grows and the test file is not updated in the same change, this test will continue to pass while the exact regression it claims to catch slips through.

**Recommended fix:** make the invariant mechanically coupled to production code instead of comment-coupled. For example, extract/export the built-in set from production code, or have the test parse/import it from the actual module under test. As currently written, the test is useful documentation, but it is not the “fails loud on new pi tool” guard the plan claims.

## Assessment

**Ready to merge: No**

v10 has real improvements, especially on the Claude parity and regression-test fronts. But the plan still is not implementation-ready because the core pi headless path is written against the wrong runtime contract:

1. the launch mode/flag in Task 11 does not match the current pi CLI surface
2. the pi parser/test design still assumes the wrong event schema
3. one of the new regression guards overstates what it actually proves

**Merge-readiness verdict: do not merge this plan yet; first re-anchor the pi headless design to the current documented `--mode json`/`--mode rpc` contract and update the parser/test sections accordingly.**
