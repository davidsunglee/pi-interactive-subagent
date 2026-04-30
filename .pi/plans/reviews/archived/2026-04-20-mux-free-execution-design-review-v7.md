# Review: `2026-04-20-mux-free-execution-design-v5.md`

Reviewed: 2026-04-21  
Plan: `.pi/plans/2026-04-20-mux-free-execution-design-v5.md`  
Verdict: **Strong revision, but three material issues still need fixes**  
Ready to merge: **No**

## Summary

v5 is materially better than the previous draft.

The important structural calls now look right:

- the launch-contract extraction is above the backend seam instead of being reimplemented inside headless code (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:20-24,1529-1590`)
- the no-mux orchestration path is finally tested through the real registered tool entrypoints rather than only through unit-level helpers (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:22,4054-4247`)
- the Claude transcript archival story is much better after switching from slug guessing to session-id discovery (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:10,3130-3366,3508-3577`)
- the Phase 1 release-sequencing risk is now explicitly called out instead of being implicit (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:12,486-496,1637-1674`)

That said, I still found **three production-relevant issues** in the current v5 plan:

1. the Claude “tool restriction” fix is still wired to the wrong CLI flag, so it does not clearly close the security gap the plan claims to fix
2. the new `messages?: Message[]` contract is not actually populated with valid `@mariozechner/pi-ai` `Message` objects on the Claude path
3. Claude launches still drop `skills` / `skillPrompts` even though the plan repeatedly claims both backends consume the shared skill-expanded launch spec

## Strengths

- **The backend seam is in the right place now.** The plan’s `resolveLaunchSpec()` extraction is the correct answer to the current `launchSubagent()` shape, where transport and launch normalization are still intertwined (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:20-24,1391-1641`; `pi-extension/subagents/index.ts:697-965`).
- **The no-mux gating is finally checked end-to-end.** Task 23b now exercises the real `subagent_serial` / `subagent_parallel` registrations instead of just constructing a backend directly (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:4054-4247`; `pi-extension/orchestration/tool-handlers.ts:27-105`).
- **The transcript archival remediation is much safer than the old slug heuristic.** Session-id discovery under `~/.claude/projects/*/<sessionId>.jsonl` is a real improvement over reconstructing Claude’s private project-dir naming convention (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:10,3286-3577`).
- **The sequencing risk is no longer buried.** v5 properly acknowledges that Phase 1’s backend-aware preflight must not ship without the real Phase 2 backend behind it (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:486-496,1637-1674`).

## Prioritized findings

### 1) The Claude restriction patch still uses `--allowedTools`, but Claude’s own CLI says `--tools` is the restriction primitive

**Severity: Major**

The plan explicitly frames Task 17 as the fix for the Claude-side “tool-restriction security regression” (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:5,24,2730-2738`). But the implementation it prescribes still maps pi tool names to `--allowedTools` for both pane and headless Claude (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:2745-2875,3137-3144,3198-3204`).

That does not line up with Claude’s own current CLI surface on this host:

- `claude --help` describes `--allowedTools` as an allow/permission rule (`lines 14, 46` in the captured help output)
- the same help text exposes `--tools <tools...>` as the way to specify the available built-in tool set (`line 58`)
- the official Claude CLI reference says the same thing: “To restrict which tools are available, use `--tools` instead.”

This matters even more because both Claude paths are also run in bypass-permissions mode:

- current pane builder uses `--dangerously-skip-permissions` (`pi-extension/subagents/index.ts:666-687`)
- planned headless builder uses `--permission-mode bypassPermissions` (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:3177-3182`)

So as written, the plan is very likely to land a patch that changes permission behavior but does **not** actually constrain which tools Claude can invoke. That means the headline “tool-restriction security regression” would still be open.

#### Recommended fix

Revise Tasks 17 and 19 so the restriction mechanism is based on the correct Claude primitive:

- use `--tools` for built-in tool restriction (and only use `--allowedTools` / `--disallowedTools` if you intentionally need permission-rule behavior too)
- keep the `--` separator regression test, because `--tools` is also variadic in current Claude CLI help
- add at least one real Claude integration test that proves a disallowed tool is actually unavailable, not just that an argv array contains a flag

### 2) The planned `messages?: Message[]` field is not populated with real `Message` objects on the Claude path

**Severity: Major**

Task 25 exports `messages?: Message[]` on `OrchestrationResult`, where `Message` is re-exported from `@mariozechner/pi-ai` (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:4290-4311`). In that type, assistant messages require fields like `api`, `provider`, `model`, `usage`, `stopReason`, and `timestamp`, and tool-result messages require `toolCallId`, `toolName`, `isError`, and `timestamp` (`node_modules/@mariozechner/pi-ai/dist/types.d.ts:117-143`).

But the Claude-side population path in the plan does not produce that shape:

- `parseClaudeStreamEvent()` only returns a transformed assistant message with content blocks; it does not add the required `AssistantMessage` metadata (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:3046-3074`)
- `runClaudeHeadless()` then pushes those values into `messages` with unchecked casts (`msg as Message`) and also synthesizes `{ role: "assistant", content: [...] } as Message` for the final result (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:3382-3446`)

So the type exported to downstream callers says “this is a real pi-ai `Message[]`”, while the described implementation returns partial/synthetic objects that do not satisfy the contract.

#### Why this matters

This is more than a type pedantry issue:

- downstream consumers are invited to treat `messages[]` as real `Message` objects because that is the exported API
- the current tests only check shallow content-level properties (e.g. that a `toolCall` exists), so they would not catch metadata breakage
- any consumer that forwards these back into pi-ai utilities or expects `usage`, `timestamp`, or `stopReason` will get malformed data

#### Recommended fix

Pick one of these and make the plan consistent:

1. **Preferred:** introduce an orchestration-specific transcript type that reflects the actual minimal payload you want to return
2. **Alternative:** fully normalize Claude events into valid `AssistantMessage` / `ToolResultMessage` objects with all required metadata before exposing them as `Message[]`

Also add contract tests that assert the returned objects satisfy the intended shape, not just their `content` array.

### 3) Claude parity still drops `skills`, despite the plan repeatedly claiming both backends consume the shared skill-expanded launch spec

**Severity: Moderate**

The plan’s architecture claims the extracted spec resolves `skills` and `skill prompt expansion`, and that both backends consume the same spec (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:20-24`). Task 9b doubles down on that by adding `effectiveSkills` and `skillPrompts` to `ResolvedLaunchSpec` and by explicitly describing `skillPrompts` as a backend-consumable output (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:1529-1534,1586`).

The pi headless path then does exactly that: it prepends `spec.skillPrompts` into the positional message list (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:1781-1784,2014-2029`).

But the Claude side does not:

- Task 19’s Claude-args summary lists model, effort, tools, system prompt, resume, and task body — no skill prompt handling (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:3137-3144`)
- `buildClaudeHeadlessArgs()` never reads `spec.skillPrompts` (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:3173-3215`)
- the current pane-Claude path also does not thread skills into `buildClaudeCmdParts()` today (`pi-extension/subagents/index.ts:742-755`)

So the parity claim is still incomplete for any `cli: "claude"` launch that relies on agent/frontmatter `skills:` or per-task `skills` overrides.

#### Recommended fix

Either:

- explicitly scope Claude+skills out of v1 and document that limitation in the plan/README/tests, **or**
- decide how Claude should receive skill prompts (for example, prepend the `/skill:...` lines into the task text or system prompt) and add both unit and integration coverage for that behavior

Right now the plan says “shared parity” but still leaves this branch underspecified.

## Additional notes

- **Task 17 has a small execution error in its test instructions.** The note says `shellEscape` can be imported from `../../pi-extension/subagents/index.ts` because it is re-exported there (`.pi/plans/2026-04-20-mux-free-execution-design-v5.md:2822`), but today `thinking-effort.test.ts` only imports `thinkingToEffort` and `buildClaudeCmdParts` (`test/orchestration/thinking-effort.test.ts:1-3`), and `index.ts` imports `shellEscape` without exporting it (`pi-extension/subagents/index.ts:24`). That is easy to fix in the plan text.
- **I would still add one pane-Claude E2E restriction test.** Task 17 currently gets array-level unit coverage, and Task 21 only exercises the headless Claude path. Because pane mode shells a command string while headless passes argv directly, a real pane-Claude tool restriction test would buy confidence on the security-sensitive path.

## Assessment

**Ready to merge: No**

If the Claude restriction flag is corrected, the `messages[]` contract is made truthful, and Claude+skills is either implemented or explicitly scoped out, I would be comfortable with this plan proceeding.