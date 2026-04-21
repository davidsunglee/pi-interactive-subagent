# Review: `2026-04-20-mux-free-execution-design-v1.md`

Reviewed: 2026-04-20
Plan: `.pi/plans/2026-04-20-mux-free-execution-design-v1.md`
Verdict: **Needs revision before implementation**
Ready to merge: **No**

## Summary

This plan is pointed in the right direction. The backend seam is reasonably narrow, the Claude `--allowedTools` fix is scoped as a discrete upstream-portable patch, and the test plan is much more concrete than most design docs.

I do **not** think it is implementation-ready yet. The strongest points from the earlier reviews hold up together:

- the headline no-mux orchestration flow is still unreachable from the actual tool entrypoint
- the proposed headless backend is not yet semantically equivalent to the current `launchSubagent()` contract
- the abort escalation logic is incorrect for real Node `ChildProcess` instances, and the proposed test would not catch that
- the Claude headless path drops `resumeSessionId`, which is already part of the documented orchestration surface

So the plan is promising, but it still needs a revision pass before anyone should start executing it.

## Strengths

- The `pane.ts` / `headless.ts` split is a sensible transport boundary and keeps the orchestration core mostly isolated from launch mechanics (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:7,15-39`).
- Treating the Claude tool-restriction fix as its own named patch is exactly the right shape for later upstreaming (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:35,1781-1919`).
- The plan is unusually concrete about verification, especially around transcript archival, tool-use parsing, aborts, and ENOENT paths.

## Blocking findings

### 1) The no-mux orchestration path is still blocked by preflight before backend selection ever runs

The stated goal is to make `subagent_serial` / `subagent_parallel` work without a supported multiplexer (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:5-7`). But the current orchestration handlers call `preflight(ctx)` before constructing launcher deps (`pi-extension/orchestration/tool-handlers.ts:46-53,90-97`), and the registration path currently passes `preflightSubagent` into orchestration (`pi-extension/subagents/index.ts:1794-1799`).

`preflightSubagent()` immediately rejects when mux is unavailable (`pi-extension/subagents/index.ts:206-223`). The plan only rewires `makeDefaultDeps()` through `selectBackend()` (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:615-779`), which means the new headless backend is never reached in the exact CI/headless/IDE scenarios the plan is trying to unlock.

The proposed tests do not close this gap. The headless integration tests instantiate `makeHeadlessBackend()` directly (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:1504-1577,1668-1745,2347-2502`) instead of exercising the real extension tool path. So the suite can go green while `subagent_serial` / `subagent_parallel` still fail with the existing mux error.

#### Why this blocks

This is the headline feature. If the real orchestration entrypoint still stops at preflight in no-mux environments, the plan does not actually deliver what it claims.

#### Recommended fix

Make orchestration preflight backend-aware:

- either relax `preflightSubagent` for orchestration when `selectBackend()` resolves headless
- or pass a distinct orchestration preflight that only requires mux for pane mode

And add at least one integration test that invokes the actual orchestration tool path in a no-mux environment, not just `makeHeadlessBackend()` directly.

---

### 2) The proposed headless backend does not preserve the current subagent launch contract

The plan presents headless mode as an alternate backend behind the same orchestration surface (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:7,37`). But the proposed implementation forwards only a narrow subset of the behavior that `launchSubagent()` currently performs.

Today, the pane path resolves agent defaults and launch semantics including model/tools/skills/thinking, cwd + local agent dir resolution, `session-mode` / `fork`, seeded sessions, system-prompt mode handling, deny-tools, auto-exit, artifact-backed task delivery, and `subagent-done` loading (`pi-extension/subagents/index.ts:705-930`).

By contrast:

- the proposed pi headless path only forwards `--session`, `--output-format`, optional `--model`, optional `--append-system-prompt`, optional `--tools`, and the raw task (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:1141-1176`)
- the proposed Claude headless path similarly only builds direct CLI args from raw task fields (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:2132-2173`)

That leaves major current behaviors either missing or behaviorally different in headless mode, including:

- agent default loading (`model`, `tools`, `skills`, `thinking`, `cli`, body)
- agent body / `system-prompt` mode handling
- skill prompt expansion
- `fork` / `session-mode` / lineage seeding
- local `.pi/agent` config-root propagation
- `PI_DENY_TOOLS`
- `PI_SUBAGENT_AUTO_EXIT`
- artifact-backed task delivery outside full-context fork mode
- `subagent-done.ts` extension loading
- session placement parity (`getDefaultSessionDirFor(...)` today vs unconditional archive roots in the proposed headless path)

That is not just a transport swap; it is a materially different launch model.

The proposed tests also under-protect this area. Several headless tests use `agent: "scout"` (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:1559-1564,1725-1729,2391-2394,2485-2492`), but the repo-local test fixtures only define `test-echo` and `test-ping` (`test/integration/agents/`). If the implementation is corrected to actually honor agent definitions and local config resolution, those tests become host-dependent.

#### Why this blocks

The orchestration API already advertises the richer task surface. Shipping a backend that silently ignores or reinterprets major parts of that contract will create mode-dependent behavior and break existing workflows in ways that are hard to debug.

#### Recommended fix

Move launch normalization above the backend seam.

Define a fully resolved launch spec once, before transport selection, covering:

- effective model / tools / skills / thinking / cli
- cwd and config-root resolution
- system-prompt handling
- task wrapping and artifact-backed delivery
- deny-tools and auto-exit env
- seeded session / fork / lineage behavior
- Claude-specific effective args such as `resumeSessionId`

Then let pane and headless backends differ only in transport, observation, and archival.

Also update the integration tests to use repo-local deterministic agents (for example `test-echo`) or explicit no-agent flows.

---

### 3) The SIGTERM → SIGKILL abort escalation is incorrect for real `ChildProcess` instances, and the proposed test masks the bug

Both proposed headless runners implement abort escalation as:

- send `SIGTERM`
- after 5 seconds, send `SIGKILL` only if `!proc.killed`

See `.pi/plans/2026-04-20-mux-free-execution-design-v1.md:1245-1256` and `.pi/plans/2026-04-20-mux-free-execution-design-v1.md:2233-2240`.

That is not a reliable exit check in Node. `child.killed` flips to `true` when `kill()` successfully sends a signal, not when the process has actually exited. So after the initial `SIGTERM`, the 5-second callback can observe `proc.killed === true` and incorrectly skip `SIGKILL` even though the child is still alive.

The proposed unit test would not catch this because its fake process only sets `killed = true` on `SIGKILL`, not on `SIGTERM` (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:1409-1416`). That means the test passes specifically because the mock does **not** behave like the real API.

#### Why this blocks

Cancellation is part of the tool contract. As written, the implementation could leave stubborn child processes alive past the documented cancellation budget while the tests incorrectly report success.

#### Recommended fix

Track process exit explicitly rather than keying escalation off `proc.killed`.

For example:

- maintain an `exited` boolean set from `close` / `exit`
- on abort, send `SIGTERM`
- after 5 seconds, send `SIGKILL` if `exited === false`

And update the unit test so the fake process flips its state on `SIGTERM` the same way a real `ChildProcess` would.

---

### 4) The headless Claude design drops `resumeSessionId`

`resumeSessionId` is already part of the orchestration task surface, and the current Claude pane path threads it into `buildClaudeCmdParts()` (`pi-extension/subagents/index.ts:748-755`).

The proposed headless Claude argument construction omits it entirely (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:2140-2173`). So any headless Claude task that intends to resume an existing conversation would silently start fresh instead.

#### Why this blocks

This is a real contract regression on an already-exposed field, not an optional enhancement.

#### Recommended fix

Thread `resumeSessionId` through the shared launch-resolution layer and the headless Claude arg builder, and add a focused unit/integration test proving it is preserved.

## Non-blocking notes

### 1) Task 8's test-edit instructions are not executable as written

Task 8 says to add a new block to `test/orchestration/default-deps.test.ts` after the existing `it` block, but the proposed snippet starts with new top-level ESM imports (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:624-629`). The current file is a standard top-import ESM file (`test/orchestration/default-deps.test.ts:1-21`), so literal append-as-written would be invalid syntax. The plan should say to merge those imports into the existing header.

### 2) The Phase 1 narrative contradicts the selector implementation shown later

The Phase 1 intro says `selectBackend()` is hard-gated to always return `"pane"` until Phase 2 (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:320`), but Task 7's implementation explicitly returns `"headless"` for `PI_SUBAGENT_MODE=headless` and for `auto` when no mux is present (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:575-597`). The later code block is the real behavior; the earlier narrative should be corrected.

### 3) The direct dependency story for `@mariozechner/pi-ai` should be made explicit

The plan currently treats `@mariozechner/pi-ai` as transitively available and only suggests a fallback peerDependency if resolution fails (`.pi/plans/2026-04-20-mux-free-execution-design-v1.md:9,394-395`). If this fork imports the package directly, the plan should state clearly whether it must become a direct dependency/devDependency rather than relying on transitive layout stability.

## Conclusion

I would not start implementation from v1 as written. The plan should first be revised to:

1. make the real orchestration entrypoint able to reach headless mode in no-mux environments, and test that path end-to-end
2. preserve current subagent semantics by sharing launch-resolution logic across pane and headless backends instead of reimplementing a reduced subset inside `headless.ts`
3. fix the abort escalation design and its test so cancellation is reliable against real child processes
4. add `resumeSessionId` parity to the headless Claude path

Once those are addressed, this should be much closer to implementation-ready.
