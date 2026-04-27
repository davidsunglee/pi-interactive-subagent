### Strengths

- The implementation matches the spec’s explicit-completion architecture: the Claude pane path now relies on the bundled MCP `subagent_done` tool instead of the fragile `user_msg_count` Stop-hook heuristic.
- The launch path keeps responsibilities well separated: `launch-spec.ts` owns Claude completion addendum generation, while `index.ts` folds it into Claude CLI system-prompt arguments and injects both bare and plugin-namespaced lifecycle MCP tool names when `--tools` is restrictive.
- The Stop hook is substantially simpler and correctly limited to surfacing the Claude transcript path for archival/session-id discovery.
- The watcher changes are narrowly scoped and preserve the existing `pollForExit` contract while adding bounded transcript-pointer wait and deterministic JSONL summary fallback for empty MCP messages.
- Test coverage is broad: unit tests cover MCP server behavior, Stop-hook regression, completion addenda, restrictive tool allowlists, and transcript fallback; slow-lane integration tests cover interactive, autonomous, orchestration serial/parallel, and spec-designer-style Claude pane flows.

### Issues

#### Critical (Must Fix)

None found.

#### Important (Should Fix)

None found.

#### Minor (Nice to Have)

None found.

### Recommendations

- Before release, run `npm run build:plugin`, `npm test`, and — on a machine with Claude CLI plus a supported mux backend — `npm run test:integration:slow` so the committed `plugin/mcp/server.js` and live Claude plugin auto-load path are verified together.
- Keep the slow Claude pane tests as a required manual/CI release gate because plugin MCP discovery is an external Claude CLI behavior that unit tests cannot fully prove.

### Assessment

**Ready to merge: Yes**

**Reasoning:** The reviewed code implements the spec’s unified Claude pane completion contract, preserves non-Claude lifecycle paths, and includes targeted regression coverage for the prior early-completion bug and the new MCP-based completion flow.
