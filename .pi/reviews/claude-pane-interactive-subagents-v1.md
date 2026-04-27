# Code Review: Claude Pane Interactive Subagents

## Assessment

Ready to merge: No

The implementation moves the Claude pane lifecycle in the intended direction: the old `user_msg_count == 1` Stop-hook completion heuristic is removed, the MCP server writes the sentinel atomically, Claude pane launches receive a completion addendum, and unit coverage was added for the MCP server, Stop hook, prompt addendum, and tool-list construction. I also verified the non-live unit suite, typecheck, and plugin build with the subagent-deny environment cleared:

- `env -u PI_DENY_TOOLS -u PI_SUBAGENT_AGENT -u PI_SUBAGENT_NAME -u PI_SUBAGENT_SESSION -u PI_SUBAGENT_SURFACE npm test` ✅
- `env -u PI_DENY_TOOLS -u PI_SUBAGENT_AGENT -u PI_SUBAGENT_NAME -u PI_SUBAGENT_SESSION -u PI_SUBAGENT_SURFACE npm run typecheck` ✅
- `env -u PI_DENY_TOOLS -u PI_SUBAGENT_AGENT -u PI_SUBAGENT_NAME -u PI_SUBAGENT_SESSION -u PI_SUBAGENT_SURFACE npm run build:plugin` ✅

However, there is one production-blocking issue for Claude agents with restrictive tool lists, plus two concrete spec/test-readiness gaps.

## Findings

### 1. High — restrictive Claude tool lists allowlist the wrong MCP tool name, so `subagent_done` can be unavailable

**File/lines:** `pi-extension/subagents/index.ts:562-578`; related: `pi-extension/subagents/plugin/.mcp.json:2-5`, `test/integration/claude-sentinel-roundtrip.test.ts:95-98`, `test/integration/agents/test-claude-spec-designer.md:1-4`

**Evidence:** `buildClaudeCmdParts` unconditionally injects `mcp__pi-subagent__subagent_done` when `effectiveTools` is set:

```ts
const MCP_LIFECYCLE_TOOL = "mcp__pi-subagent__subagent_done";
...
claudeTools.add(MCP_LIFECYCLE_TOOL);
parts.push("--tools", shellEscape([...claudeTools].join(",")));
```

But the MCP server is loaded through a Claude plugin `.mcp.json`, and Claude reports that plugin-scoped server as `plugin:pi-subagent:pi-subagent` (`claude --plugin-dir pi-extension/subagents/plugin mcp list`). The new live smoke test also acknowledges this namespace by accepting tool-use names like `mcp__plugin_pi-subagent_pi-subagent__subagent_done` rather than only `mcp__pi-subagent__subagent_done` (`test/integration/claude-sentinel-roundtrip.test.ts:95-98`).

That means the allowlist injected for restrictive launches does not include the actual plugin-loaded tool name. The spec’s acceptance criterion is explicit that restrictive Claude tool lists must not disable completion. This particularly affects real/fixture agents with `tools:` frontmatter, e.g. the new spec-designer fixture declares `tools: read, write, edit`; it will launch with `--tools Read,Write,Edit,mcp__pi-subagent__subagent_done`, while the plugin-exposed completion tool is namespaced differently.

**Impact:** Any Claude pane subagent with `effectiveTools` set can lose access to `subagent_done`. The model then cannot write the sentinel, so the watcher waits indefinitely until the user manually exits or cancellation occurs. This recreates the hang path the feature is meant to remove and breaks the spec-designer target use case when it uses restricted tools.

**Suggested fix:** Make the allowlist match the tool name Claude actually exposes for the selected loading path. Options:

- load the MCP server via a generated `--mcp-config` with server name `pi-subagent` so the allowlisted name really is `mcp__pi-subagent__subagent_done`; or
- include the plugin-namespaced tool name used by `--plugin-dir` (and keep a live restricted-tools smoke test that proves the model can call it).

After fixing, add/adjust a live slow-lane test that launches a Claude pane agent with `tools:` set and asserts `subagent_done` is callable and the watcher returns normally.

### 2. Medium — the modified live Claude smoke test is not slow-lane gated, and the slow script omits the new Claude pane suites

**File/lines:** `test/integration/claude-sentinel-roundtrip.test.ts:18-33`; `package.json:20-21`

**Evidence:** The reference spec says live Claude pane and orchestration tests must be explicitly gated with `PI_RUN_SLOW=1`. Most newly added Claude pane tests do this via `SLOW_LANE_OPT_IN`, but the modified `claude-sentinel-roundtrip` still computes:

```ts
const SHOULD_SKIP = !CLAUDE_AVAILABLE || !PLUGIN_PRESENT || backends.length === 0;
```

with no `PI_RUN_SLOW` requirement. On any developer/CI machine with Claude and a mux backend, `npm run test:integration` will run a real Claude pane session by default. Conversely, `npm run test:integration:slow` sets `PI_RUN_SLOW=1` but only names the older orchestration backend files, so it does not execute the new `pane-claude-interactive` or `orchestration-claude-pane-*` suites that were added for this feature.

**Impact:** The default integration command can unexpectedly spend tokens, take minutes, or hang on live Claude behavior, while the advertised slow-lane command does not validate the new feature’s primary live acceptance tests. This weakens release verification and violates the spec’s test gating requirement.

**Suggested fix:** Gate `claude-sentinel-roundtrip` with `SLOW_LANE_OPT_IN` and update `test:integration:slow` to run all intended slow/live suites, e.g. `PI_RUN_SLOW=1 node --test test/integration/*.test.ts` or an explicit list that includes the new Claude pane files and the smoke test.

### 3. Medium — transcript fallback can erase the previous assistant summary when the last assistant event is tool-use-only

**File/lines:** `pi-extension/subagents/index.ts:884-891`, used by `pi-extension/subagents/index.ts:1034-1039`

**Evidence:** `extractLastAssistantMessage` updates `last` for every assistant entry with array content, even when that array contains no text blocks:

```ts
last = content
  .filter((b: any) => b?.type === "text" && typeof b.text === "string")
  .map((b: any) => b.text)
  .join("");
```

A Claude assistant event that only contains `{ type: "tool_use", ... }` for `subagent_done` therefore overwrites a prior textual assistant summary with `""`. The watcher only calls this helper when the sentinel body is empty, then falls back to pane scraping if the helper returns empty.

**Impact:** The spec intentionally makes the MCP `message` parameter optional so the parent can receive the final assistant message from the transcript. If Claude emits a summary in one assistant message and then a separate tool-use-only assistant event, the deterministic transcript fallback loses the summary and returns noisy pane scrape output or the generic fallback instead of the intended final message.

**Suggested fix:** Only update `last` when an assistant entry has non-empty text content. For array content, join text blocks into a candidate and assign `last = candidate` only when `candidate.trim()` is non-empty. Add a regression test with `assistant(text summary)` followed by `assistant([{ type: "tool_use", ... }])` that expects the summary to survive.
