# Review: `2026-04-20-mux-free-execution-design-v1.md`

Reviewed: 2026-04-20  
Plan: `.pi/plans/2026-04-20-mux-free-execution-design-v1.md`  
Verdict: **Needs revision before implementation**  
Ready to merge: **No**

## Summary

There is a solid shape here:

- the phased rollout is disciplined
- the pane adapter / backend seam is a reasonable decomposition
- the Claude `--allowedTools` patch being called out as a discrete carried commit is good house style
- the plan is thoughtful about abort handling, transcript archival, and test coverage

However, I see **two blocking gaps** that prevent this from meeting its stated goal as written.

## Blocking findings

### 1) The plan never removes the existing no-mux orchestration gate, so `subagent_serial` / `subagent_parallel` still cannot reach the new backend

The stated goal is to make `subagent_serial` / `subagent_parallel` work without a multiplexer (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:5-7`). But the current tool registration path still wires orchestration through `preflightSubagent`, and that helper immediately returns an error when no mux is available (`pi-extension/subagents/index.ts:206-223`, `pi-extension/subagents/index.ts:1794-1799`).

The plan rewires `makeDefaultDeps()` to select a backend (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:714-779`), but that code only runs **after** the orchestration tool has already passed preflight. As long as preflight hard-requires mux, the new headless backend is unreachable from the actual user-facing tools.

The new tests also miss this. The headless integration tests instantiate `makeHeadlessBackend()` directly instead of invoking `subagent_serial` / `subagent_parallel` through the extension layer (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:1504-1577`, `:1668-1745`, `:2347-2502`). So the suite can go green while the real no-mux user flow still fails with the old `"mux not available"` error.

#### Why this blocks

This is the core promise of the plan. If orchestration still stops at preflight in no-mux environments, the feature is not actually delivered.

#### Recommended fix

Make the orchestration preflight backend-aware:

- either relax `preflightSubagent` for orchestration so it only requires a session file, not mux, when `selectBackend()` resolves headless
- or pass a distinct orchestration preflight that checks mux only for pane mode

And add at least one integration test that exercises the real tool path in a no-mux environment, not just `makeHeadlessBackend()` directly.

---

### 2) The proposed headless implementation drops large parts of the existing subagent contract, so headless mode would silently behave differently from pane mode

The plan says the orchestration task surface stays the same and only the execution backend changes (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:7`, `:37`). But the proposed `runPiHeadless()` and `runClaudeHeadless()` implementations only forward a small subset of today's launch behavior.

Compare the current pane launch path, which resolves agent defaults and session behavior (`pi-extension/subagents/index.ts:705-930`), with the proposed headless snippets:

- pi headless only forwards `model`, `thinking`, `systemPrompt`, `tools`, `cwd`, and raw `task` (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:1155-1175`)
- Claude headless similarly only forwards direct CLI args and ignores the rest (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:2140-2173`)

That leaves multiple current behaviors unimplemented in headless mode, including:

- agent default loading (`model`, `tools`, `skills`, `thinking`, `cli`, body)
- system-prompt mode handling from agent frontmatter
- skill prompt expansion
- `fork` / seeded session behavior
- `resumeSessionId` on the Claude headless path
- config-root propagation via local `.pi/agent`
- deny-tools / auto-exit / wrapper prompt parity
- session placement parity (`getDefaultSessionDirFor(...)` today vs unconditional `~/.pi/agent/sessions/...` in the proposal)

In effect, the plan currently defines a second, narrower launch API for headless mode.

The tests do not protect against this drift. The proposed headless tests call the backend directly and mostly use trivial prompts; where they do pass `agent: "scout"` (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:1559-1564`, `:1725-1729`, `:2391-2394`, `:2485-2492`), they do not provision that agent in the temp repo. So if the implementation is corrected to actually honor agent definitions, those tests become host-dependent.

#### Why this blocks

The orchestration schema already advertises the full `SubagentParams`-adjacent surface. Shipping a backend that silently ignores major fields will create mode-dependent behavior that is hard to debug and will break existing skills/workflows.

#### Recommended fix

Move launch normalization above the backend seam:

- resolve agent defaults, cwd/config-root, session-mode/fork behavior, wrapper prompts, skills, tool restrictions, and Claude/pi-specific effective settings **once**
- pass a fully resolved launch spec into either pane or headless execution

That keeps backend differences about transport/observation, not behavior.

Also switch headless integration tests to repo-local test agents (like `test-echo`) or explicit no-agent flows so the suite stays deterministic.

## Non-blocking notes

### 1) Task 8’s test-edit instructions are not executable as written because they append new `import` statements after code

Task 8 says to add a new block to `test/orchestration/default-deps.test.ts` “after the existing `it` block” and the snippet starts with new ESM imports (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:624-629`). The current file is a normal top-import ESM test file (`test/orchestration/default-deps.test.ts:1-21`), so literal append-as-written would produce invalid syntax. Small fix: say to merge the imports into the file header.

### 2) Phase 1’s narrative contradicts the selector implementation shown later

The phase intro says `selectBackend()` is “hard-gated to always return `"pane"` until Phase 2” (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:320`), but Task 7’s implementation explicitly returns `"headless"` for `PI_SUBAGENT_MODE=headless` and for `auto` when no mux is present (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:575-597`). The later wording is the real behavior; the phase intro should be corrected so readers do not get the wrong rollout model.

## Conclusion

This plan is close in structure, but not yet implementation-ready. The main revisions needed are:

1. make the real orchestration entrypoint able to reach headless mode in no-mux environments, and test that path end-to-end
2. preserve current subagent semantics by sharing launch-resolution logic across pane and headless backends instead of reimplementing a reduced subset in `headless.ts`
