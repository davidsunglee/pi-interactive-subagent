# Mux-Free Execution Implementation Plan (v11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a headless (stdio-piped, stream-json) execution backend alongside the existing pane backend in the `pi-interactive-subagent` fork, so that all three subagent surfaces — `subagent`, `subagent_serial`, and `subagent_parallel` — work in environments without a supported multiplexer (CI, headless SSH, IDE terminals). Close two adjacent gaps vs. the old `pi-subagent` extension: populate `usage` / `transcript[]` on `OrchestrationResult` from the headless path, and fix the tool-restriction security regression on the Claude path via an upstream-portable patch.

**Architecture — three layered changes:**

1. **Shared launch resolution above the backend seam.** Lift the launch normalization currently buried inside `launchSubagent()` into a pure `resolveLaunchSpec()` helper (new `pi-extension/subagents/launch-spec.ts`). The spec resolves agent defaults (`model` / `tools` / `skills` / `thinking` / `cli` / `body`), `cwd` and config-root (`localAgentDir` vs. propagated `PI_CODING_AGENT_DIR`), `system-prompt` mode (append/replace/agent-body fallback), seeded session / `fork` / `session-mode` lineage, artifact-backed task delivery, deny-tools, auto-exit, skill prompt expansion, `subagent-done` extension wiring, `subagentSessionFile` placement under `getDefaultSessionDirFor(...)`, and `resumeSessionId`. The pi backend consumes the full spec including `skillPrompts`; the Claude backend consumes everything **except** `skillPrompts` — see "Claude + skills: explicitly out of scope for v1" below for rationale. This eliminates the v1 risk of headless mode silently dropping or reinterpreting major chunks of the existing launch contract.
2. **Backend interface + selector.** Introduce a `Backend` interface in a new `pi-extension/subagents/backends/` directory with two implementations — `pane.ts` (thin adapter over the existing `launchSubagent` / `watchSubagent` — zero movement of upstream behavior) and `headless.ts` (new stream-json implementation that consumes a `ResolvedLaunchSpec` and spawns the CLI with piped stdio). The `Backend.launch()` entrypoint takes a `BackendLaunchParams` type: a superset of `OrchestrationTask` with `agent` optional, matching how `SubagentParams` already treats `agent` as optional on the bare `subagent` tool. `default-deps.ts` performs the trivial widening from `OrchestrationTask` to `BackendLaunchParams` at dispatch, so orchestration-tool validation is unaffected. Selection happens once per `makeDefaultDeps` call via `selectBackend()`, which honors `PI_SUBAGENT_MODE=pane|headless|auto` and falls back to mux detection when set to `auto` (default). `orchestration/default-deps.ts` routes through `selectBackend()`; the orchestration cores `run-serial` / `run-parallel` stay untouched. `OrchestrationResult` gains optional `usage?: UsageStats` and `transcript?: TranscriptMessage[]` fields populated by the headless backend only (pane leaves them `undefined`, deferred to a follow-up spec). The `TranscriptMessage` type is an orchestration-owned minimal shape (role + content blocks + optional per-message usage) — not a re-export of pi-ai's full `Message`, which requires provider/api/stopReason/etc. metadata the Claude path cannot produce truthfully. pi messages are *projected* onto `TranscriptMessage` at the headless backend boundary via `projectPiMessageToTranscript(msg)`; they are not structurally assigned. The projection normalizes pi-ai's `UserMessage.content: string | (TextContent | ImageContent)[]` into a uniform `TranscriptContent[]` block array so the public contract is honored for every `role` — user, assistant, and toolResult. The Claude headless path projects symmetrically: `parseClaudeStreamEvent` transforms `"assistant"` events' `tool_use` blocks to `toolCall` and — **v11 (review-v15 finding)** — projects `"user"` events carrying `tool_result` content blocks into `TranscriptMessage` entries with `role: "toolResult"`, `toolCallId`, `isError`, and a normalized `TranscriptContent[]` content array (one message per `tool_result` block so parallel tool calls retain a 1:1 toolCallId mapping). Without that second projection the Claude path would surface tool calls without their matching tool results — a gap that v10 left open and Task 21 now guards end-to-end.
3. **Backend-aware preflight + execute for all three subagent tools.** A new `preflightOrchestration()` replaces `preflightSubagent` on **all three** subagent tools — `subagent`, `subagent_serial`, and `subagent_parallel`. It only requires a multiplexer when `selectBackend()` resolves `pane`. When `selectBackend()` returns `headless`, all three surfaces proceed without raising the mux error. The orchestration tools already dispatch through `default-deps.ts` → `selectBackend()` for their launch/watch. The bare `subagent` tool's execute body is likewise rewritten to branch on `selectBackend()`: the pane branch keeps the existing `launchSubagent` + `watchSubagent` flow with its widget refresh and ping-via-sentinel handling intact; the headless branch dispatches via `makeHeadlessBackend(ctx).launch() + .watch()` with a simplified fire-and-forget result flow (no widget, no ping — the headless CLI doesn't emit ping-via-sentinel — but the same steer-message delivery at completion/error). End-to-end tests invoke the real registered tool callbacks in a no-mux environment to prove all three paths are reachable from the actual tool entrypoints.

A second named-commit patch to `pi-extension/subagents/index.ts` adds `PI_TO_CLAUDE_TOOLS` mapping + `--tools` emission inside `buildClaudeCmdParts` (the Claude built-in tool restriction primitive), fixing tool restriction for both backends. The mapping lives in a single shared module (`pi-extension/subagents/backends/tool-map.ts`) that both the pane builder (`index.ts`) and the headless builder (`backends/claude-stream.ts`) import from, so pane/headless Claude cannot silently drift.

**Claude + skills: explicitly out of scope for v1.** `resolveLaunchSpec()` continues to compute `effectiveSkills` / `skillPrompts` for both CLIs because it is a pure normalization step. The pi backend consumes `skillPrompts` by passing them as positional `messages[1..]` to the pi CLI, where `/skill:foo` is a recognized prefix that expands skill content. The Claude backend (pane **and** headless) does **not** consume `skillPrompts` in v1: Claude's skills are plugin/slash-command based and are resolved by the Claude CLI when the model invokes them — pi's message-prefix convention does not port over. Prefixing Claude's `-p` prompt with literal `/skill:foo` strings would leak them as task content rather than expand them. When `cli: "claude"` is combined with non-empty `effectiveSkills`, **both** Claude backends emit a one-time `stderr` warning (`pi-interactive-subagent: ignoring skills=<list> on Claude path — not supported in v1`) and proceed without them. The warning is emitted through a shared `warnClaudeSkillsDropped(name, effectiveSkills)` helper in `pi-extension/subagents/index.ts` that both `launchSubagent()`'s Claude branch and `runClaudeHeadless` call, so the pane and headless paths print identical wording from a single source of truth.

**Claude system-prompt contract.** `resolveLaunchSpec()` produces `identity = agentDefs?.body ?? params.systemPrompt ?? null` along with an `identityInSystemPrompt` placement switch and a `roleBlock`-embedded `fullTask`. That contract was designed for pi, which has two legitimate ways to deliver identity: as a separate `--system-prompt` / `--append-system-prompt` flag, or as a role-preamble block inside the task body (selected by whether `systemPromptMode` is set on the agent definition). Claude has no equivalent "role block in task body" convention — its `-p` prompt is atomic, and it already has native `--system-prompt` / `--append-system-prompt` flags — so a direct mechanical application of pi's rule to Claude would duplicate identity. The plan pins one authoritative Claude contract:

- **Identity source**: both Claude backends read `spec.identity` (= `agentDefs?.body ?? params.systemPrompt ?? null`). Same precedence as the pi path.
- **Identity placement**: identity is **always** emitted via a Claude system-prompt flag when `spec.identity` is non-null. `spec.systemPromptMode === "replace"` selects `--system-prompt`; anything else (including `undefined`) selects `--append-system-prompt`. The pi-only `spec.identityInSystemPrompt` field is deliberately ignored on the Claude path — for Claude, the flag is always the right placement, and there is no role-preamble alternative to toggle.
- **Task body**: Claude backends use `spec.claudeTaskBody` — a pi-wrapping-free task body that contains the mode hint and summary instruction (for blank-session modes) but **never** the role block. For `inheritsConversationContext === true` (fork), `claudeTaskBody === params.task` exactly. For blank-session modes, `claudeTaskBody = "${modeHint}\n\n${params.task}\n\n${summaryInstruction}"` — no leading `\n\n${roleBlock}`. Identity never enters the task body on the Claude path, so no duplication with the Claude flag is possible. `spec.fullTask` continues to include the role block — it exists for pi, which has the legacy behavior of consuming identity from the task body when `systemPromptMode` is unset.

The upshot: `spec.fullTask` and `spec.identityInSystemPrompt` are pi-specific outputs; Claude backends read `spec.identity` + `spec.systemPromptMode` + `spec.claudeTaskBody` instead. A focused launch-spec test (Task 9b Step 1) locks the mixed-case precedence (`agentDefs.body` + `params.systemPrompt` both set → `spec.identity` is `agentDefs.body`, not `params.systemPrompt`); parallel unit tests in Task 17 and Task 19 lock the Claude flag-selection and no-duplication contract end-to-end for each backend. A follow-up spec can design Claude-specific skill delivery once Claude's slash-command behavior under `-p` mode is validated.

**Tech Stack:** TypeScript (Node's native `--test` runner, `node:assert/strict`), `@sinclair/typebox` for tool schemas, `@mariozechner/pi-coding-agent` for the extension API, `node:child_process` `spawn` for stdio-piped CLI launch. `@mariozechner/pi-ai` is not a direct dependency of this fork — the pi headless backend parses raw pi-CLI stream-json payloads through a local `PiStreamMessage` type defined next to the parser boundary in `headless.ts`, capturing exactly the fields the `projectPiMessageToTranscript` projection and usage/stopReason accumulator read. No pi-ai symbol crosses the backend boundary, so `package.json` does not need a direct or transitive dependency claim on `@mariozechner/pi-ai` to hold.

---

## File Structure

**New files (shared launch resolution + headless backend + tests + typecheck wiring):**
- `tsconfig.json` — new minimal project config so `tsc --noEmit` is runnable via `npm run typecheck`. Non-strict (kept permissive so the existing codebase typechecks without forced refactors) — the gate catches gross type breakage when new files land. Added by Task 0.
- `pi-extension/subagents/launch-spec.ts` — pure `resolveLaunchSpec()` extracted from `launchSubagent()`; produces a `ResolvedLaunchSpec` consumed by both backends.
- `pi-extension/subagents/backends/types.ts` — `Backend` interface, `BackendLaunchParams` (new in v5, review-v6 blocker 3: supersets `OrchestrationTask` with `agent` optional so direct-backend callers and `makeHeadlessBackend()` / `makePaneBackend()` accept agent-less launches the way `SubagentParams` and `resolveLaunchSpec()` already do), `BackendResult`, `UsageStats`, shared re-exports of `LaunchedHandle` / `OrchestrationTask` / `ResolvedLaunchSpec`.
- `pi-extension/subagents/backends/pane.ts` — thin adapter over existing `launchSubagent` + `watchSubagent` (~30 LOC).
- `pi-extension/subagents/backends/headless.ts` — new stream-json implementation for both pi and Claude. Consumes `ResolvedLaunchSpec` for parity with the pane path (~500–600 LOC).
- `pi-extension/subagents/backends/select.ts` — `selectBackend()` resolver (`PI_SUBAGENT_MODE` + mux fallback, ~30 LOC).
- `pi-extension/subagents/backends/claude-stream.ts` — `parseClaudeStreamEvent` + `parseClaudeResult` + `ClaudeUsage` type. Lifted from `pi-subagent/claude-args.ts:153-204` (adapted, not copy-pasted). **v10 (review-v11 finding 3):** `PI_TO_CLAUDE_TOOLS` is no longer declared locally here — it is imported from the new shared `./tool-map.ts` module.
- `pi-extension/subagents/backends/tool-map.ts` — **new in v10 (review-v11 finding 3):** single source of truth for the pi → Claude CLI built-in tool-name mapping (`PI_TO_CLAUDE_TOOLS`). Imported by both pane-Claude (`pi-extension/subagents/index.ts`, Task 17) and headless-Claude (`pi-extension/subagents/backends/claude-stream.ts`, Task 19) builders so drift between the two is impossible.
- `pi-extension/subagents/preflight-orchestration.ts` — backend-aware preflight gate used by all three subagent tools (`subagent`, `subagent_serial`, `subagent_parallel`); only requires mux when `selectBackend() === "pane"`.
- `test/orchestration/select-backend.test.ts` — `PI_SUBAGENT_MODE` resolution + mux fallback unit tests.
- `test/orchestration/preflight-orchestration.test.ts` — verifies the backend-aware preflight passes in headless mode without mux (for all three subagent tools), and still surfaces `no session file` errors in both modes.
- `test/orchestration/launch-spec.test.ts` — unit tests for `resolveLaunchSpec()` (model/tools/skills/thinking/cli/cwd/system-prompt-mode/session-mode/deny-tools/auto-exit/skill-prompts/`resumeSessionId`).
- `test/orchestration/line-buffer.test.ts` — partial-line buffering across chunk boundaries.
- `test/orchestration/headless-abort.test.ts` — mocked-spawn SIGTERM → 5s → SIGKILL timing keyed off an explicit `exited` flag (not `proc.killed`).
- `test/orchestration/claude-event-transform.test.ts` — pure `parseClaudeStreamEvent` tool_use → toolCall transformation; also covers Claude headless `--resume` arg construction, the `--` separator before the task (v5 — review-v6 blocker 1), the Claude transcript discovery helper (v5 — review-v6 blocker 2: asserts it finds `<sessionId>.jsonl` under any `~/.claude/projects/*/` slug, not a guessed one), `--tools` emission (v6 — review-v7 finding 1), and the Claude+skills warning-and-drop behavior (v6 — review-v7 finding 3). **v10 (review-v11 finding 1):** gains a `buildClaudeHeadlessArgs` case that asserts the `--system-prompt` vs. `--append-system-prompt` selection is driven by `spec.systemPromptMode` (not `spec.identityInSystemPrompt`), and that `spec.claudeTaskBody` — not `spec.fullTask` — is the task body passed to the builder so the identity text never appears twice in the argv. **v11 (review-v15 finding):** gains a pair of `parseClaudeStreamEvent` cases that assert `user` events carrying `tool_result` content blocks are projected to a `TranscriptMessage` with `role: "toolResult"`, `toolCallId`, `isError`, and a normalized `content: TranscriptContent[]` block array — the counterpart to the existing `tool_use → toolCall` transform, and the unit half of the Task 21 integration-level toolResult assertion.
- `test/orchestration/pi-to-claude-tools.test.ts` — locks coverage of the shared `PI_TO_CLAUDE_TOOLS` map against the pane-path `BUILTIN_TOOLS` set in `launchSubagent()`'s pi branch. Every pi tool the pane path recognizes as built-in must have a Claude mapping; a new built-in added without a Claude mapping fails this test instead of being silently dropped under tool restriction. Lands in Task 19 Step 2b (not Task 17) because it asserts that `backends/claude-stream.ts` does not re-export a local copy of the map — an assertion only valid once Task 19 Step 1 has added the import from `tool-map.ts`.
- `test/integration/pi-pane-smoke.test.ts` — smoke test for the existing pane path (pi agent).
- `test/integration/orchestration-headless-no-mux.test.ts` — invokes all three real registered tool callbacks (`subagent`, `subagent_serial`, `subagent_parallel`) in two environment setups: (a) forced `PI_SUBAGENT_MODE=headless`, and (b) `PI_SUBAGENT_MODE` unset + all mux env vars cleared, proving each entrypoint reaches headless both when forced *and* via `selectBackend()`'s default auto fallback.
- `test/integration/headless-pi-smoke.test.ts` — headless pi path (uses repo-local `test-echo` agent).
- `test/integration/headless-claude-smoke.test.ts` — headless Claude path (no agent — direct fields).
- `test/integration/headless-tool-use.test.ts` — mid-stream tool-use parsing against the real Claude CLI. **v11 (review-v15 finding):** the test now asserts **both** the `toolCall` entry *and* the subsequent `toolResult` entry are preserved in `transcript[]`, not just `toolCalls.length > 0`. Uses direct Claude fields (`cli: "claude"`, `tools: "read"`) — no agent fixture is needed for this test since it targets the Claude stream-json parsing seam, not pi agent loading. Skips when `claude` is not on PATH.
- `test/integration/headless-transcript-archival.test.ts` — archival of pi + Claude transcripts.
- `test/integration/headless-abort-integration.test.ts` — long-running task abort.
- `test/integration/headless-enoent.test.ts` — CLI-not-on-PATH error path.
- `test/integration/headless-claude-resume.test.ts` — `resumeSessionId` round-trip for headless Claude (a focused gate for review finding 4).
- `test/integration/pane-claude-tool-restriction.test.ts` — **new in v6 (review-v7 additional note 2); v8 (review-v9 finding 1) switches its oracle from "assistant text contains marker" to "filesystem side-effect file exists with expected contents"**; **v9 (review-v10 finding 2) appends a second `describe("pane-claude-skills-warning", ...)` block that asserts the pane-Claude path emits the documented stderr warning when `effectiveSkills` is non-empty — no model invocation required because the warning fires at command-build time before the child spawns**. Exercises the full pane command-string path (not just the argv array) so the `--tools` emission is verified end-to-end. Skips when `claude` is not on PATH. **v10 (review-v11 finding 2):** the `pane-claude-skills-warning` describe block is rewritten so it actually traverses the pane launch flow — it invokes `launchSubagent({ cli: "claude", skills: "..." }, ctx, { surface: "fake-surface" })` with a pre-created fake surface to skip `createSurface`, captures stderr around the call, and catches the expected downstream `sendLongCommand` failure (mux is not available in test). The warning emits synchronously *before* `sendLongCommand`, so the stderr capture is populated regardless of the later failure. Now removing the `warnClaudeSkillsDropped(...)` line from `launchSubagent()` fails this test — v9's dynamic-import helper call was indistinguishable from the helper's own unit test and could not catch that regression.
- `test/integration/headless-claude-skills-warning.test.ts` — **new in v6 (review-v7 finding 3)**: asserts that when `cli: "claude"` is combined with non-empty skills, the headless Claude path emits the documented stderr warning and proceeds without the skills (not as literal task text).
- `test/orchestration/claude-skills-warning.test.ts` — **new in v9 (review-v10 finding 2)**: pure unit test that captures stderr around direct `warnClaudeSkillsDropped(name, effectiveSkills)` invocations. Asserts the helper writes a line containing the agent name and the skill list when skills are non-empty, and writes nothing when skills are empty / undefined. Guards the shared helper that both pane (Task 17 Step 3a) and headless (Task 19 Step 2) Claude paths call, so wording drift between the two call sites fails loud.
- `test/orchestration/pi-transcript-projection.test.ts` — **new in v7 (review-v8 finding 1)**: asserts that `projectPiMessageToTranscript` normalizes pi user messages with `content: string` into `TranscriptContent[]` block arrays, and that the other `role` branches preserve the required `toolCallId` / `toolName` / `isError` fields. Guards against a silent re-introduction of the v6 cast-based push that allowed `content: string` to escape through a field typed as `TranscriptContent[]`. **v9 (review-v10 finding 1):** the test is updated so its pi-stream fixture objects do not import or reference pi-ai's `Message` type — they match the local `PiStreamMessage` shape `projectPiMessageToTranscript` now accepts.

**Modified files (narrow changes):**
- `pi-extension/subagents/cmux.ts` — export a named `detectMux()` alias around existing `isMuxAvailable()` (for backend selection consumers).
- `pi-extension/subagents/index.ts` — six carried changes:
  1. **Baseline type-error cleanup** (Task 0 Step 5, review-v5 blocker): narrow two `.text` accesses on a `TextContent | ImageContent` union using a `type === "text"` guard, and add a no-op `invalidate(): void` member to two `registerMessageRenderer` return objects so they satisfy the `Component` interface from `@mariozechner/pi-tui`. Behavior-preserving — the runtime branch reached is the same, and there is no cached state to invalidate.
  2. **Refactor** `launchSubagent()` to delegate launch normalization to `resolveLaunchSpec()` (Task 10b). Behavior-preserving — pane tests must remain green.
  3. **Second named patch** alongside the existing `thinking` patch: add `effectiveTools?: string` to `ClaudeCmdInputs`, route it into `buildClaudeCmdParts`, import `PI_TO_CLAUDE_TOOLS` from the shared `backends/tool-map.ts` module (**v10, review-v11 finding 3:** was a local constant in v9; centralized now so the pane + headless builders cannot drift), and emit `--tools` (Task 17 — **v6: `--tools` replaces `--allowedTools`**, review-v7 finding 1). **v10 (review-v11 finding 1):** the call site now passes `spec.identity` / `spec.systemPromptMode` / `spec.claudeTaskBody` into `buildClaudeCmdParts` rather than `params.systemPrompt ?? agentDefs?.body` / `params.task` — so Claude's identity source + placement + task body match the spec contract on both backends.
  4. **Registration + bare-subagent execute wiring** (Task 7b): swaps `preflightSubagent` for `preflightOrchestration` on **all three** subagent tools — `subagent`, `subagent_serial`, and `subagent_parallel`. The orchestration tools already dispatch via `default-deps.ts` → `selectBackend()`. The bare `subagent` tool's execute body is rewritten to branch on `selectBackend()`: pane mode keeps the existing `launchSubagent` + `watchSubagent` flow (widget refresh + ping-via-sentinel handling unchanged); headless mode dispatches via `makeHeadlessBackend(ctx).launch() + .watch()` with a simplified steer-message result flow.
  5. **`shellEscape` re-export** (Task 17 Step 1 instruction correction, review-v7 additional note 1): add a one-line `export { shellEscape }` next to the existing exports so the test-file instruction "import `shellEscape` from `../../pi-extension/subagents/index.ts` because it is re-exported there" is accurate. No runtime behavior change.
  6. **Shared `warnClaudeSkillsDropped(name, effectiveSkills)` helper + pane-Claude call site** (Task 17 Step 3a, **v9 — review-v10 finding 2**): a small pure helper in `index.ts` that writes a single stderr line when `effectiveSkills` is non-empty and nothing otherwise. Called from `launchSubagent()`'s Claude branch immediately after `effectiveSkills` is resolved and before `buildClaudeCmdParts`; also imported by `headless.ts` so `runClaudeHeadless` (Task 19 Step 2) emits exactly the same wording. Exported so a focused unit test can capture stderr around a direct call.
- `pi-extension/orchestration/types.ts` — add optional `usage?: UsageStats` and `transcript?: TranscriptMessage[]` fields to `OrchestrationResult` (**v6: `transcript` replaces the ill-typed `messages: Message[]` from v5**, review-v7 finding 2). Re-export `UsageStats` and `TranscriptMessage` from the backends module.
- `pi-extension/orchestration/default-deps.ts` — rewire `launch` / `waitForCompletion` to dispatch through `selectBackend()` at module construction, preserving the `handleToRunning` bookkeeping and signal forwarding contract for the pane path, and adding equivalent bookkeeping for headless.
- `package.json` — one addition: a new `"typecheck": "tsc --noEmit"` script entry under `scripts` (Task 0). **v6 change:** v5's second addition — `@mariozechner/pi-ai` in both `peerDependencies` and `devDependencies` — is removed. v5 only added that dependency so the `OrchestrationResult.messages: Message[]` export could resolve; now that the field is renamed to `transcript: TranscriptMessage[]` (an orchestration-owned type), the direct dep addition is no longer required. The headless pi backend still uses pi-ai's `Message` internally via transitive resolution through `@mariozechner/pi-coding-agent`, which is how it resolves in the current fork tree (verified on-disk in v6).
- `README.md` — section describing `PI_SUBAGENT_MODE`, the headless backend's capabilities/limitations, and the new `usage` / `transcript` fields. Tool-restriction behavior for Claude is called out as a security fix (both backends; `--tools` is the emitted flag per v6). A note documents Claude + skills as out of scope for v1 and that **both** Claude backends (pane and headless) emit the same `ignoring skills=…` warning on stderr when `cli: "claude"` is combined with non-empty skills (review-v7 finding 3; **v9 — review-v10 finding 2:** README wording is updated from "headless emits a warning" to "both Claude backends emit a warning").

---

## Phase 0 — Baseline pane tests + typecheck wiring

Phase 0 establishes a regression safety net for the existing pane path before any refactor, and wires up the `npm run typecheck` gate that every subsequent phase relies on (review-v3 blocking finding 1 — the v2 plan called `npx tsc --noEmit` in six places but no `tsconfig.json` existed in this repo — and review-v5 blocking finding 1 — the v3 plan added the tsconfig but the repo still had pre-existing first-party type errors in `pi-extension/subagents/index.ts`, so the "clean baseline" promise did not hold).

Phase 0's gate into Phase 1: Task 0 ends with `npm run typecheck` exiting clean against the current codebase (including the core `pi-extension/subagents/index.ts` file that later phases patch), **and** the three Phase 0 baseline integration tests below (or their reasonable skip-paths) pass locally.

### Task 0: Wire up `npm run typecheck` so every subsequent type-gate is runnable, and fix the pre-existing baseline errors it surfaces

**Files:**
- Create: `tsconfig.json`
- Modify: `package.json` (add `"typecheck"` script)
- Modify: `pi-extension/subagents/index.ts` (baseline type-error cleanup — see Step 5)

This Task closes review-v3 blocking finding 1 **and** review-v5 blocking finding 1. The v2 plan called `npx tsc --noEmit` six times as a pass/fail gate, but the repo had no `tsconfig.json`, so the command was not even runnable (review-v3 blocker). v3 added the tsconfig and npm script, but `npm run typecheck` still exited non-zero against the current tree because of pre-existing first-party errors in `pi-extension/subagents/index.ts` — two unsafe `.text` accesses on a `TextContent | ImageContent` union, and two `registerMessageRenderer` return objects missing the `invalidate(): void` member required by the `Component` interface (review-v5 blocker). v4 fixes those directly so the promised clean baseline actually holds and every downstream "Expected: no errors" gate is a real signal for `pi-extension/subagents/index.ts` — which is exactly the file the rest of the plan refactors and patches.

The config is **intentionally permissive** — `strict: false`, `noImplicitAny: false`. The gate's purpose is to catch gross type breakage introduced by new files (missing imports, wrong shapes, typos in exported identifier names) without forcing an audit of the entire existing codebase before Phase 1 can start. The Step 5 cleanup below is scoped **only** to the two specific classes of errors surfaced against this file, not a general strictness pass. If a future hardening pass wants `strict: true`, that's a separate follow-up.

- [ ] **Step 1: Create `tsconfig.json` at the repo root**

Create `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "strict": false,
    "noImplicitAny": false,
    "types": ["node"]
  },
  "include": ["pi-extension/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "pi-extension/subagents/plugin/**"]
}
```

Notes:
- `allowImportingTsExtensions: true` is required because the codebase uses `.ts` suffix imports (e.g. `import { foo } from "./bar.ts"`), matching how Node's native `--experimental-strip-types` stripper expects them.
- `skipLibCheck: true` keeps the gate fast and avoids drifting on upstream `.d.ts` churn we don't control (e.g. `@mariozechner/pi-coding-agent` types).
- The `plugin/**` exclusion avoids typechecking the bundled Claude plugin's JavaScript / TypeScript, which is carried verbatim.

- [ ] **Step 2: Add the `typecheck` script to `package.json`**

Edit `package.json` → `scripts`:

```jsonc
{
  "scripts": {
    "test": "node --test test/test.ts test/system-prompt-mode.test.ts test/orchestration/*.test.ts",
    "test:integration": "node --test test/integration/*.test.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

Keep the existing `test` / `test:integration` lines verbatim — do not reorder. `typecheck` reads `tsconfig.json` automatically; no path argument needed.

- [ ] **Step 3: Ensure `typescript` is available as a devDependency**

Run: `ls node_modules/typescript/bin/tsc 2>/dev/null || npm install --save-dev typescript@^5.5 2>&1 | tail -5`
Expected: either the binary already exists (nothing to do), or the install completes successfully. If the install fails on host proxy/registry issues, surface the failure — do not paper over it with a skipped step.

After install, commit `package.json` + `package-lock.json` together with the tsconfig.

- [ ] **Step 4: Surface the current baseline errors**

Run: `npm run typecheck 2>&1 | tail -80`
Expected: the command runs (because Steps 1–3 wired it up) but exits **non-zero** against the current tree. The errors are the pre-existing first-party issues flagged by review-v5 blocking finding 1, and they are what Step 5 cleans up.

Concretely, you should see errors along these lines (line numbers as of the v4-writing baseline — may shift slightly):

- `pi-extension/subagents/index.ts:1323` and `:1434` — `Property 'text' does not exist on type 'TextContent | ImageContent'`. `ImageContent` has `data` / `mimeType`, not `text`, so indexing the first element of `result.content` and reading `.text` is unsafe at the type level even though the guarded `typeof … === "string"` check protects it at runtime (`node_modules/@mariozechner/pi-ai/dist/types.d.ts:76-94`).
- `pi-extension/subagents/index.ts:1654-1716` and `:1718-1752` — `Type '{ render(width: number): string[]; }' is not assignable to type 'Component'. Property 'invalidate' is missing`. The `Component` interface (`node_modules/@mariozechner/pi-tui/dist/tui.d.ts:9-30`) requires both `render(width)` and `invalidate(): void`; the `registerMessageRenderer(...)` return objects in this file only provide `render`. The renderers work at runtime because the pi TUI host tolerates the missing method today, but the return type demands it.

Do not relax `strict` / `noImplicitAny` further or widen `exclude` to silence these. Step 5 fixes them in place.

- [ ] **Step 5: Fix the pre-existing baseline errors in `pi-extension/subagents/index.ts`**

This is the review-v5 blocking-finding-1 remediation. `pi-extension/subagents/index.ts` is one of the main files this plan later refactors and patches (see the File Structure "Modified files" list), so getting its typecheck clean **before** Phase 1 is important — otherwise every subsequent "green typecheck" gate in the plan is meaningless for the file we care about most.

Two narrow edits in `pi-extension/subagents/index.ts`:

1. **Union-aware text extraction (two occurrences).** Replace the unsafe `.text` access with a type-narrowing guard on `type === "text"`. Before:
   ```ts
   // Fallback (shouldn't happen)
   const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
   return new Text(theme.fg("dim", text), 0, 0);
   ```
   After:
   ```ts
   // Fallback (shouldn't happen)
   const first = result.content?.[0];
   const text = first && first.type === "text" ? first.text : "";
   return new Text(theme.fg("dim", text), 0, 0);
   ```
   Apply the same rewrite at both sites (around lines 1322-1324 and 1433-1435). Behavior is unchanged — `first.type === "text"` narrows the union to `TextContent`, which is where the runtime `typeof … === "string"` guard was already aiming.

2. **Add `invalidate(): void` to each `registerMessageRenderer` return object.** Both `subagent_result` (around lines 1654-1716) and `subagent_ping` (around lines 1718-1752) return `{ render(width) { … } }`. Add a no-op `invalidate` method so the returned shape satisfies the `Component` interface from `@mariozechner/pi-tui`. Example:
   ```ts
   return {
     render(width: number): string[] {
       // …existing body unchanged…
     },
     invalidate() {},
   };
   ```
   The noop is intentional — these renderers compute output purely from `message` / `options` / `theme` each frame and hold no cached state to invalidate. Matching the interface on paper just makes the (correct) runtime behavior match the type.

Do **not** touch any other file in this step. These two changes are scoped exactly to what the v5 review flagged; they exist to make the promised baseline hold, not to broaden into a general typecheck-hardening pass.

- [ ] **Step 6: Re-run the typecheck and confirm a clean baseline**

Run: `npm run typecheck 2>&1 | tail -40`
Expected: **clean exit (code 0), no errors**.

If new errors appear that are not the ones Step 4 listed, triage them on a case-by-case basis:
- If the error is a trivial missing import / wrong identifier in code touched by Phase 0+ work, fix it in place.
- If it's a pre-existing cross-cutting issue (e.g. the upstream `ExtensionAPI` type drifted), relax the corresponding option in `tsconfig.json` (e.g. widen `exclude` more narrowly) — but do **not** reintroduce the two classes of errors Step 5 just fixed.
- If the error is in `pi-extension/subagents/plugin/**`, widen the `exclude` glob. That directory is carried verbatim from the Claude plugin and is not part of our TypeScript surface.

The goal is a green baseline that includes `pi-extension/subagents/index.ts`, so subsequent tasks can trust `npm run typecheck` as a real signal for the core file this plan refactors.

- [ ] **Step 7: Run the existing test suite to confirm the baseline-cleanup edits are behavior-preserving**

Run: `npm test 2>&1 | tail -40`
Expected: no new failures vs. the pre-edit state. The Step 5 edits are behavior-preserving:
- the `type === "text"` narrowing reaches the same runtime branch the old `typeof` check was aiming at;
- the no-op `invalidate()` is only called by the TUI on theme / width changes, and there was no cached state to invalidate before.

If a previously-passing test now fails, revert Step 5 and re-diagnose before continuing.

- [ ] **Step 8: Commit**

```bash
git add tsconfig.json package.json package-lock.json pi-extension/subagents/index.ts
git commit -m "build(typecheck): add tsconfig.json, typecheck script, and clean baseline typecheck errors"
```

### Task 1: Confirm existing pane integration tests run green

**Files:**
- Run: `test/integration/subagent-lifecycle.test.ts`
- Run: `test/integration/mux-surface.test.ts`

- [ ] **Step 1: Run the existing integration suite to establish baseline**

Run: `cd /Users/david/Code/pi-interactive-subagent && npm run test:integration 2>&1 | tail -80`
Expected: either all pass, or specific known failures. If running outside a multiplexer, expect the "No mux backend available — skipping" message for both `subagent-lifecycle` and `mux-surface` describes.

If tests fail for reasons unrelated to the mux environment (e.g. upstream API drift, typecheck errors, missing `pi` / `claude`), stop here and document failures before proceeding. The remaining Phase 0 tasks assume this baseline is green.

- [ ] **Step 2: Commit the clean baseline (no code change — marker only if needed)**

If no source files were touched, skip the commit. Proceed to Task 2.

### Task 2: Promote `claude-sentinel-roundtrip.test.ts` from scaffold to a real test

**Files:**
- Modify: `test/integration/claude-sentinel-roundtrip.test.ts`

- [ ] **Step 1: Read the current scaffold to preserve the skip-gate pattern**

Run: `cat test/integration/claude-sentinel-roundtrip.test.ts`
Expected: existing file with `CLAUDE_AVAILABLE` + `PLUGIN_PRESENT` skip conditions and a placeholder `it()` that asserts `true`.

- [ ] **Step 2: Replace the scaffold body with a real roundtrip assertion**

Replace the entire file with:

```ts
/**
 * Real Claude pane-path roundtrip test.
 *
 * Skipped when:
 *   - `claude` binary is not on PATH, or
 *   - The bundled `pi-extension/subagents/plugin/` is missing (fresh clone
 *     without submodules, etc.), or
 *   - No mux backend is available.
 *
 * What it asserts:
 *   - launchSubagent + watchSubagent complete without throwing
 *   - result.exitCode === 0
 *   - result.summary is non-empty
 *   - result.transcriptPath is non-null AND under ~/.pi/agent/sessions/claude-code/
 *   - existsSync(result.transcriptPath) === true (archival survives sentinel cleanup)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getAvailableBackends,
  setBackend,
  restoreBackend,
  createTestEnv,
  cleanupTestEnv,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";
import { launchSubagent, watchSubagent } from "../../pi-extension/subagents/index.ts";

const CLAUDE_AVAILABLE = (() => {
  try {
    execSync("which claude", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
const PLUGIN_DIR = join(
  new URL("../../pi-extension/subagents/plugin", import.meta.url).pathname,
);
const PLUGIN_PRESENT = existsSync(join(PLUGIN_DIR, "hooks", "on-stop.sh"));
const backends = getAvailableBackends();

const SHOULD_SKIP = !CLAUDE_AVAILABLE || !PLUGIN_PRESENT || backends.length === 0;

if (SHOULD_SKIP) {
  console.log(
    "⚠️  claude-sentinel-roundtrip skipped: " +
      `CLAUDE=${CLAUDE_AVAILABLE} PLUGIN=${PLUGIN_PRESENT} BACKENDS=${backends.length}`,
  );
}

for (const backend of backends) {
  describe(`claude-sentinel-roundtrip [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 2 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;

    before(() => {
      prevMux = setBackend(backend);
      env = createTestEnv(backend);
    });

    after(() => {
      cleanupTestEnv(env);
      restoreBackend(prevMux);
    });

    it("archives transcriptPath under ~/.pi/agent/sessions/claude-code/ after completion", async () => {
      const ctx = {
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "test-session",
          getSessionDir: () => env.dir,
        },
        cwd: env.dir,
      };

      const running = await launchSubagent(
        {
          name: "ClaudeRoundtrip",
          task: "Reply with exactly: OK",
          cli: "claude",
        },
        ctx,
      );
      env.surfaces.push(running.surface);

      const abort = new AbortController();
      const result = await watchSubagent(running, abort.signal);

      assert.equal(result.exitCode, 0, `expected clean exit, got ${result.exitCode}`);
      assert.ok(result.summary && result.summary.trim().length > 0, "summary must be non-empty");
      assert.ok(result.transcriptPath, "transcriptPath must be non-null");
      const archiveRoot = join(homedir(), ".pi", "agent", "sessions", "claude-code");
      assert.ok(
        result.transcriptPath!.startsWith(archiveRoot),
        `transcriptPath must be under ${archiveRoot}, got ${result.transcriptPath}`,
      );
      assert.ok(existsSync(result.transcriptPath!), "archived transcript file must exist");
    });
  });
}
```

- [ ] **Step 3: Run the promoted test locally to confirm it passes (or skips cleanly)**

Run: `npm run test:integration -- --test-name-pattern='claude-sentinel-roundtrip' 2>&1 | tail -40`
Expected: either the described test passes, or the "skipped" line prints (if `claude` isn't on PATH or no mux).

- [ ] **Step 4: Commit**

```bash
git add test/integration/claude-sentinel-roundtrip.test.ts
git commit -m "test(integration): promote claude-sentinel-roundtrip from scaffold to real"
```

### Task 3: Add `pi-pane-smoke.test.ts`

**Files:**
- Create: `test/integration/pi-pane-smoke.test.ts`

- [ ] **Step 1: Read the `test-echo.md` agent frontmatter to mirror its expectations**

Run: `cat test/integration/agents/test-echo.md`
Expected: frontmatter includes `auto-exit: true`, `model: anthropic/claude-haiku-4-5`, `tools: read, bash, write, edit`.

- [ ] **Step 2: Write the pi-pane-smoke test**

Create `test/integration/pi-pane-smoke.test.ts`:

```ts
/**
 * Smoke test for the EXISTING pi pane path.
 *
 * Phase 0 baseline — guards against refactor regressions when the Backend
 * abstraction lands in Phase 1. Uses the auto-exit `test-echo` agent so the
 * subagent self-terminates without manual sentinel nudging.
 *
 * Skipped when `pi` is not on PATH or no mux is available.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getAvailableBackends,
  setBackend,
  restoreBackend,
  createTestEnv,
  cleanupTestEnv,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";
import { launchSubagent, watchSubagent } from "../../pi-extension/subagents/index.ts";

const PI_AVAILABLE = (() => {
  try {
    execSync("which pi", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
const backends = getAvailableBackends();
const SHOULD_SKIP = !PI_AVAILABLE || backends.length === 0;

if (SHOULD_SKIP) {
  console.log(
    `⚠️  pi-pane-smoke skipped: PI=${PI_AVAILABLE} BACKENDS=${backends.length}`,
  );
}

for (const backend of backends) {
  describe(`pi-pane-smoke [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 2 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;

    before(() => {
      prevMux = setBackend(backend);
      env = createTestEnv(backend);
    });

    after(() => {
      cleanupTestEnv(env);
      restoreBackend(prevMux);
    });

    it("spawns test-echo agent, completes with clean exit, archives session", async () => {
      const ctx = {
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "test-session",
          getSessionDir: () => env.dir,
        },
        cwd: env.dir,
      };

      const running = await launchSubagent(
        {
          name: "PiPaneSmoke",
          task: "Reply with exactly: OK",
          agent: "test-echo",
        },
        ctx,
      );
      env.surfaces.push(running.surface);

      const abort = new AbortController();
      const result = await watchSubagent(running, abort.signal);

      assert.equal(result.exitCode, 0, `expected clean exit, got ${result.exitCode}`);
      assert.ok(result.summary && result.summary.trim().length > 0, "summary must be non-empty");
      assert.ok(result.sessionFile, "sessionFile must be set on pi path");
      assert.ok(existsSync(result.sessionFile!), "session file must exist on disk");
      assert.equal(result.transcriptPath, result.sessionFile, "transcriptPath aliases sessionFile on pi path");
    });
  });
}
```

- [ ] **Step 3: Run the new test locally**

Run: `npm run test:integration -- --test-name-pattern='pi-pane-smoke' 2>&1 | tail -40`
Expected: either passes or prints the skip line.

- [ ] **Step 4: Commit**

```bash
git add test/integration/pi-pane-smoke.test.ts
git commit -m "test(integration): add pi pane smoke test for Phase 0 baseline"
```

---

## Phase 1 — Backend interface + pane adapter + shared launch resolution

Phase 1 introduces the `Backend` seam, the `resolveLaunchSpec()` extraction, and the backend-aware orchestration preflight without changing observable pane behavior.

Selector behavior in Phase 1: `selectBackend()` honors `PI_SUBAGENT_MODE` and the auto/no-mux fallback exactly as it will in Phase 2 (see Task 7 below). The Phase 1 `HeadlessBackend` is a stub that throws "not implemented" — so anyone who explicitly resolves to headless (either via `PI_SUBAGENT_MODE=headless` or via auto-no-mux) gets a clean, actionable error rather than silent fallback. Phase 2 replaces the stub with the real implementation; the selector itself is final after Task 7. **All three subagent tools** — `subagent`, `subagent_serial`, `subagent_parallel` — route their preflight through `preflightOrchestration` (Task 7b) and become backend-aware in Phase 1. The orchestration tools' launch/watch dispatch is rewired through `default-deps.ts` → `selectBackend()` in Task 8; the bare `subagent` tool's execute is rewired to branch on `selectBackend()` inside Task 7b Step 4b.

> **⚠️ Release sequencing.** Tasks 7b and 8 together change the preflight gate from "mux required" to "mux required only for pane; headless passes through" for all three subagent tools. On this long-lived branch that is fine because Phase 2 lands the real headless backend shortly after. But **these Phase 1 commits must not ship to users without the Phase 2 backend behind them** — if they did, a no-mux user running any of the three subagent tools would stop seeing the current clear mux error (which at least tells them to install tmux) and start falling into the Phase 1 stub's `headless backend not implemented yet (Phase 2). Unset PI_SUBAGENT_MODE or set PI_SUBAGENT_MODE=pane ...` message, which is a worse end-user experience than the status quo. Concretely:
>
> - Do not cut a release or merge a user-visible tag that contains the Task 7b / Task 8 commits without also containing the Phase 2 Task 11 (headless pi) commit — Task 11 overwrites the stub.
> - If Phase 1 must merge to the default branch before Phase 2 is ready, gate the behavior change: either keep the old `preflightSubagent` registered and swap to `preflightOrchestration` as the last commit *after* Task 11 lands, or guard the selector with `PI_SUBAGENT_ENABLE_HEADLESS=1` until Phase 2 is complete.
> - Task 9c is the explicit Phase 1 gate that checks this invariant before Phase 2 begins. Do not proceed past Task 9c with Phase 1 preflight merged but Phase 2 stub still throwing.

### Task 4: Define the `Backend` interface and shared types

**Files:**
- Create: `pi-extension/subagents/backends/types.ts`

- [ ] **Step 1: Write the interface and result types**

Create `pi-extension/subagents/backends/types.ts`:

```ts
import type { LaunchedHandle, OrchestrationTask } from "../../orchestration/types.ts";

export type { LaunchedHandle, OrchestrationTask };

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/**
 * Minimal orchestration-owned transcript type (v6 — review-v7 finding 2).
 *
 * `@mariozechner/pi-ai`'s `Message` is a discriminated union where
 * `AssistantMessage` requires `api`, `provider`, `model`, `usage`,
 * `stopReason`, `timestamp` and `ToolResultMessage` requires
 * `toolCallId`, `toolName`, `isError`, `timestamp`. The Claude stream-json
 * path does not emit any of that metadata in a well-formed way — v5's
 * draft pushed objects via `as Message` / `as unknown as Message` casts,
 * which made the exported type lie to downstream callers (who were then
 * invited to treat the objects as real pi-ai Messages and read
 * `usage` / `timestamp` / `stopReason` fields that aren't there).
 *
 * Rather than fabricate metadata we can't justify, we expose a
 * deliberately-minimal type reflecting what the stream actually produces:
 * a role + a content array whose block types are "text" | "toolCall" |
 * "toolResult". Consumers that need richer metadata (stopReason, cost
 * breakdown, etc.) should read `usage` on BackendResult or the archived
 * transcript file on disk — not synthesize it from this array.
 *
 * The pi headless backend's internal parser narrows to `TranscriptMessage`
 * at the backend boundary by projecting only `role` and `content` via
 * `projectPiMessageToTranscript` (see `headless.ts`). v9 (review-v10
 * finding 1): that projection is typed against a local `PiStreamMessage`
 * struct rather than pi-ai's `Message` union, so neither this file nor
 * `headless.ts` imports a type from `@mariozechner/pi-ai` — the fork has
 * no direct dependency on that package, and relying on transitive
 * hoisting for a type import is a silent-break surface across package-
 * manager and version changes.
 */
export type TranscriptContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "image"; data: string; mimeType: string };

export interface TranscriptMessage {
  role: "user" | "assistant" | "toolResult";
  content: TranscriptContent[];
  /** toolResult-only fields (when role === "toolResult"). */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/**
 * Block-type shapes are chosen to be a structural supertype of pi-ai's
 * `TextContent | ThinkingContent | ToolCall | ImageContent` so the pi
 * headless backend can project its stream-parsed payloads onto this type
 * at the boundary (v9, review-v10 finding 1: the projection's input is
 * a local `PiStreamMessage` struct, not an imported pi-ai `Message`). The Claude
 * path emits `text` + `toolCall` from `"assistant"` events and
 * `{ role: "toolResult", content, toolCallId, isError }` from `"user"`
 * events carrying `tool_result` blocks (v11, review-v15 finding — the
 * tool-result half of the round-trip was missing in v10, so Task 21 could
 * only observe tool calls). See Task 18 (`parseClaudeStreamEvent`) for the
 * Claude-side transformations and Task 11 for the pi-side pass-through.
 */

export interface BackendResult {
  name: string;
  finalMessage: string;
  transcriptPath: string | null;
  exitCode: number;
  elapsedMs: number;
  sessionId?: string;
  error?: string;
  /** Headless backend only in v1; pane leaves undefined. */
  usage?: UsageStats;
  /**
   * Headless backend only in v1; pane leaves undefined.
   *
   * v6 (review-v7 finding 2): renamed from `messages: Message[]` to
   * `transcript: TranscriptMessage[]`. See `TranscriptMessage` JSDoc for
   * why we do not use pi-ai's `Message` here.
   */
  transcript?: TranscriptMessage[];
}

/**
 * Parameters a backend needs to launch a subagent.
 *
 * This is a superset of `OrchestrationTask` with `agent` made optional,
 * mirroring the surface `SubagentParams` already exposes on the bare
 * `subagent` tool (`pi-extension/subagents/index.ts:61-66` — `agent` is
 * `Type.Optional(Type.String())`). `resolveLaunchSpec()` already handles
 * launches without an agent by falling back to the direct fields
 * (`model` / `tools` / `systemPrompt` / ...), so accepting that shape at
 * the backend seam matches what actually works.
 *
 * Why not reuse `OrchestrationTask` directly (review-v6 blocker 3)?
 * `OrchestrationTaskSchema` declares `agent: Type.String({...})` as
 * required (`pi-extension/orchestration/types.ts:6`) — that requirement
 * is correct for orchestration-tool validation (orchestration is agent-
 * centric by design), but it's wrong for the backend seam, which several
 * planned tests and the bare `subagent` tool both exercise agent-less.
 * Widening `OrchestrationTaskSchema` to make `agent` optional would be a
 * larger API change to the public orchestration tools, so we instead
 * introduce a dedicated backend type that is a strict superset and do
 * the trivial widening at `default-deps.ts` dispatch time.
 *
 * Keep the field list in sync with `OrchestrationTask` so
 * `default-deps.ts` can pass a task through with a simple spread.
 */
export interface BackendLaunchParams {
  /** Display/log name. Auto-generated if omitted. */
  name?: string;
  /** Agent definition name. Optional at the backend seam (see comment above). */
  agent?: string;
  /** The task/prompt. Required. */
  task: string;
  /** "pi" (default) or "claude". Free-form string; unknown values fall back to pi. */
  cli?: string;
  model?: string;
  thinking?: string;
  systemPrompt?: string;
  skills?: string;
  tools?: string;
  cwd?: string;
  fork?: boolean;
  resumeSessionId?: string;
  focus?: boolean;
}

export interface Backend {
  launch(
    params: BackendLaunchParams,
    defaultFocus: boolean,
    signal?: AbortSignal,
  ): Promise<LaunchedHandle>;
  watch(handle: LaunchedHandle, signal?: AbortSignal): Promise<BackendResult>;
}
```

Why this shape (v5 — review-v6 blocker 3):
- `BackendLaunchParams` is a structural superset of `OrchestrationTask` — every `OrchestrationTask` value is assignable to `BackendLaunchParams` (agent present is still a valid agent-optional record). `default-deps.ts` will therefore pass `OrchestrationTask` values through by widening: `backend.launch(task as BackendLaunchParams, ...)` or just `backend.launch(task, ...)` since TS structural subtyping accepts it.
- Phase 2/3 direct-backend tests (Tasks 20, 21, 23, 22, 22b) that pass `{ task: "Reply: OK", cli: "claude" }` or `{ task: ..., cli: "claude", tools: "read" }` type-check against this shape without needing a throwaway `agent`.
- The bare `subagent` tool is untouched; orchestration-tool validation via `OrchestrationTaskSchema` is untouched. Only the *backend-seam* type is widened.

- [ ] **Step 2: Verify typecheck passes**

**v6 (review-v7 finding 2) / v9 (review-v10 finding 1):** v5's Step 2 added `@mariozechner/pi-ai` to `package.json` as a direct `peerDependencies` + `devDependencies` entry. That addition was only required because v5's `types.ts` re-exported pi-ai's `Message` out through the `BackendResult.messages` field. v6 dropped that export in favor of the orchestration-owned `TranscriptMessage`. v9 closes the remaining gap: `pi-extension/subagents/backends/headless.ts` no longer imports `Message` from `@mariozechner/pi-ai` either — the projection's input type is now a local `PiStreamMessage` struct. The fork therefore has **no** direct or indirect compile-time dependency on `@mariozechner/pi-ai`, so `package.json` stays as-is and the typecheck no longer relies on transitive hoisting through `@mariozechner/pi-coding-agent`.

No `package.json` edit is required in this Task. Skip the v5 dependency-add step entirely.

Run: `npm run typecheck 2>&1 | tail -40`
Expected: no errors mentioning `backends/types.ts`. If TypeScript complains that pi-ai `Message` is not resolvable from this file, that's expected and correct — `types.ts` **must not import `Message`** in v6.

- [ ] **Step 3: Commit**

```bash
git add pi-extension/subagents/backends/types.ts
git commit -m "feat(backends): define Backend interface + orchestration-owned TranscriptMessage type

The TranscriptMessage shape is a deliberately-minimal reflection of
what the Claude stream-json path actually produces — role + content
blocks. Using pi-ai's full Message would require fabricating api/
provider/usage/stopReason metadata we don't have, which v5 masked
with unsafe casts. Consumers that want richer transcripts should
read the archived .jsonl at BackendResult.transcriptPath."
```

### Task 5: Export a named `detectMux()` from `cmux.ts`

**Files:**
- Modify: `pi-extension/subagents/cmux.ts`

- [ ] **Step 1: Read the existing `isMuxAvailable` export**

Run: `grep -n 'isMuxAvailable\|export function' pi-extension/subagents/cmux.ts | head -20`
Expected: `isMuxAvailable` is already exported at the top of the file.

- [ ] **Step 2: Add a named alias for backend consumers**

Append to `pi-extension/subagents/cmux.ts` (after the existing `isMuxAvailable` export, around line 82):

```ts
/**
 * Named alias used by backend selection.
 *
 * `selectBackend()` in backends/select.ts reads this to decide whether to
 * route to pane (mux present) or headless (mux absent). Aliasing rather
 * than re-exporting `isMuxAvailable` under a second name keeps intent
 * clear at the import site (`detectMux()` reads as backend-selection;
 * `isMuxAvailable()` reads as a capability probe).
 */
export function detectMux(): boolean {
  return isMuxAvailable();
}
```

- [ ] **Step 3: Confirm the export resolves via import sanity check**

Run: `npm run typecheck 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add pi-extension/subagents/cmux.ts
git commit -m "feat(backends): expose detectMux() alias from cmux.ts"
```

### Task 6: Implement the pane adapter

**Files:**
- Create: `pi-extension/subagents/backends/pane.ts`

- [ ] **Step 1: Write the thin adapter**

Create `pi-extension/subagents/backends/pane.ts`:

```ts
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  launchSubagent,
  watchSubagent,
  type RunningSubagent,
} from "../index.ts";
import type {
  Backend,
  BackendLaunchParams,
  BackendResult,
  LaunchedHandle,
} from "./types.ts";

/**
 * Pane backend: thin adapter over existing launchSubagent + watchSubagent.
 *
 * Zero movement of upstream code — this file owns only the mapping
 * between the Backend interface and the existing primitives.
 *
 * `usage` and `transcript` on the returned BackendResult are intentionally
 * left undefined. Populating them from the pane path requires tapping
 * child stdout without losing the pane-TTY ergonomics, which is deferred
 * to a follow-up spec (see "Symmetric observability on the pane backend"
 * in the mux-free execution spec).
 */
export function makePaneBackend(ctx: {
  sessionManager: ExtensionContext["sessionManager"];
  cwd: string;
}): Backend {
  const handleToRunning = new Map<string, RunningSubagent>();

  return {
    async launch(
      params: BackendLaunchParams,
      defaultFocus: boolean,
      _signal?: AbortSignal,
    ): Promise<LaunchedHandle> {
      const resolvedFocus = params.focus ?? defaultFocus;
      const running = await launchSubagent(
        {
          name: params.name ?? "subagent",
          task: params.task,
          agent: params.agent,
          model: params.model,
          thinking: params.thinking,
          systemPrompt: params.systemPrompt,
          skills: params.skills,
          tools: params.tools,
          cwd: params.cwd,
          fork: params.fork,
          resumeSessionId: params.resumeSessionId,
          cli: params.cli,
          focus: resolvedFocus,
        },
        ctx,
      );
      handleToRunning.set(running.id, running);
      return { id: running.id, name: running.name, startTime: running.startTime };
    },

    async watch(
      handle: LaunchedHandle,
      signal?: AbortSignal,
    ): Promise<BackendResult> {
      const running = handleToRunning.get(handle.id);
      if (!running) {
        return {
          name: handle.name,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 1,
          elapsedMs: 0,
          error: `no running entry for ${handle.id}`,
        };
      }
      const abort = new AbortController();
      running.abortController = abort;
      let onToolAbort: (() => void) | null = null;
      if (signal) {
        if (signal.aborted) {
          abort.abort();
        } else {
          onToolAbort = () => abort.abort();
          signal.addEventListener("abort", onToolAbort, { once: true });
        }
      }
      try {
        const sub = await watchSubagent(running, abort.signal);
        return {
          name: handle.name,
          finalMessage: sub.summary,
          transcriptPath: sub.transcriptPath,
          exitCode: sub.exitCode,
          elapsedMs: sub.elapsed * 1000,
          sessionId: sub.claudeSessionId,
          error: sub.error,
        };
      } finally {
        if (signal && onToolAbort) signal.removeEventListener("abort", onToolAbort);
        handleToRunning.delete(handle.id);
      }
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck 2>&1 | tail -30`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add pi-extension/subagents/backends/pane.ts
git commit -m "feat(backends): add pane adapter over existing launchSubagent/watchSubagent"
```

### Task 7: Implement `selectBackend()` with `PI_SUBAGENT_MODE` resolution

**Files:**
- Create: `pi-extension/subagents/backends/select.ts`

- [ ] **Step 1: Write the selector with warn-once semantics**

Create `pi-extension/subagents/backends/select.ts`:

```ts
import { detectMux } from "../cmux.ts";

/** Module-level set so the same invalid value only warns once per process. */
const warnedInvalidValues = new Set<string>();

export type BackendKind = "pane" | "headless";

/**
 * Resolve the active backend from PI_SUBAGENT_MODE, falling back to
 * mux detection.
 *
 *   - PI_SUBAGENT_MODE=pane      → pane
 *   - PI_SUBAGENT_MODE=headless  → headless
 *   - PI_SUBAGENT_MODE=auto      → detectMux() ? pane : headless
 *   - PI_SUBAGENT_MODE unset     → auto (same as above)
 *   - PI_SUBAGENT_MODE=<other>   → warn-once to stderr, silent fallback
 *                                    to auto
 *
 * Phase 1 note: `headless` is accepted but the Phase 1 HeadlessBackend
 * stub throws "not implemented". Phase 2 replaces the stub with the real
 * implementation. Until then, production callers that want headless must
 * set the env var explicitly and accept the stub's error.
 */
export function selectBackend(): BackendKind {
  const raw = (process.env.PI_SUBAGENT_MODE ?? "auto").toLowerCase();
  if (raw === "pane") return "pane";
  if (raw === "headless") return "headless";
  if (raw !== "auto" && !warnedInvalidValues.has(raw)) {
    warnedInvalidValues.add(raw);
    process.stderr.write(
      `[pi-interactive-subagent] PI_SUBAGENT_MODE="${raw}" invalid; ` +
        `falling back to auto (valid: pane | headless | auto)\n`,
    );
  }
  return detectMux() ? "pane" : "headless";
}

/** Test-only: reset warn-once state so each test can observe the first-warn path. */
export const __test__ = {
  resetWarnedValues(): void {
    warnedInvalidValues.clear();
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add pi-extension/subagents/backends/select.ts
git commit -m "feat(backends): add selectBackend() resolver with PI_SUBAGENT_MODE override"
```

### Task 7b: Add backend-aware `preflightOrchestration` and wire all three subagent tools through it

**Files:**
- Create: `pi-extension/subagents/preflight-orchestration.ts`
- Modify: `pi-extension/subagents/index.ts` (registration call for orchestration tools *and* bare-subagent execute body)
- Create: `test/orchestration/preflight-orchestration.test.ts`

This Task closes the spec's no-mux promise for all three subagent surfaces. The new preflight helper replaces `preflightSubagent` on the bare `subagent` tool and on `subagent_serial` / `subagent_parallel`; the bare `subagent` tool's execute body gains a `selectBackend()` branch so its launch/watch actually reach the headless backend (the pane branch is unchanged, preserving widget refresh and ping-via-sentinel handling). The orchestration tools already dispatch via `default-deps.ts` → `selectBackend()` after Task 8, so for them the preflight swap alone suffices.

- [ ] **Step 1: Write the failing preflight unit tests**

Create `test/orchestration/preflight-orchestration.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  preflightOrchestration,
  __test__ as preflightTest,
} from "../../pi-extension/subagents/preflight-orchestration.ts";
import { __test__ as selectTest } from "../../pi-extension/subagents/backends/select.ts";

// Include ZELLIJ_SESSION_NAME alongside the TMUX/ZELLIJ/WEZTERM detection envs
// because `pi-extension/subagents/cmux.ts` treats ZELLIJ_SESSION_NAME as zellij
// runtime state; leaking it from the host would pollute supposedly "no mux"
// cases (review-v5 non-blocking note 1).
const MUX_KEYS = ["CMUX_SOCKET_PATH", "TMUX", "ZELLIJ", "ZELLIJ_SESSION_NAME", "WEZTERM_UNIX_SOCKET"];
const sessionOk = { sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" } };
const sessionMissing = { sessionManager: { getSessionFile: () => null } };

describe("preflightOrchestration", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of [...MUX_KEYS, "PI_SUBAGENT_MODE"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    selectTest.resetWarnedValues();
    preflightTest.resetMuxProbe();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    preflightTest.resetMuxProbe();
  });

  it("returns null in headless mode even when mux is absent", () => {
    process.env.PI_SUBAGENT_MODE = "headless";
    preflightTest.setMuxProbe(() => false);
    assert.equal(preflightOrchestration(sessionOk), null);
  });

  it("returns null in auto mode when mux is absent (selector resolves headless)", () => {
    // No PI_SUBAGENT_MODE set, no mux env vars set ⇒ selector returns headless.
    preflightTest.setMuxProbe(() => false);
    assert.equal(preflightOrchestration(sessionOk), null);
  });

  it("returns mux-error in pane mode when mux is absent", () => {
    process.env.PI_SUBAGENT_MODE = "pane";
    preflightTest.setMuxProbe(() => false);
    const result = preflightOrchestration(sessionOk);
    assert.ok(result, "must return an error result");
    assert.match(result!.details.error, /mux not available/);
  });

  it("returns no-session-file error in headless mode when getSessionFile returns null", () => {
    process.env.PI_SUBAGENT_MODE = "headless";
    preflightTest.setMuxProbe(() => false);
    const result = preflightOrchestration(sessionMissing);
    assert.ok(result);
    assert.match(result!.details.error, /no session file/);
  });

  it("returns no-session-file error in pane mode (mux present) when getSessionFile returns null", () => {
    // Use the injected mux-probe hook (review-v3 non-blocking note 3):
    // the v2 draft set TMUX=/tmp/tmux-fake here, but isMuxAvailable() also
    // requires `tmux` on PATH, so the test was host-dependent. Injecting a
    // truthy probe is deterministic across hosts.
    process.env.PI_SUBAGENT_MODE = "pane";
    preflightTest.setMuxProbe(() => true);
    const result = preflightOrchestration(sessionMissing);
    assert.ok(result);
    assert.match(result!.details.error, /no session file/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --test-name-pattern='preflightOrchestration' 2>&1 | tail -30`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Implement `preflightOrchestration`**

Create `pi-extension/subagents/preflight-orchestration.ts`:

```ts
import { selectBackend } from "./backends/select.ts";
import { isMuxAvailable, muxSetupHint } from "./cmux.ts";

type ErrorResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { error: string };
};

/**
 * Probe function for "is a supported multiplexer available?".
 *
 * Defaults to the real `isMuxAvailable()` from cmux.ts. Exposed as a
 * module-level swappable ref (see `__test__.setMuxProbe` below) so unit
 * tests can assert the "pane mode with mux present" branch
 * deterministically — without relying on the host actually having
 * `tmux`/`cmux`/`zellij` on PATH (review-v3 non-blocking note 3).
 */
let muxProbe: () => boolean = isMuxAvailable;

/**
 * Backend-aware preflight gate. Used by all three subagent tools —
 * `subagent`, `subagent_serial`, and `subagent_parallel` — in place of
 * the old mux-required `preflightSubagent`.
 *
 * Differs from preflightSubagent in one specific way: it consults
 * selectBackend() and only requires a multiplexer when the active
 * backend is "pane". When the active backend is "headless" (either
 * because PI_SUBAGENT_MODE=headless was set, or because no mux was
 * detected in auto mode), the mux error is suppressed — the caller
 * runs against the headless backend.
 *
 * The session-file check is unchanged: all three tools need a
 * persistent parent session to resolve artifact paths and sessionDir
 * placement. That requirement holds in both backends.
 *
 * Step 4 of Task 7b swaps this helper in at all three tool sites. The
 * bare `subagent` tool's execute body additionally branches on
 * selectBackend() so its launch/watch routes through the headless
 * backend when no mux is present; see Step 4b.
 */
export function preflightOrchestration(ctx: {
  sessionManager: { getSessionFile(): string | null };
}): ErrorResult | null {
  if (selectBackend() === "pane") {
    // Pane backend needs a multiplexer; mirror the existing message.
    // We re-check explicitly (rather than trusting selectBackend's
    // detectMux call) so a forced PI_SUBAGENT_MODE=pane without mux
    // still surfaces the helpful setup hint.
    if (!muxProbe()) {
      return {
        content: [
          { type: "text", text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}` },
        ],
        details: { error: "mux not available" },
      };
    }
  }
  if (!ctx.sessionManager.getSessionFile()) {
    return {
      content: [
        { type: "text", text: "Error: no session file. Start pi with a persistent session to use subagents." },
      ],
      details: { error: "no session file" },
    };
  }
  return null;
}

/**
 * Test-only hooks.
 *
 * `setMuxProbe` lets unit tests substitute a deterministic function for
 * `isMuxAvailable()` so the "pane mode, mux present" branch can be
 * exercised on hosts without tmux/cmux installed.
 * `resetMuxProbe` restores the real implementation so tests leave no
 * global side effect behind.
 */
export const __test__ = {
  setMuxProbe(fn: () => boolean): void {
    muxProbe = fn;
  },
  resetMuxProbe(): void {
    muxProbe = isMuxAvailable;
  },
};
```

Static-import rationale (review-v3 non-blocking note 1): the v2 draft used a dynamic `require("./cmux.ts")` to defer the dependency, but the package is ESM (`"type": "module"` in `package.json`), so `require` is not guaranteed to be available. The static import is both simpler and correct for this project.

- [ ] **Step 4: Wire `preflightOrchestration` into all three subagent tool registrations**

In `pi-extension/subagents/index.ts`, make three edits:

1. Add the import near the top of the file:

```ts
import { preflightOrchestration } from "./preflight-orchestration.ts";
```

2. Replace `preflightSubagent(ctx)` with `preflightOrchestration(ctx)` inside the bare `subagent` tool's `execute` body (currently around line 1179):

```ts
const preflight = preflightOrchestration(ctx);    // was preflightSubagent
if (preflight) return preflight;
```

3. Replace the `preflightSubagent` argument with `preflightOrchestration` in the orchestration registration call (currently around line 1794–1799):

```ts
registerOrchestrationTools(
  pi,
  (ctx) => makeDefaultDeps(ctx),
  shouldRegister,
  preflightOrchestration,    // was preflightSubagent
  selfSpawnBlocked,
);
```

After this Step the preflight gate is backend-aware for all three subagent tools. The orchestration tools already dispatch launch/watch through `default-deps.ts` → `selectBackend()` (Task 8), so the preflight swap alone makes them functional in headless. The bare `subagent` tool still calls the pane-only `launchSubagent` / `watchSubagent` directly, so after Step 4 a headless invocation would pass preflight and then fail at launch — **Step 4b is required for bare `subagent` to be fully no-mux functional.**

- [ ] **Step 4b: Rewire the bare `subagent` tool's execute to branch on `selectBackend()`**

Still in `pi-extension/subagents/index.ts`, inside the bare `subagent` tool's `execute` body (around line 1175–1256), branch on `selectBackend()` right after the `preflightOrchestration` check. The pane branch is the existing flow unchanged (widget refresh, ping-via-sentinel handling, steer messages). The headless branch dispatches through the headless backend adapter and delivers results through the same steer-message pattern but without pane-only glue.

Shape of the change:

```ts
// Add near the other imports at the top of the file:
import { selectBackend } from "./backends/select.ts";
import { makeHeadlessBackend } from "./backends/headless.ts";

// ... inside the bare `subagent` tool's execute, after the preflight check:

if (selectBackend() === "headless") {
  // Headless branch: fire-and-forget via the Backend interface.
  // No widget refresh (there is no pane TUI), no ping-via-sentinel
  // (the headless CLI does not emit pings), but the same steer-message
  // pattern so result delivery matches pane-mode from the model's view.
  const backend = makeHeadlessBackend(ctx);
  const handle = await backend.launch(params, params.focus ?? true);
  const watcherAbort = new AbortController();
  backend
    .watch(handle, watcherAbort.signal)
    .then((result) => {
      const sessionRef = result.sessionId
        ? `\n\nSession id: ${result.sessionId}`
        : "";
      const content =
        result.exitCode !== 0
          ? `Sub-agent "${handle.name}" failed (exit code ${result.exitCode}).\n\n${result.finalMessage}${sessionRef}`
          : `Sub-agent "${handle.name}" completed (${formatElapsed(result.elapsedMs / 1000)}).\n\n${result.finalMessage}${sessionRef}`;
      pi.sendMessage(
        {
          customType: "subagent_result",
          content,
          display: true,
          details: {
            name: handle.name,
            task: params.task,
            agent: params.agent,
            exitCode: result.exitCode,
            elapsed: result.elapsedMs / 1000,
            ...(result.sessionId ? { claudeSessionId: result.sessionId } : {}),
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    })
    .catch((err) => {
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: `Sub-agent "${handle.name}" error: ${err?.message ?? String(err)}`,
          display: true,
          details: { name: handle.name, task: params.task, error: err?.message },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    });

  return {
    content: [
      {
        type: "text",
        text:
          `Sub-agent "${params.name}" launched in the background (headless). ` +
          `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
          `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
          `Until then, move on to other work or tell the user you're waiting.`,
      },
    ],
    details: { name: params.name, task: params.task, agent: params.agent, backend: "headless" },
  };
}

// Pane branch — unchanged. Existing launchSubagent + watchSubagent flow,
// including startWidgetRefresh(), updateWidget(), and ping handling, follows
// here exactly as before.
```

Pane-only features — widget refresh, ping-via-sentinel steer messages — are deliberately absent from the headless branch. The headless CLI does not emit the pane sentinel, and there is no pane TUI widget to refresh. The steer-message completion/error pattern is preserved so the parent agent sees the same "sub-agent completed" / "sub-agent failed" / "sub-agent error" shape as pane-mode. Consumers that relied on `result.ping` or `startWidgetRefresh` in pane mode continue to work because the pane branch is untouched.

- [ ] **Step 5: Re-run the unit tests; expect all pass**

Run: `npm test -- --test-name-pattern='preflightOrchestration' 2>&1 | tail -30`
Expected: PASS, 5 tests.

The existing pane integration tests (Phase 0) and the no-mux integration tests (Task 23b) are the execution-level regression guards for Step 4b. After this Task they both cover the bare `subagent` tool path — confirm in Task 23b that the test file includes a `subagent` case alongside `subagent_serial` / `subagent_parallel`, or extend it there.

- [ ] **Step 6: Commit**

```bash
git add pi-extension/subagents/preflight-orchestration.ts test/orchestration/preflight-orchestration.test.ts pi-extension/subagents/index.ts
git commit -m "feat(orchestration): backend-aware preflight + bare-subagent headless dispatch unblock no-mux subagent/subagent_serial/subagent_parallel"
```

### Task 8: Rewire `default-deps.ts` to dispatch through `selectBackend()`

**Files:**
- Modify: `pi-extension/orchestration/default-deps.ts`

Phase 1 keeps `selectBackend()` pinned to `"pane"` in practice: the `HeadlessBackend` stub throws "not implemented". This Task only changes the dispatch shape; the Phase 0 pane tests must stay green.

- [ ] **Step 1: Write a failing test that exercises headless dispatch selection**

The existing `test/orchestration/default-deps.test.ts` already declares its `import { describe, it } …` and `import assert …` lines at the top of the file (see `test/orchestration/default-deps.test.ts:1-3`). Do **not** append a second top-level import block — Node's parser will reject imports below code. Instead:

1. Add `before, after` to the existing `import { describe, it } from "node:test"` line so it reads `import { describe, it, before, after } from "node:test"`.
2. Append the new `describe(...)` block (without its own imports) below the existing one.

Final shape (showing only the additions — keep the original `it` block intact):

```ts
// At top of file — extend the existing node:test import:
import { describe, it, before, after } from "node:test";
// (other existing imports unchanged)

// After the existing describe block, add:
describe("makeDefaultDeps backend selection", () => {
  let origMode: string | undefined;
  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
  });
  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
  });

  it("routes to headless backend when PI_SUBAGENT_MODE=headless (stub throws not-implemented)", async () => {
    process.env.PI_SUBAGENT_MODE = "headless";
    const deps = makeDefaultDeps({
      sessionManager: {
        getSessionFile: () => "/tmp/fake-session.jsonl",
        getSessionId: () => "test-session",
        getSessionDir: () => "/tmp",
      } as any,
      cwd: process.cwd(),
    });
    // Phase 1: stub backend throws. Phase 2 replaces the stub, at which
    // point this test is updated to assert real spawn behavior.
    await assert.rejects(
      () =>
        deps.launch(
          { agent: "x", task: "t" },
          false,
        ),
      /not implemented/i,
    );
  });
});
```

- [ ] **Step 2: Run the new test and confirm it fails (no headless stub wired yet)**

Run: `npm test -- --test-name-pattern='makeDefaultDeps backend selection' 2>&1 | tail -20`
Expected: FAIL — either the rejection message doesn't match, or `deps.launch` resolves.

- [ ] **Step 3: Add a headless stub and rewire `default-deps.ts` to dispatch**

First, create a tiny stub in `pi-extension/subagents/backends/headless.ts` (Phase 2 overwrites this file). Write:

```ts
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
  Backend,
  BackendLaunchParams,
  BackendResult,
  LaunchedHandle,
} from "./types.ts";

/**
 * Phase 1 stub — Phase 2 will overwrite this file with the real
 * stream-json implementation.
 *
 * Keeping the stub ensures:
 *   - default-deps.ts wiring is exercised by tests today
 *   - callers that set PI_SUBAGENT_MODE=headless see a clear,
 *     actionable error until Phase 2 lands
 */
export function makeHeadlessBackend(_ctx: {
  sessionManager: ExtensionContext["sessionManager"];
  cwd: string;
}): Backend {
  return {
    async launch(
      _params: BackendLaunchParams,
      _defaultFocus: boolean,
      _signal?: AbortSignal,
    ): Promise<LaunchedHandle> {
      throw new Error(
        "headless backend not implemented yet (Phase 2). " +
          "Unset PI_SUBAGENT_MODE or set PI_SUBAGENT_MODE=pane to use the existing pane backend.",
      );
    },
    async watch(_handle: LaunchedHandle, _signal?: AbortSignal): Promise<BackendResult> {
      throw new Error("headless backend not implemented yet (Phase 2).");
    },
  };
}
```

Then rewrite `pi-extension/orchestration/default-deps.ts`:

```ts
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { makePaneBackend } from "../subagents/backends/pane.ts";
import { makeHeadlessBackend } from "../subagents/backends/headless.ts";
import { selectBackend } from "../subagents/backends/select.ts";
import type { Backend, BackendLaunchParams } from "../subagents/backends/types.ts";
import type {
  LauncherDeps,
  LaunchedHandle,
  OrchestrationResult,
  OrchestrationTask,
} from "./types.ts";

/**
 * Build a LauncherDeps bound to the active session context.
 *
 * Selects a Backend (pane or headless) ONCE per makeDefaultDeps call via
 * selectBackend() (which reads PI_SUBAGENT_MODE and falls back to mux
 * detection). The chosen backend owns all orchestration IO — spawning,
 * waiting, transcript archival, abort handling, usage aggregation.
 *
 * Both backends implement the same Backend interface (launch + watch).
 * LauncherDeps adapts Backend to the existing orchestration-tool surface:
 * `waitForCompletion` spreads BackendResult into OrchestrationResult.
 * The new optional `usage` / `transcript` fields ride along transparently —
 * they're `undefined` when the pane backend produces the result, and
 * populated when the headless backend produces it.
 *
 * Type bridging (v5 — review-v6 blocker 3): `LauncherDeps.launch` takes
 * an `OrchestrationTask` (agent required, matching the orchestration-
 * tool validation surface), but `Backend.launch` takes the slightly
 * wider `BackendLaunchParams` (agent optional, matching what the bare
 * `subagent` tool and direct-backend tests already exercise). Every
 * `OrchestrationTask` value is structurally assignable to
 * `BackendLaunchParams`, so the forwarding below is a trivial widening —
 * no runtime transformation needed.
 */
export function makeDefaultDeps(ctx: {
  sessionManager: ExtensionContext["sessionManager"];
  cwd: string;
}): LauncherDeps {
  const kind = selectBackend();
  const backend: Backend = kind === "headless"
    ? makeHeadlessBackend(ctx)
    : makePaneBackend(ctx);

  return {
    async launch(
      task: OrchestrationTask,
      defaultFocus: boolean,
      signal?: AbortSignal,
    ): Promise<LaunchedHandle> {
      // Widening is structural: OrchestrationTask ⊂ BackendLaunchParams.
      const params: BackendLaunchParams = task;
      return backend.launch(params, defaultFocus, signal);
    },
    async waitForCompletion(
      handle: LaunchedHandle,
      signal?: AbortSignal,
    ): Promise<OrchestrationResult> {
      const r = await backend.watch(handle, signal);
      return {
        name: r.name,
        finalMessage: r.finalMessage,
        transcriptPath: r.transcriptPath,
        exitCode: r.exitCode,
        elapsedMs: r.elapsedMs,
        sessionId: r.sessionId,
        error: r.error,
        usage: r.usage,
        transcript: r.transcript,   // v6 rename (was `messages`), review-v7 finding 2
      };
    },
  };
}
```

- [ ] **Step 4: Re-run the new test and confirm it passes**

Run: `npm test -- --test-name-pattern='makeDefaultDeps backend selection' 2>&1 | tail -20`
Expected: PASS — `/not implemented/i` matches.

- [ ] **Step 5: Run the full pane-path integration tests to verify no regression**

Run: `npm run test:integration 2>&1 | tail -40`
Expected: same pass/skip set as Task 1 baseline. Any new failures mean the Backend indirection broke the pane path — debug before proceeding.

- [ ] **Step 6: Note about `OrchestrationResult` optional fields**

`types.ts` does not yet declare `usage` / `transcript`. `waitForCompletion` is currently constructing a result with extra properties that TypeScript will complain about. Skip this step if typecheck passed; if it did not, apply Task 25 Step 2 early (add the optional fields to `OrchestrationResult`) and re-typecheck. The clean Phase 4 work is the README-and-test pass; the type additions themselves are tiny and safe to land now.

- [ ] **Step 7: Commit**

```bash
git add pi-extension/subagents/backends/headless.ts pi-extension/orchestration/default-deps.ts test/orchestration/default-deps.test.ts
git commit -m "feat(backends): route default-deps through selectBackend() with pane/headless dispatch"
```

### Task 9: Unit-test `selectBackend()` resolution

**Files:**
- Create: `test/orchestration/select-backend.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/orchestration/select-backend.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { selectBackend, __test__ } from "../../pi-extension/subagents/backends/select.ts";

// Include ZELLIJ_SESSION_NAME — `cmux.ts` treats it as zellij runtime state,
// so leaving it set by the host would pollute "no mux" selector cases
// (review-v5 non-blocking note 1).
const SAVED_KEYS = ["PI_SUBAGENT_MODE", "CMUX_SOCKET_PATH", "TMUX", "ZELLIJ", "ZELLIJ_SESSION_NAME", "WEZTERM_UNIX_SOCKET"];

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of SAVED_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("selectBackend", () => {
  let snap: Record<string, string | undefined>;
  let origStderrWrite: typeof process.stderr.write;
  let stderrCapture: string;

  beforeEach(() => {
    snap = snapshotEnv();
    for (const k of SAVED_KEYS) delete process.env[k];
    __test__.resetWarnedValues();
    stderrCapture = "";
    origStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string | Buffer) => {
      stderrCapture += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
  });

  afterEach(() => {
    (process.stderr as any).write = origStderrWrite;
    restoreEnv(snap);
  });

  it("returns 'pane' when PI_SUBAGENT_MODE=pane (even without mux)", () => {
    process.env.PI_SUBAGENT_MODE = "pane";
    assert.equal(selectBackend(), "pane");
  });

  it("returns 'headless' when PI_SUBAGENT_MODE=headless (even with mux present)", () => {
    process.env.PI_SUBAGENT_MODE = "headless";
    process.env.TMUX = "/tmp/tmux-fake";
    assert.equal(selectBackend(), "headless");
  });

  it("is case-insensitive on PI_SUBAGENT_MODE", () => {
    process.env.PI_SUBAGENT_MODE = "HEADLESS";
    assert.equal(selectBackend(), "headless");
    process.env.PI_SUBAGENT_MODE = "Pane";
    assert.equal(selectBackend(), "pane");
  });

  it("warns once to stderr on invalid value then falls back to auto", () => {
    process.env.PI_SUBAGENT_MODE = "bogus";
    selectBackend();
    selectBackend(); // second call — should NOT re-warn
    const hits = stderrCapture.match(/PI_SUBAGENT_MODE="bogus" invalid/g) ?? [];
    assert.equal(hits.length, 1, `expected exactly one warn, got ${hits.length}`);
  });

  it("auto mode returns 'headless' when no mux env vars are set", () => {
    // All mux env vars cleared in beforeEach.
    assert.equal(selectBackend(), "headless");
  });

  // Note: we don't assert the auto→pane path here because that depends on
  // whether `which tmux`/`which cmux` succeed on the test host. The mux
  // detection path is exercised by integration tests instead; this unit
  // file sticks to deterministic env-var-only resolution.
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- --test-name-pattern='selectBackend' 2>&1 | tail -30`
Expected: all five tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/orchestration/select-backend.test.ts
git commit -m "test(backends): cover PI_SUBAGENT_MODE resolution and warn-once semantics"
```

### Task 9b: Extract `resolveLaunchSpec()` from `launchSubagent()` into a shared module

**Files:**
- Create: `pi-extension/subagents/launch-spec.ts`
- Modify: `pi-extension/subagents/index.ts` (rewrite `launchSubagent()` to consume the spec — behavior-preserving refactor)
- Create: `test/orchestration/launch-spec.test.ts`

This Task closes review finding 2. The current `launchSubagent()` (`pi-extension/subagents/index.ts:697-965`) entangles launch-time resolution (agent defaults, `cwd` and config-root, `system-prompt` mode, deny-tools, auto-exit, fork/session-mode/lineage, artifact-backed task delivery, skill prompt expansion, `subagent-done` extension wiring, session-file placement, `resumeSessionId`) with pane-specific transport (`createSurface`, `sendLongCommand`). Extracting the resolution into a pure function lets both backends consume the same fully-resolved spec — the headless backend (Phase 2/3) builds CLI args + env from the spec instead of reimplementing a reduced subset.

**Pane regression risk:** the pane integration tests from Phase 0 must remain green after this refactor. Run them before *and* after the change.

- [ ] **Step 1: Write failing unit tests for `resolveLaunchSpec()`**

Create `test/orchestration/launch-spec.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveLaunchSpec } from "../../pi-extension/subagents/launch-spec.ts";

const baseCtx = {
  sessionManager: {
    getSessionFile: () => "/tmp/parent.jsonl",
    getSessionId: () => "sess-test",
    getSessionDir: () => "/tmp",
  } as any,
  cwd: "/tmp",
};

describe("resolveLaunchSpec", () => {
  it("propagates direct fields when no agent is given", () => {
    const spec = resolveLaunchSpec(
      {
        name: "S1",
        task: "do",
        model: "anthropic/claude-haiku-4-5",
        thinking: "medium",
        cli: "pi",
        tools: "read,bash",
      },
      baseCtx,
    );
    assert.equal(spec.effectiveModel, "anthropic/claude-haiku-4-5");
    assert.equal(spec.effectiveThinking, "medium");
    assert.equal(spec.effectiveCli, "pi");
    assert.equal(spec.effectiveTools, "read,bash");
    assert.equal(spec.sessionMode, "standalone");
    assert.equal(spec.taskDelivery, "artifact");
    assert.equal(spec.autoExit, false);
    assert.deepEqual([...spec.denySet], []);
  });

  it("loads agent defaults and lets params override them", () => {
    // Uses the repo-local test-echo fixture (test/integration/agents/test-echo.md
    // with model anthropic/claude-haiku-4-5, tools "read, bash, write, edit",
    // auto-exit: true, spawning: false). Override model via params.
    const spec = resolveLaunchSpec(
      { name: "S2", task: "ping", agent: "test-echo", model: "anthropic/claude-sonnet-4-5" },
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    assert.equal(spec.effectiveModel, "anthropic/claude-sonnet-4-5");
    assert.equal(spec.effectiveTools, "read, bash, write, edit");
    assert.equal(spec.autoExit, true);
    assert.ok(spec.denySet.has("subagent_serial"));
  });

  it("flips taskDelivery to direct only when fork (or agent session-mode=fork) is set", () => {
    const a = resolveLaunchSpec({ name: "X", task: "t" }, baseCtx);
    assert.equal(a.taskDelivery, "artifact");
    const b = resolveLaunchSpec({ name: "X", task: "t", fork: true }, baseCtx);
    assert.equal(b.taskDelivery, "direct");
    assert.equal(b.sessionMode, "fork");
  });

  it("expands skill names into /skill: prompts in spec.skillPrompts", () => {
    const spec = resolveLaunchSpec(
      { name: "X", task: "t", skills: "foo, bar" },
      baseCtx,
    );
    assert.deepEqual(spec.skillPrompts, ["/skill:foo", "/skill:bar"]);
  });

  it("threads resumeSessionId through unchanged", () => {
    const spec = resolveLaunchSpec(
      { name: "X", task: "t", resumeSessionId: "abc-123" },
      baseCtx,
    );
    assert.equal(spec.resumeSessionId, "abc-123");
  });

  it("system-prompt mode 'replace' marks identityInSystemPrompt with --system-prompt flag", () => {
    // Use a fake agent-search dir with an agent declaring system-prompt: replace.
    // For this v1 test, exercise the params path by passing systemPrompt directly
    // and asserting the spec records it as appendable when no mode is set.
    const spec = resolveLaunchSpec(
      { name: "X", task: "t", systemPrompt: "you are a sentinel" },
      baseCtx,
    );
    assert.equal(spec.identity, "you are a sentinel");
    assert.equal(spec.identityInSystemPrompt, false);
    assert.match(spec.fullTask, /you are a sentinel/);
  });

  // v10 (review-v11 finding 1) — mixed precedence case. This locks the
  // authoritative Claude contract: when BOTH an agent body and a caller
  // systemPrompt are present, spec.identity must resolve to agentDefs.body
  // (NOT params.systemPrompt). This matches the pi-side resolution rule
  // in launchSubagent() today and closes the pane-vs-spec precedence
  // inversion review-v11 finding 1 flagged.
  it("resolves identity as agentDefs.body first when both agent body and caller systemPrompt are set", () => {
    // test-echo declares agent body text in its frontmatter + body; when we
    // *also* supply a caller systemPrompt, the spec must pick the agent body.
    const spec = resolveLaunchSpec(
      {
        name: "X",
        task: "t",
        agent: "test-echo",
        systemPrompt: "CALLER_PROMPT_SHOULD_NOT_WIN",
      },
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    assert.ok(spec.identity, "identity must be non-null when agent body present");
    assert.notEqual(spec.identity, "CALLER_PROMPT_SHOULD_NOT_WIN",
      "review-v11 finding 1 regression: pane-Claude inverted precedence (params.systemPrompt first) leaked into the spec");
    // The test-echo agent body contains some recognizable text; the
    // precise wording is not what we pin — we only pin "not the caller-supplied
    // string". That keeps the test robust to agent-body edits.
  });

  // v10 (review-v11 finding 1) — claudeTaskBody is a pi-wrapping-free task
  // body that Claude backends consume instead of fullTask. It must carry the
  // mode hint + summary instruction for blank-session modes but must never
  // include the role block (identity goes via the Claude flag instead). For
  // fork mode, claudeTaskBody === params.task exactly.
  it("exposes claudeTaskBody without the roleBlock for Claude backends to consume", () => {
    const blank = resolveLaunchSpec(
      { name: "X", task: "do-task", systemPrompt: "you are Y" },
      baseCtx,
    );
    // fullTask (for pi) contains identity via the role-block preamble.
    assert.match(blank.fullTask, /you are Y/);
    // claudeTaskBody must NOT contain the identity — Claude gets it via the
    // --append-system-prompt flag. This is the "no duplication" contract.
    assert.doesNotMatch(blank.claudeTaskBody, /you are Y/,
      "review-v11 finding 1 regression: identity text leaked into claudeTaskBody — Claude would see it via the flag AND the task body");
    // But the task itself + mode hint + summary instruction must still be present
    // on the Claude body so blank-session behavior matches pi.
    assert.match(blank.claudeTaskBody, /do-task/);

    const fork = resolveLaunchSpec(
      { name: "X", task: "do-task", systemPrompt: "you are Y", fork: true },
      baseCtx,
    );
    // In fork mode, the spec is not wrapped at all — claudeTaskBody === params.task.
    assert.equal(fork.claudeTaskBody, "do-task");
  });

  it("places subagentSessionFile under getDefaultSessionDirFor(targetCwd, agentDir)", () => {
    const spec = resolveLaunchSpec({ name: "X", task: "t" }, baseCtx);
    assert.match(spec.subagentSessionFile, /\.jsonl$/);
    // Path is under <agentDir>/sessions/<safe-cwd-slug>/
    assert.match(spec.subagentSessionFile, /sessions\/--tmp--\//);
  });
});
```

- [ ] **Step 2: Run the new test and confirm it fails (module not written yet)**

Run: `npm test -- --test-name-pattern='resolveLaunchSpec' 2>&1 | tail -30`
Expected: FAIL — module is missing.

- [ ] **Step 3: Implement `resolveLaunchSpec()` by extracting from `launchSubagent()`**

Create `pi-extension/subagents/launch-spec.ts`. The function must produce a `ResolvedLaunchSpec` that captures every field the existing `launchSubagent()` resolves. Move (do not duplicate) the relevant helpers — `loadAgentDefaults`, `resolveSubagentPaths`, `resolveLaunchBehavior`, `resolveDenyTools`, `getDefaultSessionDirFor`, `getArtifactDir`, `getAgentConfigDir`, `buildPiPromptArgs` — into `launch-spec.ts` and re-export them from `index.ts` so existing callers keep working.

Recommended interface:

```ts
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import type { SubagentParams } from "./index.ts";  // export the type

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface ResolvedLaunchSpec {
  // Identity / cli
  name: string;
  task: string;
  agent: string | undefined;
  effectiveCli: "pi" | "claude";

  // Model / tools / skills / thinking
  effectiveModel: string | undefined;
  effectiveTools: string | undefined;
  effectiveSkills: string | undefined;
  effectiveThinking: string | undefined;
  skillPrompts: string[];                  // already expanded to "/skill:X" strings

  // Cwd / config-root
  effectiveCwd: string | null;
  localAgentDir: string | null;
  effectiveAgentDir: string;
  /** Env to set on the child for config-root propagation. */
  configRootEnv: Record<string, string>;

  // System prompt
  identity: string | null;
  identityInSystemPrompt: boolean;
  systemPromptMode: "append" | "replace" | undefined;
  /** Wrapped task body (with role block + mode hint + summary instruction) for blank-session modes. Equals raw task in fork mode. Consumed by the pi path. */
  fullTask: string;
  /**
   * Claude-path task body. Same mode hint + summary instruction as fullTask for
   * blank-session modes, but **never** includes the role block — identity goes
   * through the Claude system-prompt flag instead (--system-prompt when
   * systemPromptMode === "replace", --append-system-prompt otherwise). In fork
   * mode this is exactly `params.task`. v10 (review-v11 finding 1) — pins the
   * "no duplication" contract across pane-Claude and headless-Claude.
   */
  claudeTaskBody: string;

  // Session lineage / delivery
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
  /** Where the subagent's own .jsonl session file lives. */
  subagentSessionFile: string;
  /** Where artifact-backed task files live. */
  artifactDir: string;

  // Per-launch toggles
  autoExit: boolean;
  denySet: Set<string>;
  resumeSessionId: string | undefined;
  focus: boolean | undefined;

  // Underlying agent definition (for callers that need raw frontmatter, e.g. body fallback).
  agentDefs: AgentDefaults | null;
}

export function resolveLaunchSpec(
  params: Static<typeof SubagentParams>,
  ctx: { sessionManager: ExtensionContext["sessionManager"]; cwd: string },
  opts?: { agentSearchDirs?: string[] },   // tests inject deterministic agent paths
): ResolvedLaunchSpec { ... }
```

The body is a near-verbatim lift of lines 702–917 of the current `launchSubagent()`, minus the `createSurface` / `sendLongCommand` calls (which stay in pane) and minus the artifact write side-effects (the spec returns the artifact path; pane vs. headless decide whether to materialize the file). Specifically:

- `effectiveModel/Tools/Skills/Thinking` — current lines 705-709.
- `effectiveCli` — current line 742 (`params.cli ?? agentDefs?.cli ?? "pi"`). Default to `"pi"` so spec callers don't have to repeat.
- `effectiveCwd / localAgentDir / effectiveAgentDir` — current `resolveSubagentPaths()` at line 716.
- `subagentSessionFile` — current lines 720-730 (deterministic timestamp + uuid).
- `sessionMode / seededSessionMode / inheritsConversationContext / taskDelivery` — current `resolveLaunchBehavior()` at line 799.
- `denySet` — current `resolveDenyTools(agentDefs)` at line 821.
- `identity / systemPromptMode / identityInSystemPrompt / roleBlock / fullTask` — current lines 823-829.
- `claudeTaskBody` (new in v10, review-v11 finding 1) — computed alongside `fullTask` but deliberately omits the `roleBlock`. Shape:
  ```ts
  const claudeTaskBody = inheritsConversationContext
    ? params.task
    : `${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;
  ```
  The `\n\n${roleBlock}` prefix that `fullTask` has when `identityInSystemPrompt` is false is deliberately absent here — identity reaches Claude via the system-prompt flag, never the task body, so any embedding would double up. See the "Claude system-prompt contract" subsection above for the full rationale.
- `skillPrompts` — current `buildPiPromptArgs()`'s skill expansion at line 619-625, broken out so the headless backend can prepend them to the `--message`/positional task.
- `configRootEnv` — equivalent to lines 877-881: `{ PI_CODING_AGENT_DIR: ... }` only when applicable.
- `autoExit` — `agentDefs?.autoExit === true`.
- `artifactDir` — `getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId())`.
- `resumeSessionId / focus` — pass-throughs from params.

Also expose `agentDefs` and the underlying agent body. In v9 the pane Claude path computed its own `appendSystemPrompt` with `params.systemPrompt ?? agentDefs?.body`, inverting the precedence `resolveLaunchSpec()` already applies — that inversion is removed in v10 (review-v11 finding 1). Both Claude backends now pass `spec.identity` (= `agentDefs?.body ?? params.systemPrompt`) through the Claude system-prompt flag directly, and use `spec.claudeTaskBody` for the task body; see the Claude system-prompt contract section near the top of this document.

- [ ] **Step 4: Rewrite `launchSubagent()` to consume the spec**

In `pi-extension/subagents/index.ts`, the body of `launchSubagent()` becomes:

```ts
export async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string }; cwd: string },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  if (!ctx.sessionManager.getSessionFile()) throw new Error("No session file");

  const spec = resolveLaunchSpec(params, ctx);
  // From here, every reference to effectiveModel / effectiveTools / agentDefs /
  // denySet / etc. reads from `spec` instead of recomputing. The pane-specific
  // sections (createSurface / sendLongCommand / launch script writing) are
  // unchanged in shape but read inputs from `spec`.
  // ...
}
```

Move the artifact-write side-effects (system-prompt file at line 855-858, task artifact at line 905-916) from `launchSubagent` into helper functions inside `launch-spec.ts` (e.g. `writeSystemPromptArtifact(spec)`, `writeTaskArtifact(spec, opts?: { flavor?: "pi" | "claude" })`) so the pane and headless paths share them. Pane keeps calling them; headless calls them too when `spec.taskDelivery === "artifact"`. **v10 (review-v11 finding 1):** `writeTaskArtifact` accepts a `flavor` option that defaults to `"pi"` (writes `spec.fullTask`, preserving v9 behavior for pi callers) and writes `spec.claudeTaskBody` when `flavor: "claude"` is passed. This keeps the artifact-contents / flag-contents split — identity never double-enters the Claude task body via the artifact path either. Callers: the pi path passes no flavor (defaults to pi); the Claude pane path does not use artifact delivery for v1 (it uses `params.task` — really `spec.claudeTaskBody` now — directly); the Claude headless path passes `flavor: "claude"` in `runClaudeHeadless` (Task 19 Step 2).

- [ ] **Step 5: Run the existing pane integration tests to confirm zero regression**

Run: `npm run test:integration 2>&1 | tail -40`
Expected: same pass/skip set as the Phase 0 baseline (Task 1). Any new failure means the refactor changed observable behavior — debug before committing.

- [ ] **Step 6: Run unit tests including the new `resolveLaunchSpec` cases**

Run: `npm test 2>&1 | tail -40`
Expected: every unit test passes, including the new `launch-spec.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add pi-extension/subagents/launch-spec.ts pi-extension/subagents/index.ts test/orchestration/launch-spec.test.ts
git commit -m "refactor(subagents): extract resolveLaunchSpec for shared launch normalization"
```

### Task 9c: Phase 1 release-sequencing gate (v5 — review-v6 non-blocking note 1)

**Files:** none modified; this is a read-only checkpoint.

This gate enforces the sequencing constraint spelled out in the Phase 1 intro: the Phase 1 preflight + dispatch changes must not reach end-users without the real Phase 2 headless backend behind them. It runs at the Phase 1 → Phase 2 boundary (i.e. now) and is re-run as part of the Phase 2 gate (Task 16) and final gate (Task 28).

- [ ] **Step 1: Confirm the Phase 1 headless stub is still a stub at this point**

Run: `grep -n 'headless backend not implemented yet' pi-extension/subagents/backends/headless.ts`
Expected: at least one hit — the Phase 1 stub string (set by Task 8). Phase 2 / Task 11 overwrites this file and removes the stub; its presence here confirms we have not accidentally landed the real backend ahead of schedule.

- [ ] **Step 2: Confirm the preflight is already wired for headless dispatch on all three subagent tools**

Run: `grep -n 'preflightOrchestration' pi-extension/subagents/index.ts`
Expected: three hits — the import, the call site inside the bare `subagent` tool's execute, and the argument in the orchestration-tool registration call (all from Task 7b Step 4). If fewer than three, Phase 1 is incomplete — stop and finish Task 7b before proceeding.

Also confirm the bare `subagent` execute has its `selectBackend()` branch:

Run: `grep -n 'selectBackend\(\) === "headless"' pi-extension/subagents/index.ts`
Expected: at least one hit inside the bare `subagent` tool's `execute` (from Task 7b Step 4b).

- [ ] **Step 3: Decide the release strategy for this branch**

If this branch will merge to `main` before Phase 2 completes, pick one of:

- **Keep Phase 1 on a feature branch until Phase 2 lands.** Simplest path; no follow-up work needed. Record the decision in the PR description.
- **Land Phase 1 now, feature-gated.** Guard the selector with `PI_SUBAGENT_ENABLE_HEADLESS=1` (or equivalent) until Task 11 is merged. In `pi-extension/subagents/backends/select.ts`, change the `return detectMux() ? "pane" : "headless";` fallback to return `"pane"` unless both `process.env.PI_SUBAGENT_ENABLE_HEADLESS === "1"` and mux is absent. Revert the guard at the end of Phase 2. If you pick this path, add a commit that removes the guard as the last step of Task 16.
- **Defer the registration swap.** In `pi-extension/subagents/index.ts`, keep `preflightSubagent` at both the orchestration-tool registration call and inside the bare `subagent` tool's `execute`, and add TODOs pointing at Task 11. Swap to `preflightOrchestration` at both sites as one commit immediately after Task 11 lands. If you pick this path, also defer Task 7b Step 4b (the bare-subagent execute `selectBackend()` branch) so the two changes land together — otherwise preflight still blocks on mux while the execute tries to dispatch headless, or vice versa. Stage the two changes as a single commit and hold it until Phase 2 is ready.

Whichever option you pick, **do not cut a user-visible release tag from this commit** without Phase 2 also merged. A no-mux user on such a release would lose the clear "mux required" error and land on the stub's less-useful `headless backend not implemented yet (Phase 2). Unset PI_SUBAGENT_MODE ...` message.

- [ ] **Step 4: Commit (if a guard or deferral was applied)**

If Step 3 changed code (added a feature-gate env var or deferred the registration swap), commit that change as its own named commit so reverting it after Phase 2 is trivial:

```bash
git add pi-extension/subagents/backends/select.ts
git commit -m "chore(backends): feature-gate headless dispatch until Phase 2 lands (revert after Task 11)"
```

If Step 3 kept the branch on feature-branch isolation, no commit is needed — proceed to Phase 2.

---

## Phase 2 — Headless pi backend

Phase 2 replaces the Phase 1 headless stub with the real pi implementation: spawn, stream-json parse, usage aggregation, transcript archival, abort. The implementation consumes `ResolvedLaunchSpec` (Task 9b) so it preserves the launch contract — agent defaults, system-prompt mode, fork/lineage seeding, artifact-backed task delivery, deny-tools, auto-exit, skill prompt expansion, `subagent-done` extension wiring, and session-file placement under `getDefaultSessionDirFor(...)` are all honored. Claude dispatch still routes to pane (or the stub throws) in this phase.

### Task 10: Build a partial-line buffer helper with tests

**Files:**
- Create: `pi-extension/subagents/backends/line-buffer.ts`
- Create: `test/orchestration/line-buffer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/orchestration/line-buffer.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LineBuffer } from "../../pi-extension/subagents/backends/line-buffer.ts";

describe("LineBuffer", () => {
  it("yields whole lines and keeps partials across chunks", () => {
    const buf = new LineBuffer();
    assert.deepEqual(buf.push("foo\nbar\nbaz"), ["foo", "bar"]);
    assert.deepEqual(buf.push("qux\n"), ["bazqux"]);
    assert.deepEqual(buf.flush(), []);
  });

  it("preserves empty lines between newlines", () => {
    const buf = new LineBuffer();
    assert.deepEqual(buf.push("a\n\nb\n"), ["a", "", "b"]);
  });

  it("flushes a trailing partial when the stream closes", () => {
    const buf = new LineBuffer();
    buf.push("partial");
    assert.deepEqual(buf.flush(), ["partial"]);
    // After flush, internal state is empty.
    assert.deepEqual(buf.flush(), []);
  });

  it("handles CR-LF gracefully (split still works on LF only — \\r is part of the line)", () => {
    const buf = new LineBuffer();
    assert.deepEqual(buf.push("a\r\nb\r\n"), ["a\r", "b\r"]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails (module not written yet)**

Run: `npm test -- --test-name-pattern='LineBuffer' 2>&1 | tail -20`
Expected: FAIL with "Cannot find module" or similar.

- [ ] **Step 3: Write the implementation**

Create `pi-extension/subagents/backends/line-buffer.ts`:

```ts
/**
 * Line-at-a-time accumulator for stream-json parsing.
 *
 * `push(chunk)` returns every complete line (terminated by `\n`) found
 * across the current chunk and any carry-over from prior chunks.
 * Partial trailing content is buffered until the next `push` or `flush`.
 *
 * Matches the pi-subagent stream loop's behavior (pi-subagent/index.ts:583-586
 * and :429-432) but extracted for direct unit testing.
 */
export class LineBuffer {
  private pending = "";

  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    return parts;
  }

  flush(): string[] {
    if (!this.pending) return [];
    const remaining = this.pending;
    this.pending = "";
    return [remaining];
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --test-name-pattern='LineBuffer' 2>&1 | tail -20`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add pi-extension/subagents/backends/line-buffer.ts test/orchestration/line-buffer.test.ts
git commit -m "feat(backends): add LineBuffer helper with tests"
```

### Task 11: Scaffold `headless.ts` with pi-path spawn + stream-json parse

**Files:**
- Modify: `pi-extension/subagents/backends/headless.ts` (overwrite Phase 1 stub)

This Task lifts `pi-subagent/index.ts:474-619` (pi dispatch path) into the fork's own headless implementation, **driven by `ResolvedLaunchSpec` from Task 9b** so the headless launch contract matches pane behavior. The Claude path stays unimplemented until Phase 3.

Specifically (review v2 finding 2): the pi headless path must honor the same launch surface as the pane path —
- agent default loading (`model` / `tools` / `skills` / `thinking` / `cli` / `body`) — read from `spec`
- agent-body / `system-prompt` mode handling (append vs. replace; identity-in-system-prompt) — read from `spec.identity` + `spec.identityInSystemPrompt` + `spec.systemPromptMode`; materialize via `writeSystemPromptArtifact(spec)` when `identityInSystemPrompt`
- skill prompt expansion — pass `spec.skillPrompts` as additional positional message arguments to `pi`
- `fork` / `session-mode` / lineage seeding — when `spec.seededSessionMode` is set, call `seedSubagentSessionFile(...)` exactly like pane does
- local `.pi/agent` config-root propagation — set env from `spec.configRootEnv`
- `PI_DENY_TOOLS` — set env from `spec.denySet`
- `PI_SUBAGENT_AUTO_EXIT` — set env when `spec.autoExit`
- artifact-backed task delivery — when `spec.taskDelivery === "artifact"`, write the task file via `writeTaskArtifact(spec)` and pass `@<path>` as the positional task arg
- `subagent-done.ts` extension loading — pass `-e <path-to-subagent-done.ts>` so the child can call the `subagent_done` tool, matching pane behavior at `pi-extension/subagents/index.ts:835-836`
- session placement parity — use `spec.subagentSessionFile` (already placed under `getDefaultSessionDirFor(targetCwd, agentDir)`) instead of an unconditional archive root
- `resumeSessionId` — passed through unchanged (not used on the pi CLI in v1, but recorded so future resume work has parity)
- abort escalation tracked via an explicit `exited` boolean (see Task 12 — review finding 3) instead of `proc.killed`, which only flips when the *signal was sent*, not when the process actually exited.

The `BackendResult.transcriptPath` for headless pi is `spec.subagentSessionFile` — the file pi itself writes — not a separately-managed archive copy. This matches pane's behavior (pane's `transcriptPath` aliases `sessionFile`).

- [ ] **Step 1: Overwrite the headless stub with the pi implementation**

Replace `pi-extension/subagents/backends/headless.ts` with:

```ts
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
// v9 (review-v10 finding 1): do NOT import pi-ai's `Message` type here.
// `@mariozechner/pi-ai` is not a direct dependency of this package
// (see package.json — only `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`,
// and `@sinclair/typebox` are). Importing a type from pi-ai relies on
// transitive hoisting through `pi-coding-agent`, which is a
// package-manager contract this fork does not own and that can break
// silently on a version bump or peer-dep reshuffle. Instead, use the
// local `PiStreamMessage` type defined below — it captures only what
// we actually read off a pi `message_end` / `tool_result_end` payload.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { LineBuffer } from "./line-buffer.ts";
import {
  resolveLaunchSpec,
  writeSystemPromptArtifact,
  writeTaskArtifact,
  type ResolvedLaunchSpec,
} from "../launch-spec.ts";
import { seedSubagentSessionFile } from "../session.ts";
import type {
  Backend,
  BackendLaunchParams,
  BackendResult,
  LaunchedHandle,
  TranscriptContent,
  TranscriptMessage,
  UsageStats,
} from "./types.ts";

interface HeadlessLaunch {
  id: string;
  name: string;
  startTime: number;
  promise: Promise<BackendResult>;
  abort: AbortController;
}

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function getFinalOutput(transcript: TranscriptMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const msg = transcript[i];
    if (msg.role === "assistant") {
      for (const part of msg.content ?? []) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

/**
 * Headless backend: spawns pi / Claude with piped stdio and parses stream-json.
 * Used when no mux is available (or when PI_SUBAGENT_MODE=headless). Both pi
 * and Claude paths consume a ResolvedLaunchSpec so launch behavior matches the
 * pane backend.
 */
export function makeHeadlessBackend(ctx: {
  sessionManager: ExtensionContext["sessionManager"];
  cwd: string;
}): Backend {
  const launches = new Map<string, HeadlessLaunch>();

  return {
    async launch(
      params: BackendLaunchParams,
      _defaultFocus: boolean,
      signal?: AbortSignal,
    ): Promise<LaunchedHandle> {
      const id = Math.random().toString(16).slice(2, 10);
      const startTime = Date.now();
      const abort = new AbortController();
      if (signal) {
        if (signal.aborted) abort.abort();
        else signal.addEventListener("abort", () => abort.abort(), { once: true });
      }

      // Resolve the full launch spec ONCE, before any backend dispatch.
      // Both pi and Claude headless paths read from the same spec, so launch
      // semantics match the pane path 1:1. `BackendLaunchParams` is a
      // structural superset of `SubagentParams`, so `resolveLaunchSpec` can
      // consume the widened params shape directly (agent-less launches land
      // in the "no agent: use direct fields" branch inside the resolver).
      const spec = resolveLaunchSpec(
        {
          name: params.name ?? "subagent",
          task: params.task,
          agent: params.agent,
          model: params.model,
          thinking: params.thinking,
          systemPrompt: params.systemPrompt,
          skills: params.skills,
          tools: params.tools,
          cwd: params.cwd,
          fork: params.fork,
          resumeSessionId: params.resumeSessionId,
          cli: params.cli,
          focus: params.focus,
        },
        ctx,
      );

      const promise: Promise<BackendResult> =
        spec.effectiveCli === "claude"
          ? runClaudeHeadless({ spec, startTime, abort: abort.signal, ctx })
          : runPiHeadless({ spec, startTime, abort: abort.signal, ctx });

      launches.set(id, { id, name: spec.name, startTime, promise, abort });
      return { id, name: spec.name, startTime };
    },

    async watch(handle: LaunchedHandle, signal?: AbortSignal): Promise<BackendResult> {
      const entry = launches.get(handle.id);
      if (!entry) {
        return {
          name: handle.name,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 1,
          elapsedMs: 0,
          error: `no launch entry for ${handle.id}`,
        };
      }
      try {
        if (signal) {
          if (signal.aborted) entry.abort.abort();
          else signal.addEventListener("abort", () => entry.abort.abort(), { once: true });
        }
        return await entry.promise;
      } finally {
        launches.delete(handle.id);
      }
    },
  };
}

interface RunParams {
  spec: ResolvedLaunchSpec;
  startTime: number;
  abort: AbortSignal;
  ctx: { sessionManager: ExtensionContext["sessionManager"]; cwd: string };
}

/**
 * SIGTERM → 5s → SIGKILL escalation that tracks an explicit `exited` flag.
 *
 * Review finding 3: `proc.killed` is set when the kill signal is *sent*,
 * not when the process actually exits. Keying SIGKILL escalation off
 * `!proc.killed` therefore skips SIGKILL after a SIGTERM for any child
 * that ignores or delays SIGTERM. We instead set `exited` from the
 * `close`/`exit` events and only escalate when the process truly hasn't
 * exited.
 *
 * Returns a function that, when called, performs the abort sequence.
 */
function makeAbortHandler(proc: ChildProcess, isExited: () => boolean): () => void {
  return () => {
    try { proc.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      if (!isExited()) {
        try { proc.kill("SIGKILL"); } catch {}
      }
    }, 5000);
  };
}

/**
 * Minimal structural type for the raw pi stream-json `message_end` and
 * `tool_result_end` payloads we care about at the parser boundary
 * (v9, review-v10 finding 1).
 *
 * This is deliberately a local type, not an import of pi-ai's `Message`.
 * `@mariozechner/pi-ai` is not a direct dependency of this package
 * (see package.json), and relying on transitive resolution through
 * `@mariozechner/pi-coding-agent` is a package-manager hoisting
 * coincidence we do not own. The shape below is a superset — pi-ai's
 * `Message` union is assignable to this type because every concrete
 * variant of that union already declares `role` and `content`. We read
 * `toolCallId` / `toolName` / `isError` from `toolResult` payloads,
 * and `usage` / `stopReason` from `assistant` payloads, via `(msg as any).…`
 * rather than widening this type with optional fields — that keeps the
 * contract tight (the projection touches exactly these fields) and keeps
 * the "this is not a public type" signal visible at every read site.
 */
type PiStreamMessage = {
  role: "user" | "assistant" | "toolResult";
  content: unknown;  // normalized to TranscriptContent[] by projectPiMessageToTranscript
};

/**
 * Boundary projection from a raw pi stream-json message payload onto
 * `TranscriptMessage` (v7, review-v8 finding 1; v9, review-v10 finding 1:
 * parameter type is now the local `PiStreamMessage`, not pi-ai's `Message`).
 *
 * v6 pushed pi stream payloads through an `as unknown as TranscriptMessage`
 * cast and called that "structural subtyping". It is not — pi-ai's
 * `UserMessage.content` is declared `string | (TextContent | ImageContent)[]`
 * (`@mariozechner/pi-ai/dist/types.d.ts:117-121`), while `TranscriptMessage.content`
 * is declared `TranscriptContent[]`. A user message with `content: "hi"`
 * therefore escaped through the public boundary as `content: string`, violating
 * the contract that every consumer reading `transcript[i].content[0]` relies on.
 *
 * The projection below is deliberately explicit: it re-picks only the
 * `TranscriptMessage` fields, normalizes `content: string` into a
 * single `{ type: "text", text }` block, and preserves the `toolCallId` /
 * `toolName` / `isError` fields required by `toolResult`. Assistant messages
 * already satisfy the shape (content in a real pi-ai `AssistantMessage` is
 * always an array of blocks) so they pass through without content rewriting.
 *
 * Directly exported so `test/orchestration/pi-transcript-projection.test.ts`
 * can import it for unit coverage; the function is behavior, not test-only
 * glue, so a named export is preferred over a `__test__` bag.
 */
export function projectPiMessageToTranscript(msg: PiStreamMessage): TranscriptMessage {
  const rawContent: unknown = msg.content;
  const content: TranscriptContent[] = typeof rawContent === "string"
    ? [{ type: "text", text: rawContent }]
    // Assistant/toolResult content is already an array of typed blocks
    // whose shapes are a subset of `TranscriptContent`. No cast needed on
    // the element level — the union discriminant is preserved by
    // structural assignability on each block variant.
    : (rawContent as TranscriptContent[]);
  if (msg.role === "toolResult") {
    const tr = msg as any;
    return {
      role: "toolResult",
      content,
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      isError: tr.isError,
    };
  }
  return { role: msg.role, content };
}

/** PI CLI headless path — spawn pi consuming the resolved launch spec. */
async function runPiHeadless(p: RunParams): Promise<BackendResult> {
  const { spec, startTime, abort, ctx } = p;
  // v7 (review-v8 finding 1): `TranscriptMessage[]` at the boundary, populated
  // via `projectPiMessageToTranscript(...)` rather than a structural-subtyping
  // cast. The projection normalizes pi `UserMessage.content: string` into a
  // block-array so every `role` satisfies `TranscriptMessage.content:
  // TranscriptContent[]`. See projectPiMessageToTranscript JSDoc for rationale.
  const transcript: TranscriptMessage[] = [];
  const usage = emptyUsage();
  let stderr = "";
  let terminalEvent = false;

  // Lineage seeding identical to pane (launchSubagent's seedSubagentSessionFile call).
  if (spec.seededSessionMode) {
    seedSubagentSessionFile({
      mode: spec.seededSessionMode,
      parentSessionFile: ctx.sessionManager.getSessionFile()!,
      childSessionFile: spec.subagentSessionFile,
      childCwd: spec.effectiveCwd ?? ctx.cwd,
    });
  }

  // System-prompt artifact when identity belongs in --[append-]system-prompt.
  const systemPromptFlag: string[] = [];
  if (spec.identityInSystemPrompt && spec.identity) {
    const flag = spec.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    systemPromptFlag.push(flag, writeSystemPromptArtifact(spec));
  }

  // Build args. Mirrors the order of pane's pi command (subagent-done extension first
  // so the child can call subagent_done; then session, model, system-prompt, tools).
  const subagentDonePath = join(
    dirname(new URL(import.meta.url).pathname),
    "..",
    "subagent-done.ts",
  );

  const args: string[] = [
    "--session", spec.subagentSessionFile,
    "-e", subagentDonePath,
    "--output-format", "stream-json",
  ];
  if (spec.effectiveModel) {
    const model = spec.effectiveThinking
      ? `${spec.effectiveModel}:${spec.effectiveThinking}`
      : spec.effectiveModel;
    args.push("--model", model);
  }
  args.push(...systemPromptFlag);
  if (spec.effectiveTools) {
    const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    const builtins = spec.effectiveTools
      .split(",").map((t) => t.trim()).filter((t) => BUILTIN_TOOLS.has(t));
    if (builtins.length > 0) args.push("--tools", builtins.join(","));
  }

  // Positional message args: skill prompts (each "/skill:foo") followed by the task.
  // Artifact-backed delivery materializes the task to a file and passes "@<path>".
  let taskArg: string;
  if (spec.taskDelivery === "direct") {
    taskArg = spec.fullTask;
  } else {
    taskArg = `@${writeTaskArtifact(spec)}`;
  }
  // Match pane's buildPiPromptArgs(): when artifact-backed AND skills present,
  // prepend an empty leading message so /skill: lands in messages[1..].
  const positional: string[] = [];
  if (spec.taskDelivery === "artifact" && spec.skillPrompts.length > 0) {
    positional.push("");
  }
  positional.push(...spec.skillPrompts, taskArg);
  args.push(...positional);

  // Env: PI_DENY_TOOLS, PI_SUBAGENT_AUTO_EXIT, PI_SUBAGENT_NAME/AGENT/SESSION,
  // and config-root propagation from spec.configRootEnv.
  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    PI_SUBAGENT_NAME: spec.name,
    PI_SUBAGENT_SESSION: spec.subagentSessionFile,
    ...spec.configRootEnv,
  };
  if (spec.agent) childEnv.PI_SUBAGENT_AGENT = spec.agent;
  if (spec.autoExit) childEnv.PI_SUBAGENT_AUTO_EXIT = "1";
  if (spec.denySet.size > 0) childEnv.PI_DENY_TOOLS = [...spec.denySet].join(",");

  if (abort.aborted) return makeAbortedResult(spec, startTime, transcript, usage);

  return new Promise<BackendResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn("pi", args, {
        cwd: spec.effectiveCwd ?? ctx.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      });
    } catch (err: any) {
      resolve({
        name: spec.name,
        finalMessage: "",
        transcriptPath: null,
        exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err?.message ?? String(err),
      });
      return;
    }

    const lb = new LineBuffer();
    let wasAborted = false;
    let exited = false;          // ← set ONLY by close/exit; drives SIGKILL escalation
    proc.on("exit", () => { exited = true; });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "message_end" && event.message) {
        // v9 (review-v10 finding 1): `PiStreamMessage` — a LOCAL structural
        // type (see its declaration above). Do not import pi-ai's `Message`
        // here; `@mariozechner/pi-ai` is not a direct dependency of this
        // package, and relying on transitive hoisting for a type import is
        // a silent-break surface across package-manager / version changes.
        const msg = event.message as PiStreamMessage;
        // v7 (review-v8 finding 1): project at the boundary instead of
        // casting. The projection normalizes user messages whose content
        // is a bare string into a TranscriptContent[] block array, so
        // every role honors `TranscriptMessage.content: TranscriptContent[]`.
        transcript.push(projectPiMessageToTranscript(msg));
        // Usage / stopReason are read from the original pi message here
        // (before projection) because they are not part of the
        // TranscriptMessage contract — they feed the usage aggregate
        // instead. `(msg as any).…` is deliberate: these fields live on
        // pi-ai's AssistantMessage variant, which our local PiStreamMessage
        // type intentionally does not widen to expose (see that type's
        // JSDoc). This keeps the projection focused on the public shape.
        if (msg.role === "assistant") {
          usage.turns++;
          const u: any = (msg as any).usage;
          if (u) {
            usage.input += u.input ?? 0;
            usage.output += u.output ?? 0;
            usage.cacheRead += u.cacheRead ?? 0;
            usage.cacheWrite += u.cacheWrite ?? 0;
            usage.cost += u.cost?.total ?? 0;
            usage.contextTokens = u.totalTokens ?? usage.contextTokens;
          }
          const stop = (msg as any).stopReason;
          if (stop === "endTurn" || stop === "stop" || stop === "error") terminalEvent = true;
        }
      } else if (event.type === "tool_result_end" && event.message) {
        // v7 (review-v8 finding 1): project — don't cast. `toolResult`
        // messages need `toolCallId` / `toolName` / `isError` copied onto
        // the boundary shape explicitly.
        // v9 (review-v10 finding 1): parameter is `PiStreamMessage`, not pi-ai `Message`.
        transcript.push(projectPiMessageToTranscript(event.message as PiStreamMessage));
      }
    };

    proc.stdout!.on("data", (data: Buffer) => {
      for (const line of lb.push(data.toString())) processLine(line);
    });
    proc.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });

    const onAbort = () => {
      wasAborted = true;
      makeAbortHandler(proc, () => exited)();
    };
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      resolve({
        name: spec.name,
        finalMessage: "",
        transcriptPath: null,
        exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err.code === "ENOENT"
          ? "pi CLI not found on PATH"
          : err.message || String(err),
      });
    });

    proc.on("close", (code) => {
      exited = true;
      for (const line of lb.flush()) processLine(line);
      const elapsedMs = Date.now() - startTime;
      const archived = existsSync(spec.subagentSessionFile) ? spec.subagentSessionFile : null;
      const exitCode = code ?? 0;
      const final = getFinalOutput(transcript);

      if (wasAborted) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode: 1, elapsedMs, error: "aborted", usage, transcript });
        return;
      }
      if (exitCode !== 0) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode, elapsedMs,
                  error: stderr.trim() || `pi exited with code ${exitCode}`,
                  usage, transcript });
        return;
      }
      if (!terminalEvent) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode: 1, elapsedMs,
                  error: "child exited without completion event", usage, transcript });
        return;
      }
      resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                exitCode: 0, elapsedMs, usage, transcript });
    });
  });
}

/** Phase 2 Claude stub — Phase 3 overwrites with the real implementation. */
async function runClaudeHeadless(p: RunParams): Promise<BackendResult> {
  return {
    name: p.spec.name,
    finalMessage: "",
    transcriptPath: null,
    exitCode: 1,
    elapsedMs: Date.now() - p.startTime,
    error: "headless Claude backend not implemented yet (Phase 3)",
  };
}

function makeAbortedResult(
  spec: ResolvedLaunchSpec,
  startTime: number,
  transcript: TranscriptMessage[],
  usage: UsageStats,
): BackendResult {
  return {
    name: spec.name,
    finalMessage: "",
    transcriptPath: null,
    exitCode: 1,
    elapsedMs: Date.now() - startTime,
    error: "aborted",
    usage,
    transcript,
  };
}
```

- [ ] **Step 1b: Unit-test `projectPiMessageToTranscript` (v7 — review-v8 finding 1)**

Create `test/orchestration/pi-transcript-projection.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectPiMessageToTranscript } from "../../pi-extension/subagents/backends/headless.ts";

/**
 * Regression coverage for review-v8 finding 1. pi-ai's UserMessage.content
 * is typed `string | (TextContent | ImageContent)[]`. v6 pushed pi messages
 * onto `TranscriptMessage[]` via `as unknown as TranscriptMessage`, which
 * allowed `content: "hi"` to leak through a field publicly typed as
 * `TranscriptContent[]`. These tests pin down the projection shape so a
 * regression to the cast-based push fails loudly.
 *
 * v9 (review-v10 finding 1): the fixtures here are typed `as any` rather
 * than `as Message`, because the projection's parameter type is now the
 * local `PiStreamMessage` defined in `headless.ts`, not pi-ai's `Message`
 * (that import was removed to avoid depending on transitive hoisting).
 * `as any` mirrors real-world usage — the caller in `runPiHeadless` feeds
 * `JSON.parse(line)` output directly into the projection.
 */
describe("projectPiMessageToTranscript", () => {
  it("normalizes a pi UserMessage with content: string into a TextContent block array", () => {
    // Mirrors a real pi `message_end` payload for a user turn.
    const msg = {
      role: "user",
      content: "hi",
      timestamp: 0,
    } as any;
    const t = projectPiMessageToTranscript(msg);
    assert.equal(t.role, "user");
    assert.ok(Array.isArray(t.content),
      `content must project to an array, got ${typeof t.content}: ${JSON.stringify(t.content)}`);
    assert.equal(t.content.length, 1);
    assert.equal(t.content[0].type, "text");
    if (t.content[0].type === "text") assert.equal(t.content[0].text, "hi");
  });

  it("passes assistant content blocks through without rewriting", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "/x" } },
      ],
      api: "anthropic", provider: "anthropic", model: "m", usage: {}, stopReason: "stop", timestamp: 0,
    } as any;
    const t = projectPiMessageToTranscript(msg);
    assert.equal(t.role, "assistant");
    assert.equal(t.content.length, 2);
    assert.equal(t.content[0].type, "text");
    assert.equal(t.content[1].type, "toolCall");
    // Public contract: no pi-ai metadata is leaked via TranscriptMessage.
    assert.equal((t as any).api, undefined);
    assert.equal((t as any).stopReason, undefined);
    assert.equal((t as any).usage, undefined);
  });

  it("preserves toolCallId / toolName / isError for toolResult messages", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "tc-1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "file contents" }],
      timestamp: 0,
    } as any;
    const t = projectPiMessageToTranscript(msg);
    assert.equal(t.role, "toolResult");
    assert.equal(t.toolCallId, "tc-1");
    assert.equal(t.toolName, "read");
    assert.equal(t.isError, false);
    assert.equal(t.content[0].type, "text");
  });

  it("normalizes a toolResult with content: string (defensive — future-proof against pi event shape drift)", () => {
    // pi's tool_result_end event shape historically carries a block array,
    // but the projection guarantees correctness even if a future pi emits a
    // bare string (the `content: TranscriptContent[]` contract still holds).
    const msg = {
      role: "toolResult",
      toolCallId: "tc-2",
      toolName: "bash",
      isError: true,
      content: "oops",
      timestamp: 0,
    } as any;
    const t = projectPiMessageToTranscript(msg);
    assert.ok(Array.isArray(t.content));
    assert.equal(t.content[0].type, "text");
    if (t.content[0].type === "text") assert.equal(t.content[0].text, "oops");
    assert.equal(t.isError, true);
  });
});
```

Run: `npm test -- --test-name-pattern='projectPiMessageToTranscript' 2>&1 | tail -40`
Expected: all four cases PASS. If any case fails, the projection has silently dropped back to a cast-based push — re-read the Step 1 projection and fix before proceeding.

If `projectPiMessageToTranscript` is not exported from `headless.ts`, prefer adding `export` directly to its declaration (it is documented for test reach). Do not route it through a `__test__` bag — the function is behavior, not test-only glue.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck 2>&1 | tail -40`
Expected: no errors. If `OrchestrationResult` still lacks `usage` / `transcript`, see Task 25 Step 2 and apply now.

- [ ] **Step 3: Commit**

```bash
git add pi-extension/subagents/backends/headless.ts test/orchestration/pi-transcript-projection.test.ts
git commit -m "feat(backends): add headless pi implementation driven by ResolvedLaunchSpec

Introduces projectPiMessageToTranscript as the pi → TranscriptMessage
boundary projection. v6 pushed pi Messages via an unsafe cast that
let UserMessage.content: string escape through a field publicly
typed as TranscriptContent[] (review-v8 finding 1). The projection
normalizes the string case into a TextContent block and re-picks
only the TranscriptMessage fields so the contract is honored for
every role. The projection's parameter type is a local PiStreamMessage
struct, not pi-ai's Message — @mariozechner/pi-ai is not a direct
dependency of this package, so a pi-ai type import would only
resolve via transitive hoisting (review-v10 finding 1)."
```

### Task 12: Unit-test the headless abort path with a mocked spawn

**Files:**
- Create: `test/orchestration/headless-abort.test.ts`

Abort behavior is the highest-value piece of this backend to exercise without a real CLI. The fake `ChildProcess` matches Node's actual semantics:

- `kill(sig)` only **sends** a signal — it does *not* set `proc.killed` until SIGKILL (and even then, real Node sets `killed` synchronously when the signal is sent successfully, *not* when the process exits).
- `proc.killed` is **not** a "process has exited" sentinel. The implementation tracks an `exited` flag from the `close`/`exit` events — review finding 3.

The two test cases below exercise both the happy path (process exits cleanly after SIGTERM, no escalation) and the stuck-child path (process ignores SIGTERM, escalation to SIGKILL must still fire).

- [ ] **Step 1: Write the failing tests**

Create `test/orchestration/headless-abort.test.ts`:

```ts
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

/**
 * Mocks `node:child_process` `spawn` before loading the headless backend.
 * The fake process mirrors real Node semantics: `kill(sig)` only sends the
 * signal — it does NOT mark the process as exited. Only an emitted
 * "close"/"exit" event flips the implementation's `exited` flag, which is
 * the actual gate for SIGKILL escalation (review finding 3 — proc.killed
 * is not a reliable exit check).
 */
describe("headless abort", { timeout: 15_000 }, () => {
  let lastFakeProc: any;
  let killed: string[];
  let backendModule: any;

  function makeFakeProc() {
    const ee = new EventEmitter() as any;
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.killed = false;        // Real Node: only set when kill() successfully sends.
                              // Tests do NOT mutate this; the implementation MUST
                              // NOT key escalation off it.
    ee.kill = (sig: string) => {
      killed.push(sig);
      // IMPORTANT: real ChildProcess.kill() does not synchronously emit close.
      // The process may ignore SIGTERM entirely; close fires only when the OS
      // confirms the process has exited.
      return true;
    };
    /** Test helper: simulate the OS reporting process exit. */
    ee._fakeExit = (code: number) => {
      ee.emit("exit", code);
      ee.emit("close", code);
    };
    lastFakeProc = ee;
    return ee;
  }

  before(async () => {
    const cp = await import("node:child_process");
    mock.method(cp, "spawn", () => makeFakeProc());
    backendModule = await import("../../pi-extension/subagents/backends/headless.ts");
  });

  after(() => {
    mock.restoreAll();
  });

  function patchSetTimeout(): {
    scheduled: Array<{ ms: number; fn: () => void }>;
    restore: () => void;
  } {
    const orig = globalThis.setTimeout;
    const scheduled: Array<{ ms: number; fn: () => void }> = [];
    (globalThis as any).setTimeout = ((fn: () => void, ms: number) => {
      scheduled.push({ ms, fn });
      return { unref: () => {} } as any;
    }) as any;
    return { scheduled, restore: () => { (globalThis as any).setTimeout = orig; } };
  }

  const ctx = {
    sessionManager: {
      getSessionFile: () => "/tmp/fake",
      getSessionId: () => "test",
      getSessionDir: () => "/tmp",
    } as any,
    cwd: "/tmp",
  };

  it("sends SIGTERM immediately, then schedules SIGKILL; no escalation when child exits cleanly", async () => {
    killed = [];
    const t = patchSetTimeout();
    try {
      const backend = backendModule.makeHeadlessBackend(ctx);
      const controller = new AbortController();
      const handle = await backend.launch(
        { agent: "x", task: "spin", cli: "pi" }, false, controller.signal,
      );
      // Let spawn attach listeners.
      await new Promise((r) => setImmediate(r));

      controller.abort();
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(killed, ["SIGTERM"]);
      assert.ok(t.scheduled.find((s) => s.ms === 5000), "5s escalation timer must be scheduled");

      // Child exits cleanly in response to SIGTERM (within the 5s window).
      lastFakeProc._fakeExit(0);
      // Now fire the 5s callback — escalation must NOT send SIGKILL.
      t.scheduled.find((s) => s.ms === 5000)!.fn();
      assert.deepEqual(killed, ["SIGTERM"], "no SIGKILL when child already exited");

      const result = await backend.watch(handle);
      assert.equal(result.error, "aborted");
      assert.equal(result.exitCode, 1);
    } finally {
      t.restore();
    }
  });

  it("sends SIGKILL after 5s when the child ignores SIGTERM (regression for proc.killed bug)", async () => {
    killed = [];
    const t = patchSetTimeout();
    try {
      const backend = backendModule.makeHeadlessBackend(ctx);
      const controller = new AbortController();
      const handle = await backend.launch(
        { agent: "x", task: "spin", cli: "pi" }, false, controller.signal,
      );
      await new Promise((r) => setImmediate(r));

      controller.abort();
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(killed, ["SIGTERM"]);

      // Simulate the 5s timer firing while the child is still alive
      // (i.e. it ignored SIGTERM). SIGKILL MUST be sent. With the old
      // !proc.killed check this would incorrectly skip — proc.killed is
      // never flipped by the real ChildProcess on SIGTERM.
      const fiveSec = t.scheduled.find((s) => s.ms === 5000);
      assert.ok(fiveSec);
      fiveSec!.fn();
      assert.deepEqual(killed, ["SIGTERM", "SIGKILL"],
        `SIGKILL must be sent when child has not exited; got ${killed.join(",")}`);

      // Now the OS reports the kill.
      lastFakeProc._fakeExit(137);
      const result = await backend.watch(handle);
      assert.equal(result.error, "aborted");
      assert.equal(result.exitCode, 1);
    } finally {
      t.restore();
    }
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test -- --test-name-pattern='headless abort' 2>&1 | tail -40`
Expected: both tests PASS. If the mock of `spawn` fails because `node:test` `mock.method` can't intercept an ESM function, switch to using a test-only injection — e.g. add a module-private `_spawnImpl` symbol in `headless.ts` that the test can override via an exported `__test__` hook. Prefer that path if the mock approach doesn't take.

- [ ] **Step 3: Commit**

```bash
git add test/orchestration/headless-abort.test.ts
git commit -m "test(backends): cover SIGTERM→5s→SIGKILL escalation gated on explicit exited flag"
```

### Task 12b: Add a `copyTestAgents(dir)` helper to the integration harness

**Files:**
- Modify: `test/integration/harness.ts`

The new headless integration tests below use the repo-local fixtures (`test-echo`, `test-ping`) instead of `scout` (review finding 2 — `scout` is host-dependent). They don't go through `createTestEnv()` (which is mux-coupled), so they need a small standalone helper to seed agent definitions into a temp dir's `.pi/agents/`.

- [ ] **Step 1: Append the helper export**

In `test/integration/harness.ts`, after the existing `createTestEnv` block (around line 130), add:

```ts
/**
 * Seed the repo-local test agent fixtures into <dir>/.pi/agents/.
 *
 * Used by headless integration tests that don't go through createTestEnv()
 * (which is coupled to mux backend setup). Mirrors the mux-coupled path so
 * agent: "test-echo" / "test-ping" resolve identically across both.
 */
export function copyTestAgents(dir: string): void {
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  if (!existsSync(TEST_AGENTS_SRC)) return;
  for (const file of readdirSync(TEST_AGENTS_SRC)) {
    if (file.endsWith(".md")) {
      cpSync(join(TEST_AGENTS_SRC, file), join(agentsDir, file));
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add test/integration/harness.ts
git commit -m "test(integration): add copyTestAgents helper for headless tests"
```

### Task 13: Integration test — headless pi smoke

**Files:**
- Create: `test/integration/headless-pi-smoke.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/integration/headless-pi-smoke.test.ts`:

```ts
/**
 * Integration smoke test for the headless pi backend.
 *
 * Skipped when `pi` is not on PATH. Explicitly sets
 * PI_SUBAGENT_MODE=headless so mux detection doesn't confound results
 * when the host shell happens to be inside tmux/cmux.
 *
 * Uses the repo-local `test-echo` fixture so the test is deterministic
 * across hosts (review finding 2 — `scout` is host-dependent on the
 * caller's ~/.pi/agent/agents/ contents).
 *
 * Cost: sub-second Haiku turn — a few cents per run.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTestAgents } from "./harness.ts";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

const PI_AVAILABLE = (() => {
  try {
    execSync("which pi", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe("headless-pi-smoke", { skip: !PI_AVAILABLE, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-smoke-"));
    copyTestAgents(dir);          // ← seeds <dir>/.pi/agents/test-echo.md so loadAgentDefaults finds it
  });

  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a trivial pi task and returns non-empty usage + transcript + archived session file", async () => {
    const origCwd = process.cwd();
    process.chdir(dir);            // loadAgentDefaults reads from process.cwd()/.pi/agents/
    try {
      const backend = makeHeadlessBackend({
        sessionManager: {
          getSessionFile: () => join(dir, "parent.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => dir,
        } as any,
        cwd: dir,
      });
      const handle = await backend.launch(
        {
          agent: "test-echo",
          task: "Reply with exactly: OK",
        },
        false,
      );
      const result = await backend.watch(handle);

      assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);
      assert.ok(result.finalMessage.trim().length > 0, "finalMessage must be non-empty");
      assert.ok(result.usage, "usage must be set on headless result");
      assert.ok(result.usage!.turns >= 1, `usage.turns must be >=1, got ${result.usage!.turns}`);
      assert.ok(result.transcript && result.transcript.length > 0, "transcript array must be non-empty");
      assert.ok(result.transcriptPath, "transcriptPath must be set");
      assert.ok(existsSync(result.transcriptPath!), "archived session file must exist");
    } finally {
      process.chdir(origCwd);
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- --test-name-pattern='headless-pi-smoke' 2>&1 | tail -40`
Expected: PASS, or skipped if `pi` is not on PATH.

- [ ] **Step 3: Commit**

```bash
git add test/integration/headless-pi-smoke.test.ts
git commit -m "test(integration): add headless pi smoke test"
```

### Task 14: Integration test — ENOENT path

**Files:**
- Create: `test/integration/headless-enoent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/integration/headless-enoent.test.ts`:

```ts
/**
 * ENOENT path: force PATH to exclude the target CLI and verify the
 * backend returns an actionable error result (no throw).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

describe("headless-enoent", { timeout: 15_000 }, () => {
  let dir: string;
  let origPath: string | undefined;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-headless-enoent-"));
    origPath = process.env.PATH;
    process.env.PATH = "/nonexistent";
  });

  after(() => {
    process.env.PATH = origPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns BackendResult with 'pi CLI not found on PATH' when pi is missing", async () => {
    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    const handle = await backend.launch(
      { agent: "x", task: "nop", cli: "pi" },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 1);
    assert.match(result.error ?? "", /pi CLI not found on PATH/);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- --test-name-pattern='headless-enoent' 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/integration/headless-enoent.test.ts
git commit -m "test(integration): cover headless ENOENT error path"
```

### Task 15: Integration test — transcript archival (pi half)

**Files:**
- Create: `test/integration/headless-transcript-archival.test.ts`

- [ ] **Step 1: Write the test (pi half; Claude half lands in Phase 3)**

Create `test/integration/headless-transcript-archival.test.ts`:

```ts
/**
 * After a successful headless pi run, the archived session file must:
 *  - exist on disk
 *  - be under the resolved session root for this launch
 *    (i.e. `getDefaultSessionDirFor(effectiveCwd, effectiveAgentDir)` —
 *    which may resolve to a project-local `.pi/agent` rather than
 *    `~/.pi/agent` if one exists, or to `$PI_CODING_AGENT_DIR` when set —
 *    review-v3 non-blocking note 2)
 *  - contain the task prompt as a user message
 *
 * Claude-half assertions are appended in Phase 3 (headless Claude
 * backend), gated on `which claude`. Claude's archive path is always
 * `~/.pi/agent/sessions/claude-code/` (see Task 22); that hardcoded
 * root is Claude-specific and does not apply here.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { copyTestAgents } from "./harness.ts";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

const PI_AVAILABLE = (() => {
  try {
    execSync("which pi", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe("headless-transcript-archival [pi]", { skip: !PI_AVAILABLE, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-archival-"));
    copyTestAgents(dir);
  });

  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("archives the pi session file with the task prompt present", async () => {
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      const backend = makeHeadlessBackend({
        sessionManager: {
          getSessionFile: () => join(dir, "parent.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => dir,
        } as any,
        cwd: dir,
      });
      const uniqueMarker = `MARKER_${Math.random().toString(36).slice(2, 10)}`;
      const handle = await backend.launch(
        {
          agent: "test-echo",
          task: `Reply with exactly: OK. (Do not mention ${uniqueMarker}.)`,
        },
        false,
      );
      const result = await backend.watch(handle);

      assert.equal(result.exitCode, 0);
      assert.ok(result.transcriptPath, "transcriptPath must be set");
      assert.ok(existsSync(result.transcriptPath!));

      // Validate against the resolved session root rather than a hardcoded
      // ~/.pi/agent/sessions/ — the current codebase places pi session
      // files under `getDefaultSessionDirFor(targetCwd, effectiveAgentDir)`
      // which can resolve to a project-local `.pi/agent` or a propagated
      // PI_CODING_AGENT_DIR (review-v3 non-blocking note 2).
      // Since this test seeds agents into `<dir>/.pi/agents/` (NOT `.pi/agent/`),
      // effectiveAgentDir falls back to ~/.pi/agent — but a hypothetical
      // future tweak that places them under `.pi/agent` would redirect
      // transcriptPath too, which we want the test to tolerate.
      const possibleRoots = [
        join(homedir(), ".pi", "agent", "sessions"),
        join(dir, ".pi", "agent", "sessions"),
        // If PI_CODING_AGENT_DIR was set by the harness, include that root.
        ...(process.env.PI_CODING_AGENT_DIR
          ? [join(process.env.PI_CODING_AGENT_DIR, "sessions")]
          : []),
      ];
      assert.ok(
        possibleRoots.some((root) => result.transcriptPath!.startsWith(root)),
        `transcriptPath must be under a resolved session root; got ${result.transcriptPath}. Candidates: ${possibleRoots.join(", ")}`,
      );

      const body = readFileSync(result.transcriptPath!, "utf8");
      assert.ok(body.includes(uniqueMarker), "archived transcript must include the task prompt text");
    } finally {
      process.chdir(origCwd);
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- --test-name-pattern='headless-transcript-archival' 2>&1 | tail -30`
Expected: PASS (or skipped).

- [ ] **Step 3: Commit**

```bash
git add test/integration/headless-transcript-archival.test.ts
git commit -m "test(integration): verify headless pi transcript archival"
```

### Task 16: Phase 2 gate — confirm no regression on the pane suite

**Files:** none modified; read-only gate.

- [ ] **Step 1: Run the full unit + integration suite**

Run: `npm test 2>&1 | tail -40 && npm run test:integration 2>&1 | tail -40`
Expected:
- `npm test`: all orchestration unit tests pass (including new `line-buffer`, `select-backend`, `headless-abort`, updated `default-deps`).
- `npm run test:integration`: all Phase 0 baseline tests (`pi-pane-smoke`, `claude-sentinel-roundtrip`, `subagent-lifecycle`, `mux-surface`) pass or skip consistently. New tests (`headless-pi-smoke`, `headless-enoent`, `headless-transcript-archival`) pass.

- [ ] **Step 2: Manual smoke (only if the integration suite skipped due to CLI absence)**

If `pi` is present locally, run a `subagent_serial` call with `PI_SUBAGENT_MODE=headless` in a scratch repo against any agent you actually have installed (e.g. the repo-local `test-echo`, or a personal agent from `~/.pi/agent/agents/`); confirm the output shape matches a pane-mode run (clean exit, non-empty finalMessage, session file under the resolved session root — i.e. the appropriate `getDefaultSessionDirFor(...)` output for your cwd/agent-dir setup, typically `~/.pi/agent/sessions/` unless you've configured `PI_CODING_AGENT_DIR` or a project-local `.pi/agent/`). Capture any divergence in a follow-up note; don't block Phase 3 on cosmetic differences.

---

## Phase 3 — Headless Claude backend + tool-restriction patch

Phase 3 completes the headless implementation (Claude path) and lands the security-relevant `--tools` patch on the Claude command builder (**v6 — review-v7 finding 1**: the flag changed from `--allowedTools` to `--tools`; see the Task 17 intro below for rationale).

### Task 17: Patch `buildClaudeCmdParts` with `PI_TO_CLAUDE_TOOLS` + `--tools` + required `--` separator + re-export `shellEscape`

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Modify: `test/orchestration/thinking-effort.test.ts` (add a tools-map assertion and a separator-regression assertion to an existing test)
- Create: `test/integration/pane-claude-tool-restriction.test.ts` (new in v6 — review-v7 additional note 2: pane-Claude E2E restriction test)

This is the second named upstream-portable patch alongside the existing `thinking` patch. It benefits both backends — pane-Claude commands gain tool restriction automatically.

**v6 (review-v7 finding 1) — why `--tools`, not `--allowedTools`.** Claude CLI's `--help` output distinguishes the two flags:

- `--allowedTools, --allowed-tools <tools...>` — "Comma or space-separated list of tool names to allow (e.g. 'Bash(git *) Edit')". This is a *permission / allow rule*: it affects what the permissions system will approve when Claude tries to invoke a tool.
- `--tools <tools...>` — "Specify the list of available tools from the built-in set. Use '' to disable all tools, 'default' to use all tools, or specify tool names (e.g. 'Bash,Edit,Read')". This is the *built-in tool availability* knob: it constrains which tools Claude can invoke at all.

Because both backends run Claude in bypass-permissions mode (pane uses `--dangerously-skip-permissions`; headless uses `--permission-mode bypassPermissions`), permission rules are not consulted during tool use. `--allowedTools` therefore does not restrict which tools Claude actually invokes under our usage — it would have shipped a behavior change that did not close the named "tool-restriction security regression". `--tools` does, because it operates *before* the permission layer. v6 changes the emission in both `buildClaudeCmdParts` (pane) and `buildClaudeHeadlessArgs` (headless, Task 19) to `--tools`. The `--` separator rule stays in place because `--tools` is also variadic (`<tools...>` in the help output), so the regression test at `../pi-subagent/test/claude-args.test.ts:302-316` still applies.

**v5 (review-v6 blocker 1) — retained:** the Task also ports upstream's `--` task separator rule into the fork's `buildClaudeCmdParts()`. Claude CLI declares `--tools` as variadic (`<tools...>`), so without a `--` separator between the last option and the task, commander can consume the prompt text as "another tool name" and the `--print` branch sees no prompt. That regression is already captured upstream: `../pi-subagent/test/claude-args.test.ts:302-316` asserts `sepIdx > toolsIdx`, `taskIdx === sepIdx + 1`, and `taskIdx === args.length - 1`. v6 keeps the equivalent emit (append `"--"` after all options, then the task — but **only** when the task is non-empty — matching `pi-subagent/test/claude-args.test.ts:319-327`) and the regression test.

**v6 (review-v7 additional note 1) — `shellEscape` re-export.** The test file note previously said "import `shellEscape` from `../../pi-extension/subagents/index.ts` because it is re-exported there", but `shellEscape` is only *imported* at `pi-extension/subagents/index.ts:24`, not exported. v6 Step 3 adds a one-line `export { shellEscape }` next to the existing exports so the instruction is accurate. No runtime behavior change.

- [ ] **Step 1: Write a failing assertion in the existing Claude-cmd test file**

Append to `test/orchestration/thinking-effort.test.ts` (inside the `describe("buildClaudeCmdParts", …)` block, after the existing tests):

```ts
  it("emits --tools with mapped Claude tool names when effectiveTools is set", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: undefined,                 // v10 — was `appendSystemPrompt`
      systemPromptMode: undefined,         // v10 (review-v11 finding 1)
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      effectiveTools: "read, bash, find, ls, unknown",
      task: "do things",
    });
    const idx = parts.indexOf("--tools");
    assert.notEqual(idx, -1, "--tools must be present");
    // Values are shell-escaped in single quotes; strip the quotes for the set check.
    const raw = parts[idx + 1].replace(/^'|'$/g, "");
    const mapped = new Set(raw.split(","));
    assert.ok(mapped.has("Read"));
    assert.ok(mapped.has("Bash"));
    // find + ls both map to Glob — de-dup'd via Set in the builder.
    assert.ok(mapped.has("Glob"));
    assert.ok(!mapped.has("unknown"), "unmapped tools must be dropped, not passed through");
    // Defensive: --allowedTools must NOT be emitted. v5 used --allowedTools,
    // which is a permission-rule flag that bypassPermissions mode ignores.
    // Regression would defeat the tool-restriction security fix (review-v7 finding 1).
    assert.equal(parts.includes("--allowedTools"), false,
      "must not emit --allowedTools (that is a permission rule ignored in bypassPermissions mode)");
  });

  it("omits --tools when effectiveTools is absent (no regression for agents without tools: frontmatter)", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: undefined,                 // v10 — was `appendSystemPrompt`
      systemPromptMode: undefined,         // v10 (review-v11 finding 1)
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do things",
    });
    assert.equal(parts.includes("--tools"), false);
    assert.equal(parts.includes("--allowedTools"), false);
  });

  it("appends task separated by -- so variadic --tools does not consume it (review-v6 blocker 1)", () => {
    // Regression: Claude CLI declares --tools as variadic (<tools...>).
    // If the task is pushed directly after --tools, commander consumes
    // it as another tool name and --print sees no prompt. This mirrors the
    // upstream regression test at ../pi-subagent/test/claude-args.test.ts:302-316
    // (the upstream file was written against --allowedTools, but the same
    // variadic hazard applies to --tools — indexes checked here).
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: undefined,                 // v10 — was `appendSystemPrompt`
      systemPromptMode: undefined,         // v10 (review-v11 finding 1)
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      effectiveTools: "read, bash",
      task: "Write a plan for X.",
    });
    const toolsIdx = parts.indexOf("--tools");
    const sepIdx = parts.lastIndexOf("--");
    const taskIdx = parts.indexOf(shellEscape("Write a plan for X."));
    assert.ok(toolsIdx >= 0, "expected --tools in parts");
    assert.ok(sepIdx > toolsIdx, `expected -- separator after --tools (got sepIdx=${sepIdx}, toolsIdx=${toolsIdx})`);
    assert.equal(taskIdx, sepIdx + 1, "task must appear immediately after --");
    assert.equal(parts.length - 1, taskIdx, "task must be the final argv entry");
  });

  it("omits -- separator when task is empty (matches upstream pi-subagent behavior)", () => {
    // Upstream's test/claude-args.test.ts:319-327 asserts "-- separator absent
    // when task is empty". Mirror it so the fork's builder is drop-in portable
    // to an upstream PR.
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: undefined,                 // v10 — was `appendSystemPrompt`
      systemPromptMode: undefined,         // v10 (review-v11 finding 1)
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "",
    });
    assert.equal(parts.includes("--"), false, "empty task should not emit -- separator");
  });
```

Note on `shellEscape`: the existing fork builder pushes the task as `shellEscape(input.task)` (`pi-extension/subagents/index.ts:687`), so comparing `parts.indexOf(...)` against the escaped form keeps the assertion stable regardless of how `shellEscape` wraps the string. If `shellEscape` is not already imported in `thinking-effort.test.ts`, add it to the existing imports from `../../pi-extension/subagents/index.ts` — **v6 (review-v7 additional note 1):** Step 3 below adds `export { shellEscape }` to `index.ts`, making this import work.

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `npm test -- --test-name-pattern='buildClaudeCmdParts' 2>&1 | tail -30`
Expected: FAIL on all three new cases — `effectiveTools` is not in the `ClaudeCmdInputs` type, no `--tools` is emitted, and no `--` separator is emitted before the task. If the `shellEscape` import also fails, that's expected until Step 3 adds the re-export.

- [ ] **Step 3: Patch `ClaudeCmdInputs` + `buildClaudeCmdParts` + re-export `shellEscape`**

In `pi-extension/subagents/index.ts`, locate the `ClaudeCmdInputs` interface (currently around line 656) and extend it. **v10 (review-v11 finding 1)** renames `appendSystemPrompt` → `identity` and adds `systemPromptMode` so the pane builder can select `--system-prompt` vs. `--append-system-prompt` the same way the headless builder does, from one spec-driven input:

```ts
interface ClaudeCmdInputs {
  sentinelFile: string;
  pluginDir: string | undefined;
  model: string | undefined;
  identity: string | null | undefined;        // v10 — was `appendSystemPrompt`
  systemPromptMode: "append" | "replace" | undefined;  // v10 (review-v11 finding 1)
  resumeSessionId: string | undefined;
  effectiveThinking: string | undefined;
  effectiveTools: string | undefined;  // NEW (v6 / review-v7 finding 1)
  task: string;
}
```

Any existing `appendSystemPrompt:` uses elsewhere in `index.ts` are updated to `identity:`. The only call site is `launchSubagent()`'s Claude branch, so the rename is trivial — no external callers consume this interface directly.

**v10 (review-v11 finding 3): centralize `PI_TO_CLAUDE_TOOLS` in one shared module.** Instead of declaring the mapping twice (once here in `index.ts`, once in `backends/claude-stream.ts`), create a single module that both builders import from. In v9 Task 17 declared a local const and Task 19 declared a separate but textually identical const; v10 moves both to a new file and turns the two call sites into imports.

First, create `pi-extension/subagents/backends/tool-map.ts`:

```ts
/**
 * Single source of truth for the pi → Claude CLI built-in tool-name mapping.
 *
 * Emitted via `--tools` (NOT `--allowedTools`) because `--tools` is the
 * built-in availability gate; `--allowedTools` is a permission rule that
 * `--dangerously-skip-permissions` (pane) / `--permission-mode bypassPermissions`
 * (headless) ignores. See Task 17's intro in v6 for the Claude CLI help
 * references (review-v7 finding 1).
 *
 * Before v10 this map was declared locally in both `pi-extension/subagents/index.ts`
 * (pane-Claude builder) and `pi-extension/subagents/backends/claude-stream.ts`
 * (headless-Claude builder). The v11 reviewer flagged that duplication as a
 * quiet drift hazard in a security-sensitive area (review-v11 finding 3).
 * Centralizing here means updating one file updates both builders.
 */
export const PI_TO_CLAUDE_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
});
```

Then in `pi-extension/subagents/index.ts`, near the top (right after `const SPAWNING_TOOLS = new Set([...])` so the import lives with its kin), add:

```ts
import { PI_TO_CLAUDE_TOOLS } from "./backends/tool-map.ts";
```

No local `const PI_TO_CLAUDE_TOOLS = { ... }` declaration is added here — the import is the canonical form. If a future change adds a new pi→Claude mapping, it goes in `tool-map.ts` only; both builders pick it up.

Then inside `buildClaudeCmdParts`, immediately after the `if (effort) { parts.push("--effort", effort); }` block, add the `--tools` emit:

```ts
  if (input.effectiveTools) {
    const claudeTools = new Set<string>();
    for (const tool of input.effectiveTools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)) {
      const mapped = PI_TO_CLAUDE_TOOLS[tool.toLowerCase()];
      if (mapped) claudeTools.add(mapped);
    }
    if (claudeTools.size > 0) {
      // --tools (NOT --allowedTools): --tools constrains the set of
      // built-in tools available to the model; --allowedTools is a
      // permission rule that bypassPermissions mode ignores. See the
      // Task 17 intro (v6 / review-v7 finding 1) for rationale.
      parts.push("--tools", shellEscape([...claudeTools].join(",")));
    }
  }
```

**Then replace the existing final line** — `parts.push(shellEscape(input.task));` at `pi-extension/subagents/index.ts:687` — with a separator-aware emit:

```ts
  // Emit `--` before the task so the variadic --tools option
  // does not swallow the prompt as "another tool name".
  // Mirrors ../pi-subagent/test/claude-args.test.ts:302-316 (task
  // immediately after separator, separator after all options) and
  // :319-327 (omit separator when task is empty).
  if (input.task !== "") {
    parts.push("--");
    parts.push(shellEscape(input.task));
  }
```

Do not emit a bare `parts.push(shellEscape(input.task))` outside the `if`. The upstream contract is "no `--` when no task", and the fork builder must match so the commit is drop-in portable to an upstream PR.

**v6 re-export (review-v7 additional note 1).** In the same `index.ts`, next to the existing `export ... __test__` block, add:

```ts
export { shellEscape };
```

This makes the Step 1 test-file instruction ("import `shellEscape` from `../../pi-extension/subagents/index.ts` — it is re-exported there") true. Without this export, the instruction would have failed on first read. There is no runtime impact — the identifier is already in scope inside `index.ts`; the export is purely for test-importability.

**v10 (review-v11 finding 1): unify the Claude system-prompt contract.** `ClaudeCmdInputs` gains a new optional `systemPromptMode?: "append" | "replace"` field so the pane builder can emit `--system-prompt` vs. `--append-system-prompt` consistently with the headless builder (Task 19). The builder's system-prompt emit changes from a single `appendSystemPrompt` branch to:

```ts
  if (input.identity) {
    const flag = input.systemPromptMode === "replace"
      ? "--system-prompt"
      : "--append-system-prompt";
    parts.push(flag, shellEscape(input.identity));
  }
```

The field name changes from `appendSystemPrompt` (v9 — misleading once `--system-prompt` is also emitted) to `identity` so the pane and headless inputs share the same vocabulary. The rename is trivial since the only call site inside this file is `launchSubagent()`'s Claude branch.

Finally, at the call site (currently around line 748 inside `launchSubagent`'s Claude branch), thread the spec through with the v10 contract (review-v11 finding 1). In v9 the call site did its own `params.systemPrompt ?? agentDefs?.body` computation (opposite precedence from the spec) and passed `task: params.task` directly. v10 reads identity / placement / task body from the spec so pane-Claude and headless-Claude are driven by the same fields:

```ts
    // v10 (review-v11 finding 1): source all identity + task-body inputs
    // from the already-resolved spec. spec.identity uses `agentDefs.body ??
    // params.systemPrompt` (matches pi path); spec.systemPromptMode picks
    // the flag; spec.claudeTaskBody is fullTask minus the pi-only role
    // block so identity never double-enters via the task body.
    const cmdParts = buildClaudeCmdParts({
      sentinelFile,
      pluginDir: pluginDirResolved,
      model: effectiveModel,
      identity: spec.identity,
      systemPromptMode: spec.systemPromptMode,
      resumeSessionId: params.resumeSessionId,
      effectiveThinking,
      effectiveTools,        // NEW — already computed at line 707
      task: spec.claudeTaskBody,
    });
```

A regression of review-v11 finding 1 (someone "simplifying" this back to `params.systemPrompt ?? agentDefs?.body` and `params.task`) is caught by the new mixed-case test in `launch-spec.test.ts` (Step 1) plus a new pane-side unit test added to Step 1 of this task:

```ts
  it("uses spec.identity (agent body first) — not params.systemPrompt first (v10, review-v11 finding 1)", () => {
    // If a caller ever inverted the precedence back to v9's shape, this
    // would pick the literal "CALLER_PROMPT" — reject that explicitly.
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: "AGENT_BODY_IDENTITY", // Would be agentDefs.body in production
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "just do the task",
    });
    const idx = parts.indexOf("--append-system-prompt");
    assert.ok(idx >= 0, "expected --append-system-prompt for default mode");
    assert.equal(parts[idx + 1], shellEscape("AGENT_BODY_IDENTITY"),
      "review-v11 finding 1 regression: pane-Claude must use spec.identity");
  });

  it("emits --system-prompt (not --append-system-prompt) when systemPromptMode=replace", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: "REPLACE_IDENTITY",
      systemPromptMode: "replace",
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do",
    });
    assert.ok(parts.includes("--system-prompt"),
      "replace mode must emit --system-prompt on the pane path");
    assert.equal(parts.includes("--append-system-prompt"), false);
  });

  it("does NOT embed identity text in the task argv — identity goes via the flag only", () => {
    // v10 / review-v11 finding 1 "no duplication" contract. The pane-Claude
    // call site passes spec.claudeTaskBody (pi-wrapping-free), so identity
    // text must not appear anywhere other than the --append-system-prompt
    // argument. Pin this on the builder's input contract: if identity text
    // is passed as task, that's an upstream spec bug — the builder itself
    // must not copy identity into both fields.
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      identity: "SECRET_IDENTITY_XYZ",
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "the real task, no identity leakage here",
    });
    const identityOccurrences = parts.filter((p) =>
      p.includes("SECRET_IDENTITY_XYZ"),
    );
    assert.equal(identityOccurrences.length, 1,
      `identity must appear exactly once (after --append-system-prompt); got ${identityOccurrences.length}`);
  });
```

- [ ] **Step 3a: Add the shared `warnClaudeSkillsDropped` helper and call it on the pane-Claude path (v9 — review-v10 finding 2)**

Review-v10 finding 2: v8 only emitted the "ignoring skills" warning inside `runClaudeHeadless` (Task 19 Step 2), but the architecture section says the Claude-backend skills limitation applies to **both** pane and headless. Under v8, a user running `cli: "claude"` through the pane path would still silently drop `skills:`. This Step closes that gap by:

1. adding a shared `warnClaudeSkillsDropped(name, effectiveSkills)` helper in `index.ts`,
2. calling it from `launchSubagent()`'s Claude branch immediately after `effectiveSkills` is resolved but before `buildClaudeCmdParts`, and
3. (in Task 19 Step 2) having `runClaudeHeadless` import and call the **same** helper, so the wording cannot drift between the two call sites.

In `pi-extension/subagents/index.ts`, right next to the `shellEscape` re-export you just added, define and export the helper:

```ts
/**
 * Emit the one-line stderr warning for the "Claude + skills" out-of-scope
 * case (v6 / review-v7 finding 3; v9 / review-v10 finding 2: now shared
 * between pane and headless call sites).
 *
 * Both Claude backends ignore `effectiveSkills`: pi's `/skill:foo` is a
 * pi-CLI message-prefix expansion, which Claude does not implement. Rather
 * than silently dropping (confusing — users wonder why `skills:` had no
 * effect) or leaking literal `/skill:foo` strings into the task body
 * (worse than no skills), both paths route through this helper so the
 * user sees one consistent line regardless of which backend ran.
 *
 * No-op when `effectiveSkills` is undefined / null / empty. Exported so
 * `test/orchestration/claude-skills-warning.test.ts` can assert on the
 * wording directly, and so `backends/headless.ts` can import and call the
 * same function.
 */
export function warnClaudeSkillsDropped(
  subagentName: string,
  effectiveSkills: string | undefined,
): void {
  if (!effectiveSkills || effectiveSkills.trim() === "") return;
  process.stderr.write(
    `[pi-interactive-subagent] ${subagentName}: ignoring skills=${effectiveSkills} on Claude path — not supported in v1\n`,
  );
}
```

Then at the call site inside `launchSubagent()`'s Claude branch, add the warning **before** `buildClaudeCmdParts` is invoked. The cleanest location is immediately after the `if (effectiveCli === "claude") {` block opens and `sentinelFile` / `pluginDir` are set up, but before `cmdParts` is built — so the warning fires even on the failure path where the command builder throws. Specifically, insert this just above the existing `const cmdParts = buildClaudeCmdParts({ ... })` call (around `pi-extension/subagents/index.ts:748`):

```ts
    // v9 (review-v10 finding 2): warn that skills are dropped on Claude.
    // Must fire on both backends for parity — runClaudeHeadless calls the
    // same helper. effectiveSkills is already resolved above (line ~707).
    warnClaudeSkillsDropped(params.name, effectiveSkills);
```

Finally, add the focused unit test at `test/orchestration/claude-skills-warning.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { warnClaudeSkillsDropped } from "../../pi-extension/subagents/index.ts";

/**
 * Unit coverage for the shared Claude-skills warning helper
 * (v9, review-v10 finding 2). Both pane (Task 17 Step 3a) and headless
 * (Task 19 Step 2) Claude paths route through this function, so a
 * regression in the wording or the no-op branch would silently desync
 * the two call sites. This test pins both.
 */
describe("warnClaudeSkillsDropped", () => {
  let captured: string;
  let origWrite: typeof process.stderr.write;

  beforeEach(() => {
    captured = "";
    origWrite = process.stderr.write.bind(process.stderr);
    // node's `process.stderr.write` has two overloads; this shim matches
    // the Buffer | string form the helper uses.
    (process.stderr as any).write = (chunk: string | Buffer): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };
  });
  afterEach(() => {
    (process.stderr as any).write = origWrite;
  });

  it("writes a single-line warning when effectiveSkills is non-empty", () => {
    warnClaudeSkillsDropped("my-subagent", "plan, code-review");
    assert.ok(
      captured.includes("ignoring skills=plan, code-review"),
      `expected skills list in warning; got: ${JSON.stringify(captured)}`,
    );
    assert.ok(
      captured.includes("my-subagent"),
      `expected subagent name in warning; got: ${JSON.stringify(captured)}`,
    );
    assert.ok(
      captured.includes("Claude path"),
      `expected "Claude path" phrasing so pane + headless share exact wording; got: ${JSON.stringify(captured)}`,
    );
    assert.equal(captured.split("\n").filter(Boolean).length, 1,
      "warning must be a single line — multiple lines indicate a shadow emit path");
  });

  it("is a no-op when effectiveSkills is undefined", () => {
    warnClaudeSkillsDropped("my-subagent", undefined);
    assert.equal(captured, "");
  });

  it("is a no-op when effectiveSkills is the empty string or whitespace-only", () => {
    warnClaudeSkillsDropped("my-subagent", "");
    warnClaudeSkillsDropped("my-subagent", "   ");
    assert.equal(captured, "");
  });
});
```

Run: `npm test -- --test-name-pattern='warnClaudeSkillsDropped' 2>&1 | tail -30`
Expected: all three cases PASS. If the helper writes to `stdout` instead of `stderr`, or if the wording diverges between call sites (e.g. someone edited `runClaudeHeadless`'s inline template without updating this helper), these tests fail. Do not "fix" by duplicating the wording — fix by consolidating both call sites on `warnClaudeSkillsDropped`.

- [ ] **Step 4: Run the new tests; expect all buildClaudeCmdParts tests pass**

Run: `npm test -- --test-name-pattern='buildClaudeCmdParts' 2>&1 | tail -30`
Expected: PASS.

- [ ] **Step 5: Add the pane-Claude E2E restriction integration test (v6 — review-v7 additional note 2; v7 — review-v8 finding 2; v8 — review-v9 finding 1)**

Create `test/integration/pane-claude-tool-restriction.test.ts`. Unlike the unit tests above (which only assert the argv array shape), this test exercises the *full pane command-string path*: the shell-escaped command string is built by `buildClaudeCmdParts` and executed via `execSync`, so any breakage in how the separator or `--tools` arg survives shell quoting is caught end-to-end.

The test confirms two things against a real Claude CLI:
1. With `effectiveTools: "read"`, asking Claude to run a Bash command does **not** produce the command's filesystem side effect (proof `--tools` genuinely restricts).
2. With no `effectiveTools`, the same request **does** produce the side effect (baseline — so the test is measuring restriction, not some other failure mode).

**v8 (review-v9 finding 1) — side-effect oracle, not assistant prose.** The previous v6/v7 revisions asserted on whether Claude's assistant text contained a literal marker string (`HELLO_FROM_BASH_42`). That is not a trustworthy oracle for a security-sensitive test: (a) a compliant refusal can legitimately quote the command it was asked to run, producing a false failure in the restricted case, and (b) the model can emit the marker text without actually invoking Bash, producing a false pass in the baseline case. v8 therefore drives each case off an observable filesystem side effect instead: the task asks Bash to `echo <uniqueMarker> > <uniqueFile>` inside a per-test tempdir, and the assertion is whether `<uniqueFile>` exists on disk (restricted case: must not exist; baseline case: must exist and contain the marker). The only way the file can exist is if Bash actually executed the redirection — refusal prose and hallucinated marker text are both harmless to this oracle. Markers are generated per-case with `Date.now()` + a random suffix so parallel or repeated runs cannot cross-contaminate. The tempdir is created in `before` and removed in `after` so no test artifact is left on the host.

**v7 (review-v8 finding 2) — `--print` placement (carried forward).** `buildClaudeCmdParts` ends `parts` with `"--", shellEscape(task)` under Step 3's separator rule. Naively appending `--print` to the joined command (`parts.join(" ") + " --print"`) places `--print` *after* the `--` separator, where commander parses it as another positional argument instead of the non-interactive-mode option. That was verified locally: `claude --dangerously-skip-permissions -- 'Reply with exactly: OK' --print` hangs, while `claude --dangerously-skip-permissions --print -- 'Reply with exactly: OK'` returns immediately. To keep `--print` parsed as an option, the test splices it into `parts` **before** the `--` separator via a small helper. A defensive assertion on the separator's presence fails loud if a future refactor drops the `--` rule so the test cannot silently regress back to the broken v6 layout.

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeCmdParts } from "../../pi-extension/subagents/index.ts";

const CLAUDE_AVAILABLE = (() => {
  try { execSync("which claude", { stdio: "pipe" }); return true; }
  catch { return false; }
})();

/**
 * Insert `--print` immediately before the `--` separator (v7, review-v8
 * finding 2). Placing `--print` *after* the separator — as a naive
 * `parts.join(" ") + " --print"` would — causes commander to treat it as
 * another positional argument, so non-interactive mode is not engaged and
 * the command either hangs or measures the wrong path. The defensive
 * `sepIdx > 0` assertion keeps a future refactor that drops the separator
 * from silently regressing this test.
 */
function withPrintBeforeSeparator(parts: string[]): string {
  const injected = parts.slice();
  const sepIdx = injected.indexOf("--");
  assert.ok(sepIdx > 0,
    "expected -- separator before the task in buildClaudeCmdParts output; " +
    "a regression that drops the separator would place --print as a positional (v7 finding 2).");
  injected.splice(sepIdx, 0, "--print");
  return injected.join(" ");
}

/**
 * Build a unique marker + absolute filesystem-side-effect path for a
 * single test case (v8, review-v9 finding 1). The marker is generated
 * per-case with Date.now() + a random suffix so parallel / repeated
 * runs cannot cross-contaminate, and the file lives inside a per-test
 * tempdir so nothing leaks onto the host after cleanup.
 */
function makeMarker(dir: string, label: string): { marker: string; file: string } {
  const marker = `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return { marker, file: join(dir, `${marker}.txt`) };
}

describe("pane-claude-tool-restriction", { skip: !CLAUDE_AVAILABLE, timeout: 120_000 }, () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-pane-tool-restrict-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("--tools restricts the built-in set so Bash is unavailable when only read is allowed", () => {
    // Review-v9 finding 1: assert on an observable filesystem side effect,
    // not on assistant prose. A refusal that quotes the requested command
    // string cannot fake a file existing on disk.
    const { marker, file } = makeMarker(dir, "RESTRICT");
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s-restrict",
      pluginDir: undefined,
      model: "sonnet",
      identity: undefined,                 // v10 — was `appendSystemPrompt`
      systemPromptMode: undefined,         // v10 (review-v11 finding 1)
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      effectiveTools: "read",
      // Ask the model to run Bash with a side effect. If --tools actually
      // restricts, Bash cannot run, so the file cannot be created.
      task:
        `Run this exact bash command and nothing else: echo ${marker} > ${file}. ` +
        `If you cannot run it, say so briefly — do not describe or emulate the command.`,
    });
    const cmd = withPrintBeforeSeparator(parts);
    // Ignore stdout/exit code: the model may refuse in prose, which is
    // fine. The only question is whether the side-effect file exists.
    try { execSync(cmd, { cwd: dir, encoding: "utf8", timeout: 90_000 }); }
    catch { /* refusal-driven non-zero exit is acceptable */ }
    assert.ok(!existsSync(file),
      `--tools restriction failed: Bash wrote ${file}; tool restriction did not hold.`);
  });

  it("same request succeeds when effectiveTools is absent (baseline — rules out generic failure)", () => {
    // Baseline companion to the restricted case (review-v9 finding 1): if
    // Bash is unrestricted, the side-effect file MUST exist with the
    // exact marker as contents. Any other outcome means the test is
    // measuring something other than tool availability.
    const { marker, file } = makeMarker(dir, "BASELINE");
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s-baseline",
      pluginDir: undefined,
      model: "sonnet",
      identity: undefined,                 // v10 — was `appendSystemPrompt`
      systemPromptMode: undefined,         // v10 (review-v11 finding 1)
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      // No effectiveTools — no --tools emitted, full built-in set available.
      task:
        `Run this exact bash command and nothing else: echo ${marker} > ${file}. ` +
        `Do not paraphrase the command; run it as written.`,
    });
    const cmd = withPrintBeforeSeparator(parts);
    execSync(cmd, { cwd: dir, encoding: "utf8", timeout: 90_000 });
    assert.ok(existsSync(file),
      `baseline case failed: Bash was not invoked even though --tools was absent; ${file} does not exist.`);
    const contents = readFileSync(file, "utf8").trim();
    assert.equal(contents, marker,
      `baseline file contents mismatch — expected ${marker}, got ${JSON.stringify(contents)}.`);
  });
});

/**
 * Second describe block (v9, review-v10 finding 2; v10 rewritten per
 * review-v11 finding 2). The pane-Claude skills-dropped warning must fire
 * on the pane path, not just the headless path. In v9 this block called
 * `warnClaudeSkillsDropped(...)` directly — which is indistinguishable
 * from the helper's own unit test in `claude-skills-warning.test.ts`, so
 * a regression that dropped the *call site* inside `launchSubagent()`
 * (while the helper itself stayed working) would still pass. v10 rewires
 * the test to actually exercise the pane launch path: it invokes
 * `launchSubagent({ cli: "claude", skills: "..." })` with a pre-created
 * fake surface so `createSurface` is skipped, captures stderr around the
 * call, and swallows the expected downstream `sendLongCommand` failure
 * (mux is not available in test, so the command write-out raises).
 *
 * The warning emits *synchronously* inside the Claude branch *before*
 * `sendLongCommand` is invoked, so the stderr capture is populated
 * regardless of the later failure — the catch is purely for noise
 * suppression, not the oracle. Removing the `warnClaudeSkillsDropped(...)`
 * line from `launchSubagent()` now fails this test loudly.
 */
describe("pane-claude-skills-warning (review-v11 finding 2)", () => {
  // No skip: this test does not invoke Claude. It drives the synchronous
  // pre-spawn portion of launchSubagent() in a mux-less environment.
  it("launchSubagent() emits the warning from the pane Claude branch when effectiveSkills is non-empty", async () => {
    // Dynamic import lives inside the `it` body so the stderr shim is in
    // place *before* the module is loaded and initialized. The package is
    // ESM ("type": "module" in package.json), so dynamic `import(...)` is
    // the only option.
    const { launchSubagent } = await import(
      "../../pi-extension/subagents/index.ts"
    );

    let captured = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string | Buffer): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };

    const sessionDir = mkdtempSync(join(tmpdir(), "pi-pane-warn-"));
    try {
      // options.surface = <fake-id> skips createSurface(...), so we don't
      // need a real mux to reach the Claude branch. launchSubagent still
      // calls sendLongCommand(surface, ...) after the warning — that will
      // throw because the fake surface has no backend, which is the
      // "expected downstream failure" noted above.
      await launchSubagent(
        {
          name: "pane-subagent",
          task: "ignored — test never reaches Claude",
          cli: "claude",
          skills: "plan, code-review",
        } as any,
        {
          sessionManager: {
            getSessionFile: () => join(sessionDir, "parent.jsonl"),
            getSessionId: () => "parent",
            getSessionDir: () => sessionDir,
          },
          cwd: sessionDir,
        } as any,
        { surface: "pi-test-fake-surface" },
      ).catch(() => {
        // sendLongCommand failure is expected (no mux backend in test).
        // The warning fires BEFORE sendLongCommand, so the stderr capture
        // is already populated by the time we swallow this rejection.
      });
    } finally {
      (process.stderr as any).write = origWrite;
      rmSync(sessionDir, { recursive: true, force: true });
    }

    // Same wording contract as the unit test, but this time the write path
    // is through launchSubagent()'s Claude branch — removing the call site
    // from that branch makes this assertion fail even if the helper
    // itself still works.
    assert.ok(captured.includes("pane-subagent"),
      `expected subagent name in warning (review-v11 finding 2 regression: pane call site removed); got: ${JSON.stringify(captured)}`);
    assert.ok(captured.includes("ignoring skills=plan, code-review"),
      `expected skills list in warning; got: ${JSON.stringify(captured)}`);
    assert.ok(captured.includes("Claude path"),
      `expected "Claude path" wording so pane + headless match; got: ${JSON.stringify(captured)}`);
  });

  it("launchSubagent() is silent on stderr when skills are empty on the pane Claude branch", async () => {
    // Negative case: guards against a regression where `warnClaudeSkillsDropped`
    // starts always-writing. The helper must stay a no-op when effectiveSkills
    // is empty — otherwise every pane-Claude launch would produce warning
    // noise regardless of whether skills were requested.
    const { launchSubagent } = await import(
      "../../pi-extension/subagents/index.ts"
    );

    let captured = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: string | Buffer): boolean => {
      captured += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };

    const sessionDir = mkdtempSync(join(tmpdir(), "pi-pane-warn-silent-"));
    try {
      await launchSubagent(
        {
          name: "pane-subagent",
          task: "ignored",
          cli: "claude",
          // No skills field — the warning should not fire.
        } as any,
        {
          sessionManager: {
            getSessionFile: () => join(sessionDir, "parent.jsonl"),
            getSessionId: () => "parent",
            getSessionDir: () => sessionDir,
          },
          cwd: sessionDir,
        } as any,
        { surface: "pi-test-fake-surface" },
      ).catch(() => { /* mux-less downstream failure — ignored */ });
    } finally {
      (process.stderr as any).write = origWrite;
      rmSync(sessionDir, { recursive: true, force: true });
    }

    assert.equal(captured.includes("ignoring skills="), false,
      `expected no skills-dropped warning when no skills declared; got stderr: ${JSON.stringify(captured)}`);
  });

  it("buildClaudeCmdParts does NOT leak /skill:... tokens into the pane argv (defense in depth)", () => {
    // Complements the stderr check: even if the warning were ever
    // silenced by mistake, the command builder itself must not emit
    // skill tokens into the argv. The builder's input shape has no
    // skills field, so the only way skill text could leak would be if
    // someone threaded it in via the `task` argument. This case
    // documents that contract.
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s-skills",
      pluginDir: undefined,
      model: "sonnet",
      identity: undefined,                 // v10 — was `appendSystemPrompt`
      systemPromptMode: undefined,         // v10 (review-v11 finding 1)
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do the real work",
    });
    for (const a of parts) {
      assert.ok(!a.includes("/skill:"),
        `pane argv must not contain /skill:... tokens; got: ${parts.join(" | ")}`);
    }
  });
});
```

Run: `npm run test:integration -- --test-name-pattern='pane-claude-tool-restriction|pane-claude-skills-warning' 2>&1 | tail -40`
Expected: PASS on all cases (the `pane-claude-skills-warning` block has no CLI skip). A regression of review-v7 finding 1 manifests as case 1 of the first block failing because Bash actually wrote the marker file. A regression of review-v8 finding 2 manifests as case 2 of the first block hanging up to the test timeout (because `--print` becomes a positional, non-interactive mode is not engaged, and Claude sits in interactive mode waiting for more input). A regression of review-v9 finding 1 (reverting to a prose-based oracle) is caught at code review: this test must assert on `existsSync` / `readFileSync`, never on `stdout.includes(...)`. **v10 (review-v11 finding 2):** a regression where someone removes the `warnClaudeSkillsDropped(...)` line from `launchSubagent()`'s Claude branch — but leaves the helper function itself intact — now fails the first `it` in the `pane-claude-skills-warning` block (v9's direct-helper call site in this block could not catch that regression; v10's `launchSubagent(...)` invocation does). A regression where the helper starts always-writing is caught by the new "silent when skills empty" case.

- [ ] **Step 6: Invariant check — sweep for callers that would regress**

Run: `grep -rn '"tools":\|tools:' pi-config/agent/agents/ 2>/dev/null | head -20 || echo "pi-config not on this host"`
Expected: either a short list of agents that declare `tools:` frontmatter (they will now get `--tools` in pane-Claude mode — confirm that matches intent), or the "not on this host" message. If any listed agent relies on unrestricted tools despite declaring `tools:`, call that out in the commit body so the Phase 3 merge can be audited.

- [ ] **Step 7: Commit (named for upstream portability)**

```bash
git add pi-extension/subagents/backends/tool-map.ts pi-extension/subagents/index.ts test/orchestration/thinking-effort.test.ts test/orchestration/claude-skills-warning.test.ts test/integration/pane-claude-tool-restriction.test.ts
git commit -m "feat(subagents): emit --tools + required -- separator on Claude path; share skills-dropped warning; centralize tool map; unify Claude system-prompt contract

Adds a new shared backends/tool-map.ts module that owns
PI_TO_CLAUDE_TOOLS; both pane (buildClaudeCmdParts) and headless
(buildClaudeHeadlessArgs) builders import from it so the map
cannot silently drift between backends (review-v11 finding 3).
Emits --tools + required -- separator, closing the
tool-restriction security regression identified during fork-state
review. Uses --tools (the built-in tool availability primitive)
rather than --allowedTools (a permission rule that
bypassPermissions / dangerously-skip-permissions mode ignores).
Mirrors the upstream regression test at
pi-subagent/test/claude-args.test.ts:302-316 so tool-restricted
runs do not have their prompt consumed as another tool name.
Includes a pane-Claude E2E restriction test that exercises the
full shell-escaped command path.

Also introduces a shared warnClaudeSkillsDropped helper so both
pane (launchSubagent) and headless (runClaudeHeadless) Claude
paths emit identical stderr wording when effectiveSkills is
non-empty (v1 scope: skills are not consumed on the Claude
backend — review-v10 finding 2 closed the pane-only silent-drop
gap, review-v11 finding 2 upgraded the pane regression-coverage
to actually traverse launchSubagent()).

Finally unifies the Claude system-prompt contract across both
backends (review-v11 finding 1): pane-Claude now reads spec.identity
(agentDefs.body ?? params.systemPrompt) instead of params.systemPrompt
first, and uses spec.claudeTaskBody (fullTask minus the pi-only
roleBlock) as the task body so identity never double-enters via
the task body when also emitted through --append-system-prompt.
The pane and headless Claude paths now share one rule for
identity source, placement flag, and task body. Kept as a discrete
named commit portable to an upstream PR alongside the existing
thinking patch."
```

### Task 18: Lift `parseClaudeStreamEvent` + `parseClaudeResult` into `claude-stream.ts`

**Files:**
- Create: `pi-extension/subagents/backends/claude-stream.ts`
- Create: `test/orchestration/claude-event-transform.test.ts`

- [ ] **Step 1: Write the failing transform test**

Create `test/orchestration/claude-event-transform.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeStreamEvent, parseClaudeResult } from "../../pi-extension/subagents/backends/claude-stream.ts";

describe("parseClaudeStreamEvent", () => {
  it("transforms tool_use blocks to pi-compatible toolCall shape, lowercased name", () => {
    const result = parseClaudeStreamEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "abc", name: "Read", input: { path: "/tmp/x" } },
        ],
      },
    });
    // v11 (review-v15 finding): return shape is TranscriptMessage[] | undefined.
    // Assistant events produce a single-element array; the caller iterates so
    // user events carrying multiple tool_result blocks can emit one
    // TranscriptMessage per block (see the toolResult test below).
    assert.ok(Array.isArray(result), "parser must return a TranscriptMessage[]");
    assert.equal(result!.length, 1);
    const msg = result![0] as any;
    assert.equal(msg.role, "assistant");
    assert.equal(msg.content[0].type, "text");
    assert.equal(msg.content[1].type, "toolCall");
    assert.equal(msg.content[1].id, "abc");
    assert.equal(msg.content[1].name, "read");
    assert.deepEqual(msg.content[1].arguments, { path: "/tmp/x" });
  });

  it("returns undefined for non-assistant, non-user events", () => {
    assert.equal(parseClaudeStreamEvent({ type: "result", result: "ok" }), undefined);
    assert.equal(parseClaudeStreamEvent({ type: "system", subtype: "init" }), undefined);
  });

  it("passes through text-only assistant messages unchanged in shape", () => {
    const r = parseClaudeStreamEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    })!;
    assert.equal(r.length, 1);
    const msg = r[0];
    assert.equal(msg.role, "assistant");
    assert.equal(msg.content[0].type, "text");
    if (msg.content[0].type === "text") assert.equal(msg.content[0].text, "done");
  });

  // v11 (review-v15 finding) — tool_result round-trip coverage. v10's parser
  // only handled `"assistant"` events (projecting `tool_use` → `toolCall`);
  // Claude also emits `"user"` events whose content array contains
  // `tool_result` blocks (the tool execution output the model consumed on
  // its next turn). Without projecting those, `transcript[]` lost the
  // second half of every tool round-trip — Task 21 could only observe
  // tool *calls*, not the tool *results* the model actually read. These
  // tests pin the new projection so a regression that drops the user-
  // event branch (or silently stops re-roling "user" to "toolResult")
  // fails loud.
  it("projects a user event carrying a tool_result block to role: 'toolResult' with toolCallId / isError / normalized content", () => {
    const r = parseClaudeStreamEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_abc",
            is_error: false,
            content: [{ type: "text", text: "file contents" }],
          },
        ],
      },
    })!;
    assert.ok(Array.isArray(r));
    assert.equal(r.length, 1);
    const msg = r[0];
    assert.equal(msg.role, "toolResult",
      "user events with tool_result content must be re-roled to 'toolResult' at the boundary");
    assert.equal(msg.toolCallId, "toolu_abc");
    assert.equal(msg.isError, false);
    assert.equal(msg.content.length, 1);
    assert.equal(msg.content[0].type, "text");
    if (msg.content[0].type === "text") assert.equal(msg.content[0].text, "file contents");
  });

  it("normalizes a tool_result whose content is a bare string into a TextContent block array", () => {
    // Claude CLI sometimes emits tool_result.content as a bare string
    // rather than an array of blocks (e.g. for short Bash output). The
    // TranscriptMessage contract requires `content: TranscriptContent[]`
    // for every role, so the projection wraps the string in a single
    // `{type:"text"}` block — mirroring the pi-side `projectPiMessage
    // ToTranscript` contract so consumers can iterate `content[i].type`
    // at any callsite without a typeof-guard.
    const r = parseClaudeStreamEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_xyz", is_error: true, content: "bash error output" },
        ],
      },
    })!;
    const msg = r[0];
    assert.equal(msg.role, "toolResult");
    assert.equal(msg.isError, true);
    assert.ok(Array.isArray(msg.content));
    assert.equal(msg.content[0].type, "text");
    if (msg.content[0].type === "text") assert.equal(msg.content[0].text, "bash error output");
  });

  it("emits one TranscriptMessage per tool_result block when a user event batches multiple parallel tool results", () => {
    // Parallel tool calls can produce multiple tool_result blocks in a
    // single user event. Collapsing them into one TranscriptMessage would
    // lose the 1:1 toolCallId → toolResult mapping. Keep one message per
    // block so `transcript[]` has exactly one toolResult entry for each
    // toolCall entry (same invariant the pi path provides).
    const r = parseClaudeStreamEvent({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", is_error: false, content: "A" },
          { type: "tool_result", tool_use_id: "toolu_b", is_error: false, content: "B" },
        ],
      },
    })!;
    assert.equal(r.length, 2);
    assert.equal(r[0].toolCallId, "toolu_a");
    assert.equal(r[1].toolCallId, "toolu_b");
  });

  it("returns undefined for user events that carry no tool_result blocks (v1 scope)", () => {
    // Plain user-text user events are rare in `-p` mode but legal. In v1
    // we deliberately do not surface them in transcript[] — the array is
    // scoped to assistant output + tool_result pairs. A future change that
    // wants to include user text should do so explicitly; until then,
    // returning undefined keeps the caller's iteration a no-op.
    const r = parseClaudeStreamEvent({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    assert.equal(r, undefined);
  });
});

describe("parseClaudeResult", () => {
  it("extracts usage, cost, turns on success", () => {
    const r = parseClaudeResult({
      type: "result",
      is_error: false,
      subtype: "success",
      result: "OK",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 200,
      },
      total_cost_usd: 0.0012,
      num_turns: 3,
      model: "claude-sonnet-4-6",
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.finalOutput, "OK");
    assert.equal(r.usage.input, 10);
    assert.equal(r.usage.output, 5);
    assert.equal(r.usage.cacheRead, 100);
    assert.equal(r.usage.cacheWrite, 200);
    assert.equal(r.usage.cost, 0.0012);
    assert.equal(r.usage.turns, 3);
    assert.equal(r.usage.contextTokens, 315);
    assert.equal(r.model, "claude-sonnet-4-6");
  });

  it("flags error when is_error=true or subtype!='success'", () => {
    const r1 = parseClaudeResult({ type: "result", is_error: true, usage: {}, result: "oops" });
    assert.equal(r1.exitCode, 1);
    assert.ok(r1.error);
    const r2 = parseClaudeResult({ type: "result", is_error: false, subtype: "rate_limit", usage: {} });
    assert.equal(r2.exitCode, 1);
    assert.ok(r2.error);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npm test -- --test-name-pattern='parseClaudeStreamEvent|parseClaudeResult' 2>&1 | tail -30`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write `claude-stream.ts`**

Create `pi-extension/subagents/backends/claude-stream.ts`:

```ts
import type { TranscriptContent, TranscriptMessage, UsageStats } from "./types.ts";

export interface ClaudeResult {
  exitCode: number;
  finalOutput: string;
  usage: UsageStats;
  error?: string;
  model?: string;
}

/**
 * Parse an intermediate Claude Code stream-json event into zero or more
 * boundary-projected `TranscriptMessage` entries.
 *
 * v11 (review-v15 finding) — return type and semantics.
 *   - v10 returned `unknown | undefined` and only handled `"assistant"` events,
 *     projecting `tool_use` blocks to the pi-compatible `toolCall` shape.
 *     The tool-result half of the round-trip (Claude's `"user"` events
 *     carrying `tool_result` content blocks) was silently dropped, so
 *     `transcript[]` on the headless Claude path exposed tool calls without
 *     their matching tool results.
 *   - v11 widens the contract: the return type is `TranscriptMessage[] |
 *     undefined`. `"assistant"` events produce a single-element array;
 *     `"user"` events carrying `tool_result` blocks produce one
 *     `TranscriptMessage` per block (parallel tool calls can batch
 *     multiple results into one event — emitting N messages preserves
 *     the 1:1 toolCallId → toolResult invariant the pi path also upholds).
 *     Plain user-text events and other event types return undefined.
 *
 * "user" events with tool_result content are re-roled to `"toolResult"`
 * at this boundary so downstream consumers see a role that matches the
 * pi path's `{role: "toolResult", content, toolCallId, toolName,
 * isError}` shape — a consistent transcript across backends is a
 * first-class goal of the spec.
 *
 * Lifted (and widened) from `pi-subagent/claude-args.ts:153` — the
 * upstream helper also only handled assistant events; this fork's
 * version closes the tool-result gap that review-v15 flagged.
 */
export function parseClaudeStreamEvent(
  event: Record<string, unknown>,
): TranscriptMessage[] | undefined {
  if (event.type === "assistant") {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return undefined;
    const rawContent = message.content;
    const content: TranscriptContent[] = Array.isArray(rawContent)
      ? (rawContent as Array<Record<string, unknown>>).map((block) => {
          if (block.type === "tool_use") {
            return {
              type: "toolCall",
              id: block.id as string,
              name: (block.name as string)?.toLowerCase(),
              arguments: block.input,
            };
          }
          return block as unknown as TranscriptContent;
        })
      : [];
    return [{ role: "assistant", content }];
  }
  if (event.type === "user") {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message || !Array.isArray(message.content)) return undefined;
    const out: TranscriptMessage[] = [];
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result") continue;
      // Normalize tool_result.content: Claude CLI may emit a bare string
      // (short output) or an array of content blocks (rich output).
      // TranscriptMessage.content is always `TranscriptContent[]`, so
      // wrap the string case in a single text block. Image blocks use
      // Anthropic's `{source: {data, media_type}}` nesting; flatten to
      // the TranscriptContent `image` shape.
      const raw = block.content;
      let content: TranscriptContent[];
      if (typeof raw === "string") {
        content = [{ type: "text", text: raw }];
      } else if (Array.isArray(raw)) {
        content = (raw as Array<Record<string, unknown>>).map((b) => {
          if (b.type === "text") return { type: "text", text: b.text as string };
          if (b.type === "image") {
            const src = (b.source ?? {}) as Record<string, unknown>;
            return {
              type: "image",
              data: (src.data as string) ?? (b.data as string) ?? "",
              mimeType: (src.media_type as string) ?? (b.mimeType as string) ?? "",
            };
          }
          return b as unknown as TranscriptContent;
        });
      } else {
        content = [];
      }
      out.push({
        role: "toolResult",
        content,
        toolCallId: block.tool_use_id as string,
        isError: block.is_error === true,
      });
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

/**
 * Parse the final "result" event from Claude Code stream-json output.
 *
 * Lifted from pi-subagent/claude-args.ts:176 (adapted to return
 * UsageStats for consistency with the Backend interface).
 */
export function parseClaudeResult(json: Record<string, unknown>): ClaudeResult {
  const isError = json.is_error === true;
  const subtype = json.subtype as string | undefined;
  const hasError = isError || (subtype !== undefined && subtype !== "success");

  const usage = (json.usage ?? {}) as Record<string, number>;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cost = (json.total_cost_usd as number) ?? 0;
  const turns = (json.num_turns as number) ?? 0;

  return {
    exitCode: hasError ? 1 : 0,
    finalOutput: (json.result as string) || "",
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      cost,
      contextTokens: input + output + cacheRead + cacheWrite,
      turns,
    },
    error: hasError
      ? ((json.result as string) || subtype || "unknown_error")
      : undefined,
    model: json.model as string | undefined,
  };
}
```

- [ ] **Step 4: Run the tests; confirm all pass**

Run: `npm test -- --test-name-pattern='parseClaudeStreamEvent|parseClaudeResult' 2>&1 | tail -40`
Expected: PASS, 9 tests (7 `parseClaudeStreamEvent` + 2 `parseClaudeResult`) — v11 (review-v15 finding) added four `tool_result` projection cases to the v10 set of three.

- [ ] **Step 5: Commit**

```bash
git add pi-extension/subagents/backends/claude-stream.ts test/orchestration/claude-event-transform.test.ts
git commit -m "feat(backends): add claude-stream parser with tool_use→toolCall and tool_result→toolResult projections

v10 projected only the assistant-side tool_use blocks, leaving the
tool_result half of the round-trip silently dropped — consumers reading
transcript[] on the headless Claude path saw tool calls with no matching
tool results (review-v15 finding). v11 widens parseClaudeStreamEvent
to return TranscriptMessage[] | undefined and handles Claude's 'user'
events that carry tool_result content, re-roling them to 'toolResult'
at the boundary and emitting one message per block so parallel tool
calls preserve the 1:1 toolCallId mapping."
```

### Task 19: Implement `runClaudeHeadless` driven by `ResolvedLaunchSpec` (spawn, parse, session-id extraction, `--resume` support, session-id transcript discovery)

**Files:**
- Modify: `pi-extension/subagents/backends/headless.ts` (overwrite the Phase 2 Claude stub; add `findClaudeSessionFile` + rework `archiveClaudeTranscript` to use it)
- Modify: `pi-extension/subagents/backends/claude-stream.ts` (add a pure `buildClaudeHeadlessArgs(spec)` so unit tests can assert arg construction without spawning Claude; guard the `--` task separator on empty task, matching the pane-side builder)
- Create: `test/orchestration/claude-transcript-discovery.test.ts` (new in v5 — locks the discovery contract so future drift from Claude's on-disk layout fails loud; review-v6 blocker 2)

This Task closes review findings 2 (parity — partial; see skills note below), 4 (`resumeSessionId`), and the review-v6 blocker 2 (transcript archival must not depend on a guessed Claude project-dir slug). The pi headless path already consumes `ResolvedLaunchSpec`; the Claude headless path now does too. Specifically the Claude args include:

- `--model <claude-id>` derived from `spec.effectiveModel` (provider prefix stripped for Claude CLI)
- `--effort <off|low|medium|high|max>` derived from `spec.effectiveThinking`
- `--tools <Mapped,Names>` from `spec.effectiveTools` via `PI_TO_CLAUDE_TOOLS` — **v10 (review-v11 finding 3):** imported from `pi-extension/subagents/backends/tool-map.ts`, the single shared source of truth; the pane builder (Task 17) imports the same symbol from the same file. v9 had two locally-declared copies of this map in two files (one in `index.ts`, one in `claude-stream.ts`) — a silent-drift hazard in a security-sensitive area that the v11 reviewer flagged. **v6:** `--tools` (the Claude CLI built-in tool availability flag), not `--allowedTools` (a permission rule bypassPermissions mode ignores). See the Task 17 intro for the Claude-CLI help references that establish the distinction (review-v7 finding 1).
- `--append-system-prompt <identity>` or `--system-prompt <identity>` from `spec.identity` when `spec.identity` is non-null. Flag selection is driven by `spec.systemPromptMode`: `"replace"` → `--system-prompt`, anything else (including `undefined`) → `--append-system-prompt`. **v10 (review-v11 finding 1):** the Claude path deliberately ignores `spec.identityInSystemPrompt` — that flag only governs pi's role-block-in-task-body placement (pi's legacy behavior when `systemPromptMode` is unset); Claude has no equivalent role-block convention, so for Claude the system-prompt flag is always the right placement when identity is present. The precedence of identity itself (agent body vs. per-call `systemPrompt`) is determined by `spec.identity = agentDefs?.body ?? params.systemPrompt ?? null`, the same rule the pi path uses.
- `--resume <id>` from `spec.resumeSessionId` — review finding 4 (was dropped in v1).
- task body: **v10 (review-v11 finding 1)** — `spec.claudeTaskBody` for `direct` delivery (NOT `spec.fullTask`, which includes the pi-only role-block preamble and would duplicate identity already emitted via the Claude system-prompt flag). In fork mode, `spec.claudeTaskBody` equals `params.task` exactly; in blank-session modes it is the mode hint + `params.task` + summary instruction, without the role block. For `artifact` delivery, the same principle applies: Claude CLI does not consume `@<path>`, so we read the artifact file's content into the prompt — but the artifact's contents are the Claude-flavored task body (no role block), not the pi-flavored `fullTask`. See Task 9b Step 3 for how the artifact path is produced with the right contents.

The abort escalation uses the same `exited`-flag pattern as `runPiHeadless` (review finding 3).

**v11 — transcript round-trip completeness (review-v15 finding).** The parser (`parseClaudeStreamEvent`, Task 18) now returns `TranscriptMessage[] | undefined` and handles Claude's `"user"` stream-json events carrying `tool_result` content blocks — re-roling them to `"toolResult"` at the boundary so downstream consumers reading `transcript[]` see a consistent `{toolCall, toolResult, toolCall, toolResult, ...}` sequence (the same shape the pi path provides). `runClaudeHeadless`'s caller below iterates the array (`for (const m of msgs) transcript.push(m)`) so parallel tool calls that Claude batches into one `user` event emit one `TranscriptMessage` per `tool_result` block, preserving the 1:1 toolCallId → toolResult invariant. The Task 21 integration test asserts the round-trip end-to-end; the new `parseClaudeStreamEvent` unit cases in Task 18 assert the shape + normalization + multi-block fan-out deterministically.

**v6 — Claude + skills explicitly dropped with a stderr warning (review-v7 finding 3; v9 review-v10 finding 2).** `spec.skillPrompts` is **not** included in the Claude argv. pi's `/skill:foo` expansion is a pi-CLI feature (it only works because pi parses the leading token of each positional `messages[1..]`); Claude has no equivalent for `-p` mode. Rather than silently dropping (so users get confused why their agent's declared `skills:` frontmatter had no effect) or leaking literal `/skill:foo` strings into the task body (worse than no skills at all), the Claude path emits a single `stderr` line when `spec.skillPrompts.length > 0` and proceeds without them. **v9 (review-v10 finding 2):** the warning is now delegated to the shared `warnClaudeSkillsDropped` helper in `pi-extension/subagents/index.ts` (Task 17 Step 3a), so pane-Claude and headless-Claude emit exactly the same wording from a single source of truth. Step 2 lands the headless call site; Step 1 adds a unit test that covers the argv shape (no skill leakage) and the warning channel.

- [ ] **Step 1: Add a pure arg-builder + write a failing test**

In `pi-extension/subagents/backends/claude-stream.ts`, append:

```ts
import type { ResolvedLaunchSpec } from "../launch-spec.ts";
// v10 (review-v11 finding 3): shared source of truth. v9 redeclared this
// map locally here AND in pi-extension/subagents/index.ts (Task 17 Step 3).
// Two copies in a security-sensitive code path are a silent-drift hazard —
// an update to one could diverge from the other. The shared module is the
// only declaration; both pane and headless builders import from it.
import { PI_TO_CLAUDE_TOOLS } from "./tool-map.ts";

const EFFORT_MAP: Record<string, string> = {
  off: "low", minimal: "low", low: "low",
  medium: "medium", high: "high", xhigh: "max",
};

/**
 * Build the headless Claude CLI argv from a ResolvedLaunchSpec.
 *
 * Pure — no IO. Called by runClaudeHeadless and by unit tests so the
 * resumeSessionId / model / tools / system-prompt threading is asserted
 * without spawning a real Claude process.
 *
 * v6 note (review-v7 finding 3): skill prompts are **NOT** emitted here.
 * Claude has no equivalent of pi's `/skill:foo` message-prefix expansion,
 * so shoving them into the task body would leak literal text. Callers that
 * need to surface a warning about dropped skills should do so at the
 * runClaudeHeadless layer, not inside this pure function.
 */
export function buildClaudeHeadlessArgs(
  spec: ResolvedLaunchSpec,
  taskText: string,
): string[] {
  const args: string[] = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
  ];
  if (spec.effectiveModel) {
    const slashIdx = spec.effectiveModel.indexOf("/");
    args.push("--model",
      slashIdx >= 0 ? spec.effectiveModel.slice(slashIdx + 1) : spec.effectiveModel);
  }
  if (spec.effectiveThinking) {
    const effort = EFFORT_MAP[spec.effectiveThinking.toLowerCase()];
    if (effort) args.push("--effort", effort);
  }
  if (spec.identity) {
    const flag = spec.systemPromptMode === "replace"
      ? "--system-prompt"
      : "--append-system-prompt";
    args.push(flag, spec.identity);
  }
  if (spec.effectiveTools) {
    const claudeTools = new Set<string>();
    for (const t of spec.effectiveTools.split(",").map((s) => s.trim()).filter(Boolean)) {
      const mapped = PI_TO_CLAUDE_TOOLS[t.toLowerCase()];
      if (mapped) claudeTools.add(mapped);
    }
    // --tools (NOT --allowedTools): --tools constrains the built-in tool
    // set available to the model; --allowedTools is a permission rule that
    // `--permission-mode bypassPermissions` ignores. See Task 17 intro
    // (v6 / review-v7 finding 1) for rationale.
    if (claudeTools.size > 0) args.push("--tools", [...claudeTools].join(","));
  }
  if (spec.resumeSessionId) {
    args.push("--resume", spec.resumeSessionId);
  }
  // Append `--` before the task so the variadic --tools option does not
  // swallow the prompt as "another tool name" — mirrors the pane-side
  // builder (`buildClaudeCmdParts` in Task 17) and the upstream contract
  // at `../pi-subagent/test/claude-args.test.ts:302-316, 319-327`.
  if (taskText !== "") {
    args.push("--", taskText);
  }
  return args;
}
```

Add to `test/orchestration/claude-event-transform.test.ts`:

```ts
import { buildClaudeHeadlessArgs } from "../../pi-extension/subagents/backends/claude-stream.ts";

describe("buildClaudeHeadlessArgs", () => {
  const baseSpec: any = {
    name: "S", task: "do",
    effectiveCli: "claude",
    effectiveModel: undefined, effectiveTools: undefined, effectiveSkills: undefined,
    effectiveThinking: undefined, skillPrompts: [],
    effectiveCwd: null, localAgentDir: null, effectiveAgentDir: "/tmp",
    configRootEnv: {}, identity: null, identityInSystemPrompt: false,
    systemPromptMode: undefined, fullTask: "do", claudeTaskBody: "do",
    sessionMode: "standalone", seededSessionMode: null,
    inheritsConversationContext: false, taskDelivery: "direct",
    subagentSessionFile: "/tmp/x.jsonl", artifactDir: "/tmp",
    autoExit: false, denySet: new Set<string>(),
    resumeSessionId: undefined, focus: undefined, agentDefs: null,
  };

  it("emits --resume <id> when spec.resumeSessionId is set (review finding 4)", () => {
    const args = buildClaudeHeadlessArgs({ ...baseSpec, resumeSessionId: "abc-123" }, "do");
    const idx = args.indexOf("--resume");
    assert.notEqual(idx, -1, `--resume must be in args: ${args.join(" ")}`);
    assert.equal(args[idx + 1], "abc-123");
  });

  it("strips provider prefix on the model arg", () => {
    const args = buildClaudeHeadlessArgs({ ...baseSpec, effectiveModel: "anthropic/claude-haiku-4-5" }, "do");
    const idx = args.indexOf("--model");
    assert.equal(args[idx + 1], "claude-haiku-4-5");
  });

  it("maps thinking → effort", () => {
    const args = buildClaudeHeadlessArgs({ ...baseSpec, effectiveThinking: "xhigh" }, "do");
    const idx = args.indexOf("--effort");
    assert.equal(args[idx + 1], "max");
  });

  it("emits --append-system-prompt by default and --system-prompt when mode=replace", () => {
    const a = buildClaudeHeadlessArgs({ ...baseSpec, identity: "you are X" }, "do");
    assert.notEqual(a.indexOf("--append-system-prompt"), -1);
    const r = buildClaudeHeadlessArgs(
      { ...baseSpec, identity: "you are X", systemPromptMode: "replace" }, "do");
    assert.notEqual(r.indexOf("--system-prompt"), -1);
    assert.equal(r.indexOf("--append-system-prompt"), -1);
  });

  // v10 (review-v11 finding 1). The Claude system-prompt contract: identity
  // is ALWAYS emitted via the flag when non-null, regardless of
  // identityInSystemPrompt. That pi-only switch picks between "flag" and
  // "roleBlock-in-task-body" — Claude has no roleBlock path, so the flag
  // must fire in both branches. v9's builder already did this, but locking
  // it here guards against a "consistency cleanup" that threads
  // identityInSystemPrompt into the Claude path and breaks the contract.
  it("emits the system-prompt flag regardless of spec.identityInSystemPrompt (v10, review-v11 finding 1)", () => {
    const withFlag = buildClaudeHeadlessArgs(
      { ...baseSpec, identity: "X", identityInSystemPrompt: true }, "do");
    assert.notEqual(withFlag.indexOf("--append-system-prompt"), -1,
      "identityInSystemPrompt=true must still emit the flag on Claude");

    const withoutFlag = buildClaudeHeadlessArgs(
      { ...baseSpec, identity: "X", identityInSystemPrompt: false }, "do");
    assert.notEqual(withoutFlag.indexOf("--append-system-prompt"), -1,
      "identityInSystemPrompt=false must still emit the flag on Claude (the pi roleBlock path does not apply)");
  });

  // v10 (review-v11 finding 1). Identity must appear in the argv exactly
  // once — after --append-system-prompt — even when the task body also
  // contains model-instruction text. A regression where the Claude headless
  // path reverted to using spec.fullTask (which embeds the roleBlock) would
  // make identity appear twice: once in the flag, once in the final -- task
  // argv. This test fails loud in that case.
  it("does not duplicate identity text in the task argv (v10, review-v11 finding 1)", () => {
    // taskText is what runClaudeHeadless computes from spec.claudeTaskBody —
    // it does NOT include the roleBlock prefix. Simulate that input here.
    const args = buildClaudeHeadlessArgs(
      { ...baseSpec, identity: "ROLE_TEXT_XYZ" },
      "do the task (no identity leakage here)",
    );
    const occurrences = args.filter((a) => a.includes("ROLE_TEXT_XYZ"));
    assert.equal(occurrences.length, 1,
      `identity must appear exactly once (after --append-system-prompt); got ${occurrences.length} (regression: someone fed spec.fullTask with roleBlock prefix as taskText)`);
  });

  it("emits --tools with mapped Claude tool names; drops unknowns (v6 / review-v7 finding 1)", () => {
    const args = buildClaudeHeadlessArgs(
      { ...baseSpec, effectiveTools: "read, bash, find, ls, unknown" }, "do");
    const idx = args.indexOf("--tools");
    assert.notEqual(idx, -1, "--tools must be present (v5's --allowedTools was a permission rule bypassPermissions ignored)");
    const mapped = new Set(args[idx + 1].split(","));
    assert.ok(mapped.has("Read"));
    assert.ok(mapped.has("Bash"));
    assert.ok(mapped.has("Glob"));    // find + ls both map to Glob, deduped
    assert.ok(!mapped.has("unknown"));
    // Regression guard: --allowedTools must NOT be emitted. v5 used it,
    // which bypassPermissions mode silently ignored.
    assert.equal(args.includes("--allowedTools"), false,
      "must not emit --allowedTools (permission rule ignored under bypassPermissions)");
  });

  it("does NOT include /skill:... tokens in the argv when spec.skillPrompts is non-empty (v6 / review-v7 finding 3)", () => {
    // Claude has no pi-style /skill: expansion; emitting them into the task
    // body would leak literal text. buildClaudeHeadlessArgs must silently
    // omit them (the warning surface is in runClaudeHeadless, not here,
    // because this function is pure — see its JSDoc).
    const args = buildClaudeHeadlessArgs(
      { ...baseSpec, skillPrompts: ["/skill:plan", "/skill:code-review"] },
      "the real task",
    );
    for (const a of args) {
      assert.ok(!a.startsWith("/skill:"),
        `argv must not contain /skill:... tokens; got: ${args.join(" | ")}`);
    }
    // Sanity: the real task is the final arg (after --).
    assert.equal(args[args.length - 1], "the real task");
  });
});
```

Run: `npm test -- --test-name-pattern='buildClaudeHeadlessArgs' 2>&1 | tail -30`
Expected: FAIL — `buildClaudeHeadlessArgs` does not exist yet.

- [ ] **Step 1b: Write a focused test for the Claude transcript discovery helper (review-v6 blocker 2)**

Create `test/orchestration/claude-transcript-discovery.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { findClaudeSessionFile } from "../../pi-extension/subagents/backends/headless.ts";

/**
 * Asserts the Claude transcript discovery path is NOT tied to any
 * specific project-slug formula. Instead, it must locate
 * `<sessionId>.jsonl` under *any* direct child of
 * `~/.claude/projects/` — matching the real on-disk layout (e.g.
 * `-Users-david-Code-pi-config/<uuid>.jsonl`, without a trailing
 * hyphen) rather than the `-${cwdSlug}-/` heuristic that earlier
 * drafts of this plan tried to use (review-v6 blocker 2).
 *
 * This test shims HOME to a temp dir so it is hermetic — it does not
 * touch the user's real ~/.claude tree.
 */
describe("findClaudeSessionFile", () => {
  let fakeHome: string;
  let origHome: string | undefined;

  before(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "pi-claude-arch-"));
    origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    // Sanity check: the helper uses os.homedir(), which reads HOME.
    assert.equal(homedir(), fakeHome);
  });
  after(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("finds <sessionId>.jsonl under an arbitrary project-slug directory (no trailing hyphen)", async () => {
    // Layout mirrors what `ls ~/.claude/projects/` actually shows:
    // each project is `-path-components-joined/`, with NO trailing hyphen.
    const projectsRoot = join(fakeHome, ".claude", "projects");
    const slugDir = join(projectsRoot, "-Users-david-Code-pi-config");
    mkdirSync(slugDir, { recursive: true });
    const sessionId = "0f2d5442-1141-43f4-bfa1-3daa44e65382";
    const sessionFile = join(slugDir, `${sessionId}.jsonl`);
    writeFileSync(sessionFile, "{}\n");

    const found = await findClaudeSessionFile(sessionId, 500);
    assert.equal(found, sessionFile,
      "discovery must locate the real file regardless of slug shape — NOT reconstruct a `-<cwdSlug>-/` guess");
  });

  it("returns null when the sessionId has no match anywhere under ~/.claude/projects/", async () => {
    const projectsRoot = join(fakeHome, ".claude", "projects");
    mkdirSync(join(projectsRoot, "-some-other-project"), { recursive: true });
    writeFileSync(
      join(projectsRoot, "-some-other-project", "unrelated-uuid.jsonl"),
      "{}\n",
    );
    const found = await findClaudeSessionFile("nonexistent-id", 200);
    assert.equal(found, null);
  });

  it("tolerates a missing projects root (first Claude run ever) by returning null", async () => {
    // Remove the fake projects root entirely.
    rmSync(join(fakeHome, ".claude"), { recursive: true, force: true });
    const found = await findClaudeSessionFile("any-id", 200);
    assert.equal(found, null);
  });
});
```

Run: `npm test -- --test-name-pattern='findClaudeSessionFile' 2>&1 | tail -30`
Expected: FAIL — `findClaudeSessionFile` is not exported yet. It will be after Step 2 lands the helper.

These tests exist specifically to catch the review-v6 blocker 2 regression if someone later "simplifies" the discovery pass back into a slug-reconstruction heuristic. The first test deliberately uses a real on-disk slug shape (`-Users-david-Code-pi-config`, no trailing hyphen) — a reconstructed `-${cwdSlug}-/` would miss it.

- [ ] **Step 2: Replace the `runClaudeHeadless` stub**

In `pi-extension/subagents/backends/headless.ts`, add imports at the top:

```ts
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { buildClaudeHeadlessArgs, parseClaudeStreamEvent, parseClaudeResult } from "./claude-stream.ts";
// v9 (review-v10 finding 2): shared helper so pane + headless paths emit
// the exact same stderr wording. launchSubagent()'s Claude branch also
// imports this function (Task 17 Step 3a) — if the two call sites diverge,
// the focused unit test in test/orchestration/claude-skills-warning.test.ts
// fails loud.
import { warnClaudeSkillsDropped } from "../index.ts";
```

Replace the `runClaudeHeadless` stub with:

```ts
async function runClaudeHeadless(p: RunParams): Promise<BackendResult> {
  const { spec, startTime, abort, ctx } = p;
  // v6 (review-v7 finding 2): `TranscriptMessage` (not pi-ai `Message`).
  // The Claude stream-json path cannot produce a valid `AssistantMessage`
  // because it has no api/provider/model/usage/stopReason metadata in a
  // well-formed shape. See backends/types.ts for the truthful minimal type.
  const transcript: TranscriptMessage[] = [];
  let usage: UsageStats = emptyUsage();
  let stderr = "";
  let terminalResult: ReturnType<typeof parseClaudeResult> | null = null;
  let sessionId: string | undefined;

  // v6 (review-v7 finding 3) / v9 (review-v10 finding 2):
  // Claude has no pi-style /skill: expansion. If the caller (or agent
  // frontmatter) declared skills, they would otherwise either be silently
  // dropped (confusing) or leaked as literal task text (worse). Emit a
  // one-line warning to stderr, then proceed without them. The same helper
  // is called from launchSubagent()'s Claude branch (Task 17 Step 3a), so
  // pane + headless share exact wording — the focused unit test in
  // test/orchestration/claude-skills-warning.test.ts is the guard.
  warnClaudeSkillsDropped(spec.name, spec.effectiveSkills);

  // Body of the prompt. v10 (review-v11 finding 1) — use spec.claudeTaskBody,
  // NOT spec.fullTask. The Claude path emits identity via the system-prompt
  // flag (above, via buildClaudeHeadlessArgs), so the task body must not
  // include the pi-only roleBlock preamble or identity would double-up.
  //   - direct delivery (fork): claudeTaskBody === params.task exactly
  //   - direct delivery (blank session): claudeTaskBody is modeHint + task
  //     + summaryInstruction (no roleBlock).
  //   - artifact delivery: Claude CLI doesn't accept @file, so we read the
  //     materialized task artifact and inline its contents. writeTaskArtifact
  //     writes claudeTaskBody for the Claude path (see Task 9b Step 3).
  let taskText: string;
  if (spec.taskDelivery === "direct") {
    taskText = spec.claudeTaskBody;
  } else {
    const artifactPath = writeTaskArtifact(spec, { flavor: "claude" });
    taskText = readFileSync(artifactPath, "utf8");
  }

  const args = buildClaudeHeadlessArgs(spec, taskText);

  if (abort.aborted) return makeAbortedResult(spec, startTime, transcript, usage);

  return new Promise<BackendResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn("claude", args, {
        cwd: spec.effectiveCwd ?? ctx.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...spec.configRootEnv },
      });
    } catch (err: any) {
      resolve({
        name: spec.name, finalMessage: "", transcriptPath: null, exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err?.message ?? String(err),
      });
      return;
    }

    const lb = new LineBuffer();
    let wasAborted = false;
    let exited = false;             // ← review finding 3: exit-from-events, not proc.killed
    proc.on("exit", () => { exited = true; });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "system" && event.subtype === "init"
          && typeof event.session_id === "string") {
        sessionId = event.session_id;
      }
      if (event.type === "result") {
        terminalResult = parseClaudeResult(event);
        usage = terminalResult.usage;
        if (terminalResult.finalOutput) {
          // v6: plain TranscriptMessage — no need to fake AssistantMessage metadata.
          transcript.push({
            role: "assistant",
            content: [{ type: "text", text: terminalResult.finalOutput }],
          });
        }
      } else {
        // v11 (review-v15 finding): parser now returns TranscriptMessage[]
        // (or undefined). A single "user" event can carry multiple
        // tool_result blocks (parallel tool calls); each becomes its own
        // TranscriptMessage so transcript[] preserves the 1:1 toolCallId →
        // toolResult mapping. Iterating here — rather than pushing a
        // single projected object — is what makes the Task 21 integration
        // assertion ("both toolCall and toolResult present") achievable.
        const msgs = parseClaudeStreamEvent(event);
        if (msgs) for (const m of msgs) transcript.push(m);
      }
    };

    proc.stdout!.on("data", (data: Buffer) => {
      for (const line of lb.push(data.toString())) processLine(line);
    });
    proc.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });

    const onAbort = () => {
      wasAborted = true;
      makeAbortHandler(proc, () => exited)();
    };
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      resolve({
        name: spec.name, finalMessage: "", transcriptPath: null, exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err.code === "ENOENT"
          ? "claude CLI not found on PATH"
          : err.message || String(err),
      });
    });

    proc.on("close", async (code) => {
      exited = true;
      for (const line of lb.flush()) processLine(line);
      const elapsedMs = Date.now() - startTime;
      const exitCode = code ?? 0;
      const finalMessage = terminalResult?.finalOutput ?? "";
      const transcriptPath = sessionId
        ? await archiveClaudeTranscript(sessionId)
        : null;

      if (wasAborted) {
        resolve({ name: spec.name, finalMessage, transcriptPath, exitCode: 1, elapsedMs,
                  error: "aborted", sessionId, usage, transcript });
        return;
      }
      if (exitCode !== 0 || terminalResult?.error) {
        resolve({ name: spec.name, finalMessage, transcriptPath,
                  exitCode: exitCode !== 0 ? exitCode : 1, elapsedMs,
                  error: terminalResult?.error
                    ?? (stderr.trim() || `claude exited with code ${exitCode}`),
                  sessionId, usage, transcript });
        return;
      }
      if (!terminalResult) {
        resolve({ name: spec.name, finalMessage, transcriptPath, exitCode: 1, elapsedMs,
                  error: "child exited without completion event",
                  sessionId, usage, transcript });
        return;
      }
      resolve({ name: spec.name, finalMessage, transcriptPath, exitCode: 0, elapsedMs,
                sessionId, usage, transcript });
    });
  });
}

/**
 * Archive the Claude transcript for this run to a stable location.
 *
 * Claude CLI persists its session transcript to
 *   ~/.claude/projects/<project-slug>/<session_id>.jsonl
 * where `<project-slug>` is derived from cwd by the CLI. The slug format
 * is an undocumented CLI internal and has historically varied — on this
 * host, directories are shaped like `-Users-david-Code-pi-config/` (no
 * trailing hyphen); earlier drafts of this plan guessed
 * `-${cwdSlug}-/` (with trailing hyphen), which matches no real
 * directory on this host (review-v6 blocker 2).
 *
 * Rather than re-implementing Claude's slug derivation (which we would
 * need to keep in sync with every Claude CLI release), v5 discovers the
 * source file by session id: glob `~/.claude/projects/`*`/`${sessionId}.jsonl`
 * and pick the first match. `session_id` is globally unique per Claude
 * run and is already captured from the `system/init` stream event, so
 * this is a precise, slug-independent lookup. If Claude ever relocates
 * its project tree, the focused test below (Task 19 Step 1b) fails loud
 * and points at exactly this helper.
 *
 * Poll for up to 2s to tolerate the CLI's file-write timing on process
 * close. Returns null on persistent absence.
 */
async function archiveClaudeTranscript(sessionId: string): Promise<string | null> {
  const sourceFile = await findClaudeSessionFile(sessionId, 2000);
  if (!sourceFile) {
    process.stderr.write(
      `[pi-interactive-subagent] Claude session file ${sessionId}.jsonl not found ` +
        `under ~/.claude/projects/*/ after 2s; transcriptPath will be null.\n`,
    );
    return null;
  }
  const destDir = join(homedir(), ".pi", "agent", "sessions", "claude-code");
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, `${sessionId}.jsonl`);
  copyFileSync(sourceFile, dest);
  return dest;
}

/**
 * Discover `~/.claude/projects/`*`/`${sessionId}.jsonl — the source of
 * truth for Claude headless transcript archival. Exported for test use.
 *
 * Why session-id discovery rather than slug reconstruction:
 *   - `session_id` is globally unique across all Claude runs, so at most
 *     one match exists (and in practice exactly one, once the CLI has
 *     flushed its jsonl).
 *   - The project-slug derivation is a CLI internal; locking ourselves
 *     to any specific formula creates a silent-break surface when
 *     Claude updates that derivation.
 *   - Discovery tolerates per-repo slug quirks (symlinks, worktrees
 *     that produce unexpected slugs, NFS mounts, etc.) without code
 *     changes.
 *
 * Polls for up to `timeoutMs` because the CLI flushes on close,
 * which may race with our `proc.on("close", ...)` handler.
 */
export async function findClaudeSessionFile(
  sessionId: string,
  timeoutMs: number,
): Promise<string | null> {
  const projectsRoot = join(homedir(), ".claude", "projects");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(projectsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      // projects root missing (e.g. first Claude run ever) — retry.
    }
    for (const slug of dirs) {
      const candidate = join(projectsRoot, slug, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
```

The `archiveClaudeTranscript` signature changes from `(sessionId, cwd)` to just `(sessionId)` — the cwd is no longer needed for discovery, which is the whole point. Update the caller accordingly:

```ts
    const transcriptPath = sessionId
      ? await archiveClaudeTranscript(sessionId)
      : null;
```

And add `readdirSync` to the `node:fs` import list at the top of `headless.ts` (alongside the existing `copyFileSync, mkdirSync, readFileSync`).

- [ ] **Step 2b: Lock coverage of the shared `PI_TO_CLAUDE_TOOLS` map against the pane path's built-in tool set**

Create `test/orchestration/pi-to-claude-tools.test.ts`. This test lands in Task 19 rather than Task 17 because it dynamically imports `backends/claude-stream.ts` and asserts it does not re-export the map — a valid assertion only once Task 19 Step 1 has added the `import { PI_TO_CLAUDE_TOOLS } from "./tool-map.ts"` line. Landing it earlier would make Task 17's commit transiently red.

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PI_TO_CLAUDE_TOOLS } from "../../pi-extension/subagents/backends/tool-map.ts";

/**
 * The pi → Claude tool mapping is declared in exactly one file
 * (`backends/tool-map.ts`) and imported by both the pane
 * (`buildClaudeCmdParts` in `index.ts`, Task 17) and headless
 * (`buildClaudeHeadlessArgs` in `backends/claude-stream.ts`, Task 19)
 * builders — so a drop or typo in one place cannot desync from the
 * other.
 *
 * But a second hazard still exists: if the pi path's BUILTIN_TOOLS set
 * grows a new tool (e.g. someone adds "glob" or "task" to pi's
 * built-ins) and the author forgets to add a Claude mapping here, the
 * Claude backend will silently drop that tool when tool restriction is
 * requested. This test fails loud in that case.
 *
 * BUILTIN_TOOLS is the list that `launchSubagent()`'s pi branch
 * recognizes for `--tools` emission today. Keep this list in sync with
 * the one in `pi-extension/subagents/index.ts`; if it moves, import
 * from there instead.
 */
const PI_BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

describe("PI_TO_CLAUDE_TOOLS", () => {
  it("covers every pi built-in tool the pane path already recognizes", () => {
    const missing: string[] = [];
    for (const tool of PI_BUILTIN_TOOLS) {
      if (!(tool in PI_TO_CLAUDE_TOOLS)) missing.push(tool);
    }
    assert.equal(missing.length, 0,
      `Missing Claude mappings for pi built-in tools: ${missing.join(", ")}. ` +
      `Add them to pi-extension/subagents/backends/tool-map.ts so headless/pane Claude ` +
      `do not silently drop them under tool restriction.`);
  });

  it("is exported from the single shared module both builders import from", async () => {
    // The pane builder imports it here:
    const index = await import("../../pi-extension/subagents/index.ts");
    // The headless builder imports it here:
    const claudeStream = await import("../../pi-extension/subagents/backends/claude-stream.ts");
    // Neither module should re-export a local clone — the only canonical
    // identity is tool-map.ts. We assert indirectly by checking neither
    // file's public surface exports a `PI_TO_CLAUDE_TOOLS` symbol (the
    // symbol lives in the map module and is consumed, not re-exported).
    assert.equal((index as any).PI_TO_CLAUDE_TOOLS, undefined,
      "index.ts must not re-export a local copy; import from backends/tool-map.ts");
    assert.equal((claudeStream as any).PI_TO_CLAUDE_TOOLS, undefined,
      "claude-stream.ts must not re-export a local copy; import from backends/tool-map.ts");
  });

  it("is a frozen/read-only object so a caller cannot mutate the shared map at runtime", () => {
    // Object.freeze in tool-map.ts; verified so a mutation attempt throws
    // in strict mode (Node test runs strict). This guards against cross-test
    // contamination or a clever caller calling `delete PI_TO_CLAUDE_TOOLS.bash`.
    assert.throws(() => {
      (PI_TO_CLAUDE_TOOLS as any).extra = "Nope";
    }, "map must be frozen so no caller can mutate it");
  });
});
```

Run: `npm test -- --test-name-pattern='PI_TO_CLAUDE_TOOLS' 2>&1 | tail -30`
Expected: all three cases PASS — Task 17 Step 3 has already imported from `tool-map.ts`, and Task 19 Step 1 has done the same in `claude-stream.ts`. If this test fails with "Missing Claude mappings" after a future change, the fix is to add the pi tool name → Claude CLI built-in name entry in `tool-map.ts`, not to delete entries from `PI_BUILTIN_TOOLS` here.

- [ ] **Step 3: Run all unit tests**

Run: `npm test 2>&1 | tail -40`
Expected: every unit test passes, including `buildClaudeHeadlessArgs` (8 cases — v10 added two "no identity duplication" cases in review-v11 finding 1), the `parseClaudeStreamEvent` / `parseClaudeResult` cases (9 total — v11 added four `tool_result` projection cases per review-v15 finding, bringing `parseClaudeStreamEvent` to 7 and `parseClaudeResult` to 2), and the three `PI_TO_CLAUDE_TOOLS` cases from Step 2b.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck 2>&1 | tail -40`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add pi-extension/subagents/backends/headless.ts pi-extension/subagents/backends/claude-stream.ts test/orchestration/claude-event-transform.test.ts test/orchestration/claude-transcript-discovery.test.ts test/orchestration/pi-to-claude-tools.test.ts
git commit -m "feat(backends): headless Claude consumes ResolvedLaunchSpec; thread --resume; exit-tracked SIGKILL; session-id transcript discovery; lock shared tool-map coverage; iterate tool_result messages into transcript[] (review-v15 finding)"
```

### Task 20: Integration test — headless Claude smoke

**Files:**
- Create: `test/integration/headless-claude-smoke.test.ts`

- [ ] **Step 1: Write the test**

Create `test/integration/headless-claude-smoke.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

const CLAUDE_AVAILABLE = (() => {
  try {
    execSync("which claude", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe("headless-claude-smoke", { skip: !CLAUDE_AVAILABLE, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-claude-"));
  });
  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a trivial Claude task with non-zero cost, sessionId, archived transcript", async () => {
    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    const handle = await backend.launch(
      // No agent — just direct fields. Avoids host-dependent agent fixtures
      // (review finding 2 — `scout` lives in ~/.pi/agent/agents/ if at all).
      { task: "Reply with exactly: OK", cli: "claude" },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);
    assert.ok(result.finalMessage.trim().length > 0, "finalMessage must be non-empty");
    assert.ok(result.usage, "usage must be set");
    assert.ok(result.usage!.cost >= 0, "usage.cost must be set (may be 0 for cached)");
    assert.ok(result.usage!.turns >= 1, `usage.turns must be >=1, got ${result.usage!.turns}`);
    assert.ok(result.sessionId, "sessionId must be populated from system/init event");
    assert.ok(result.transcript && result.transcript.length > 0, "transcript array must be non-empty");
    // v6 (review-v7 finding 2) regression guard: the field is `transcript`,
    // not `messages`. v5 named it `messages: Message[]` but populated it
    // with partial/synthetic objects. A regression that re-introduces the
    // wrong name would make this assertion undefined-safe-short-circuit
    // rather than fail, so also check explicitly:
    assert.equal((result as any).messages, undefined,
      "BackendResult must not expose `messages` (v5 shape); v6 exposes `transcript` (review-v7 finding 2)");
    assert.ok(result.transcriptPath, "transcriptPath must be set");
    const archiveRoot = join(homedir(), ".pi", "agent", "sessions", "claude-code");
    assert.ok(
      result.transcriptPath!.startsWith(archiveRoot),
      `transcriptPath must be under ${archiveRoot}, got ${result.transcriptPath}`,
    );
    assert.ok(existsSync(result.transcriptPath!), "archived transcript must exist");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- --test-name-pattern='headless-claude-smoke' 2>&1 | tail -40`
Expected: PASS, or skipped if `claude` not on PATH.

- [ ] **Step 3: Commit**

```bash
git add test/integration/headless-claude-smoke.test.ts
git commit -m "test(integration): add headless Claude smoke test"
```

### Task 21: Integration test — headless tool use (mid-stream)

**Files:**
- Create: `test/integration/headless-tool-use.test.ts`

- [ ] **Step 1: Write the test**

Create `test/integration/headless-tool-use.test.ts`:

```ts
/**
 * Mid-stream tool-use: prompt the CLI to call a tool, then validate that
 * the parsed transcript array contains a toolCall entry. Exercises the
 * stream-parse loop against a real CLI (catches format drift that units
 * cannot).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

const CLAUDE_AVAILABLE = (() => {
  try {
    execSync("which claude", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe("headless-tool-use [claude]", { skip: !CLAUDE_AVAILABLE, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-tool-"));
    writeFileSync(join(dir, "marker.txt"), "HEADLESS_TOOL_MARKER_42\n");
  });
  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures the full toolCall + toolResult round-trip in transcript[]", async () => {
    // v11 (review-v15 finding): v10 only asserted `toolCalls.length > 0`.
    // That left a real gap — a regression where Claude tool_result blocks
    // disappeared from transcript[] (either because the parser never
    // projected them, or because the caller stopped iterating them) would
    // still satisfy the old assertion. This test now pins BOTH halves of
    // the round-trip, including the 1:1 toolCallId ↔ toolCallId linkage,
    // so the contract review-v15 flagged is observable end-to-end against
    // a real Claude CLI (not just in the unit test of the parser).
    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    const handle = await backend.launch(
      // No agent — explicit fields keep the test deterministic across hosts.
      {
        task: "Read the file marker.txt in the current directory and print its contents verbatim.",
        cli: "claude",
        tools: "read",
      },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);

    const transcript = result.transcript ?? [];

    // Half 1: a toolCall entry exists, exposed through an assistant-role
    // message's content blocks.
    const toolCallBlocks = transcript
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c): c is { type: "toolCall"; id: string; name: string; arguments: unknown } =>
        c.type === "toolCall");
    assert.ok(toolCallBlocks.length > 0,
      "transcript[] must include at least one assistant-role message with a toolCall content block");

    // Half 2: a toolResult entry exists as a top-level TranscriptMessage
    // with role: "toolResult". This is the piece v10's assertion did not
    // exercise — the parser had to (a) handle Claude "user" events
    // carrying tool_result content blocks, and (b) re-role them to
    // "toolResult" at the boundary.
    const toolResultMessages = transcript.filter((m) => m.role === "toolResult");
    assert.ok(toolResultMessages.length > 0,
      "transcript[] must include at least one toolResult-role message " +
        "(v11 / review-v15: regression surface for Claude tool_result parsing)");

    // 1:1 linkage: every toolCall id should have a matching toolResult
    // whose `toolCallId` equals it. A mismatch indicates either a parser
    // regression (toolCallId lost) or a stream-shape drift Claude
    // introduced that the projection no longer covers.
    const callIds = new Set(toolCallBlocks.map((c) => c.id));
    const resultIds = new Set(toolResultMessages.map((m) => m.toolCallId));
    for (const id of callIds) {
      assert.ok(resultIds.has(id),
        `toolCall id ${id} has no matching toolResult.toolCallId; ` +
          `callIds=${JSON.stringify([...callIds])}, resultIds=${JSON.stringify([...resultIds])}`);
    }

    // Content shape: the projected toolResult message must honor the
    // TranscriptMessage contract (content is a TranscriptContent[] array,
    // each block has a .type). Guards against a regression where the
    // normalization of Claude's string-or-array content is skipped.
    for (const tr of toolResultMessages) {
      assert.ok(Array.isArray(tr.content),
        `toolResult.content must be an array, got ${typeof tr.content}`);
      for (const block of tr.content) {
        assert.ok(typeof block.type === "string" && block.type.length > 0,
          `toolResult.content[].type must be a non-empty string, got ${JSON.stringify(block)}`);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- --test-name-pattern='headless-tool-use' 2>&1 | tail -30`
Expected: PASS or skipped.

- [ ] **Step 3: Commit**

```bash
git add test/integration/headless-tool-use.test.ts
git commit -m "test(integration): verify full toolCall+toolResult round-trip against real Claude CLI (review-v15 finding)"
```

### Task 22: Extend `headless-transcript-archival` with the Claude half

**Files:**
- Modify: `test/integration/headless-transcript-archival.test.ts`

- [ ] **Step 1: Append a Claude describe block**

Append to `test/integration/headless-transcript-archival.test.ts` (after the existing `describe(... [pi] ...)` block):

```ts
import { homedir } from "node:os"; // already imported above — de-dup

const CLAUDE_AVAILABLE = (() => {
  try {
    execSync("which claude", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe("headless-transcript-archival [claude]", { skip: !CLAUDE_AVAILABLE, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-claude-arch-"));
  });
  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("archives the Claude transcript under ~/.pi/agent/sessions/claude-code/ with session_id in path", async () => {
    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    const handle = await backend.launch(
      { task: "Reply: OK", cli: "claude" },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0);
    assert.ok(result.sessionId);
    assert.ok(result.transcriptPath);
    assert.ok(existsSync(result.transcriptPath!));
    const archiveRoot = join(homedir(), ".pi", "agent", "sessions", "claude-code");
    assert.ok(result.transcriptPath!.startsWith(archiveRoot));
    assert.ok(result.transcriptPath!.endsWith(`${result.sessionId}.jsonl`));
  });
});
```

Note: the `import { homedir } from "node:os"` is already present at the top of the file from the pi-half test — keep a single import. If your linter complains about the duplicate, remove the new one.

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- --test-name-pattern='headless-transcript-archival' 2>&1 | tail -30`
Expected: both pi + claude halves PASS or skip.

- [ ] **Step 3: Commit**

```bash
git add test/integration/headless-transcript-archival.test.ts
git commit -m "test(integration): verify headless Claude transcript archival under sessions/claude-code/"
```

### Task 22b: Integration test — `resumeSessionId` round-trip on headless Claude (review finding 4)

**Files:**
- Create: `test/integration/headless-claude-resume.test.ts`

This is the gate for review finding 4. Run a trivial first turn, capture the `sessionId`, then run a second headless invocation that passes that id as `resumeSessionId`. Assert the new run reports the same `sessionId` and that its transcript reflects continuity (e.g. references the first turn's marker).

- [ ] **Step 1: Write the test**

Create `test/integration/headless-claude-resume.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

const CLAUDE_AVAILABLE = (() => {
  try { execSync("which claude", { stdio: "pipe" }); return true; }
  catch { return false; }
})();

describe("headless-claude-resume", { skip: !CLAUDE_AVAILABLE, timeout: 180_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-claude-resume-"));
  });
  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("resumes the same Claude session id on a second launch when resumeSessionId is set", async () => {
    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    const marker = `MARK_${Math.random().toString(36).slice(2, 10)}`;
    const first = await backend.watch(
      await backend.launch(
        { task: `Acknowledge marker ${marker}. Reply with: OK`, cli: "claude" },
        false,
      ),
    );
    assert.equal(first.exitCode, 0, `first launch error=${first.error}`);
    assert.ok(first.sessionId, "first launch must report a sessionId");

    // Second launch with resumeSessionId — same id should appear.
    const second = await backend.watch(
      await backend.launch(
        {
          task: `Repeat the marker you received in the previous turn.`,
          cli: "claude",
          resumeSessionId: first.sessionId,
        },
        false,
      ),
    );
    assert.equal(second.exitCode, 0, `second launch error=${second.error}`);
    assert.equal(second.sessionId, first.sessionId,
      "resumed launch must report the same sessionId");
    // Transcript continuity check: the second transcript should reference the marker.
    assert.ok(second.transcriptPath && existsSync(second.transcriptPath));
    const body = readFileSync(second.transcriptPath!, "utf8");
    assert.ok(body.includes(marker), "resumed transcript must reflect the prior turn's content");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- --test-name-pattern='headless-claude-resume' 2>&1 | tail -30`
Expected: PASS, or skipped if `claude` is not on PATH.

- [ ] **Step 3: Commit**

```bash
git add test/integration/headless-claude-resume.test.ts
git commit -m "test(integration): verify resumeSessionId round-trip on headless Claude"
```

### Task 23: Integration test — abort

**Files:**
- Create: `test/integration/headless-abort-integration.test.ts`

- [ ] **Step 1: Write the test**

Create `test/integration/headless-abort-integration.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

const PI_AVAILABLE = (() => {
  try {
    execSync("which pi", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe("headless-abort-integration [pi]", { skip: !PI_AVAILABLE, timeout: 30_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-abort-"));
  });
  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("aborted long-running task surfaces error: 'aborted' within ~6s", async () => {
    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    const controller = new AbortController();
    const handle = await backend.launch(
      // No agent — `test-echo` declares auto-exit:true and would short-circuit
      // the test; `scout` is host-dependent. Direct fields keep the abort path
      // exercised against a real long-running pi process.
      {
        task: "Count to 1000 aloud, one number per line, very slowly. Do not stop early.",
        model: "anthropic/claude-haiku-4-5",
      },
      false,
      controller.signal,
    );
    // Let the CLI get going, then abort.
    await new Promise((r) => setTimeout(r, 3000));
    const start = Date.now();
    controller.abort();

    const result = await backend.watch(handle);
    const elapsed = Date.now() - start;
    assert.equal(result.error, "aborted");
    assert.equal(result.exitCode, 1);
    assert.ok(elapsed < 6500, `abort must complete within ~6s, took ${elapsed}ms`);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- --test-name-pattern='headless-abort-integration' 2>&1 | tail -30`
Expected: PASS or skipped.

- [ ] **Step 3: Commit**

```bash
git add test/integration/headless-abort-integration.test.ts
git commit -m "test(integration): verify headless abort completes within SIGTERM→5s→SIGKILL budget"
```

### Task 23b: Integration test — all three subagent tools reach headless in a no-mux environment

**Files:**
- Create: `test/integration/orchestration-headless-no-mux.test.ts`

This is the headline gate for the no-mux goal. Unit tests instantiate `makeHeadlessBackend()` directly, but they do **not** prove that the real `subagent` / `subagent_serial` / `subagent_parallel` tool callbacks reach the headless backend after passing through `preflightOrchestration()` (and, for the bare `subagent` tool, through its new `selectBackend()` branch). This test exercises the full registered-tool path: it loads the extension via `subagentsExtension(pi)` against a captured-tools mock `pi`, then invokes each registered tool's execute callback in two environments: (a) forced `PI_SUBAGENT_MODE=headless` with all mux env vars cleared, and (b) `PI_SUBAGENT_MODE` unset entirely (so the default `"auto"` path is exercised) with the same mux env vars cleared. The two configurations exercise adjacent-but-distinct paths through `selectBackend()` — forced mode returns `"headless"` directly, while auto mode runs the real mux-detection logic in `pi-extension/subagents/cmux.ts:30-83` before falling back to headless. A regression that only broke the auto path (e.g., a `selectBackend()` mux-detection bug, or a preflight that incorrectly required mux when mode was unset) would still fail Case B.

- [ ] **Step 1: Write the test**

Create `test/integration/orchestration-headless-no-mux.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTestAgents } from "./harness.ts";
import subagentsExtension from "../../pi-extension/subagents/index.ts";

const PI_AVAILABLE = (() => {
  try { execSync("which pi", { stdio: "pipe" }); return true; }
  catch { return false; }
})();

/**
 * Fake ExtensionAPI — captures registered tools so the test can invoke
 * the real `subagent_serial` / `subagent_parallel` execute callbacks,
 * and provides no-op implementations for every other method that
 * `subagentsExtension(...)` touches during initialization.
 *
 * Review-v3 blocking finding 2: the v2 draft only implemented
 * registerTool/on/emit, but subagentsExtension also calls
 * `pi.registerCommand(...)` (iterate / subagent / plan) and
 * `pi.registerMessageRenderer(...)` (subagent_result / subagent_ping)
 * during init — see `pi-extension/subagents/index.ts` around lines
 * 1612-1622, 1624-1652, 1654-1717, 1719-1753, 1755-1778. Without those
 * stubs the extension throws before the orchestration tools are ever
 * registered, which would make this headline no-mux gate useless.
 *
 * Review-v5 non-blocking note 2: `pi.sendUserMessage(...)` is called
 * from the registered `/iterate`, `/subagent`, and `/plan` command
 * handlers (`pi-extension/subagents/index.ts:1619, 1649, 1779`). The
 * Task 23b assertions do not exercise those command handlers, so the
 * stub is not strictly required for this test to pass — but it would
 * be required by any follow-up test that invokes a registered command,
 * and adding a no-op now keeps `makeFakePi()` drop-in ready for that
 * work without touching this fake again.
 */
function makeFakePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const renderers = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  const userMessages: string[] = [];
  const sentMessages: Array<{ message: any; opts?: any }> = [];
  return {
    tools,
    commands,
    renderers,
    userMessages,
    sentMessages,
    api: {
      registerTool(spec: any) { tools.set(spec.name, spec); },
      registerCommand(name: string, spec: any) { commands.set(name, spec); },
      registerMessageRenderer(type: string, fn: any) { renderers.set(type, fn); },
      // No-op stub: captures the message so follow-up command-path tests can
      // assert on it, but does not route the message anywhere since there is
      // no agent loop running in this harness.
      sendUserMessage(message: string) { userMessages.push(message); },
      // Captures steer messages the bare `subagent` tool emits when its
      // background watch resolves. Required so the bare-subagent cases can
      // poll for completion (the execute returns a "launched" ack
      // immediately; the sub-agent's actual result arrives later via
      // sendMessage).
      sendMessage(message: any, opts?: any) { sentMessages.push({ message, opts }); },
      on(event: string, fn: (ev: any, ctx: any) => void) {
        const arr = handlers.get(event) ?? [];
        arr.push(fn); handlers.set(event, arr);
      },
      emit(event: string, payload: any, ctx: any) {
        for (const fn of handlers.get(event) ?? []) fn(payload, ctx);
      },
    },
  };
}

/**
 * Shared env keys both describe blocks save-and-clear before running.
 *
 * PI_SUBAGENT_MODE is the selector switch. The mux-related keys
 * (CMUX_SOCKET_PATH, TMUX, ZELLIJ, ZELLIJ_SESSION_NAME, WEZTERM_UNIX_SOCKET)
 * must be unset so `selectBackend()`'s auto fallback does not see a mux that
 * only exists because the host running the test happens to be inside one.
 * ZELLIJ_SESSION_NAME is included because `cmux.ts` treats it as zellij
 * runtime state (review-v5 note 1).
 */
const MUX_ENV_KEYS = [
  "PI_SUBAGENT_MODE",
  "CMUX_SOCKET_PATH",
  "TMUX",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "WEZTERM_UNIX_SOCKET",
];

/**
 * Invoke a freshly-constructed registered tool callback against a fresh
 * `makeFakePi()` so each case sees a clean extension init. Returns the
 * fake and the tool-execution result so bare-subagent cases can also
 * inspect the captured steer messages delivered via `pi.sendMessage`
 * (the orchestration tools resolve their results synchronously, but the
 * bare `subagent` tool returns a "launched" ack and delivers the real
 * result later via a steer message).
 */
async function runRegisteredTool(
  toolName: "subagent" | "subagent_serial" | "subagent_parallel",
  params: unknown,
  dir: string,
) {
  const fake = makeFakePi();
  subagentsExtension(fake.api as any);

  const tool = fake.tools.get(toolName);
  assert.ok(tool, `${toolName} must be registered`);

  const ctx = {
    sessionManager: {
      getSessionFile: () => join(dir, "parent.jsonl"),
      getSessionId: () => "parent",
      getSessionDir: () => dir,
    },
    cwd: dir,
  };
  // Required by the widget wiring; safe to emit even though we don't render.
  fake.api.emit("session_start", {}, ctx);

  const origCwd = process.cwd();
  process.chdir(dir);
  try {
    const result = await tool.execute(
      "test-call-id",
      params,
      new AbortController().signal,
      () => {},
      ctx,
    );
    return { fake, result };
  } finally {
    process.chdir(origCwd);
  }
}

/**
 * Poll `fake.sentMessages` for a steer message matching the expected
 * customType. Used by the bare-subagent cases which dispatch
 * fire-and-forget and deliver the actual result later via sendMessage.
 */
async function waitForSteer(
  fake: ReturnType<typeof makeFakePi>,
  customType: "subagent_result" | "subagent_ping",
  timeoutMs: number,
): Promise<{ message: any; opts?: any }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = fake.sentMessages.find((m) => m.message?.customType === customType);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for steer message of type ${customType}; ` +
    `got: ${JSON.stringify(fake.sentMessages.map((m) => m.message?.customType))}`,
  );
}

// -----------------------------------------------------------------------
// Case A: forced PI_SUBAGENT_MODE=headless (original review-v2 finding 1
// gate). selectBackend() returns "headless" without consulting mux env at
// all, so this verifies that the forced-headless switch still reaches the
// real headless backend through preflightOrchestration.
// -----------------------------------------------------------------------
describe("orchestration-headless-no-mux (forced headless)", { skip: !PI_AVAILABLE, timeout: 180_000 }, () => {
  let saved: Record<string, string | undefined>;
  let dir: string;

  before(() => {
    saved = {};
    for (const k of MUX_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-orch-headless-"));
    copyTestAgents(dir);
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("subagent executes through the real registered tool callback under forced headless", async () => {
    const { fake, result } = await runRegisteredTool(
      "subagent",
      { name: "echo-bare", agent: "test-echo", task: "Reply with exactly: OK" },
      dir,
    );

    // The execute returns a "launched" ack immediately — it must NOT be a
    // mux-blocked error.
    assert.notMatch(JSON.stringify(result), /mux not available/i,
      "no-mux regression: bare subagent preflight blocked headless dispatch");
    assert.match(JSON.stringify(result.content), /launched/i,
      "bare subagent must return a 'launched in background' ack, not a backend error");

    // Wait for the background steer message with the real result.
    const steer = await waitForSteer(fake, "subagent_result", 120_000);
    assert.equal(steer.message.details.exitCode, 0,
      `bare subagent headless run errored: ${JSON.stringify(steer.message.details)}`);
    assert.ok(typeof steer.message.content === "string" && steer.message.content.length > 0);
  });

  it("subagent_serial executes through the real registered tool callback under forced headless", async () => {
    const { result } = await runRegisteredTool(
      "subagent_serial",
      { tasks: [{ agent: "test-echo", task: "Reply with exactly: OK" }] },
      dir,
    );

    // Most important: did NOT short-circuit on the mux preflight.
    assert.notMatch(JSON.stringify(result), /mux not available/i,
      "no-mux regression: orchestration preflight blocked headless dispatch");
    // Real headless run completed.
    assert.equal(result.details.isError, false, `serial errored: ${JSON.stringify(result.details)}`);
    assert.equal(result.details.results.length, 1);
    assert.equal(result.details.results[0].exitCode, 0);
    assert.ok(result.details.results[0].finalMessage.trim().length > 0);
  });

  it("subagent_parallel executes through the real registered tool callback under forced headless", async () => {
    const { result } = await runRegisteredTool(
      "subagent_parallel",
      {
        tasks: [
          { agent: "test-echo", task: "Reply with exactly: A" },
          { agent: "test-echo", task: "Reply with exactly: B" },
        ],
        maxConcurrency: 2,
      },
      dir,
    );

    assert.notMatch(JSON.stringify(result), /mux not available/i);
    assert.equal(result.details.isError, false, `parallel errored: ${JSON.stringify(result.details)}`);
    assert.equal(result.details.results.length, 2);
    for (const r of result.details.results) {
      assert.equal(r.exitCode, 0);
    }
  });
});

// -----------------------------------------------------------------------
// Case B (v8, review-v9 finding 2): default "auto" + no mux env.
// PI_SUBAGENT_MODE is unset entirely, so selectBackend() resolves to
// "auto" and runs the real mux-detection logic. With all mux env vars
// cleared, detection must report "no mux", and the auto fallback must
// land on headless. This path — not the forced-headless switch — is the
// one advertised by the plan's goal and architecture sections as the
// user-default behavior, and is distinct from Case A in selectBackend().
// A regression that only broke auto mode (e.g., a mux-detection bug or
// a preflight that incorrectly required mux when mode was unset) would
// have passed Case A but fails Case B.
// -----------------------------------------------------------------------
describe("orchestration-headless-no-mux (auto + no mux env)", { skip: !PI_AVAILABLE, timeout: 180_000 }, () => {
  let saved: Record<string, string | undefined>;
  let dir: string;

  before(() => {
    saved = {};
    for (const k of MUX_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // DO NOT set PI_SUBAGENT_MODE — the whole point of this describe
    // block is exercising the default auto path. Explicitly
    // asserting it is unset below so a future `before` edit cannot
    // silently turn this back into a forced-mode test.
    assert.equal(process.env.PI_SUBAGENT_MODE, undefined,
      "Case B must exercise the default auto path; PI_SUBAGENT_MODE must be unset (review-v9 finding 2).");
    dir = mkdtempSync(join(tmpdir(), "pi-orch-auto-"));
    copyTestAgents(dir);
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("subagent reaches headless via selectBackend's auto fallback when no mux is present", async () => {
    const { fake, result } = await runRegisteredTool(
      "subagent",
      { name: "echo-bare-auto", agent: "test-echo", task: "Reply with exactly: OK" },
      dir,
    );

    assert.notMatch(JSON.stringify(result), /mux not available/i,
      "auto-mode regression: bare subagent preflight blocked the auto + no-mux path");
    assert.match(JSON.stringify(result.content), /launched/i,
      "bare subagent must return a 'launched in background' ack in auto mode too");

    const steer = await waitForSteer(fake, "subagent_result", 120_000);
    assert.equal(steer.message.details.exitCode, 0,
      `bare subagent auto+no-mux errored: ${JSON.stringify(steer.message.details)}`);
    assert.ok(typeof steer.message.content === "string" && steer.message.content.length > 0);
  });

  it("subagent_serial reaches headless via selectBackend's auto fallback when no mux is present", async () => {
    const { result } = await runRegisteredTool(
      "subagent_serial",
      { tasks: [{ agent: "test-echo", task: "Reply with exactly: OK" }] },
      dir,
    );

    assert.notMatch(JSON.stringify(result), /mux not available/i,
      "auto-mode regression: orchestration preflight blocked the auto + no-mux path");
    assert.equal(result.details.isError, false, `serial errored: ${JSON.stringify(result.details)}`);
    assert.equal(result.details.results.length, 1);
    assert.equal(result.details.results[0].exitCode, 0);
    assert.ok(result.details.results[0].finalMessage.trim().length > 0);
  });

  it("subagent_parallel reaches headless via selectBackend's auto fallback when no mux is present", async () => {
    const { result } = await runRegisteredTool(
      "subagent_parallel",
      {
        tasks: [
          { agent: "test-echo", task: "Reply with exactly: A" },
          { agent: "test-echo", task: "Reply with exactly: B" },
        ],
        maxConcurrency: 2,
      },
      dir,
    );

    assert.notMatch(JSON.stringify(result), /mux not available/i,
      "auto-mode regression: orchestration preflight blocked the auto + no-mux path");
    assert.equal(result.details.isError, false, `parallel errored: ${JSON.stringify(result.details)}`);
    assert.equal(result.details.results.length, 2);
    for (const r of result.details.results) {
      assert.equal(r.exitCode, 0);
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- --test-name-pattern='orchestration-headless-no-mux' 2>&1 | tail -80`
Expected: all six tests PASS (subagent + subagent_serial + subagent_parallel in forced-headless; same three in auto + no-mux), or all six skip when `pi` is missing. A no-mux regression on any of the three tool surfaces manifests as its case failing with either a "preflight blocked headless dispatch" message or a "bare subagent preflight blocked" message. The auto-mode cases (Case B) are the path the feature sells as the user default, so Case B must not be skipped or weakened when Case A passes.

- [ ] **Step 3: Commit**

```bash
git add test/integration/orchestration-headless-no-mux.test.ts
git commit -m "test(integration): exercise subagent/subagent_serial/subagent_parallel via real registered tool callbacks under both forced-headless and auto+no-mux"
```

### Task 23c: Integration test — Claude + skills emits warning, does not leak /skill: tokens (v6, review-v7 finding 3)

**Files:**
- Create: `test/integration/headless-claude-skills-warning.test.ts`

This is the headline gate for the Claude + skills out-of-scope decision. The assertion has two parts: (a) the documented `stderr` warning fires, (b) no `/skill:...` literal leaks into the transcript or final message. The test runs against a real Claude CLI so the transcript-content assertion is not just introspecting argv but actually observing Claude's response.

- [ ] **Step 1: Write the failing test**

Create `test/integration/headless-claude-skills-warning.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHeadlessBackend } from "../../pi-extension/subagents/backends/headless.ts";

const CLAUDE_AVAILABLE = (() => {
  try { execSync("which claude", { stdio: "pipe" }); return true; }
  catch { return false; }
})();

describe("headless-claude-skills-warning", { skip: !CLAUDE_AVAILABLE, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let dir: string;
  let originalStderrWrite: typeof process.stderr.write;
  let stderrCapture: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-claude-skills-"));
  });
  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits the documented stderr warning and does not leak /skill: tokens into the task or response", async () => {
    // Swap process.stderr.write so we can capture whatever the backend emits.
    stderrCapture = "";
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
      stderrCapture += typeof chunk === "string" ? chunk : chunk.toString();
      return originalStderrWrite(chunk, ...rest);
    };
    try {
      const backend = makeHeadlessBackend({
        sessionManager: {
          getSessionFile: () => join(dir, "parent.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => dir,
        } as any,
        cwd: dir,
      });
      const handle = await backend.launch(
        {
          task: "Reply with exactly the single word: OK",
          cli: "claude",
          skills: "plan, code-review",
        },
        false,
      );
      const result = await backend.watch(handle);

      assert.equal(result.exitCode, 0, `Claude should still complete cleanly; error=${result.error}`);

      // (a) stderr contains the warning.
      assert.match(stderrCapture, /ignoring skills=.*on Claude path/i,
        `expected skills-drop warning in stderr; got:\n${stderrCapture}`);

      // (b) finalMessage does not contain a literal /skill: token.
      // (If it did, that would mean the task body was polluted with
      // /skill:plan / /skill:code-review lines and Claude echoed them back.)
      assert.ok(!result.finalMessage.includes("/skill:"),
        `Claude response contains /skill: literal — indicates skill tokens leaked into task body.\nfinalMessage: ${result.finalMessage}`);

      // (c) transcript does not contain a literal /skill: token in any text block.
      const textBlocks = (result.transcript ?? [])
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text);
      for (const t of textBlocks) {
        assert.ok(!t.includes("/skill:"),
          `transcript text block contains /skill: literal: ${t}`);
      }
    } finally {
      (process.stderr as any).write = originalStderrWrite;
    }
  });
});
```

Run: `npm run test:integration -- --test-name-pattern='headless-claude-skills-warning' 2>&1 | tail -40`
Expected: PASS when Claude is on PATH; skipped otherwise. A regression of review-v7 finding 3 manifests as assertion (a) failing (warning silenced) or (b)/(c) failing (skill tokens leaked into the task).

- [ ] **Step 2: Commit**

```bash
git add test/integration/headless-claude-skills-warning.test.ts
git commit -m "test(integration): verify Claude + skills warns on stderr and does not leak /skill: tokens"
```

### Task 24: Phase 3 gate — full suite green

**Files:** none modified; read-only gate.

- [ ] **Step 1: Run all tests**

Run: `npm test 2>&1 | tail -40 && npm run test:integration 2>&1 | tail -60`
Expected: every test passes or skips cleanly. No unexpected failures.

- [ ] **Step 2: Inspect the tool-restriction patch as a discrete commit**

Run: `git log --oneline -- pi-extension/subagents/index.ts | head -5`
Expected: the most recent commit touching `index.ts` is the named `feat(subagents): emit --tools + required -- separator on Claude path` from Task 17 — ready to cherry-pick into an upstream PR alongside the existing `thinking` commit.

---

## Phase 4 — Enrich `OrchestrationResult` + docs

Phase 4 finalizes the `OrchestrationResult` shape, wires `onUpdate` from headless into the orchestration tool handlers, and updates the README. (If `OrchestrationResult` was already extended opportunistically in Phase 1, this phase is a short docs+callback pass.)

### Task 25: Add optional fields to `OrchestrationResult`

**Files:**
- Modify: `pi-extension/orchestration/types.ts`

- [ ] **Step 1: Check whether the fields are already present from Task 8/11**

Run: `grep -n 'usage\|transcript' pi-extension/orchestration/types.ts`
Expected: either the fields are present (done) or absent (apply Step 2).

- [ ] **Step 2: If absent, append the fields and re-export `UsageStats` + `TranscriptMessage`**

**v6 (review-v7 finding 2):** v5 exported `messages?: Message[]` where `Message` came from `@mariozechner/pi-ai`, but the field was populated from the Claude stream-json path with partial/synthetic objects cast via `as Message`. Downstream callers that read `usage` / `timestamp` / `stopReason` on those objects got malformed data. v6 renames the field to `transcript?: TranscriptMessage[]` and sources `TranscriptMessage` from the backends module so the type reflects what the path actually produces.

In `pi-extension/orchestration/types.ts`, add imports and extend the `OrchestrationResult` interface:

```ts
import type { UsageStats, TranscriptMessage } from "../subagents/backends/types.ts";

export type { UsageStats, TranscriptMessage };

export interface OrchestrationResult {
  name: string;
  finalMessage: string;
  transcriptPath: string | null;
  exitCode: number;
  elapsedMs: number;
  sessionId?: string;
  error?: string;
  /** Populated by the headless backend only in v1. */
  usage?: UsageStats;
  /**
   * Parsed transcript from the headless backend. v6 (review-v7 finding 2):
   * renamed from `messages: Message[]` — see `TranscriptMessage` JSDoc in
   * `../subagents/backends/types.ts` for why pi-ai's `Message` is no
   * longer the declared type (the Claude path cannot produce a valid
   * `AssistantMessage` metadata shape).
   */
  transcript?: TranscriptMessage[];
}
```

- [ ] **Step 3: Typecheck the full project**

Run: `npm run typecheck 2>&1 | tail -30`
Expected: no errors. If a caller elsewhere still references the old `messages` field, fix the call site (rename to `transcript`); there are no known external consumers but the sweep in Step 4 catches them.

- [ ] **Step 4: Invariant check — sweep callers for destructure-without-optional-chaining**

Run: `grep -rn 'finalMessage\|exitCode\|transcriptPath\|usage\|transcript\|\.messages' pi-config/agent/skills/ 2>/dev/null | grep -v '?' | head -20 || echo "pi-config not on this host"`
Expected: either the "not on this host" message, or a short list. Manually inspect each hit to confirm no existing caller destructures `usage` / `transcript` without optional chaining. Specifically check for any remnant reference to the old `.messages` field — those must be updated to `.transcript` (or guarded by optional chaining and tolerated as `undefined`).

- [ ] **Step 5: Add a contract test for the transcript shape (review-v7 finding 2)**

Create `test/orchestration/transcript-shape.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptMessage } from "../../pi-extension/subagents/backends/types.ts";

/**
 * Contract test for TranscriptMessage. v5 exported `messages: Message[]`
 * (pi-ai) but populated from casts, so the type lied. v6 declares
 * TranscriptMessage with an honest block enumeration; this test locks
 * the shape so future edits that try to re-introduce provider metadata
 * (`usage` / `stopReason` / etc.) on this boundary type fail loud.
 */
describe("TranscriptMessage contract", () => {
  it("accepts an assistant message with text + toolCall blocks (the Claude-path output)", () => {
    const m: TranscriptMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "I will call a tool." },
        { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "/tmp/x" } },
      ],
    };
    assert.equal(m.role, "assistant");
    assert.equal(m.content[0].type, "text");
    assert.equal(m.content[1].type, "toolCall");
  });

  it("accepts a toolResult message with the optional isError / toolCallId / toolName fields", () => {
    const m: TranscriptMessage = {
      role: "toolResult",
      toolCallId: "tc-1",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "file contents" }],
    };
    assert.equal(m.role, "toolResult");
    assert.equal(m.toolCallId, "tc-1");
  });

  it("accepts a thinking block with `thinking: string` (not `text: string`)", () => {
    // Matches pi-ai's ThinkingContent shape so the pi path can assign
    // its internal Message[] to TranscriptMessage[] without projection.
    const m: TranscriptMessage = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "let me think..." }],
    };
    const block = m.content[0];
    assert.equal(block.type, "thinking");
    if (block.type === "thinking") {
      assert.equal(block.thinking, "let me think...");
    }
  });

  it("does NOT require api/provider/model/usage/stopReason/timestamp (the v5 lie that v6 fixes)", () => {
    // This is a compile-time assertion: if TranscriptMessage ever grows
    // to require pi-ai AssistantMessage fields, this object literal will
    // not typecheck. A runtime pass here only confirms the test compiled.
    const m: TranscriptMessage = { role: "assistant", content: [] };
    assert.ok(m);
  });
});
```

Run: `npm test -- --test-name-pattern='TranscriptMessage contract' 2>&1 | tail -30`
Expected: PASS (4 cases). If the first, second, or third case fails to compile, the shape has drifted away from what the pi and Claude paths emit; reconcile before proceeding.

- [ ] **Step 6: Commit**

```bash
git add pi-extension/orchestration/types.ts test/orchestration/transcript-shape.test.ts
git commit -m "feat(orchestration): add optional usage/transcript fields on OrchestrationResult

Replaces v5's dishonest messages: Message[] (pi-ai) with a truthful
orchestration-owned TranscriptMessage type. v5's field declared pi-ai
Message shape but was populated with partial/synthetic objects via
unchecked casts — downstream callers reading usage/stopReason/timestamp
got malformed data (review-v7 finding 2). TranscriptMessage declares
only what the stream-json path actually produces."
```

### Task 26: Wire `onUpdate` from headless into orchestration tool handlers

**Files:**
- Modify: `pi-extension/subagents/backends/headless.ts`
- Modify: `pi-extension/orchestration/default-deps.ts`
- Modify: `pi-extension/orchestration/tool-handlers.ts`

- [ ] **Step 1: Extend the `Backend` interface with an optional `onUpdate` hook on watch**

In `pi-extension/subagents/backends/types.ts`, extend the `Backend` interface:

```ts
export interface Backend {
  launch(
    params: BackendLaunchParams,
    defaultFocus: boolean,
    signal?: AbortSignal,
  ): Promise<LaunchedHandle>;
  watch(
    handle: LaunchedHandle,
    signal?: AbortSignal,
    onUpdate?: (partial: BackendResult) => void,
  ): Promise<BackendResult>;
}
```

(The `launch` signature stays on `BackendLaunchParams` from Task 4. Task 26 only adds the optional `onUpdate` parameter to `watch` — it does not revisit the launch-side type.)

- [ ] **Step 2: Pipe `onUpdate` from the headless watch through to per-event callbacks**

In `pi-extension/subagents/backends/headless.ts`, change `watch` to accept `onUpdate` and pass it down to the run-helpers; inside both `runPiHeadless` and `runClaudeHeadless`, call `onUpdate?.({ ...snapshot })` after each `transcript.push(...)` / `usage` mutation, passing a current partial shape:

```ts
function emitPartial(onUpdate: ((p: BackendResult) => void) | undefined, snapshot: BackendResult) {
  if (!onUpdate) return;
  onUpdate({ ...snapshot });
}
```

Concrete wiring: change the `launch`/`watch` signatures to thread an `onUpdate` callback through the per-launch `HeadlessLaunch` entry:

```ts
interface HeadlessLaunch {
  id: string;
  name: string;
  startTime: number;
  promise: Promise<BackendResult>;
  abort: AbortController;
  setOnUpdate: (fn: (p: BackendResult) => void) => void;
}
```

Have `runPiHeadless` / `runClaudeHeadless` take an accessor (`() => onUpdate`) so the `watch` call can inject `onUpdate` after launch but before completion. Example skeleton to replicate in both run-helpers:

```ts
let currentOnUpdate: ((p: BackendResult) => void) | undefined;
// in the stream-json callbacks (v6: `transcript`, not `messages`):
emitPartial(currentOnUpdate, {
  name, finalMessage: getFinalOutput(transcript), transcriptPath: null,
  exitCode: 0, elapsedMs: Date.now() - startTime, usage, transcript,
});
```

- [ ] **Step 3: Update `default-deps.ts` so `waitForCompletion` forwards an `onUpdate` signal**

The `LauncherDeps` interface doesn't expose `onUpdate` today. Extend it in `pi-extension/orchestration/types.ts`:

```ts
export interface LauncherDeps {
  launch(task: OrchestrationTask, defaultFocus: boolean, signal?: AbortSignal): Promise<LaunchedHandle>;
  waitForCompletion(
    handle: LaunchedHandle,
    signal?: AbortSignal,
    onUpdate?: (partial: OrchestrationResult) => void,
  ): Promise<OrchestrationResult>;
}
```

In `default-deps.ts`, pipe it through:

```ts
    async waitForCompletion(
      handle: LaunchedHandle,
      signal?: AbortSignal,
      onUpdate?: (partial: OrchestrationResult) => void,
    ): Promise<OrchestrationResult> {
      const r = await backend.watch(handle, signal, onUpdate ? (partial) => {
        onUpdate({
          name: partial.name,
          finalMessage: partial.finalMessage,
          transcriptPath: partial.transcriptPath,
          exitCode: partial.exitCode,
          elapsedMs: partial.elapsedMs,
          sessionId: partial.sessionId,
          error: partial.error,
          usage: partial.usage,
          transcript: partial.transcript,   // v6 rename (was `messages`)
        });
      } : undefined);
      return { /* same mapping as before */ };
    },
```

- [ ] **Step 4: Wire `onUpdate` in `tool-handlers.ts` (optional in v1 — skill display)**

In `pi-extension/orchestration/tool-handlers.ts`, pass `onUpdate` through from the tool framework into `runSerial` / `runParallel` → `deps.waitForCompletion`. If `onUpdate` is not already a parameter in `runSerial` / `runParallel` (it is not in v1), add it as an optional `opts.onUpdate` callback that the orchestration core invokes with a per-step partial shape. The simplest v1 behavior: forward the latest step's partial via the tool framework's `_onUpdate` callback, so the TUI shows live progress for headless runs.

Concretely, in the `execute` body of `subagent_serial`:

```ts
const out = await runSerial(params.tasks, { signal, onUpdate: _onUpdate }, deps);
```

and in `run-serial.ts`:

```ts
export interface RunSerialOpts {
  signal?: AbortSignal;
  onUpdate?: (content: { content: [{ type: "text"; text: string }]; details: any }) => void;
}
```

Then inside the loop, call:

```ts
const stepOnUpdate = opts.onUpdate
  ? (partial: OrchestrationResult) => {
      opts.onUpdate!({
        content: [{ type: "text", text: partial.finalMessage || "(running...)" }],
        details: { results: [partial] },
      });
    }
  : undefined;
result = await deps.waitForCompletion(handle, opts.signal, stepOnUpdate);
```

Mirror the same change in `run-parallel.ts` (use the worker's `i` to key per-task partials).

- [ ] **Step 5: Run the unit suite to confirm no regressions**

Run: `npm test 2>&1 | tail -40`
Expected: all orchestration unit tests still pass. If `run-serial` / `run-parallel` tests construct `opts` without `onUpdate`, they should continue to work (the field is optional).

- [ ] **Step 6: Commit**

```bash
git add pi-extension/subagents/backends/headless.ts pi-extension/subagents/backends/types.ts pi-extension/orchestration/default-deps.ts pi-extension/orchestration/types.ts pi-extension/orchestration/tool-handlers.ts pi-extension/orchestration/run-serial.ts pi-extension/orchestration/run-parallel.ts
git commit -m "feat(orchestration): forward onUpdate from headless backend through to tool handlers"
```

### Task 27: Document `PI_SUBAGENT_MODE`, backends, and new result fields

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the existing README sections so the new copy slots in cleanly**

Run: `grep -n '^##\|^###' README.md | head -30`
Expected: top-level section headings. New copy should land near the existing "How It Works" / install section; a new "Backends" subsection is appropriate.

- [ ] **Step 2: Add the backend-selection section**

Append (or insert after the install block) a section:

```markdown
## Backends

Subagents run under one of two backends, selected per session:

- **pane** (default when a multiplexer is available) — spawns each subagent in a dedicated mux pane (cmux, tmux, zellij, or wezterm). The widget renders live elapsed time and message counts. Transcripts are archived after completion.
- **headless** (default when no multiplexer is available) — spawns each subagent as a child process with piped stdio and parses stream-json. Works in CI, headless SSH sessions, and IDE-embedded terminals. Populates `usage` (tokens, cost, turns) and `transcript[]` (parsed stream of `TranscriptMessage` entries) on the orchestration result.

Override selection via env var:

```bash
PI_SUBAGENT_MODE=pane      # force pane (errors if no mux)
PI_SUBAGENT_MODE=headless  # force headless (works anywhere)
PI_SUBAGENT_MODE=auto      # default — detect mux, fall back to headless
```

### Orchestration result shape

`subagent_serial` and `subagent_parallel` return results with these fields per task:

| Field            | Backend filling it     | Notes                                                                 |
| ---------------- | ---------------------- | --------------------------------------------------------------------- |
| `finalMessage`   | both                   | Last assistant text output.                                           |
| `transcriptPath` | both                   | Path to the session/transcript file. For pi runs, this is `getDefaultSessionDirFor(effectiveCwd, effectiveAgentDir)` — typically `~/.pi/agent/sessions/<project-slug>/`, but project-local `.pi/agent/` and `PI_CODING_AGENT_DIR` override it. For Claude runs, this is always under `~/.pi/agent/sessions/claude-code/`. |
| `exitCode`       | both                   | 0 on success, 1 on error / cancellation.                              |
| `elapsedMs`      | both                   | Wall time from launch to completion.                                  |
| `sessionId`      | both (Claude only)     | Claude session id — useful for `subagent_resume`.                     |
| `error`          | both                   | Non-empty when the run didn't cleanly finish.                         |
| `usage`          | **headless only (v1)** | `{ input, output, cacheRead, cacheWrite, cost, contextTokens, turns }` |
| `transcript`     | **headless only (v1)** | Parsed array of `TranscriptMessage { role, content[] }`. Content block types: `"text" \| "thinking" \| "toolCall" \| "image"`. Rich provider metadata (stopReason, per-message timestamp/cost) is **not** surfaced here — read the archived `.jsonl` at `transcriptPath` for the full stream. |

The `usage` / `transcript` fields are `undefined` on pane-backend results in v1; enriching the pane path is tracked as follow-up work.

## Tool restriction

Agents declaring `tools:` frontmatter have that restriction enforced in **both** backends for both CLIs (`pi` and `claude`). On the Claude path, the pi tool names are mapped to the equivalent Claude tools (`read → Read`, `bash → Bash`, `find`/`ls → Glob`, etc.) and emitted as `--tools` (the Claude CLI built-in tool availability flag — not `--allowedTools`, which is a permission rule that `bypassPermissions` / `--dangerously-skip-permissions` mode ignores). Agents without `tools:` frontmatter still run with full tool access on both CLIs.

## Skills

Agents declaring `skills:` frontmatter (or passing `skills:` in a subagent task) work as follows:

- **pi backend (pane + headless):** each listed skill is expanded into a `/skill:<name>` positional message, which pi's CLI resolves and inlines at the start of the conversation. Full parity with upstream.
- **Claude backend (pane + headless) — v1 limitation:** skills are currently **not** forwarded to the Claude CLI. Claude's skill mechanism is plugin/slash-command based, resolved by the CLI when the model invokes them mid-conversation; it does not consume pi's `/skill:<name>` message-prefix convention. Rather than leak literal `/skill:<name>` strings into the task body, **both** Claude backends emit an identical one-line `stderr` warning (`[pi-interactive-subagent] <name>: ignoring skills=<list> on Claude path — not supported in v1`) when skills are present and proceed without them. A follow-up spec will design Claude-specific skill delivery; until then, use the pi CLI for skill-dependent agents.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document PI_SUBAGENT_MODE, backends, result fields, and tool-restriction"
```

### Task 28: Phase 4 gate — final full-suite sweep

**Files:** none modified; read-only gate.

- [ ] **Step 1: Run the full unit + integration suite one more time**

Run: `npm test 2>&1 | tail -40 && npm run test:integration 2>&1 | tail -60`
Expected: every test passes or skips cleanly.

- [ ] **Step 2: Confirm the two carried patches are discrete named commits**

Run: `git log --oneline pi-extension/subagents/index.ts | head -10`
Expected: the most recent two touching `index.ts` are (a) `feat(subagents): emit --tools + required -- separator on Claude path` (Task 17) and (b) an earlier `thinking` patch. Both are portable as-is to an upstream PR.

- [ ] **Step 3: Final commit (if README or test-list adjustments happened during the sweep)**

If nothing to commit, skip. Otherwise:

```bash
git add -A
git commit -m "chore(mux-free): finalize suite sweep and patch inspection"
```

---

## Out of scope reminders

The following are **explicitly out of scope for this plan** (see the spec for rationale):

- Symmetric observability on the pane backend (`usage` / `transcript` / `onUpdate` on pane results). Deferred.
- `fallbackModels` replacement. Skills own fallback.
- Numeric recursion depth guard. `spawning: false` remains the convention.
- Skills migration from the old `subagent { chain / tasks }` surface. Tracked in the fork-design spec.
- Retiring `pi-subagent`. Gated on skills migration + fallback story + soak.
- Real CI enablement for integration tests (provisioning CLIs and API keys in runners).
- Plumbing the `interactive` schema field as a real behavioral switch. Vestigial in v1.

When implementing, if a task's scope drifts into any of the above, stop and note the drift in the PR description — do not expand the plan inline.

