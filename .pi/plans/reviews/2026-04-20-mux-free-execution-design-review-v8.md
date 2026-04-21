# Review: 2026-04-20-mux-free-execution-design-v6.md

Reviewed: 2026-04-21  
Plan: `.pi/plans/2026-04-20-mux-free-execution-design-v6.md`  
Verdict: **v6 closes most of the v7 checklist, but two material issues still need fixes**  
Ready to merge: **With fixes**

## Summary

v6 does fix most of what review v7 asked for.

- **Prior finding 1 is fixed.** The plan now switches both Claude paths to `--tools` and keeps the required `--` separator (`.pi/plans/2026-04-20-mux-free-execution-design-v6.md:2797-2815,3305-3406`), which is the right correction given the current pane launcher still runs Claude in bypass-permissions mode (`pi-extension/subagents/index.ts:666-687`).
- **Prior finding 3 is fixed.** Claude+skills is now explicitly scoped out of v1 instead of being implied as parity (`.pi/plans/2026-04-20-mux-free-execution-design-v6.md:25-33`), which matches the current codebase: pi expands `/skill:` prompts on its own path (`pi-extension/subagents/index.ts:609-631,919-924`), while the current pane-Claude path does not thread skills at all (`pi-extension/subagents/index.ts:742-755`).
- **Prior additional note 1 is fixed.** v6 now plans to re-export `shellEscape` so the Task 17 test instructions are accurate (`.pi/plans/2026-04-20-mux-free-execution-design-v6.md:73-75,2815`).
- **Prior additional note 2 is addressed in intent** via a real pane-Claude restriction test (`.pi/plans/2026-04-20-mux-free-execution-design-v6.md:65,3020-3083`), but that test body has a command-construction bug described below.

The remaining blockers are narrower than in v7, but I still found one major contract issue and one test-design issue.

## Strengths

- **The launch-contract extraction still sits at the right seam.** v6 keeps `resolveLaunchSpec()` above backend dispatch (`.pi/plans/2026-04-20-mux-free-execution-design-v6.md:27-31,1563-1638`), which matches the amount of normalization currently buried in `launchSubagent()` (`pi-extension/subagents/index.ts:697-965`).
- **The Claude restriction remediation is now conceptually correct.** Moving from `--allowedTools` to `--tools` for both pane and headless Claude is the right fix for a launcher that already uses permission bypass (`.pi/plans/2026-04-20-mux-free-execution-design-v6.md:2797-2815,3312-3318`; `pi-extension/subagents/index.ts:666-687`).
- **The Claude+skills story is now honest.** Explicitly documenting Claude skills as out of scope for v1 is better than claiming parity the current code does not have (`.pi/plans/2026-04-20-mux-free-execution-design-v6.md:33`; `pi-extension/subagents/index.ts:742-755,919-924`).
- **The no-mux entrypoint coverage remains strong.** Keeping the real registered-tool orchestration test is still the right guardrail for the feature’s headline value (`.pi/plans/2026-04-20-mux-free-execution-design-v6.md:4290-4385`).

## Prioritized findings

### 1) `TranscriptMessage` is still not truthful on the pi headless path because Task 11 blindly casts raw pi `message_end` payloads

**Severity: Major**

v6 correctly replaces the old `messages?: Message[]` API with an orchestration-owned `transcript?: TranscriptMessage[]` boundary (`.pi/plans/2026-04-20-mux-free-execution-design-v6.md:28,567-602,4623-4661`). That fixes the specific Claude-side type lie from v7.

But the plan then reintroduces a different contract lie on the **pi** headless path:

- `TranscriptMessage` requires `content: TranscriptContent[]` (`.pi/plans/2026-04-20-mux-free-execution-design-v6.md:567-570`)
- Task 11 says pi `Message` objects are “assignable” to that shape and pushes every `message_end` payload into `transcript` via `msg as unknown as TranscriptMessage` (`.pi/plans/2026-04-20-mux-free-execution-design-v6.md:2023-2027,2137-2145`)
- but pi’s own event docs say `message_end` fires for **user, assistant, and toolResult** messages (`/opt/homebrew/Cellar/pi-coding-agent/0.67.68/libexec/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md:468-473`)
- and pi-ai’s `UserMessage` type allows `content: string | (TextContent | ImageContent)[]` (`node_modules/@mariozechner/pi-ai/dist/types.d.ts:117-121`)

So the claimed structural-subtyping argument is false for user messages. As written, `runPiHeadless()` can push a user message whose `content` is a bare string into a field whose public type promises an array of typed blocks. The new contract tests do not catch this, because they only instantiate assistant/toolResult shapes and never exercise a streamed user message or a `content: string` case (`.pi/plans/2026-04-20-mux-free-execution-design-v6.md:4684-4742`).

#### Recommended fix

At the backend boundary, either:

1. normalize pi user messages into block arrays before pushing them into `transcript`, or
2. explicitly filter user messages out of `transcript` and document that choice.

In either case, replace the cast-based push with a projection function and add one test that proves a real pi `message_end` user payload cannot escape as `content: string`.

### 2) The new pane-Claude E2E restriction test appends `--print` in the wrong place, so it will not reliably exercise the intended path

**Severity: Moderate**

Task 17 correctly requires the Claude builder to emit `--` before the task so variadic `--tools` cannot swallow the prompt (`.pi/plans/2026-04-20-mux-free-execution-design-v6.md:2813,2977-2980`). But the new pane-Claude integration test then constructs its command as:

- `const cmd = parts.join(" ") + " --print"` (`.pi/plans/2026-04-20-mux-free-execution-design-v6.md:3051-3054,3074-3075`)

That places `--print` **after** the already-emitted `-- <task>` pair, so `--print` is no longer an option; it is just another positional argument. The current builder shape makes that obvious too: it ends with the task as the final positional part (`pi-extension/subagents/index.ts:666-687`).

I also validated this locally: `claude --dangerously-skip-permissions -- 'Reply with exactly: OK' --print` timed out, while `claude --dangerously-skip-permissions --print -- 'Reply with exactly: OK'` returned `OK` immediately. So the proposed test can hang or test the wrong mode instead of proving the `--tools` restriction.

#### Recommended fix

Build the test command so `--print` is inserted **before** the `--` separator (or bypass shell-string assembly entirely and execute an argv array that includes `--print` in the right slot). If you still want shell-quoting coverage, keep that as a separate assertion after the non-interactive flag placement is correct.

## Assessment

**Ready to merge: With fixes**

The v7 checklist is mostly closed:

- prior finding 1 (`--tools` vs `--allowedTools`) is fixed
- prior finding 3 (Claude+skills parity claim) is fixed by explicit scoping
- prior note 1 (`shellEscape` re-export) is fixed

What remains is smaller but still important:

- the new `transcript` contract is still not fully truthful on the pi headless path
- the new pane-Claude E2E restriction test will not reliably run in `--print` mode as written

If those two issues are corrected, I would be comfortable calling this plan ready.
