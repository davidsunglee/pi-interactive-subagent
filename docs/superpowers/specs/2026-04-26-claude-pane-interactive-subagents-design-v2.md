# Claude Pane Interactive Subagents — Design v2

**Status:** Approved (brainstorming) — pending implementation plan.
**Supersedes:** `docs/superpowers/specs/2026-04-26-claude-pane-interactive-subagents-design.md`
**Source TODO:** `.pi/todos/fca9feda.md`
**Target use case:** `pi-config` `define-spec` skill dispatching `spec-designer` (a `cli: claude, auto-exit: false` agent) via `subagent_run_serial`.

## v2 change summary

This v2 spec adopts the stronger `--tools` behavior from the v2 implementation plan review: whenever Claude pane launch receives an explicit `effectiveTools` allowlist, the launch command must emit `--tools` and include `mcp__pi-subagent__subagent_done` even if none of the requested pi tool names map to Claude built-in tools. This prevents restrictive but unmappable tool lists from silently removing the completion tool and recreating a hang path.

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
3. `pi-extension/subagents/plugin/mcp/server.ts` *(new)* — tiny stdio MCP server built on `@modelcontextprotocol/sdk` (already an indirect dep via `@mariozechner/pi-coding-agent`; add as a direct dep if not present). Exposes one tool, `subagent_done`, with optional `message: string`. On invocation: writes `$PI_CLAUDE_SENTINEL` (atomic-rename) with the message body; returns a confirmation text content. Defensive error response if `$PI_CLAUDE_SENTINEL` is unset.
4. `pi-extension/subagents/plugin/hooks/on-stop.sh` *(modified)* — slimmed to one responsibility: write `${PI_CLAUDE_SENTINEL}.transcript` containing the transcript path. The user-msg-count completion path is removed. The hook no longer reads `auto-exit`-related env vars, and Python is replaced with one-line Node JSON parsing (Node is already a hard plugin dependency).
5. `pi-extension/subagents/index.ts` *(modified)* — Claude pane launch path:
   - Stops setting `PI_SUBAGENT_AUTO_EXIT` on the Claude env (no remaining consumer).
   - Folds `spec.claudeCompletionAddendum` into the `identity` value passed to `buildClaudeCmdParts`, so the addendum reaches Claude via `--append-system-prompt` even when `spec.identity` itself is null/empty (in that case the addendum becomes the entire system-prompt addition).
   - `buildClaudeCmdParts` always injects `mcp__pi-subagent__subagent_done` into the `--tools` allowlist whenever an explicit `effectiveTools` value is present. If the requested pi tool names map to one or more Claude builtins, the MCP tool is emitted alongside those mapped builtins. If none of the requested pi tool names map to Claude builtins, `--tools` is still emitted with `mcp__pi-subagent__subagent_done` as the sole allowed tool. This is symmetric to how `resolvePiToolsArg` always reserves `caller_ping,subagent_done` on the pi path and prevents restrictive/unmappable tool lists from disabling Claude-pane completion.
6. `pi-extension/subagents/launch-spec.ts` *(modified)* — adds `buildClaudeCompletionAddendum(autoExit: boolean): string` and exposes `claudeCompletionAddendum` on `ResolvedLaunchSpec` (populated only when `effectiveCli === "claude"`; `null` otherwise). The pane launch path is the sole consumer; the headless Claude backend ignores this field because its completion contract is unchanged (Claude SDK stream events, not the MCP tool). Keeps Claude-specific instruction shaping in the spec layer; pane backend stays a thin transport layer.

### Components that stay unchanged

- `pollForExit` — still polls the existing sentinel file path.
- `watchSubagent` — completion detection, transcript archival via `copyClaudeSession`, `onSessionKey` plumbing, `BackendResult` mapping. The only adjustment is in the "summary fallback when sentinel is empty" path, which now prefers extracting the last assistant message from the archived transcript JSONL before falling back to pane screen-scrape (more reliable; same artifact `copyClaudeSession` is about to archive).
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

`message` is optional so the model isn't forced to repeat its assistant-turn summary into the tool argument. When omitted/empty, the watcher falls back through the existing chain, with one upgrade:

1. Read sentinel file (preferred).
2. (New) Extract last assistant message from the archived transcript JSONL.
3. Pane screen scrape (existing final fallback).
4. Generic "Claude Code exited without output" / non-zero exit message.

### System-prompt addendum

Folded into the `identity` value passed to `buildClaudeCmdParts` and reaches Claude via the existing `--append-system-prompt` / `--system-prompt` flag. The fold rule: if `spec.identity` is non-empty, the addendum is appended after a blank-line separator; if `spec.identity` is null/empty, the addendum becomes the sole system-prompt addition (the flag is still emitted). Result: every Claude pane subagent — with or without an agent-defined identity — receives the completion instruction.

For `auto-exit: true`:
> You are a one-shot subagent. Complete your task autonomously without asking the user questions. When finished, your FINAL assistant message should summarize what you accomplished, then call `subagent_done` to end the session.

For `auto-exit: false`:
> You are an interactive subagent. The user can type into this pane at any time — feel free to ask clarifying questions as many times as needed. When the task is complete, your FINAL assistant message should summarize what you accomplished, then call `subagent_done` to end the session.

### `--allowed-tools` injection

`buildClaudeCmdParts` treats `effectiveTools` as an explicit restriction request. When `effectiveTools` is unset, no `--tools` flag is emitted and Claude's default allowlist permits MCP tools. When `effectiveTools` is set, `buildClaudeCmdParts` must emit `--tools <list>` and the list must always include `mcp__pi-subagent__subagent_done`.

Tool-list construction:

1. Map requested pi tool names to Claude built-in tool names via `PI_TO_CLAUDE_TOOLS`.
2. Add `mcp__pi-subagent__subagent_done` unconditionally.
3. De-duplicate while preserving deterministic order.
4. Emit `--tools` even when step 1 produced no mapped builtins; in that case the emitted list contains only `mcp__pi-subagent__subagent_done`.

This stronger rule is intentional. A restrictive allowlist containing only pi tool names that Claude cannot map must not silently omit `--tools` or emit an allowlist that lacks the completion MCP tool; either behavior can recreate the original hang path by making `subagent_done` unavailable.

### Watcher impact

Zero changes to `pollForExit`, the Claude-branch polling loop, exit-code propagation, `onSessionKey` plumbing, or registry behavior. All depend on the sentinel file existing, and it still does — written by the MCP server instead of the hook.

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

- Plugin ships `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/`, and `mcp/server.js` (compiled).
- Add a build step that compiles `plugin/mcp/server.ts` to `plugin/mcp/server.js` alongside the existing TypeScript build (likely a one-line `package.json` script extension or `tsconfig` include adjustment).
- The plugin manifest has no runtime effect on the existing Stop hook — `--plugin-dir` already finds `hooks/hooks.json`. Adding `.claude-plugin/plugin.json` is required for the MCP server to load. Empirically verify during implementation; if plugin-MCP auto-load is unreliable across Claude versions, fall back to emitting `--mcp-config <generated path>` from `buildClaudeCmdParts`. The generated config is identical to `.mcp.json`, just passed explicitly. Decide during implementation; not pre-committing.

## Error handling & edge cases

- **Cancellation (signal abort):** unchanged. `pollForExit` honors the abort signal; `watchSubagent` calls `closeSurface(surface)` regardless of whether `subagent_done` was invoked.
- **User closes the pane manually** (`/exit`, Ctrl-C, multiplexer kill-pane): Claude CLI exits → shell prints `__SUBAGENT_DONE_$?__` → `pollForExit`'s screen-scrape branch matches → watcher returns. Sentinel may be absent; falls back through transcript JSONL → screen scrape.
- **Model forgets to call `subagent_done`:** pane stays alive until the user types `/exit` or the orchestration is cancelled. Matches the pi path's existing posture for an `auto-exit: false` pi child that never signals completion. Mitigated by an explicit system-prompt addendum on every launch. No new timeout in this design.
- **Sentinel write failure inside the MCP server:** server returns `isError: true` with the underlying error message. Pane stays alive; the model sees the error and can retry or surface it to the user.
- **`PI_CLAUDE_SENTINEL` not propagated into MCP server env:** would be a launch-path bug. The MCP server is a child of the Claude process, which inherits the env set on the launch command (the env var is already present today). Defensive check covered by a unit test.
- **Empty `message` argument:** sentinel written empty; watcher falls back to transcript JSONL → screen scrape. Edge case where the model calls `subagent_done` as its first action with no prior assistant turn produces the existing "exited without output" string. Acceptable.
- **Concurrent invocations of `subagent_done`:** physically impossible for a single-threaded model, but the atomic-rename pattern (write `.tmp`, then `renameSync`) keeps the sentinel file appearance atomic for the watcher in any case.
- **Plugin auto-load failure on first run:** every Claude pane subagent would hang because the model has no `subagent_done` tool. Mitigation: smoke-test as the first integration test; if plugin-MCP loading is fragile, switch to `--mcp-config` fallback. Not pre-committed.
- **Resume path (`subagent_resume` → `--resume`):** resumed Claude session uses the same plugin-dir and env, so the MCP server is available again. No changes needed.
- **Headless Claude regression risk:** none expected — headless completion uses Claude SDK stream events, not the Stop hook or sentinel file. Existing headless test suite serves as a regression check.
- **Pi-backed subagent regression risk:** zero — none of the changes touch `subagent-done.ts`, the pi launch branch, `resolvePiToolsArg`, or pi result extraction.

## Testing strategy

### Plugin-MCP server unit tests *(new — `test/plugin-mcp.test.ts`)*

1. `subagent_done` with non-empty `message` writes that exact string to `$PI_CLAUDE_SENTINEL`.
2. `subagent_done` with omitted `message` writes empty body.
3. `subagent_done` with `$PI_CLAUDE_SENTINEL` unset returns an error response and writes nothing.
4. Atomic-rename behavior: assert no partial-content read window under simulated concurrent invocation.
5. Server startup smoke test: handshake completes; advertises exactly one tool with the documented schema.

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

### Pane integration tests *(new — `test/integration/`, gated by `muxAvailable`)*

1. **Interactive multi-turn happy path** (the original failing case): launch a Claude pane subagent with `auto-exit: false`. Assert the pane stays alive after the first assistant turn (poll for ~2s, sentinel must NOT exist). Send a user input simulating a turn-2 answer. Instruct the model to invoke `subagent_done` with a known message. Assert sentinel content matches, watcher returns `finalMessage` matching, `exitCode === 0`, `transcriptPath` populated, `sessionId` populated.
2. **Autonomous-with-MCP happy path** (`auto-exit: true`): pane subagent that completes one autonomous turn and calls `subagent_done`. Assert terminal fields populated.
3. **Autonomous-without-MCP hang regression**: launch with `auto-exit: true`, instruct the model NOT to call the tool. Use a 10s test-only abort timeout. Assert pane was alive throughout and the watcher returns via the abort path with the expected error shape. Pins the documented "model forgot ⇒ hang until cancel" behavior.
4. **Cancellation mid-question**: launch interactive subagent, abort while the model is between turns. Assert pane closes cleanly and `BackendResult` reflects abort.
5. **User closes pane manually**: launch interactive subagent, simulate `/exit` in the pane. Assert watcher returns via the `__SUBAGENT_DONE__` marker fallback; summary populated from transcript JSONL.

### Orchestration tests *(extend existing `test/orchestration/`)*

1. `subagent_run_serial` with a `cli: claude, auto-exit: false` agent — full path returns the expected payload shape.
2. `subagent_run_serial` against a stubbed pane backend simulating "interactive Claude that called `subagent_done` after 3 turns" — orchestration completes only after the final tool call.
3. Parallel: same with `subagent_run_parallel`.
4. Pi-path regression: existing serial/parallel tests must pass unchanged.

### Spec-designer-style end-to-end *(workflow-level)*

1. Mock spec-designer flow: parent dispatches Claude subagent, model asks 2 clarifying questions in 2 turns, user-pane simulates answers, model writes a SPEC file and calls `subagent_done` with a `SPEC_WRITTEN: <path>` summary. Assert the parent receives that summary as `finalMessage` and the `SPEC_WRITTEN:` substring is matchable.

### Test seams

The pane backend's existing `__test__` exports already cover `LauncherDeps`, `watchSubagent`, registry, and `muxAvailable`. No new seams expected. Add a `setMcpServerOverride` helper only if a unit test specifically needs to avoid spawning a real Node MCP server.

## Acceptance criteria

- A Claude pane subagent with `auto-exit: false` can ask at least two clarifying questions in its pane without the orchestration completing after the first question.
- A Claude pane subagent can later emit the agreed completion signal (`subagent_done` MCP tool) and have the orchestration complete normally.
- The resulting orchestration payload includes the expected terminal fields (`finalMessage`, `exitCode`, `state`, `transcriptPath`, `sessionId`/`sessionKey` where applicable).
- Explicit Claude tool restrictions do not disable completion: if `effectiveTools` is set, `mcp__pi-subagent__subagent_done` is always present in `--tools`, including the case where no requested pi tool names map to Claude builtins.
- Existing one-shot Claude subagent behavior remains available — exercised through the same MCP completion path with the autonomous system-prompt addendum.
- Pi-backed subagent lifecycle behavior is not regressed.
- Tests cover the interactive-Claude-pane behavior, the autonomous-Claude-pane behavior, and pin the user-msg-count regression so it cannot return.

## Non-goals

1. **Headless Claude backend** — not modified. Interactive headless support, if it ever lands, is a separate design.
2. **Parent-mediated resume loops** for multi-turn interaction — explicitly rejected by the source TODO.
3. **`caller_ping` for Claude pane sessions** — deferred to phase-2.5. The plugin MCP server is a natural future home (one more registered tool); shipping it later is additive.
4. **`SubagentParams.interactive` field** — stays vestigial. No remove, no wire.
5. **`PI_SUBAGENT_AUTO_EXIT` env var on the Claude path** — removed entirely; no remaining consumer after hook simplification.
6. **Hard timeouts for "model forgot to call `subagent_done`"** — not in scope. Cancel + pane-close fallback are sufficient. A timeout mechanism is its own design.
7. **Pi-backed subagent behavior** — zero changes.
