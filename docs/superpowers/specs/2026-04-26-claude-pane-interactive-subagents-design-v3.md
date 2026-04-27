# Claude Pane Interactive Subagents — Design v3

**Status:** Approved (brainstorming) — aligned with implementation plan v3 review.
**Supersedes:** `docs/superpowers/specs/2026-04-26-claude-pane-interactive-subagents-design-v2.md`
**Source TODO:** `.pi/todos/fca9feda.md`
**Target use case:** `pi-config` `define-spec` skill dispatching `spec-designer` (a `cli: claude, auto-exit: false` agent) via `subagent_run_serial`.

## v3 change summary

This v3 spec keeps the v2 architecture and incorporates the implementation-ready improvements from the v3 plan:

- Live Claude pane and orchestration tests are explicitly slow-lane gated with `PI_RUN_SLOW=1`, but their per-test run commands must set that variable when the goal is to actually validate live behavior rather than observe skips.
- Watcher finalization should tolerate the race where the MCP sentinel appears before the Stop hook writes `${PI_CLAUDE_SENTINEL}.transcript`; it performs a small bounded wait for the transcript pointer before archiving, while keeping `pollForExit` unchanged.
- The transcript-summary fallback is implemented as a deterministic helper, `extractLastAssistantMessage(jsonl)`, and covered by unit tests before being wired into `watchSubagent`.
- Orchestration coverage uses the real `runSerial` / `runParallel` path and discovers live pane surfaces via the subagent registry test hook rather than assuming the orchestration layer exposes raw surfaces.
- Multi-turn tests wait for observable assistant-turn markers before sending answers or asserting the sentinel is absent; driver failures are test failures, not ignored background noise.
- Packaging is made explicit: the plugin MCP server has its own `tsconfig`, `@modelcontextprotocol/sdk` is a direct runtime dependency, and the compiled `plugin/mcp/server.js` is committed/refreshed by `npm run build:plugin` for zero-build installs.

The v2 `--tools` strengthening still applies: whenever Claude pane launch receives an explicit `effectiveTools` allowlist, the launch command must emit `--tools` and include `mcp__pi-subagent__subagent_done` even if none of the requested pi tool names map to Claude built-in tools.

## Problem

Claude-backed pane subagents currently complete after the first assistant turn — including when that turn is a clarifying question. Workflows that expect multi-turn interaction (the user types answers directly into the subagent's pane) silently fail because the orchestration returns to the parent before the user has had a chance to respond.

The mechanical cause lives in `pi-extension/subagents/plugin/hooks/on-stop.sh`. The hook fires after every Claude turn and writes the completion sentinel whenever `user_msg_count == 1` in the transcript — interpreting "no follow-ups yet" as "autonomous task done." That heuristic was added to give `auto-exit: true` Claude agents an automatic terminate-on-completion path, but it is fundamentally fragile: any agent that asks even one clarifying question hits this code path before the user can answer.

## Goal

Make Claude-backed pane subagents capable of true interactive sessions. A Claude pane subagent can ask the user multiple clarifying questions in its pane and remain alive until it explicitly signals completion. Existing one-shot Claude subagent behavior is preserved through the same explicit signal — not through a heuristic.

## Architecture

The Claude pane completion path is unified around a single explicit signal: a plugin-bundled MCP tool, `mcp__pi-subagent__subagent_done`, that the model invokes when its task is finished. The current `user_msg_count`-based heuristic is removed entirely. The Stop hook is reduced to one job — surfacing the transcript path to the watcher — which has no clean substitute outside the hook.

`auto-exit: false` (interactive) and `auto-exit: true` (autonomous) Claude agents now use the same completion mechanism. The flag varies only the system-prompt language ("ask clarifying questions as needed" vs "complete autonomously without asking the user"); both forms end with "call `subagent_done` when finished."

### New / changed components

1. `pi-extension/subagents/plugin/.claude-plugin/plugin.json` *(new)* — minimal plugin manifest required for plugin-MCP discovery.
2. `pi-extension/subagents/plugin/.mcp.json` *(new)* — declares one stdio MCP server, `pi-subagent`, that auto-loads when Claude is launched with `--plugin-dir`.
3. `pi-extension/subagents/plugin/mcp/server.ts` *(new)* — tiny stdio MCP server built on `@modelcontextprotocol/sdk` as a direct runtime dependency. Exposes one tool, `subagent_done`, with optional `message: string`. On invocation: writes `$PI_CLAUDE_SENTINEL` (atomic-rename) with the message body; returns a confirmation text content. Defensive error response if `$PI_CLAUDE_SENTINEL` is unset. The compiled `pi-extension/subagents/plugin/mcp/server.js` is committed so installed plugins work without an end-user build step.
4. `pi-extension/subagents/plugin/hooks/on-stop.sh` *(modified)* — slimmed to one responsibility: write `${PI_CLAUDE_SENTINEL}.transcript` containing the transcript path. The user-msg-count completion path is removed. The hook no longer reads `auto-exit`-related env vars, and Python is replaced with one-line Node JSON parsing (Node is already a hard plugin dependency).
5. `pi-extension/subagents/index.ts` *(modified)* — Claude pane launch path:
   - Stops setting `PI_SUBAGENT_AUTO_EXIT` on the Claude env (no remaining consumer).
   - Folds `spec.claudeCompletionAddendum` into the `identity` value passed to `buildClaudeCmdParts`, so the addendum reaches Claude via `--append-system-prompt` even when `spec.identity` itself is null/empty (in that case the addendum becomes the entire system-prompt addition).
   - `buildClaudeCmdParts` always injects `mcp__pi-subagent__subagent_done` into the `--tools` allowlist whenever an explicit `effectiveTools` value is present. If the requested pi tool names map to one or more Claude builtins, the MCP tool is emitted alongside those mapped builtins. If none of the requested pi tool names map to Claude builtins, `--tools` is still emitted with `mcp__pi-subagent__subagent_done` as the sole allowed tool. This is symmetric to how `resolvePiToolsArg` always reserves `caller_ping,subagent_done` on the pi path and prevents restrictive/unmappable tool lists from disabling Claude-pane completion.
   - If plugin-MCP auto-discovery is proven unreliable by the first live smoke test, the same launch path may additionally emit `--mcp-config <generated-path>`. The generated config lives under the session artifact directory, has its parent directory created before write, and points directly at the absolute `plugin/mcp/server.js` path.
6. `pi-extension/subagents/launch-spec.ts` *(modified)* — adds `buildClaudeCompletionAddendum(autoExit: boolean): string` and exposes `claudeCompletionAddendum` on `ResolvedLaunchSpec` (populated only when `effectiveCli === "claude"`; `null` otherwise). The pane launch path is the sole consumer; the headless Claude backend ignores this field because its completion contract is unchanged (Claude SDK stream events, not the MCP tool). Keeps Claude-specific instruction shaping in the spec layer; pane backend stays a thin transport layer.

### Components that stay unchanged

- `pollForExit` — still polls the existing sentinel file path.
- `watchSubagent` — completion detection, `onSessionKey` plumbing, `BackendResult` mapping, and registry behavior stay the same. Finalization changes only where required by the new completion source: before archival it may bounded-wait for `${PI_CLAUDE_SENTINEL}.transcript` so one-turn MCP completions do not race the Stop hook, and when the sentinel is empty it prefers extracting the last assistant message from the archived transcript JSONL before falling back to pane screen-scrape.
- `BackendResult` shape, registry, `run-serial`, `run-parallel`.
- Headless Claude backend (`backends/claude-stream.ts`, `backends/headless.ts`). Out of scope — its completion path uses Claude SDK stream events, not the Stop hook or sentinel file.
- Pi launch branch, `subagent-done.ts`, `resolvePiToolsArg`, pi result extraction.
- The `interactive` field in `SubagentParams` — stays vestigial.

## Completion contract

### MCP server surface

- Server name: `pi-subagent`. Tool name resolves to `mcp__pi-subagent__subagent_done`.
- One tool:
  - Name: `subagent_done`
  - Description: "Call this when your task is complete. Your final assistant message before this call should summarize what you accomplished — that summary is returned to the parent agent. The session will end after this call."
  - Input schema: `{ message?: string }` (optional final summary; defaults to the last assistant message if omitted).
- Behavior:
  1. Read `process.env.PI_CLAUDE_SENTINEL`. If unset, return `isError: true` text content `"PI_CLAUDE_SENTINEL is not set — subagent_done is only valid in pi-spawned Claude sessions."` and write nothing.
  2. Write `params.message ?? ""` to that path via atomic rename (`writeFileSync` to `${path}.tmp`, then `renameSync`).
  3. Return `{ content: [{ type: "text", text: "Session ending. Parent will receive your summary." }] }`.
- Lifetime: server stays alive on stdio for the duration of the Claude session; Claude exit (after the watcher closes the pane) terminates it via SIGHUP.

### Optional `message` parameter

`message` is optional so the model isn't forced to repeat its assistant-turn summary into the tool argument. When omitted/empty, the watcher falls back through the existing chain, with two upgrades:

1. Read sentinel file (preferred).
2. If a sentinel exists but no transcript pointer is visible yet, bounded-wait briefly for `${PI_CLAUDE_SENTINEL}.transcript` before archiving. This avoids the one-turn race where the MCP tool writes the sentinel before the Stop hook has surfaced the transcript path.
3. Extract last assistant message from the archived transcript JSONL with `extractLastAssistantMessage(jsonl)`.
4. Pane screen scrape (existing final fallback).
5. Generic "Claude Code exited without output" / non-zero exit message.

### System-prompt addendum

Folded into the `identity` value passed to `buildClaudeCmdParts` and reaches Claude via the existing `--append-system-prompt` / `--system-prompt` flag. The fold rule: if `spec.identity` is non-empty, the addendum is appended after a blank-line separator; if `spec.identity` is null/empty, the addendum becomes the sole system-prompt addition (the flag is still emitted). Result: every Claude pane subagent — with or without an agent-defined identity — receives the completion instruction.

For `auto-exit: true`:
> You are a one-shot subagent. Complete your task autonomously without asking the user questions. When finished, your FINAL assistant message should summarize what you accomplished, then call `subagent_done` to end the session.

For `auto-exit: false`:
> You are an interactive subagent. The user can type into this pane at any time — feel free to ask clarifying questions as many times as needed. When the task is complete, your FINAL assistant message should summarize what you accomplished, then call `subagent_done` to end the session.

### `--allowed-tools` injection

`buildClaudeCmdParts` treats `effectiveTools` as an explicit restriction request. When `effectiveTools` is unset, no `--tools` flag is emitted and Claude's default allowlist permits MCP tools. When `effectiveTools` is set, `buildClaudeCmdParts` must emit `--tools <list>` and the list must always include both lifecycle MCP tool names (see below).

Tool-list construction:

1. Map requested pi tool names to Claude built-in tool names via `PI_TO_CLAUDE_TOOLS`.
2. Add both lifecycle MCP tool names unconditionally:
   - `mcp__pi-subagent__subagent_done` — bare form exposed by the `--mcp-config` fallback path.
   - `mcp__plugin_pi-subagent_pi-subagent__subagent_done` — plugin-namespaced form exposed by the `--plugin-dir` path (Claude's `mcp__plugin_<plugin>_<server>__<tool>` convention; both `<plugin>` and `<server>` happen to be `pi-subagent`).
3. De-duplicate while preserving deterministic order.
4. Emit `--tools` even when step 1 produced no mapped builtins; in that case the emitted list contains only those two MCP tool names.

This stronger rule is intentional. A restrictive allowlist containing only pi tool names that Claude cannot map must not silently omit `--tools` or emit an allowlist that lacks the completion MCP tools; either behavior can recreate the original hang path by making `subagent_done` unavailable. Both names are listed because the actual exposed tool name depends on which MCP loading path Claude used, and an allowlist that contains only the bare form silently disables completion under `--plugin-dir` (review-v1 finding 1).

### Watcher impact

Zero changes to `pollForExit`, the Claude-branch polling loop, exit-code propagation, `onSessionKey` plumbing, or registry behavior. All depend on the sentinel file existing, and it still does — written by the MCP server instead of the hook.

`watchSubagent` finalization is allowed to change in two narrowly scoped ways:

1. After `pollForExit` observes the sentinel, perform a small bounded wait/retry for `${PI_CLAUDE_SENTINEL}.transcript` before calling `copyClaudeSession`. This keeps transcript/session metadata reliable for one-turn autonomous Claude sessions without changing the polling contract.
2. If the sentinel body is empty, call the exported helper `extractLastAssistantMessage(jsonl)` on the archived transcript before falling back to pane screen-scrape.

### `spec.autoExit` semantic shift on the Claude path

| | pi path (today, unchanged) | Claude path (after unification) |
|---|---|---|
| `auto-exit: true` | session shuts down on `agent_end` if no user takeover | model is told "no questions"; session ends on MCP tool call |
| `auto-exit: false` | session stays alive across user takeovers | model is told "questions allowed"; session ends on MCP tool call |
| Completion mechanism | `subagent_done` tool writes `.exit` sidecar | `mcp__pi-subagent__subagent_done` writes sentinel |

## Stop hook simplification

```sh
#!/usr/bin/env bash
# Stop hook for pi-spawned Claude sessions.
# Sole responsibility: surface the transcript path to the watcher so it can
# archive the JSONL and resolve the Claude session id early. Completion
# signaling lives in the bundled MCP `subagent_done` tool.

set -euo pipefail

input=$(cat)

# Loop guard
stop_hook_active=$(printf '%s' "$input" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).stop_hook_active||false)))')
[ "$stop_hook_active" = "true" ] && exit 0

# Only act for pi-spawned sessions
[ -z "${PI_CLAUDE_SENTINEL:-}" ] && exit 0

# Surface the transcript path
transcript_path=$(printf '%s' "$input" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).transcript_path||""))')
[ -n "$transcript_path" ] && [ -f "$transcript_path" ] && \
  printf '%s\n' "$transcript_path" > "${PI_CLAUDE_SENTINEL}.transcript"

exit 0
```

The slim hook continues to feed `copyClaudeSession` (transcript archival) and `readClaudeSessionId` (early `onSessionKey` resolution while the pane is alive). Neither has a substitute outside the hook — Claude's stdout is captured by the multiplexer, not us, so we cannot intercept `system/init`.

## Build / packaging

- Plugin ships `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/`, `mcp/server.ts`, and committed compiled `mcp/server.js`.
- `@modelcontextprotocol/sdk` is a direct runtime dependency because the bundled MCP server imports it at runtime.
- The plugin MCP server compiles with its own `pi-extension/subagents/plugin/tsconfig.json`; the root `tsconfig.json` can continue excluding plugin artifacts.
- Add `npm run build:plugin` (`tsc -p pi-extension/subagents/plugin`) and run it before typecheck/final verification so `server.js` cannot go stale relative to `server.ts`.
- The plugin manifest has no runtime effect on the existing Stop hook — `--plugin-dir` already finds `hooks/hooks.json`. Adding `.claude-plugin/plugin.json` is required for the MCP server to load. Empirically verify during implementation with the adapted `claude-sentinel-roundtrip` smoke test. If plugin-MCP auto-load is unreliable across Claude versions, fall back to emitting `--mcp-config <generated path>` from `buildClaudeCmdParts`; create the artifact parent directory before writing the generated config.

## Error handling & edge cases

- **Cancellation (signal abort):** unchanged. `pollForExit` honors the abort signal; `watchSubagent` calls `closeSurface(surface)` regardless of whether `subagent_done` was invoked.
- **User closes the pane manually** (`/exit`, Ctrl-C, multiplexer kill-pane): Claude CLI exits → shell prints `__SUBAGENT_DONE_$?__` → `pollForExit`'s screen-scrape branch matches → watcher returns. Sentinel may be absent; falls back through transcript JSONL → screen scrape.
- **Model forgets to call `subagent_done`:** pane stays alive until the user types `/exit` or the orchestration is cancelled. Matches the pi path's existing posture for an `auto-exit: false` pi child that never signals completion. Mitigated by an explicit system-prompt addendum on every launch. No new timeout in this design.
- **Sentinel write failure inside the MCP server:** server returns `isError: true` with the underlying error message. Pane stays alive; the model sees the error and can retry or surface it to the user.
- **`PI_CLAUDE_SENTINEL` not propagated into MCP server env:** would be a launch-path bug. The MCP server is a child of the Claude process, which inherits the env set on the launch command (the env var is already present today). Defensive check covered by a unit test.
- **Empty `message` argument:** sentinel written empty; watcher falls back to transcript JSONL → screen scrape. Edge case where the model calls `subagent_done` as its first action with no prior assistant turn produces the existing "exited without output" string. Acceptable.
- **Concurrent invocations of `subagent_done`:** physically impossible for a single-threaded model, but the atomic-rename pattern (write `.tmp`, then `renameSync`) keeps the sentinel file appearance atomic for the watcher in any case.
- **Plugin auto-load failure on first run:** every Claude pane subagent would hang because the model has no `subagent_done` tool. Mitigation: smoke-test as the first integration test; if plugin-MCP loading is fragile, switch to a generated `--mcp-config` fallback that points at the absolute compiled server path.
- **Resume path (`subagent_resume` → `--resume`):** resumed Claude session uses the same plugin-dir and env, so the MCP server is available again. No changes needed.
- **Headless Claude regression risk:** none expected — headless completion uses Claude SDK stream events, not the Stop hook or sentinel file. Existing headless test suite serves as a regression check.
- **Pi-backed subagent regression risk:** zero — none of the changes touch `subagent-done.ts`, the pi launch branch, `resolvePiToolsArg`, or pi result extraction.

## Testing strategy

### Plugin-MCP server and manifest unit tests *(new — `test/plugin-mcp.test.ts`)*

1. `subagent_done` with non-empty `message` writes that exact string to `$PI_CLAUDE_SENTINEL`.
2. `subagent_done` with omitted `message` writes empty body.
3. `subagent_done` with `$PI_CLAUDE_SENTINEL` unset returns an error response and writes nothing.
4. Atomic-rename behavior: assert no partial-content read window under simulated sequential/concurrent invocation.
5. Server startup smoke test: handshake completes; advertises exactly one tool with the documented schema.
6. `.claude-plugin/plugin.json` exists and parses.
7. `.mcp.json` declares exactly one server named `pi-subagent` that invokes `node mcp/server.js`.

### Stop hook unit tests *(replace today's hook tests)*

1. Hook with no `PI_CLAUDE_SENTINEL` exits 0, writes nothing.
2. Hook with `stop_hook_active=true` exits 0 immediately.
3. Hook with valid input writes the transcript path to `${PI_CLAUDE_SENTINEL}.transcript`.
4. Hook with missing/nonexistent `transcript_path` exits 0, writes nothing.
5. Regression guard: a fixture transcript with `user_msg_count == 1` MUST NOT cause the sentinel file to appear. Pins the original-bug fix.

### Launch-spec / `buildClaudeCmdParts` unit tests *(extend existing)*

1. When `effectiveTools` contains one or more pi tool names that map to Claude builtins, `--tools` contains those mapped builtins plus `mcp__pi-subagent__subagent_done`.
2. When `effectiveTools` is set but no requested pi tool names map to Claude builtins, `--tools` is still emitted with `mcp__pi-subagent__subagent_done` as the sole allowed tool.
3. `--tools` is omitted entirely when no `effectiveTools` is set.
4. System-prompt addendum present and matches the `auto-exit: false` form when `agentDefs.autoExit === false`.
5. System-prompt addendum present and matches the `auto-exit: true` form when `agentDefs.autoExit === true`.
6. Addendum appended after `spec.identity` (not replacing) — verify ordering.
7. When `spec.identity` is null/empty, the addendum still flows: `--append-system-prompt` is emitted with the addendum as its sole content.
8. When `effectiveCli !== "claude"`, `claudeCompletionAddendum` is `null` on the resolved spec.

### Watcher summary fallback unit tests *(new — `test/orchestration/pane-claude-transcript-fallback.test.ts`)*

1. `extractLastAssistantMessage(jsonl)` returns the most recent assistant text from Claude JSONL.
2. Handles assistant content as either a string or an array of text blocks.
3. Returns `""` for transcripts without assistant messages or malformed JSONL.
4. `watchSubagent` finalization reads the archived transcript before pane screen-scrape when the sentinel body is empty.
5. One-turn autonomous completion has a bounded wait/retry for the transcript pointer before archiving so `transcriptPath` / `sessionId` are not lost to the MCP-sentinel-vs-Stop-hook race.

### Pane integration tests *(new — `test/integration/`, gated by `CLAUDE_AVAILABLE`, compiled plugin, mux backend availability, and `PI_RUN_SLOW=1`)*

1. **Interactive multi-turn happy path** (the original failing case): launch a Claude pane subagent with `auto-exit: false`. Wait for an observable assistant marker such as `CLARIFY?`, then assert the sentinel does not exist after that first assistant turn. Send a user input simulating a later turn. Instruct the model to invoke `subagent_done` with a known message. Assert sentinel/final summary matches, watcher returns `exitCode === 0`, `transcriptPath` populated, and `sessionId` populated.
2. **Autonomous-with-MCP happy path** (`auto-exit: true`): pane subagent that completes one autonomous turn and calls `subagent_done`. Assert terminal fields populated, including transcript/session metadata.
3. **Autonomous-without-MCP hang regression**: launch with `auto-exit: true`, instruct the model NOT to call the tool. Use a 10s test-only abort timeout. Assert the watcher returns via the abort path with the expected error shape. Pins the documented "model forgot ⇒ hang until cancel" behavior.
4. **Cancellation mid-question**: launch interactive subagent, abort while the model is between turns. Assert pane closes cleanly and `BackendResult` reflects abort.
5. **User closes pane manually**: launch interactive subagent, wait for an observable `READY` marker, simulate `/exit` in the pane, and assert watcher returns via the `__SUBAGENT_DONE__` marker fallback with a non-empty summary.

### Orchestration integration tests *(new slow-lane `test/integration/orchestration-claude-pane-*.test.ts`)*

1. Real `runSerial` with a `cli: claude, auto-exit: false` agent returns the expected parent-facing payload shape.
2. Real `runParallel` with two `cli: claude, auto-exit: false` agents returns independent child payloads and unique `sessionKey`s.
3. Because `runSerial` / `runParallel` do not expose raw pane handles, tests discover live pane surfaces through `subagents.__test__.getRunningSubagents()` and match by task name.
4. Driver coroutines must wait for observable clarifying-question markers and send replies; driver failures are assertion failures, not swallowed. This is what proves multi-turn behavior rather than only final payload shape.
5. Pi-path regression: existing serial/parallel unit tests must pass unchanged.

### Spec-designer-style end-to-end *(workflow-level)*

1. Mock spec-designer flow: parent dispatches Claude subagent through real `runSerial`, model asks 2 clarifying questions in 2 turns, user-pane simulates answers after observing `Q1?` and `Q2?`, model writes a SPEC file and calls `subagent_done` with a `SPEC_WRITTEN: <absolute path>` summary. Assert the parent receives that summary as `finalMessage`, that it includes the actual absolute path, and that the written SPEC file exists and is non-empty.

### Test seams

The pane backend's existing `__test__` exports already cover `LauncherDeps`, `watchSubagent`, registry, and `muxAvailable`; the slow-lane orchestration tests should use the registry hook to discover live surfaces. No new seams expected. Add a `setMcpServerOverride` helper only if a unit test specifically needs to avoid spawning a real Node MCP server.

## Acceptance criteria

- A Claude pane subagent with `auto-exit: false` can ask at least two clarifying questions in its pane without the orchestration completing after the first question.
- A Claude pane subagent can later emit the agreed completion signal (`subagent_done` MCP tool) and have the orchestration complete normally.
- The resulting orchestration payload includes the expected terminal fields (`finalMessage`, `exitCode`, `state`, `transcriptPath`, `sessionId`/`sessionKey` where applicable).
- One-turn autonomous Claude pane completions still populate transcript/session metadata; the MCP sentinel must not race the Stop hook pointer badly enough to lose `transcriptPath` or `sessionId` under normal conditions.
- Explicit Claude tool restrictions do not disable completion: if `effectiveTools` is set, `mcp__pi-subagent__subagent_done` is always present in `--tools`, including the case where no requested pi tool names map to Claude builtins.
- Existing one-shot Claude subagent behavior remains available — exercised through the same MCP completion path with the autonomous system-prompt addendum.
- Pi-backed subagent lifecycle behavior is not regressed.
- Tests cover the interactive-Claude-pane behavior, the autonomous-Claude-pane behavior, and pin the user-msg-count regression so it cannot return.
- Slow-lane live tests are skipped by default but actually execute when `PI_RUN_SLOW=1` is set on a machine with Claude and a mux backend.

## Non-goals

1. **Headless Claude backend** — not modified. Interactive headless support, if it ever lands, is a separate design.
2. **Parent-mediated resume loops** for multi-turn interaction — explicitly rejected by the source TODO.
3. **`caller_ping` for Claude pane sessions** — deferred to phase-2.5. The plugin MCP server is a natural future home (one more registered tool); shipping it later is additive.
4. **`SubagentParams.interactive` field** — stays vestigial. No remove, no wire.
5. **`PI_SUBAGENT_AUTO_EXIT` env var on the Claude path** — removed entirely; no remaining consumer after hook simplification.
6. **Hard timeouts for "model forgot to call `subagent_done`"** — not in scope. Cancel + pane-close fallback are sufficient. A timeout mechanism is its own design.
7. **Pi-backed subagent behavior** — zero changes.
