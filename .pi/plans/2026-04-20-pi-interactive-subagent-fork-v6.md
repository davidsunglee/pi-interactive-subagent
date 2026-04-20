# pi-interactive-subagent Fork Implementation Plan (v6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **v6 revision notes** (addresses `.pi/plans/reviews/2026-04-20-pi-interactive-subagent-fork-review-v5.md`):
> 1. **Self-spawn protection is now enforced for `subagent_serial` / `subagent_parallel`, not just the bare `subagent` tool.** v5 wired the orchestration handlers straight through `launchSubagent`, which — unlike `subagent.execute` — contains no `PI_SUBAGENT_AGENT` recursion guard. That meant a `planner` session could spawn another `planner` via `subagent_serial`, silently changing an existing runtime safety invariant. Task 7 Step 5 now extracts **two** shared helpers (`preflightSubagent` + a new `selfSpawnBlocked(agent)`), `subagent.execute` is refactored to call `selfSpawnBlocked` instead of its inline block, Task 15's registrar takes an injectable `selfSpawn: SelfSpawnCheckFn` alongside the existing `preflight` injection and short-circuits the whole orchestration call if **any** task targets the current `PI_SUBAGENT_AGENT` (matching the bare tool's early-reject behavior), Task 14 gains a focused test, and Task 16 wires the real `selfSpawnBlocked` helper through the registrar.
> 2. **Task 18 Step 3's missing-Claude-plugin wording no longer overstates cancellation.** v5 said `watchSubagent` keeps polling "until the caller cancels the subagent through the widget or by aborting the tool call." The tool-signal → running-wait propagation is still explicitly deferred (see Deferred work), so "aborting the tool call" is not yet a real cancellation path for orchestration waits. The sentence is now scoped to the widget-cancel path and cross-references Deferred work.
> 3. **Task 19 Step 3's expected test-file listing now includes `default-deps.test.ts`.** Task 13 Step 2 added this file in v5 but the final-sweep checklist in Task 19 kept the v4 four-file listing. The expected `ls test/orchestration` output is updated so the last sweep is mechanically accurate against the files this plan actually produces.
>
> **Carried from v5** (still true — addresses `.pi/plans/reviews/2026-04-20-pi-interactive-subagent-fork-review-v4.md`):
> 1. **`transcriptPath` contract is now complete across all four `watchSubagent` return paths.** v4 only added `transcriptPath` to the two success returns (Claude success, pi success), leaving the `catch` block's cancelled/error returns shaped without the now-required field. Task 7 Step 3 is extended to set `transcriptPath: null` on both the `signal.aborted` cancel return and the generic error return, so `makeDefaultDeps.waitForCompletion` in Task 13 never sees `undefined` when reading `sub.transcriptPath`.
> 2. **Task 13 adds a focused `transcriptPath: null` passthrough test.** A small `test/orchestration/default-deps.test.ts` exercises `waitForCompletion` on an unknown handle (which hits the same mapping code) and asserts the returned `transcriptPath` is `null` (not `undefined`). Guards against future optional-field relaxation.
> 3. **Task 18 Step 2 splits docs ownership cleanly.** v4 implied all three new fields (`cli`, `thinking`, `focus`) land in both the tool-parameter reference and the agent-frontmatter reference. In truth, only `cli` and `thinking` are parsed from agent frontmatter today; `focus` is a per-call tool parameter only. The step now lists all three under "tool parameters" and only `cli` / `thinking` under "agent frontmatter".
> 4. **Task 15's `subagent_parallel` tool metadata is aligned with backend reality.** v4 updated the README to scope detach to tmux but left the tool `description` and `promptSnippet` saying "Panes are spawned detached by default" without qualifier. Both strings now call out that detached spawn is tmux-only and other backends (cmux, zellij, wezterm) focus the new pane — matching the README wording and the actual behavior from Task 4 Step 6.
> 5. **Unused `DEFAULT_SENTINEL_TIMEOUT_MS` constant removed from Task 8.** v4 declared a `30_000` sentinel timeout symbol in `types.ts` but never consumed it anywhere, and the README copy already documents that no dedicated 30s guard exists. The constant is dropped to avoid the same doc confusion v4 corrected; it can land with its consumer if/when a real sentinel timeout is implemented.
>
> **Carried from v4** (still true):
> 1. **`runSerial` / `runParallel` now catch thrown launch/wait errors.** v3 only handled returned failure states (`exitCode !== 0`, `result.error`), so a throw from `deps.launch()` or `deps.waitForCompletion()` on step N would reject the whole promise and discard earlier results. Tasks 10 and 12 now wrap each `launch`/`waitForCompletion` pair in `try/catch`, synthesize a failing `OrchestrationResult` with `exitCode: 1` and `error: err.message`, and keep the advertised semantics intact (serial: prior + failing step returned with `isError: true`; parallel: sibling workers run to completion and the full input-order array is returned). Task 9 and Task 11 gain matching tests (serial launch-throw, serial wait-throw, parallel one-throws-siblings-complete).
> 2. **Task 17 is reframed honestly as a skip-gated scaffold.** The description, narration, and test name no longer advertise end-to-end roundtrip coverage that the placeholder body doesn't actually provide. The manual smoke checklist in Task 18 remains the authoritative verification path for the Claude sentinel flow until a real automated harness exists.
> 3. **Task 18 README copy is aligned with the actual implementation.** The existing intro's "Fully non-blocking" line is rewritten to reflect that the fork now ships both non-blocking (`subagent`, `subagent_resume`) and blocking orchestration tools. The parallel-tools description drops the unqualified "spawned detached by default" claim and explicitly scopes detach to tmux (other backends focus regardless, per Task 4 Step 6). The "times out after ~30s" sentence on missing Claude plugin is rewritten to describe the actually-implemented behavior (the sentinel wait hangs until the external timeout/cancel path fires — no dedicated 30s guard exists in this plan). Existing README sections that gate on tool name (`spawning: false` allowlist, `deny-tools` examples, the parameter/frontmatter reference) are extended to mention `subagent_serial` / `subagent_parallel` and the new `cli` / `thinking` / `focus` fields (with `focus` as a parameter-only field — see v5 revision note 3).
>
> **Carried from v3** (still true):
> 1. **Claude transcript path is recoverable in real execution order.** `SubagentResult` carries a uniform `transcriptPath: string | null` populated by `watchSubagent` before sentinel cleanup (pi branch: `sessionFile`; Claude branch: `join(CLAUDE_SESSIONS_DIR, claudeSessionId)` computed from the already-archived copy). `default-deps` reads `sub.transcriptPath` directly — no post-watch file reads, no `readTranscript` helper.
> 2. **Widget refresh starts inside `launchSubagent` itself** (right after `runningSubagents.set`), so every caller — including `makeDefaultDeps.launch` — gets the widget loop for free. The previously-redundant call sites at `subagent.execute` / `subagent_resume.execute` stay in place, idempotent via the `widgetInterval` guard.
> 3. **`{previous}` substitution uses `split/join`** so `$$`, `$&`, `$1`, … in assistant output are inserted literally (v3 fix, tested in Task 9).
> 4. **README rebrand covers title, install-command URL, and "What's Included" tool-count/table copy** (v3 fix in Task 1 Step 3).
> 5. **Shared `preflightSubagent(ctx)` helper** (mux-availability + session-file checks) is exported from Task 7 Step 5 and called by both the bare `subagent` tool and the orchestration handlers so error shapes match.
>
> **Carried from v2** (still true):
> - Per-tool registration gating via `shouldRegister` predicate.
> - `OrchestrationTaskSchema` omits unplumbed `interactive` / `permissionMode` fields.
> - `caller_ping` surfacing, tool-signal cancellation, and async mode remain deferred.
> - `npm test` script covers `test/test.ts` + `test/system-prompt-mode.test.ts` + `test/orchestration/*.test.ts`.

**Goal:** Turn the current freshly-forked `HazAT/pi-interactive-subagents` checkout into `pi-interactive-subagent` by (a) rebranding the package, (b) patching upstream `subagent()` to support per-call `thinking` end-to-end, (c) adding a pure-async orchestration layer exposing `subagent_serial` and `subagent_parallel`, and (d) supporting detached pane spawning with a per-task `focus` override. Out of scope: migrating `pi-config/agent/skills/` (that happens in a follow-up PR in the `pi-config` repo).

**Architecture:** Keep upstream files (`pi-extension/subagents/*`) in place as "vendored from upstream + narrow patches". Put all orchestration code under a new sibling directory `pi-extension/orchestration/`. Tool handlers are thin wrappers; the orchestration cores (`runSerial`, `runParallel`) are pure async functions that accept an injectable `LauncherDeps` (`launch` + `waitForCompletion`) so unit tests can mock all IO. The production `LauncherDeps` composes the exported `launchSubagent` + `watchSubagent` primitives directly: `launchSubagent` now starts the widget refresh loop itself (no external glue needed), and `watchSubagent` now returns a uniform `transcriptPath` on its result (populated before Claude sentinel cleanup). `runSerial` iterates, substitutes `{previous}` via `split/join` (literal insertion — safe for `$`-bearing output), and stops on error. `runParallel` uses a bounded concurrency pool (cap 8, default 4). Both cores wrap each `deps.launch` + `deps.waitForCompletion` pair in `try/catch` and convert thrown errors into synthetic failing `OrchestrationResult` entries (exitCode 1, `error` set), so the promised failure semantics — serial returns prior + failing step, parallel lets siblings run and aggregates in input order — hold even when upstream launch/wait throws. Both feed through the existing widget via the shared `runningSubagents` map in `index.ts`. Orchestration tool handlers reuse **two** exported helpers so runtime invariants match the bare `subagent` tool: `preflightSubagent(ctx)` (mux / session-file validation) and `selfSpawnBlocked(agent)` (the `PI_SUBAGENT_AGENT` recursion guard). The orchestration registrar iterates `params.tasks` and early-rejects the whole call if any task targets the current agent, matching the bare tool's existing behavior.

**Tech Stack:** TypeScript (Node's native `--test` runner, `node:assert/strict`), `@sinclair/typebox` for tool schemas, `@mariozechner/pi-coding-agent` for the extension API, tmux/cmux/zellij/wezterm via the existing `cmux.ts` surface helpers.

---

## File Structure

**Modified files (upstream, narrow changes only):**
- `package.json` — rename, update repo URL, bump version, add test script for orchestration.
- `README.md` — rewrite title + install URL + "What's Included" copy, add new tool section, fork provenance note, Claude plugin install steps.
- `pi-extension/subagents/index.ts` — add `thinking`, `cli`, `focus` to `SubagentParams`; wire `params.thinking ?? agentDefs?.thinking`; add `thinkingToEffort` + Claude `--effort` path; export `launchSubagent`, `watchSubagent`, a new `preflightSubagent(ctx)` helper, and a new `selfSpawnBlocked(agent)` helper for orchestration; refactor `subagent.execute` to call `selfSpawnBlocked` instead of its inline `PI_SUBAGENT_AGENT` check; extend `SubagentResult` with a uniform `transcriptPath: string | null`; populate it in both branches of `watchSubagent` **before** sentinel cleanup; move `startWidgetRefresh()` invocation into `launchSubagent` itself (after `runningSubagents.set`); add `detach` option flowing from `params.focus === false`; register orchestration tools from its `subagentsExtension` default export.
- `pi-extension/subagents/cmux.ts` — extend `createSurface(name, opts?: { detach?: boolean })`; extend `createSurfaceSplit` with the same `detach` passthrough; tmux branch adds `-d`; other backends no-op detach (documented limitation).

**New files (our additions, clearly segregated):**
- `pi-extension/orchestration/types.ts` — shared types: `OrchestrationTask`, `OrchestrationResult`, `LauncherDeps`.
- `pi-extension/orchestration/run-serial.ts` — pure `runSerial(tasks, opts, deps)`.
- `pi-extension/orchestration/run-parallel.ts` — pure `runParallel(tasks, opts, deps)`.
- `pi-extension/orchestration/default-deps.ts` — `makeDefaultDeps(ctx)` composing `launchSubagent` + `watchSubagent` into `LauncherDeps`, reading `sub.transcriptPath` / `sub.summary` / `sub.claudeSessionId` directly off the returned `SubagentResult`.
- `pi-extension/orchestration/tool-handlers.ts` — `registerOrchestrationTools(pi, depsFactory, shouldRegister)` — conditionally registers each tool; each `execute` calls exported `preflightSubagent(ctx)` first for mux/session-file validation that matches the bare `subagent` tool's error shape.
- `test/orchestration/run-serial.test.ts`
- `test/orchestration/run-parallel.test.ts`
- `test/orchestration/tool-handlers.test.ts`
- `test/orchestration/default-deps.test.ts` — focused `transcriptPath: null` passthrough test (Task 13 Step 2).
- `test/orchestration/thinking-effort.test.ts` — unit tests for the upstream patch.
- `test/integration/claude-sentinel-roundtrip.test.ts` — local-only, skipped without `claude` + plugin.

---

## Task 1: Rebrand the fork

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Confirm current state**

Run: `grep -n '"name"\|"repository"\|"author"\|"description"' package.json`
Expected:
```
  "name": "pi-interactive-subagents",
  "description": "Interactive subagents for pi ...",
  "author": "HazAT",
  "repository": { ... "url": "https://github.com/HazAT/pi-interactive-subagents" },
```

- [ ] **Step 2: Rewrite `package.json` metadata**

Replace the top-level metadata in `package.json` with:

```json
{
  "name": "@davidsunglee/pi-interactive-subagent",
  "version": "3.3.0-fork.0",
  "description": "Interactive subagents + orchestration (serial/parallel) for pi and Claude Code — fork of HazAT/pi-interactive-subagents.",
  "keywords": [
    "pi-package"
  ],
  "license": "MIT",
  "author": "David Lee",
  "contributors": [
    "HazAT (upstream: github.com/HazAT/pi-interactive-subagents)"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/davidsunglee/pi-interactive-subagent"
  },
  "type": "module",
  "scripts": {
    "test": "node --test test/test.ts test/system-prompt-mode.test.ts test/orchestration/*.test.ts",
    "test:integration": "node --test test/integration/*.test.ts"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "@sinclair/typebox": "*"
  },
  "pi": {
    "extensions": [
      "./pi-extension/subagents/index.ts"
    ]
  },
  "devDependencies": {
    "@mariozechner/pi-coding-agent": "^0.65.0",
    "@mariozechner/pi-tui": "^0.65.0",
    "@sinclair/typebox": "^0.34.49"
  }
}
```

- [ ] **Step 3a: Rewrite the README title + fork-provenance block**

Replace the very first line of `README.md`:

```markdown
# pi-interactive-subagents
```

with:

```markdown
# pi-interactive-subagent

> **Fork notice.** This is a fork of [`HazAT/pi-interactive-subagents`](https://github.com/HazAT/pi-interactive-subagents). We preserve the upstream execution core unchanged under `pi-extension/subagents/` (treat as vendored — periodically rebased), and layer orchestration tools (`subagent_serial`, `subagent_parallel`) under `pi-extension/orchestration/`. Small upstream patches (currently only the `thinking` fix) live as named local commits with intent to upstream.
```

- [ ] **Step 3b: Rewrite the install command**

In the `## Install` section, replace:

```bash
pi install git:github.com/HazAT/pi-interactive-subagents
```

with:

```bash
pi install git:github.com/davidsunglee/pi-interactive-subagent
```

- [ ] **Step 3c: Update the `## What's Included` → Extensions tool count + table**

The existing copy reads `**Subagents** — 4 tools + 3 commands:` (already inaccurate upstream — only 3 tool rows). After this plan lands, the fork ships **5 tools + 3 commands**. Replace:

```markdown
**Subagents** — 4 tools + 3 commands:

| Tool              | Description                                                                     |
| ----------------- | ------------------------------------------------------------------------------- |
| `subagent`        | Spawn a sub-agent in a dedicated multiplexer pane (async — returns immediately) |
| `subagents_list`  | List available agent definitions                                                |
| `subagent_resume` | Resume a previous sub-agent session (async)                                     |
```

with:

```markdown
**Subagents** — 5 tools + 3 commands:

| Tool                | Description                                                                     |
| ------------------- | ------------------------------------------------------------------------------- |
| `subagent`          | Spawn a sub-agent in a dedicated multiplexer pane (async — returns immediately) |
| `subagents_list`    | List available agent definitions                                                |
| `subagent_resume`   | Resume a previous sub-agent session (async)                                     |
| `subagent_serial`   | Run a pipeline of subagents in order (blocks; `{previous}` substitution)        |
| `subagent_parallel` | Fan out a batch of subagents concurrently (blocks; default cap 4, hard cap 8)   |
```

(The detailed per-tool prose for the two new rows lives in Task 18's README section.)

- [ ] **Step 4: Commit**

```bash
git add package.json README.md
git commit -m "chore: rebrand fork to @davidsunglee/pi-interactive-subagent"
```

---

## Task 2: Write failing test for `thinkingToEffort` mapping

**Files:**
- Create: `test/orchestration/thinking-effort.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { thinkingToEffort } from "../../pi-extension/subagents/index.ts";

describe("thinkingToEffort", () => {
  it("maps off/minimal/low to low", () => {
    assert.equal(thinkingToEffort("off"), "low");
    assert.equal(thinkingToEffort("minimal"), "low");
    assert.equal(thinkingToEffort("low"), "low");
  });
  it("maps medium to medium", () => {
    assert.equal(thinkingToEffort("medium"), "medium");
  });
  it("maps high to high", () => {
    assert.equal(thinkingToEffort("high"), "high");
  });
  it("maps xhigh to max", () => {
    assert.equal(thinkingToEffort("xhigh"), "max");
  });
  it("returns undefined for unknown values", () => {
    assert.equal(thinkingToEffort("bogus"), undefined);
    assert.equal(thinkingToEffort(""), undefined);
    assert.equal(thinkingToEffort(undefined), undefined);
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `node --test test/orchestration/thinking-effort.test.ts`
Expected: FAIL with `thinkingToEffort is not exported from index.ts`

---

## Task 3: Implement `thinkingToEffort` and export it

**Files:**
- Modify: `pi-extension/subagents/index.ts`

- [ ] **Step 1: Add the helper near the other small helpers (after `parseSessionMode`, around line 178)**

```ts
export function thinkingToEffort(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase().trim();
  if (v === "off" || v === "minimal" || v === "low") return "low";
  if (v === "medium") return "medium";
  if (v === "high") return "high";
  if (v === "xhigh") return "max";
  return undefined;
}
```

- [ ] **Step 2: Run the test**

Run: `node --test test/orchestration/thinking-effort.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 3: Commit**

```bash
git add pi-extension/subagents/index.ts test/orchestration/thinking-effort.test.ts
git commit -m "feat(subagent): add thinkingToEffort mapping (off/minimal/low→low, medium, high, xhigh→max)"
```

---

## Task 4: Extend `SubagentParams` with `thinking`, `cli`, `focus`

**Files:**
- Modify: `pi-extension/subagents/index.ts` (around the `SubagentParams = Type.Object({...})` declaration near line 56)

- [ ] **Step 1: Add the three optional fields to `SubagentParams`**

Locate the `SubagentParams = Type.Object({` block. Immediately before the closing `});` at line 93, add:

```ts
  cli: Type.Optional(
    Type.String({
      description:
        "CLI to launch for this subagent. One of 'pi' (default) or 'claude'. Overrides the agent frontmatter `cli` field.",
    }),
  ),
  thinking: Type.Optional(
    Type.String({
      description:
        "Thinking/effort override. Values: off, minimal, low, medium, high, xhigh. For pi: folded into the model string as `<model>:<thinking>`. For Claude: mapped to --effort (off/minimal/low→low, medium, high, xhigh→max). Overrides agent frontmatter.",
    }),
  ),
  focus: Type.Optional(
    Type.Boolean({
      description:
        "Whether the newly spawned pane grabs focus. Default true. Only honored on tmux today (other backends ignore). Orchestration wrappers default this to false for parallel, true for serial.",
    }),
  ),
```

- [ ] **Step 2: Wire `thinking` resolution (around `effectiveThinking` near line 601)**

Change:
```ts
  const effectiveThinking = agentDefs?.thinking;
```
to:
```ts
  const effectiveThinking = params.thinking ?? agentDefs?.thinking;
```

- [ ] **Step 3: Wire `cli` resolution (around the Claude-branch guard near line 633)**

Change:
```ts
  if (agentDefs?.cli === "claude") {
```
to:
```ts
  const effectiveCli = params.cli ?? agentDefs?.cli;
  if (effectiveCli === "claude") {
```

- [ ] **Step 4: Record `cli` on `RunningSubagent` (inside the Claude branch, around line 683–694)**

Change the Claude-branch `const running: RunningSubagent = {` block's `cli: "claude",` assignment — no change needed there since it already sets `cli: "claude"`. But add a comment above it:

```ts
    // cli recorded for watchSubagent completion-path dispatch
    const running: RunningSubagent = {
```

Also, in the Pi-path `const running: RunningSubagent = {` block (around line 853), add:
```ts
      cli: "pi",
```
right after `launchScriptFile,`.

- [ ] **Step 5: Plumb `focus` into surface creation (around line 627)**

Change:
```ts
  const surface = options?.surface ?? createSurface(params.name);
```
to:
```ts
  const surface =
    options?.surface ?? createSurface(params.name, { detach: params.focus === false });
```

- [ ] **Step 6: Update `createSurface` signature in `cmux.ts`**

In `pi-extension/subagents/cmux.ts`, change the declaration at line 200:

```ts
export function createSurface(name: string, opts?: { detach?: boolean }): string {
```

And at line 218 change:
```ts
  const surface = createSurfaceSplit(name, "right", fromSurface);
```
to:
```ts
  const surface = createSurfaceSplit(name, "right", fromSurface, opts);
```

Update `createSurfaceSplit`'s signature at line 259:

```ts
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  opts?: { detach?: boolean },
): string {
```

Inside the tmux branch, immediately after `const args = ["split-window"];` (around line 283) add:

```ts
    if (opts?.detach) args.push("-d");
```

The cmux / zellij / wezterm branches remain unchanged — `detach` is a no-op there for v1, documented as a backend limitation.

- [ ] **Step 7: Run the existing test suite to confirm nothing broke**

Run: `npm test`
Expected: all pre-existing tests still pass (the new thinking-effort test already passes from Task 3).

- [ ] **Step 8: Commit**

```bash
git add pi-extension/subagents/index.ts pi-extension/subagents/cmux.ts
git commit -m "feat(subagent): add per-call thinking/cli/focus overrides to SubagentParams"
```

---

## Task 5: Write failing test for Claude `--effort` on thinking

**Files:**
- Modify: `test/orchestration/thinking-effort.test.ts`

- [ ] **Step 1: Add a test that patches the shell-exec pipeline and inspects the built command**

We can't run a real `claude` binary in unit tests. Instead, export a pure helper from `index.ts` that builds the Claude command parts, and test that.

Extend the test file:

```ts
import { buildClaudeCmdParts } from "../../pi-extension/subagents/index.ts";

describe("buildClaudeCmdParts", () => {
  it("includes --effort when thinking is set", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      appendSystemPrompt: undefined,
      resumeSessionId: undefined,
      effectiveThinking: "high",
      task: "do things",
    });
    assert.ok(parts.includes("--effort"));
    assert.equal(parts[parts.indexOf("--effort") + 1], "high");
  });
  it("maps xhigh to max", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      appendSystemPrompt: undefined,
      resumeSessionId: undefined,
      effectiveThinking: "xhigh",
      task: "do things",
    });
    assert.equal(parts[parts.indexOf("--effort") + 1], "max");
  });
  it("omits --effort when thinking is absent", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      appendSystemPrompt: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do things",
    });
    assert.equal(parts.includes("--effort"), false);
  });
  it("omits --effort when thinking is unknown (maps to undefined)", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      appendSystemPrompt: undefined,
      resumeSessionId: undefined,
      effectiveThinking: "bogus",
      task: "do things",
    });
    assert.equal(parts.includes("--effort"), false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/orchestration/thinking-effort.test.ts`
Expected: FAIL with `buildClaudeCmdParts is not exported`.

---

## Task 6: Extract `buildClaudeCmdParts` + wire `--effort`

**Files:**
- Modify: `pi-extension/subagents/index.ts`

- [ ] **Step 1: Extract the Claude command-builder as a pure function**

Above `launchSubagent` (near line 583), add:

```ts
interface ClaudeCmdInputs {
  sentinelFile: string;
  pluginDir: string | undefined; // if existsSync, pass --plugin-dir
  model: string | undefined;
  appendSystemPrompt: string | undefined;
  resumeSessionId: string | undefined;
  effectiveThinking: string | undefined;
  task: string;
}

export function buildClaudeCmdParts(input: ClaudeCmdInputs): string[] {
  const parts: string[] = [];
  parts.push(`PI_CLAUDE_SENTINEL=${shellEscape(input.sentinelFile)}`);
  parts.push("claude");
  parts.push("--dangerously-skip-permissions");
  if (input.pluginDir) {
    parts.push("--plugin-dir", shellEscape(input.pluginDir));
  }
  if (input.model) {
    parts.push("--model", shellEscape(input.model));
  }
  const effort = thinkingToEffort(input.effectiveThinking);
  if (effort) {
    parts.push("--effort", effort);
  }
  if (input.appendSystemPrompt) {
    parts.push("--append-system-prompt", shellEscape(input.appendSystemPrompt));
  }
  if (input.resumeSessionId) {
    parts.push("--resume", shellEscape(input.resumeSessionId));
  }
  parts.push(shellEscape(input.task));
  return parts;
}
```

- [ ] **Step 2: Replace the inline Claude command construction inside `launchSubagent`**

In the Claude branch (around lines 637–661), replace the `cmdParts.push(...)` sequence with:

```ts
    const pluginDirResolved = existsSync(pluginDir) ? pluginDir : undefined;
    const cmdParts = buildClaudeCmdParts({
      sentinelFile,
      pluginDir: pluginDirResolved,
      model: effectiveModel,
      appendSystemPrompt: params.systemPrompt ?? agentDefs?.body,
      resumeSessionId: params.resumeSessionId,
      effectiveThinking,
      task: params.task,
    });
```

Keep the surrounding `cdPrefix` / `command` construction unchanged.

- [ ] **Step 3: Run the tests**

Run: `node --test test/orchestration/thinking-effort.test.ts test/test.ts`
Expected: all pass (new buildClaudeCmdParts suite + pre-existing suite).

- [ ] **Step 4: Commit**

```bash
git add pi-extension/subagents/index.ts test/orchestration/thinking-effort.test.ts
git commit -m "feat(subagent): wire --effort on Claude path from thinking param (upstream patch candidate)"
```

---

## Task 7: Export primitives + move widget start + uniform `transcriptPath` + shared preflight + shared self-spawn guard

This task bundles the upstream surgery that the v3 / v5 reviews surfaced. All sub-steps are narrow and touch only `pi-extension/subagents/index.ts`.

**Files:**
- Modify: `pi-extension/subagents/index.ts`

- [ ] **Step 1: Export the two async primitives + the two shared types**

Find `async function launchSubagent(` (~line 589) and change to:
```ts
export async function launchSubagent(
```

Find `async function watchSubagent(` (~line 894) and change to:
```ts
export async function watchSubagent(
```

Change the existing `interface SubagentResult` and `interface RunningSubagent` declarations (near line 370 and 385) to `export interface`:
```ts
export interface SubagentResult { ... }
export interface RunningSubagent { ... }
```

- [ ] **Step 2: Extend `SubagentResult` with a uniform `transcriptPath` field**

Inside the `export interface SubagentResult { ... }` block, add:
```ts
  transcriptPath: string | null;
```

The field is **required** (not optional) so both branches of `watchSubagent` must populate it — this is the contract that makes the orchestration layer's Claude path recoverable.

- [ ] **Step 3: Populate `transcriptPath` in `watchSubagent` BEFORE sentinel cleanup**

Goal: both branches of `watchSubagent` must set `transcriptPath` on the returned `SubagentResult`. For Claude, the value must be computed **before** `unlinkSync` runs.

**Claude branch** (~line 943–954). Locate:

```ts
      // Copy Claude session transcript
      let sessionId: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        try { unlinkSync(running.sentinelFile); } catch {}
        try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
      }

      closeSurface(surface);
      runningSubagents.delete(running.id);

      return { name, task, summary, exitCode: result.exitCode, elapsed, ...(sessionId ? { claudeSessionId: sessionId } : {}) };
```

Replace with:

```ts
      // Archive Claude session transcript; compute archived path BEFORE unlinking
      // the sentinel + pointer files (cleanup erases the source path we need).
      let sessionId: string | null = null;
      let transcriptPath: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        transcriptPath = sessionId ? join(CLAUDE_SESSIONS_DIR, sessionId) : null;
        try { unlinkSync(running.sentinelFile); } catch {}
        try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
      }

      closeSurface(surface);
      runningSubagents.delete(running.id);

      return {
        name,
        task,
        summary,
        exitCode: result.exitCode,
        elapsed,
        transcriptPath,
        ...(sessionId ? { claudeSessionId: sessionId } : {}),
      };
```

**Pi branch** (~line 958–990). Locate the final `return { name, task, summary, ... }` on the pi path and add `transcriptPath: existsSync(sessionFile) ? sessionFile : null,` to the returned object. Example:

```ts
    return {
      name,
      task,
      summary,
      exitCode: result.exitCode,
      elapsed,
      sessionFile,
      transcriptPath: existsSync(sessionFile) ? sessionFile : null,
      entries: running.entries,
      bytes: running.bytes,
      ping: running.ping,
    };
```

(Adjust to the exact set of fields already on the pi return — just add the new `transcriptPath` line.)

**Catch block** (~line 977–1001). Because `SubagentResult.transcriptPath` is now **required**, both failure returns in the `catch` must populate it explicitly. There is no archived transcript on these paths (cancel / poll error / IO error), so the correct value is `null`. Locate:

```ts
    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
```

Replace with:

```ts
    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        transcriptPath: null,
        error: "cancelled",
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      transcriptPath: null,
      error: err?.message ?? String(err),
    };
```

This makes the `transcriptPath` contract uniform across all four return paths (Claude success, pi success, cancelled, error). Downstream, `makeDefaultDeps.waitForCompletion` (Task 13) reads `sub.transcriptPath` directly and must never see `undefined`.

- [ ] **Step 4: Move `startWidgetRefresh()` into `launchSubagent`**

Locate the bottom of `launchSubagent` (~line 860–865) where `runningSubagents.set(id, running)` appears, just before the `return running`. Immediately after the `.set(...)` call, add:

```ts
  runningSubagents.set(id, running);
  startWidgetRefresh();   // idempotent via widgetInterval guard
  return running;
```

This guarantees every caller — including orchestration's `makeDefaultDeps.launch` — gets the widget loop for free. The existing `startWidgetRefresh()` calls at ~line 1095 (`subagent.execute`) and ~line 1437 (`subagent_resume.execute`) become redundant but stay put; they're idempotent (early-returns when `widgetInterval` is already set).

- [ ] **Step 5: Extract + export a shared `preflightSubagent(ctx)` helper**

Locate the two inline preflight checks inside `subagent.execute` (~line 1069–1084):

```ts
        // Validate prerequisites
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }
        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [{ type: "text", text: "Error: no session file. Start pi with a persistent session to use subagents." }],
            details: { error: "no session file" },
          };
        }
```

Hoist these into a small exported helper near the other small helpers (after `parseSessionMode` / `thinkingToEffort`, ~line 182):

```ts
export function preflightSubagent(ctx: {
  sessionManager: { getSessionFile(): string | null };
}): { content: Array<{ type: "text"; text: string }>; details: { error: string } } | null {
  if (!isMuxAvailable()) {
    return muxUnavailableResult();
  }
  if (!ctx.sessionManager.getSessionFile()) {
    return {
      content: [
        {
          type: "text",
          text: "Error: no session file. Start pi with a persistent session to use subagents.",
        },
      ],
      details: { error: "no session file" },
    };
  }
  return null;
}
```

Then replace the inline block at ~line 1069–1084 with:

```ts
        const preflight = preflightSubagent(ctx);
        if (preflight) return preflight;
```

- [ ] **Step 6: Extract + export a shared `selfSpawnBlocked(agent)` helper**

The bare `subagent` tool today contains an inline `PI_SUBAGENT_AGENT` recursion guard at the top of `subagent.execute` (~line 1053–1067):

```ts
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }
```

This guard prevents `planner` → `planner`, `worker` → `worker`, and similar accidental recursive delegation loops inside subagent contexts. It must apply to `subagent_serial` / `subagent_parallel` too (v5 review finding #1 — orchestration must not silently bypass an existing runtime safety invariant of the bare tool).

Hoist the check into an exported helper near `preflightSubagent`:

```ts
export function selfSpawnBlocked(
  agent: string | undefined,
): { content: Array<{ type: "text"; text: string }>; details: { error: string } } | null {
  const currentAgent = process.env.PI_SUBAGENT_AGENT;
  if (!agent || !currentAgent || agent !== currentAgent) return null;
  return {
    content: [
      {
        type: "text",
        text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
      },
    ],
    details: { error: "self-spawn blocked" },
  };
}
```

Then replace the inline block at ~line 1053–1067 in `subagent.execute` with:

```ts
        const blocked = selfSpawnBlocked(params.agent);
        if (blocked) return blocked;
```

Orchestration handlers (Task 15) will call this same helper per-task and short-circuit the whole call on the first offending task, preserving the existing early-reject behavior.

- [ ] **Step 7: Run the existing suite**

Run: `npm test`
Expected: all green — new exports and the extra `transcriptPath` field are additive; widget start relocation is behavior-preserving; `selfSpawnBlocked` refactor is semantically equivalent to the inline block it replaces.

- [ ] **Step 8: Commit**

```bash
git add pi-extension/subagents/index.ts
git commit -m "refactor(subagent): export primitives, uniform transcriptPath, widget start in launchSubagent, shared preflight + self-spawn helpers"
```

---

## Task 8: Create orchestration types + scaffolding

**Files:**
- Create: `pi-extension/orchestration/types.ts`

- [ ] **Step 1: Write the types file**

```ts
import type { Static, TObject } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";

export const OrchestrationTaskSchema = Type.Object({
  name: Type.Optional(Type.String({ description: "Widget label; auto-generated if omitted." })),
  agent: Type.String({ description: "Agent definition name." }),
  task: Type.String({ description: "Task string; may contain {previous} in serial mode." }),
  cli: Type.Optional(Type.String({ description: "'pi' (default) or 'claude'." })),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  focus: Type.Optional(Type.Boolean()),
  // Note: `interactive` and `permissionMode` are intentionally omitted —
  // `launchSubagent()` does not currently accept them. Add them here only
  // when plumbing all the way through SubagentParams.
});

export type OrchestrationTask = Static<typeof OrchestrationTaskSchema>;

export interface OrchestrationResult {
  name: string;
  finalMessage: string;
  transcriptPath: string | null;
  exitCode: number;
  elapsedMs: number;
  sessionId?: string;
  error?: string;
}

/**
 * Dependencies that orchestration cores need injected, so tests can
 * mock all IO (pane spawning, sentinel waits, transcript reads).
 */
export interface LauncherDeps {
  launch(task: OrchestrationTask, defaultFocus: boolean): Promise<LaunchedHandle>;
  waitForCompletion(handle: LaunchedHandle): Promise<OrchestrationResult>;
}

export interface LaunchedHandle {
  id: string;
  name: string;
  startTime: number;
}

export const MAX_PARALLEL_HARD_CAP = 8;
export const DEFAULT_PARALLEL_CONCURRENCY = 4;
```

(No `DEFAULT_SENTINEL_TIMEOUT_MS` constant is introduced. v4 explicitly deferred a dedicated Claude-plugin timeout; leaving an unused symbol here would risk reintroducing the same doc confusion. If/when a sentinel timeout is actually implemented, the constant can land with its consumer.)

- [ ] **Step 2: Typecheck by running tests**

Run: `npm test`
Expected: still green — types.ts is not imported anywhere yet.

- [ ] **Step 3: Commit**

```bash
git add pi-extension/orchestration/types.ts
git commit -m "feat(orchestration): add shared types + schema for serial/parallel wrappers"
```

---

## Task 9: Write failing tests for `runSerial` (pure async, mocked deps)

**Files:**
- Create: `test/orchestration/run-serial.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSerial } from "../../pi-extension/orchestration/run-serial.ts";
import type { LauncherDeps, OrchestrationTask } from "../../pi-extension/orchestration/types.ts";

function fakeDeps(
  results: Array<{ finalMessage: string; exitCode?: number; transcriptPath?: string }>,
): { deps: LauncherDeps; launchCalls: OrchestrationTask[] } {
  let idx = 0;
  const launchCalls: OrchestrationTask[] = [];
  const deps: LauncherDeps = {
    async launch(task, _defaultFocus) {
      launchCalls.push({ ...task });
      return { id: `id-${idx}`, name: task.name ?? `step-${idx + 1}`, startTime: Date.now() };
    },
    async waitForCompletion(handle) {
      const i = Number(handle.id.replace("id-", ""));
      const r = results[i] ?? { finalMessage: "", exitCode: 0 };
      idx = i + 1;
      return {
        name: handle.name,
        finalMessage: r.finalMessage,
        transcriptPath: r.transcriptPath ?? null,
        exitCode: r.exitCode ?? 0,
        elapsedMs: 1,
      };
    },
  };
  return { deps, launchCalls };
}

describe("runSerial", () => {
  it("runs tasks in order and auto-generates names", async () => {
    const { deps, launchCalls } = fakeDeps([{ finalMessage: "A" }, { finalMessage: "B" }]);
    const out = await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "t2" },
      ],
      {},
      deps,
    );
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].name, "step-1");
    assert.equal(out.results[1].name, "step-2");
    assert.equal(launchCalls[0].task, "t1");
    assert.equal(launchCalls[1].task, "t2");
    assert.equal(out.isError, false);
  });

  it("substitutes {previous} with prior step's finalMessage", async () => {
    const { deps, launchCalls } = fakeDeps([
      { finalMessage: "A RESULT" },
      { finalMessage: "done" },
    ]);
    await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "use {previous} as input" },
      ],
      {},
      deps,
    );
    assert.equal(launchCalls[1].task, "use A RESULT as input");
  });

  it("substitutes {previous} literally — no $-sequence interpretation", async () => {
    // Assistant output can contain $$, $&, $1 etc. Using String.replace as
    // the substitution primitive would interpret these. split/join must not.
    const tricky = "totals: $$200 then $&chunk $1arg";
    const { deps, launchCalls } = fakeDeps([
      { finalMessage: tricky },
      { finalMessage: "done" },
    ]);
    await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "wrap: [{previous}]" },
      ],
      {},
      deps,
    );
    assert.equal(launchCalls[1].task, `wrap: [${tricky}]`);
  });

  it("stops on first failure, reports all prior + failing, no later spawns", async () => {
    const { deps, launchCalls } = fakeDeps([
      { finalMessage: "ok" },
      { finalMessage: "bad", exitCode: 2 },
    ]);
    const out = await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "t2" },
        { agent: "x", task: "t3" },
      ],
      {},
      deps,
    );
    assert.equal(launchCalls.length, 2);
    assert.equal(out.results.length, 2);
    assert.equal(out.results[1].exitCode, 2);
    assert.equal(out.isError, true);
  });

  it("respects explicit names over auto-generated ones", async () => {
    const { deps } = fakeDeps([{ finalMessage: "A" }]);
    const out = await runSerial([{ name: "custom", agent: "x", task: "t" }], {}, deps);
    assert.equal(out.results[0].name, "custom");
  });

  it("defaults focus=true for each task when unspecified", async () => {
    const { deps, launchCalls } = fakeDeps([{ finalMessage: "A" }]);
    // The wrapper calls launch(task, defaultFocus); we peek defaultFocus via a spy
    let sawFocus: boolean | undefined;
    deps.launch = async (task, defaultFocus) => {
      sawFocus = defaultFocus;
      return { id: "id-0", name: task.name ?? "step-1", startTime: Date.now() };
    };
    await runSerial([{ agent: "x", task: "t" }], {}, deps);
    assert.equal(sawFocus, true);
    assert.equal(launchCalls.length, 0);
  });

  it("when deps.launch throws on step N, prior results are preserved and later steps are not spawned", async () => {
    // v4 fix: upstream launchSubagent can throw before a result object exists
    // (mux/surface creation failure, dispatch failure). runSerial must
    // synthesize a failing OrchestrationResult so Task 9/10's "reports
    // completed + failing step" contract holds.
    const launchCalls: string[] = [];
    const deps: LauncherDeps = {
      async launch(task) {
        launchCalls.push(task.task);
        if (task.task === "t2") throw new Error("surface creation failed");
        return { id: task.task, name: task.name ?? "step", startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return {
          name: handle.name,
          finalMessage: "ok",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 1,
        };
      },
    };
    const out = await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "t2" },
        { agent: "x", task: "t3" },
      ],
      {},
      deps,
    );
    assert.deepEqual(launchCalls, ["t1", "t2"]);
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].exitCode, 0);
    assert.equal(out.results[1].exitCode, 1);
    assert.match(out.results[1].error ?? "", /surface creation failed/);
    assert.equal(out.isError, true);
  });

  it("when deps.waitForCompletion throws, the throwing step is recorded as a failure and the run stops", async () => {
    // v4 fix: watchSubagent can throw (abort, IO failure) after launch
    // succeeds. The failing step must still appear in results.
    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.task, name: task.name ?? "step", startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        if (handle.name === "step-2") throw new Error("watch IO failed");
        return {
          name: handle.name,
          finalMessage: "ok",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 1,
        };
      },
    };
    const out = await runSerial(
      [
        { agent: "x", task: "t1" },
        { agent: "x", task: "t2" },
        { agent: "x", task: "t3" },
      ],
      {},
      deps,
    );
    assert.equal(out.results.length, 2);
    assert.equal(out.results[1].exitCode, 1);
    assert.match(out.results[1].error ?? "", /watch IO failed/);
    assert.equal(out.isError, true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/orchestration/run-serial.test.ts`
Expected: FAIL — `Cannot find module '../../pi-extension/orchestration/run-serial.ts'`.

---

## Task 10: Implement `runSerial`

**Files:**
- Create: `pi-extension/orchestration/run-serial.ts`

- [ ] **Step 1: Write the minimal implementation**

```ts
import type {
  LauncherDeps,
  OrchestrationResult,
  OrchestrationTask,
} from "./types.ts";

export interface RunSerialOpts {
  // reserved for future: abort signal, timeout, etc.
}

export interface RunSerialOutput {
  results: OrchestrationResult[];
  isError: boolean;
}

export async function runSerial(
  tasks: OrchestrationTask[],
  _opts: RunSerialOpts,
  deps: LauncherDeps,
): Promise<RunSerialOutput> {
  const results: OrchestrationResult[] = [];
  let previous = "";

  for (let i = 0; i < tasks.length; i++) {
    const raw = tasks[i];
    const task: OrchestrationTask = {
      ...raw,
      name: raw.name ?? `step-${i + 1}`,
      // split/join inserts `previous` literally. `String.replace` would
      // interpret `$$`, `$&`, `$1`, ... in the assistant's output.
      task: raw.task.split("{previous}").join(previous),
    };

    // Normalize thrown errors from deps.launch / deps.waitForCompletion
    // into a synthetic failing OrchestrationResult. Without this, an upstream
    // throw (e.g. mux/surface creation failure) would reject this promise and
    // discard all prior results, breaking the "prior + failing step" contract.
    const startedAt = Date.now();
    let result: OrchestrationResult;
    try {
      const handle = await deps.launch(task, true /* defaultFocus */);
      result = await deps.waitForCompletion(handle);
    } catch (err: any) {
      result = {
        name: task.name!,
        finalMessage: "",
        transcriptPath: null,
        exitCode: 1,
        elapsedMs: Date.now() - startedAt,
        error: err?.message ?? String(err),
      };
    }
    results.push(result);

    if (result.exitCode !== 0 || result.error) {
      return { results, isError: true };
    }
    previous = result.finalMessage;
  }

  return { results, isError: false };
}
```

- [ ] **Step 2: Run tests**

Run: `node --test test/orchestration/run-serial.test.ts`
Expected: PASS, 7 tests (5 from v3 + 2 v4 throw-path tests).

- [ ] **Step 3: Commit**

```bash
git add pi-extension/orchestration/run-serial.ts test/orchestration/run-serial.test.ts
git commit -m "feat(orchestration): pure runSerial with {previous} substitution + stop-on-error"
```

---

## Task 11: Write failing tests for `runParallel`

**Files:**
- Create: `test/orchestration/run-parallel.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runParallel } from "../../pi-extension/orchestration/run-parallel.ts";
import type { LauncherDeps, OrchestrationTask } from "../../pi-extension/orchestration/types.ts";
import { MAX_PARALLEL_HARD_CAP } from "../../pi-extension/orchestration/types.ts";

interface Spy {
  deps: LauncherDeps;
  maxInFlight: number;
  launchOrder: string[];
}

function spyDeps(
  results: Record<string, { finalMessage: string; exitCode?: number; delayMs?: number }>,
): Spy {
  let inFlight = 0;
  let maxInFlight = 0;
  const launchOrder: string[] = [];

  const deps: LauncherDeps = {
    async launch(task) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      launchOrder.push(task.name!);
      return { id: task.name!, name: task.name!, startTime: Date.now() };
    },
    async waitForCompletion(handle) {
      const r = results[handle.name] ?? { finalMessage: "" };
      await new Promise((res) => setTimeout(res, r.delayMs ?? 5));
      inFlight--;
      return {
        name: handle.name,
        finalMessage: r.finalMessage,
        transcriptPath: null,
        exitCode: r.exitCode ?? 0,
        elapsedMs: 1,
      };
    },
  };
  return { deps, maxInFlight, launchOrder } as any; // maxInFlight read through closure
}

describe("runParallel", () => {
  it("respects maxConcurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const deps: LauncherDeps = {
      async launch(task) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return {
          name: handle.name,
          finalMessage: "ok",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 1,
        };
      },
    };

    const tasks: OrchestrationTask[] = Array.from({ length: 6 }, (_, i) => ({
      name: `t${i}`,
      agent: "x",
      task: "t",
    }));
    const out = await runParallel(tasks, { maxConcurrency: 2 }, deps);
    assert.equal(peak, 2);
    assert.equal(out.results.length, 6);
  });

  it("aggregates results in INPUT order regardless of completion order", async () => {
    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        const delay = handle.name === "fast" ? 1 : 30;
        await new Promise((r) => setTimeout(r, delay));
        return {
          name: handle.name,
          finalMessage: handle.name,
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: delay,
        };
      },
    };
    const out = await runParallel(
      [
        { name: "slow", agent: "x", task: "t" },
        { name: "fast", agent: "x", task: "t" },
      ],
      { maxConcurrency: 4 },
      deps,
    );
    assert.equal(out.results[0].name, "slow");
    assert.equal(out.results[1].name, "fast");
  });

  it("partial failure does not cancel siblings; isError=true reported", async () => {
    const deps: LauncherDeps = {
      async launch(task) {
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return {
          name: handle.name,
          finalMessage: "x",
          transcriptPath: null,
          exitCode: handle.name === "bad" ? 1 : 0,
          elapsedMs: 1,
        };
      },
    };
    const out = await runParallel(
      [
        { name: "ok1", agent: "x", task: "t" },
        { name: "bad", agent: "x", task: "t" },
        { name: "ok2", agent: "x", task: "t" },
      ],
      {},
      deps,
    );
    assert.equal(out.results.length, 3);
    assert.equal(out.isError, true);
    assert.equal(out.results[0].exitCode, 0);
    assert.equal(out.results[1].exitCode, 1);
    assert.equal(out.results[2].exitCode, 0);
  });

  it("rejects maxConcurrency above hard cap", async () => {
    const deps: LauncherDeps = {
      async launch() { throw new Error("should not launch"); },
      async waitForCompletion() { throw new Error("should not wait"); },
    };
    await assert.rejects(
      runParallel(
        [{ name: "t", agent: "x", task: "t" }],
        { maxConcurrency: MAX_PARALLEL_HARD_CAP + 1 },
        deps,
      ),
      /hard cap/,
    );
  });

  it("defaults maxConcurrency=4 when omitted", async () => {
    let peak = 0;
    let inFlight = 0;
    const deps: LauncherDeps = {
      async launch(task) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return {
          name: handle.name,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 1,
        };
      },
    };
    const tasks: OrchestrationTask[] = Array.from({ length: 8 }, (_, i) => ({
      name: `t${i}`,
      agent: "x",
      task: "t",
    }));
    await runParallel(tasks, {}, deps);
    assert.equal(peak, 4);
  });

  it("passes defaultFocus=false to launcher", async () => {
    let sawFocus: boolean | undefined;
    const deps: LauncherDeps = {
      async launch(task, defaultFocus) {
        sawFocus = defaultFocus;
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return {
          name: handle.name,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 1,
        };
      },
    };
    await runParallel([{ name: "t", agent: "x", task: "t" }], {}, deps);
    assert.equal(sawFocus, false);
  });

  it("one task throwing does not cancel siblings; failing task appears at its input index", async () => {
    // v4 fix: a thrown error from deps.launch or deps.waitForCompletion for
    // one worker must not reject Promise.all for the whole run. Siblings
    // continue and the aggregated result includes the synthetic failure in
    // INPUT order.
    const deps: LauncherDeps = {
      async launch(task) {
        if (task.name === "boom-launch") throw new Error("surface creation failed");
        return { id: task.name!, name: task.name!, startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        if (handle.name === "boom-wait") throw new Error("watch IO failed");
        await new Promise((r) => setTimeout(r, 5));
        return {
          name: handle.name,
          finalMessage: handle.name,
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: 1,
        };
      },
    };
    const out = await runParallel(
      [
        { name: "ok1", agent: "x", task: "t" },
        { name: "boom-launch", agent: "x", task: "t" },
        { name: "boom-wait", agent: "x", task: "t" },
        { name: "ok2", agent: "x", task: "t" },
      ],
      { maxConcurrency: 4 },
      deps,
    );
    assert.equal(out.results.length, 4);
    assert.equal(out.isError, true);
    assert.equal(out.results[0].name, "ok1");
    assert.equal(out.results[0].exitCode, 0);
    assert.equal(out.results[1].name, "boom-launch");
    assert.equal(out.results[1].exitCode, 1);
    assert.match(out.results[1].error ?? "", /surface creation failed/);
    assert.equal(out.results[2].name, "boom-wait");
    assert.equal(out.results[2].exitCode, 1);
    assert.match(out.results[2].error ?? "", /watch IO failed/);
    assert.equal(out.results[3].name, "ok2");
    assert.equal(out.results[3].exitCode, 0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/orchestration/run-parallel.test.ts`
Expected: FAIL — module not found.

---

## Task 12: Implement `runParallel`

**Files:**
- Create: `pi-extension/orchestration/run-parallel.ts`

- [ ] **Step 1: Write the implementation**

```ts
import {
  DEFAULT_PARALLEL_CONCURRENCY,
  MAX_PARALLEL_HARD_CAP,
  type LauncherDeps,
  type OrchestrationResult,
  type OrchestrationTask,
} from "./types.ts";

export interface RunParallelOpts {
  maxConcurrency?: number;
}

export interface RunParallelOutput {
  results: OrchestrationResult[];
  isError: boolean;
}

export async function runParallel(
  tasks: OrchestrationTask[],
  opts: RunParallelOpts,
  deps: LauncherDeps,
): Promise<RunParallelOutput> {
  const cap = opts.maxConcurrency ?? DEFAULT_PARALLEL_CONCURRENCY;
  if (cap > MAX_PARALLEL_HARD_CAP) {
    throw new Error(
      `subagent_parallel: maxConcurrency=${cap} exceeds hard cap ${MAX_PARALLEL_HARD_CAP}. Split into sub-waves.`,
    );
  }
  if (cap < 1) {
    throw new Error(`subagent_parallel: maxConcurrency=${cap} must be >= 1.`);
  }

  const results: OrchestrationResult[] = new Array(tasks.length);
  let nextIdx = 0;
  let isError = false;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIdx++;
      if (i >= tasks.length) return;
      const raw = tasks[i];
      const task: OrchestrationTask = {
        ...raw,
        name: raw.name ?? `task-${i + 1}`,
      };
      // Normalize thrown errors into a synthetic failing result so one
      // worker's throw does not reject Promise.all and cancel siblings.
      // The failing result is placed at the task's INPUT index so the
      // aggregated array remains input-ordered.
      const startedAt = Date.now();
      let result: OrchestrationResult;
      try {
        const handle = await deps.launch(task, false /* defaultFocus */);
        result = await deps.waitForCompletion(handle);
      } catch (err: any) {
        result = {
          name: task.name!,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 1,
          elapsedMs: Date.now() - startedAt,
          error: err?.message ?? String(err),
        };
      }
      results[i] = result;
      if (result.exitCode !== 0 || result.error) {
        isError = true;
      }
    }
  }

  const workers = Array.from({ length: Math.min(cap, tasks.length) }, () => worker());
  await Promise.all(workers);

  return { results, isError };
}
```

- [ ] **Step 2: Run tests**

Run: `node --test test/orchestration/run-parallel.test.ts`
Expected: PASS, 7 tests (6 from v3 + 1 v4 throw-path test).

- [ ] **Step 3: Commit**

```bash
git add pi-extension/orchestration/run-parallel.ts test/orchestration/run-parallel.test.ts
git commit -m "feat(orchestration): pure runParallel with concurrency cap + input-order aggregation"
```

---

## Task 13: Build the default `LauncherDeps` bound to real `launchSubagent`

**Files:**
- Create: `pi-extension/orchestration/default-deps.ts`

- [ ] **Step 1: Write the glue that composes `launchSubagent` + `watchSubagent` into `LauncherDeps`**

```ts
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  launchSubagent,
  watchSubagent,
  type RunningSubagent,
} from "../subagents/index.ts";
import type {
  LauncherDeps,
  LaunchedHandle,
  OrchestrationResult,
  OrchestrationTask,
} from "./types.ts";

/**
 * Build a LauncherDeps bound to the active session context.
 *
 * Completion path:
 *   launch = launchSubagent (widget registration + widget-refresh start
 *            + surface creation, all owned by the upstream primitive).
 *   waitForCompletion = watchSubagent (polling, widget updates, pane
 *            cleanup). The SubagentResult returned by watchSubagent now
 *            carries a uniform transcriptPath populated BEFORE cleanup
 *            in both the pi branch (sessionFile) and Claude branch
 *            (archived jsonl under ~/.pi/agent/sessions/claude-code/).
 *
 * No readTranscript layer — the v3 upstream patch made that helper
 * redundant. The transcriptPath on SubagentResult is the single source
 * of truth.
 *
 * Deferred (intentionally NOT plumbed here):
 *   - `caller_ping` surfacing — treated as a regular error for now;
 *     a future revision can add an explicit `ping` field on
 *     OrchestrationResult if the wrappers need to differentiate.
 *   - Propagating the tool-execution AbortSignal into the running
 *     subagent's wait — orchestration wrappers construct a local
 *     AbortController today; tying it to the tool signal is future work.
 */
export function makeDefaultDeps(ctx: {
  sessionManager: ExtensionContext["sessionManager"];
  cwd: string;
}): LauncherDeps {
  const handleToRunning = new Map<string, RunningSubagent>();

  return {
    async launch(task: OrchestrationTask, defaultFocus: boolean): Promise<LaunchedHandle> {
      const resolvedFocus = task.focus ?? defaultFocus;
      const running = await launchSubagent(
        {
          name: task.name ?? "subagent",
          task: task.task,
          agent: task.agent,
          model: task.model,
          thinking: task.thinking,
          cwd: task.cwd,
          cli: task.cli,
          focus: resolvedFocus,
        },
        ctx,
      );
      handleToRunning.set(running.id, running);
      return { id: running.id, name: running.name, startTime: running.startTime };
    },
    async waitForCompletion(handle: LaunchedHandle): Promise<OrchestrationResult> {
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
      const sub = await watchSubagent(running, abort.signal);
      handleToRunning.delete(handle.id);
      return {
        name: handle.name,
        finalMessage: sub.summary,
        transcriptPath: sub.transcriptPath,
        exitCode: sub.exitCode,
        elapsedMs: sub.elapsed * 1000,
        sessionId: sub.claudeSessionId,
        error: sub.error,
      };
    },
  };
}
```

- [ ] **Step 2: Add a focused test covering the `transcriptPath: null` failure passthrough**

**File:** Create `test/orchestration/default-deps.test.ts`.

Goal: prove that when `watchSubagent` returns a failure `SubagentResult` with `transcriptPath: null` (the contract enforced in Task 7 Step 3's catch block), `makeDefaultDeps.waitForCompletion` surfaces `null` — **not** `undefined` — on the `OrchestrationResult`. This guards against regressions where a future optional-field relaxation would let `undefined` leak through.

Rather than standing up real panes, the test uses the "unknown handle" branch in `waitForCompletion` to exercise the same mapping code path, and then a tiny direct shape test confirms the contract on the Claude/pi error return.

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDefaultDeps } from "../../pi-extension/orchestration/default-deps.ts";

describe("makeDefaultDeps.waitForCompletion", () => {
  it("returns transcriptPath: null (not undefined) when the handle is unknown", async () => {
    const deps = makeDefaultDeps({
      sessionManager: { getSessionFile: () => null } as any,
      cwd: process.cwd(),
    });
    const result = await deps.waitForCompletion({
      id: "does-not-exist",
      name: "ghost",
      startTime: Date.now(),
    });
    assert.equal(result.transcriptPath, null);
    assert.notEqual(result.transcriptPath, undefined);
    assert.equal(result.exitCode, 1);
    assert.ok(result.error);
  });
});
```

If a follow-up test needs to exercise the real `watchSubagent` error path (cancelled / poll error), use a module-level mock of `../subagents/index.ts` to stub `watchSubagent` — the handle-unknown branch above is sufficient for the contract check and avoids that complexity here.

- [ ] **Step 3: Typecheck by running full suite**

Run: `npm test`
Expected: all green (new test passes; default-deps.ts is otherwise not imported yet — it compiles via this test and then via tool-handlers after Task 16).

- [ ] **Step 4: Commit**

```bash
git add pi-extension/orchestration/default-deps.ts test/orchestration/default-deps.test.ts
git commit -m "feat(orchestration): default-deps bind LauncherDeps to real launchSubagent/watchSubagent"
```

---

## Task 14: Write failing test for `registerOrchestrationTools` tool surface

**Files:**
- Create: `test/orchestration/tool-handlers.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerOrchestrationTools } from "../../pi-extension/orchestration/tool-handlers.ts";
import type { LauncherDeps } from "../../pi-extension/orchestration/types.ts";

function createMockApi() {
  const tools: any[] = [];
  return {
    tools,
    api: {
      registerTool(tool: any) { tools.push(tool); },
      on() {},
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      sendUserMessage() {},
    } as any,
  };
}

const noopDeps: LauncherDeps = {
  async launch(task) {
    return { id: "x", name: task.name ?? "step", startTime: Date.now() };
  },
  async waitForCompletion(handle) {
    return {
      name: handle.name,
      finalMessage: "ok",
      transcriptPath: null,
      exitCode: 0,
      elapsedMs: 1,
    };
  },
};

describe("registerOrchestrationTools", () => {
  it("registers both tools when shouldRegister returns true for both", () => {
    const { api, tools } = createMockApi();
    registerOrchestrationTools(api, () => noopDeps, () => true);
    const names = tools.map((t) => t.name);
    assert.deepEqual(names.sort(), ["subagent_parallel", "subagent_serial"]);
  });

  it("registers only subagent_serial when subagent_parallel is denied", () => {
    const { api, tools } = createMockApi();
    registerOrchestrationTools(
      api,
      () => noopDeps,
      (name) => name === "subagent_serial",
    );
    const names = tools.map((t) => t.name);
    assert.deepEqual(names, ["subagent_serial"]);
  });

  it("registers only subagent_parallel when subagent_serial is denied", () => {
    const { api, tools } = createMockApi();
    registerOrchestrationTools(
      api,
      () => noopDeps,
      (name) => name === "subagent_parallel",
    );
    const names = tools.map((t) => t.name);
    assert.deepEqual(names, ["subagent_parallel"]);
  });

  it("registers nothing when shouldRegister rejects both", () => {
    const { api, tools } = createMockApi();
    registerOrchestrationTools(api, () => noopDeps, () => false);
    assert.deepEqual(tools, []);
  });

  it("subagent_serial.execute invokes runSerial and returns aggregated result", async () => {
    const { api, tools } = createMockApi();
    registerOrchestrationTools(api, () => noopDeps, () => true);
    const serial = tools.find((t) => t.name === "subagent_serial");
    const out = await serial.execute(
      "call-1",
      { tasks: [{ agent: "x", task: "t1" }, { agent: "x", task: "t2" }] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    const details = out.details;
    assert.equal(details.results.length, 2);
    assert.equal(details.isError, false);
  });

  it("subagent_parallel rejects maxConcurrency > 8 with a readable message", async () => {
    const { api, tools } = createMockApi();
    registerOrchestrationTools(api, () => noopDeps, () => true);
    const parallel = tools.find((t) => t.name === "subagent_parallel");
    const out = await parallel.execute(
      "call-2",
      { tasks: [{ agent: "x", task: "t" }], maxConcurrency: 12 },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.match(out.content[0].text, /hard cap/);
    assert.equal(out.details.error, "maxConcurrency exceeds hard cap");
  });

  it("subagent_serial short-circuits with the shared preflight error when the ctx rejects", async () => {
    // The mock `noopDeps` launch/wait would otherwise succeed; the handler
    // must call the injected preflight helper BEFORE building deps.
    const { api, tools } = createMockApi();
    // Inject a preflight that always returns a "no session file" error.
    const denyingPreflight = () => ({
      content: [{ type: "text" as const, text: "Error: no session file. Start pi with a persistent session to use subagents." }],
      details: { error: "no session file" },
    });
    registerOrchestrationTools(api, () => noopDeps, () => true, denyingPreflight);
    const serial = tools.find((t) => t.name === "subagent_serial");
    const out = await serial.execute(
      "call-3",
      { tasks: [{ agent: "x", task: "t" }] },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.match(out.content[0].text, /no session file/);
    assert.equal(out.details.error, "no session file");
  });

  it("subagent_serial short-circuits with self-spawn-blocked when ANY task targets the current agent", async () => {
    // v5 review finding #1: the bare `subagent` tool already rejects when
    // params.agent === PI_SUBAGENT_AGENT; orchestration must match that
    // existing runtime invariant for `subagent_serial` / `subagent_parallel`
    // (a `planner` session cannot launch another `planner` via the wrappers).
    //
    // The registrar accepts an injected `selfSpawn` check so this test
    // doesn't need to manipulate process.env. Inject a check that blocks
    // agent name "planner"; verify a mixed task list with one "planner"
    // entry is rejected whole (no deps.launch calls, error shape matches
    // the bare tool).
    let launched = 0;
    const countingDeps: LauncherDeps = {
      async launch(task) {
        launched++;
        return { id: "x", name: task.name ?? "step", startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return { name: handle.name, finalMessage: "ok", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
      },
    };
    const denyingSelfSpawn = (agent: string | undefined) =>
      agent === "planner"
        ? {
            content: [
              {
                type: "text" as const,
                text: `You are the planner agent — do not start another planner. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          }
        : null;

    const { api, tools } = createMockApi();
    registerOrchestrationTools(
      api,
      () => countingDeps,
      () => true,
      () => null, // preflight: pass
      denyingSelfSpawn,
    );
    const serial = tools.find((t) => t.name === "subagent_serial");
    const out = await serial.execute(
      "call-4",
      {
        tasks: [
          { agent: "scout", task: "t1" },
          { agent: "planner", task: "t2" }, // offending task
          { agent: "worker", task: "t3" },
        ],
      },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.equal(launched, 0, "no task should be launched when any task is self-spawn-blocked");
    assert.match(out.content[0].text, /planner agent/);
    assert.equal(out.details.error, "self-spawn blocked");
  });

  it("subagent_parallel short-circuits with self-spawn-blocked when ANY task targets the current agent", async () => {
    let launched = 0;
    const countingDeps: LauncherDeps = {
      async launch(task) {
        launched++;
        return { id: "x", name: task.name ?? "step", startTime: Date.now() };
      },
      async waitForCompletion(handle) {
        return { name: handle.name, finalMessage: "ok", transcriptPath: null, exitCode: 0, elapsedMs: 1 };
      },
    };
    const denyingSelfSpawn = (agent: string | undefined) =>
      agent === "worker"
        ? {
            content: [
              {
                type: "text" as const,
                text: `You are the worker agent — do not start another worker. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          }
        : null;

    const { api, tools } = createMockApi();
    registerOrchestrationTools(
      api,
      () => countingDeps,
      () => true,
      () => null,
      denyingSelfSpawn,
    );
    const parallel = tools.find((t) => t.name === "subagent_parallel");
    const out = await parallel.execute(
      "call-5",
      {
        tasks: [
          { agent: "scout", task: "t1" },
          { agent: "worker", task: "t2" },
        ],
      },
      new AbortController().signal,
      () => {},
      { sessionManager: {} as any, cwd: "/tmp" },
    );
    assert.equal(launched, 0);
    assert.match(out.content[0].text, /worker agent/);
    assert.equal(out.details.error, "self-spawn blocked");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/orchestration/tool-handlers.test.ts`
Expected: FAIL — module not found.

---

## Task 15: Implement `tool-handlers.ts`

**Files:**
- Create: `pi-extension/orchestration/tool-handlers.ts`

- [ ] **Step 1: Write the implementation**

The registrar accepts two optional injections so tests can exercise the early-return paths without standing up a real session or manipulating `process.env`:

- `preflight` — mux / session-file validation. Production code passes `preflightSubagent` (Task 7 Step 5).
- `selfSpawn` — per-task `PI_SUBAGENT_AGENT` recursion check. Production code passes `selfSpawnBlocked` (Task 7 Step 6). The handler iterates `params.tasks` and returns the first blocking result; no task is launched if any task is blocked (matches the bare `subagent` tool's early-reject behavior — v5 review finding #1).

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runSerial } from "./run-serial.ts";
import { runParallel } from "./run-parallel.ts";
import { OrchestrationTaskSchema, type LauncherDeps } from "./types.ts";

const SerialParams = Type.Object({
  tasks: Type.Array(OrchestrationTaskSchema),
});

const ParallelParams = Type.Object({
  tasks: Type.Array(OrchestrationTaskSchema),
  maxConcurrency: Type.Optional(Type.Number()),
});

type ErrorResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { error: string };
};

export type PreflightFn = (ctx: {
  sessionManager: { getSessionFile(): string | null };
}) => ErrorResult | null;

export type SelfSpawnCheckFn = (agent: string | undefined) => ErrorResult | null;

export function registerOrchestrationTools(
  pi: ExtensionAPI,
  depsFactory: (ctx: { sessionManager: any; cwd: string }) => LauncherDeps,
  shouldRegister: (name: string) => boolean,
  preflight: PreflightFn = () => null,
  selfSpawn: SelfSpawnCheckFn = () => null,
) {
  if (shouldRegister("subagent_serial")) {
    pi.registerTool({
      name: "subagent_serial",
      label: "Serial Subagents",
      description:
        "Run a sequence of subagent tasks in order. Each task's output is available to the next " +
        "as `{previous}`. Stops on first failure. Blocks the caller until the full sequence " +
        "completes (or errors). Use for pipelines where step N depends on step N-1.",
      promptSnippet:
        "Run a sequence of subagent tasks in order. Each task's output is available to the next " +
        "as `{previous}`. Stops on first failure. Blocks until the sequence completes.",
      parameters: SerialParams,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        for (const task of params.tasks) {
          const blocked = selfSpawn(task.agent);
          if (blocked) return blocked;
        }
        const gate = preflight(ctx);
        if (gate) return gate;
        const deps = depsFactory(ctx);
        try {
          const out = await runSerial(params.tasks, {}, deps);
          return {
            content: [
              {
                type: "text",
                text: summarize("serial", out.results, out.isError),
              },
            ],
            details: out,
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `subagent_serial error: ${err?.message ?? String(err)}` }],
            details: { error: err?.message ?? String(err) },
          };
        }
      },
    });
  }

  if (shouldRegister("subagent_parallel")) {
    pi.registerTool({
      name: "subagent_parallel",
      label: "Parallel Subagents",
      description:
        "Run a batch of subagent tasks concurrently (default 4, hard cap 8). Blocks until all " +
        "tasks complete. Partial failures don't cancel siblings; each result is reported. " +
        "Panes are spawned detached by default on tmux; other mux backends (cmux, zellij, " +
        "wezterm) currently focus the new pane regardless — use the widget or native mux " +
        "shortcuts to navigate. Per-task `focus: true` overrides on any backend.",
      promptSnippet:
        "Run a batch of subagent tasks concurrently (default 4, hard cap 8). Blocks until all " +
        "tasks complete. Partial failures are reported independently. Detached spawn is " +
        "tmux-only; other backends focus the new pane.",
      parameters: ParallelParams,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        for (const task of params.tasks) {
          const blocked = selfSpawn(task.agent);
          if (blocked) return blocked;
        }
        const gate = preflight(ctx);
        if (gate) return gate;
        const deps = depsFactory(ctx);
        try {
          const out = await runParallel(
            params.tasks,
            { maxConcurrency: params.maxConcurrency },
            deps,
          );
          return {
            content: [
              {
                type: "text",
                text: summarize("parallel", out.results, out.isError),
              },
            ],
            details: out,
          };
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          const hint = msg.includes("hard cap")
            ? msg
            : `subagent_parallel error: ${msg}`;
          return {
            content: [{ type: "text", text: hint }],
            details: {
              error: msg.includes("hard cap") ? "maxConcurrency exceeds hard cap" : msg,
            },
          };
        }
      },
    });
  }
}

function summarize(mode: "serial" | "parallel", results: any[], isError: boolean): string {
  const lines = [`${mode} orchestration: ${results.length} task(s), isError=${isError}`];
  for (const r of results) {
    lines.push(`- ${r.name}: exit=${r.exitCode} (${r.elapsedMs}ms) — ${firstLine(r.finalMessage)}`);
  }
  return lines.join("\n");
}

function firstLine(s: string): string {
  const line = (s ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > 200 ? line.slice(0, 200) + "…" : line;
}
```

- [ ] **Step 2: Run tests**

Run: `node --test test/orchestration/tool-handlers.test.ts`
Expected: PASS, 9 tests (7 from v5 + 2 v6 self-spawn tests for serial + parallel).

- [ ] **Step 3: Commit**

```bash
git add pi-extension/orchestration/tool-handlers.ts test/orchestration/tool-handlers.test.ts
git commit -m "feat(orchestration): register subagent_serial + subagent_parallel tools with preflight + self-spawn guard"
```

---

## Task 16: Wire orchestration tools into the extension default export

**Files:**
- Modify: `pi-extension/subagents/index.ts`

- [ ] **Step 1: Import the registrar and call it from `subagentsExtension`**

At the top of `index.ts`, alongside other imports, add:

```ts
import { registerOrchestrationTools } from "../orchestration/tool-handlers.ts";
import { makeDefaultDeps } from "../orchestration/default-deps.ts";
```

Inside `export default function subagentsExtension(pi: ExtensionAPI) { ... }`, at the end of the body (just before the final closing `}` at line 1688), add:

```ts
  // ── Orchestration tools (our additions) ──
  // Pass shouldRegister through so per-tool deny entries in settings.json
  // (e.g. disabling subagent_parallel alone) gate each tool independently.
  // Pass preflightSubagent so orchestration execute handlers surface the
  // same mux/session-file errors as the bare subagent tool.
  // Pass selfSpawnBlocked so orchestration handlers enforce the same
  // PI_SUBAGENT_AGENT recursion guard as the bare subagent tool
  // (v5 review finding #1 — no silent bypass of the existing runtime
  // invariant).
  registerOrchestrationTools(
    pi,
    (ctx) => makeDefaultDeps(ctx),
    shouldRegister,
    preflightSubagent,
    selfSpawnBlocked,
  );
```

Also, extend the `SPAWNING_TOOLS` set at line 126 to include the new orchestrators (they should inherit the `spawning: false` gating):

```ts
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagents_list",
  "subagent_resume",
  "subagent_serial",
  "subagent_parallel",
]);
```

- [ ] **Step 2: Run full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add pi-extension/subagents/index.ts
git commit -m "feat(extension): register orchestration tools via subagentsExtension default export"
```

---

## Task 17: Add the Claude sentinel integration-test scaffold (skip-gated, no real harness yet)

**Files:**
- Create: `test/integration/claude-sentinel-roundtrip.test.ts`

> **Honest framing (v4):** this task does **not** add automated end-to-end coverage of the Claude Stop-hook → transcript-archive flow. It only stands up a skip-gated test file so `npm run test:integration` keeps working on fresh checkouts, documents the prerequisites for a future real harness, and anchors the review's "finding 1" transcript-path assertions in code comments near where they would eventually execute. The authoritative verification path until that harness exists is the manual smoke checklist in Task 18.

- [ ] **Step 1: Write a skip-gated scaffold (not a roundtrip assertion)**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

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

// NOTE (v4): this is a SCAFFOLD, not a roundtrip test. It exists so the
// integration test-runner has something to discover on fresh checkouts and
// so the skip condition for a future real harness is already wired. The
// actual Claude Stop-hook → archived-transcript verification is run
// manually via the README "Manual smoke test" checklist; when an automated
// harness is added, it will live inside the `it()` body below and assert:
//   - SubagentResult.transcriptPath is non-null and under
//     ~/.pi/agent/sessions/claude-code/
//   - existsSync(transcriptPath) === true after sentinel cleanup
describe("claude sentinel scaffold (local only)", { skip: !CLAUDE_AVAILABLE || !PLUGIN_PRESENT }, () => {
  it("scaffold present; real roundtrip harness is future work (see README smoke test)", () => {
    assert.ok(true);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:integration`
Expected: existing HazAT integration tests run; new scaffold skips on machines without `claude` + plugin, otherwise no-ops (and that no-op is explicitly not an end-to-end assertion — see comment in the file).

- [ ] **Step 3: Commit**

```bash
git add test/integration/claude-sentinel-roundtrip.test.ts
git commit -m "test(integration): scaffold skip-gated claude sentinel file (real harness deferred)"
```

---

## Task 18: README updates — intro correction + tool docs + existing-section touch-ups + plugin install + smoke checklist

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Correct the intro's "Fully non-blocking" claim**

The existing upstream intro advertises the extension as "**Fully non-blocking**", which was accurate when only `subagent` / `subagent_resume` existed. This fork adds blocking orchestration wrappers, so that sentence is no longer true as stated.

Locate the intro line (in the upstream README, the bullet reading roughly `- **Fully non-blocking** — ...`) and replace it with a mixed-mode description, e.g.:

```markdown
- **Mixed-mode execution** — the bare `subagent` / `subagent_resume` tools are non-blocking (they return immediately after spawning the pane); the new `subagent_serial` / `subagent_parallel` orchestration tools block the caller until all tasks in the batch complete.
```

(If the upstream intro phrases this differently, preserve its voice but make the claim match this fork's actual behavior.)

- [ ] **Step 2: Update existing tool-gating / deny / parameter-reference sections**

Several existing README sections enumerate tool names or parameter fields and fall out of date with the two new tools and the three new per-call fields. Touch them up so they reflect this plan's surface:

1. **`spawning: false` tool allowlist paragraph.** The upstream copy lists which tools require a mux surface. Extend the list to include `subagent_serial` and `subagent_parallel` (both go through `launchSubagent`, so they inherit the same `spawning` gate — this matches the `SPAWNING_TOOLS` set extension in Task 16 Step 1).

2. **`deny-tools` examples.** If the README shows example settings for denying individual subagent tools, add an example line that denies `subagent_parallel` alone (demonstrating the per-tool gate wired via `shouldRegister` in Tasks 7 / 15 / 16).

3. **Parameter / agent-frontmatter reference.** The README has two distinct reference surfaces — the per-call **tool parameter** reference and the **agent-frontmatter** reference. These three new fields split across them differently, so do not fold them into a single table:

   **Tool parameters only** (all three are per-call `SubagentParams` fields):
   - `cli` — `'pi' | 'claude'`, overrides agent frontmatter.
   - `thinking` — `off | minimal | low | medium | high | xhigh`; pi folds into `<model>:<thinking>`, Claude maps via `thinkingToEffort` to `--effort`.
   - `focus` — boolean, default `true`, honored on tmux only (see the backend-support note in Step 3's `subagent_parallel` block below).

   **Agent frontmatter also** (these two are parsed from agent definition frontmatter today, so add them to the frontmatter reference in addition to the parameter reference):
   - `cli`
   - `thinking`

   `focus` is **not** parsed from frontmatter — do not add it to the frontmatter reference.

If any of these sections don't exist in the upstream README, skip the corresponding bullet — do not invent a new section just to carry the field. The point is to keep existing references consistent, not to expand docs.

- [ ] **Step 3: Add a "New tools" section near the existing `subagent` tool reference**

Append (or insert in the appropriate location in the existing README) the following section:

````markdown
## Orchestration tools (fork additions)

### `subagent_serial`

Run subagent tasks sequentially. Each task may reference the previous task's final message via the `{previous}` placeholder.

```json
{
  "tasks": [
    { "name": "research", "agent": "scout", "task": "Summarize the auth flow" },
    { "name": "plan",     "agent": "planner", "task": "Given {previous}, write a migration plan" }
  ]
}
```

- Blocks until the sequence completes (or errors).
- Stops on the first non-zero exit; remaining tasks are not spawned. Prior step results (including the failing step) are still returned with `isError: true`.
- If `launch` or the completion wait throws on a step, the failure is recorded as a synthetic result at that step's position — prior results are preserved and later steps are not spawned.
- Returns `{ results: [...], isError }` with one entry per completed step.
- Default `focus` = `true` for each task (panes grab focus as they spawn, on tmux).

### `subagent_parallel`

Run subagent tasks concurrently with a cap.

```json
{
  "tasks": [
    { "name": "t1", "agent": "worker", "task": "Do thing A" },
    { "name": "t2", "agent": "worker", "task": "Do thing B" },
    { "name": "t3", "agent": "worker", "task": "Do thing C" }
  ],
  "maxConcurrency": 4
}
```

- Blocks until **all** tasks in the batch complete (success or failure).
- Default `maxConcurrency` = 4, hard cap 8 (call is rejected above the cap).
- Partial failures don't cancel siblings; each task's result is reported independently at its input index. A thrown error from one task's `launch` or completion wait is captured as a synthetic failing result and does not stop the others.
- Default `focus` = `false` for each task. Honored only on tmux (spawned via `split-window -d`); **other backends (cmux, zellij, wezterm) currently focus the new pane regardless** — documented backend limitation. Use the widget or native mux shortcuts to navigate.
- Set `focus: true` on an individual task to override.

### Claude plugin install (required for `cli: "claude"` tasks)

The sentinel-based completion handshake depends on a small Claude Stop hook shipped in this repo at `pi-extension/subagents/plugin/`. Install it manually once:

```bash
claude plugin install /absolute/path/to/pi-interactive-subagent/pi-extension/subagents/plugin
# or symlink into ~/.claude/plugins/
ln -s /abs/path/to/pi-interactive-subagent/pi-extension/subagents/plugin ~/.claude/plugins/pi-interactive-subagent
```

If the plugin is not installed and a `cli: "claude"` task is dispatched, the Claude process completes but no Stop-hook sentinel is ever written, so `watchSubagent` keeps polling until the caller cancels the subagent **through the widget** (the widget's per-subagent cancel action aborts the running wait). Aborting the surrounding tool call does **not** currently cancel orchestration waits — tool-signal → running-wait propagation is deferred (see Deferred work); the tool signal reaches `subagent_serial` / `subagent_parallel`, but `default-deps.waitForCompletion` constructs its own local `AbortController` and does not yet thread the tool signal through. This fork also does **not** currently emit a dedicated "plugin not installed" error or apply a fixed timeout — diagnosing a missing install is a manual step. Auto-install and an installation-health probe are listed under Deferred work.

### Manual smoke test (per-skill migration)

1. `cd` to a scratch repo with a persistent pi session running.
2. Dispatch `subagent_serial` with two trivial tasks (pi + pi), confirm both panes spawn, `{previous}` substitution works, final message returns.
3. Dispatch `subagent_parallel` with 3 tasks and `maxConcurrency: 2` on tmux, confirm detached spawn (panes appear but focus stays on the caller), widget displays all three, results aggregate in input order. On non-tmux backends, confirm the new panes take focus (documented limitation).
4. Dispatch `subagent_serial` with one `cli: "claude"` task (trivial prompt like "echo hello"), confirm the Stop hook fires and the transcript is copied to `~/.pi/agent/sessions/claude-code/`.
5. Verify `SubagentResult.transcriptPath` (visible via the orchestration tool's `details.results[i].transcriptPath`) points at a file that still `existsSync` after sentinel cleanup — this is the v3 archived-transcript fix and the behavior the Task 17 scaffold will one day cover automatically.
````

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: correct non-blocking intro, document orchestration tools, plugin install, smoke checklist"
```

---

## Task 19: Final sweep — run everything, confirm green

- [ ] **Step 1: Run unit tests**

Run: `npm test`
Expected: all green (orchestration + existing).

- [ ] **Step 2: Run integration tests**

Run: `npm run test:integration`
Expected: all green (new test skips without `claude`).

- [ ] **Step 3: Confirm the file layout matches the plan**

Run: `ls pi-extension/orchestration test/orchestration`
Expected (note: `transcript-read.ts` intentionally absent — v3 pushed that logic into `watchSubagent`; `default-deps.test.ts` is the v5 `transcriptPath: null` passthrough test added in Task 13 Step 2):
```
pi-extension/orchestration:
default-deps.ts   run-parallel.ts   run-serial.ts   tool-handlers.ts   types.ts

test/orchestration:
default-deps.test.ts   run-parallel.test.ts   run-serial.test.ts   thinking-effort.test.ts   tool-handlers.test.ts
```

- [ ] **Step 3b: Confirm `npm test` loads every test file the plan produces**

Run: `node -e "console.log(require('./package.json').scripts.test)"`
Expected substrings: `test/test.ts`, `test/system-prompt-mode.test.ts`, `test/orchestration/*.test.ts`

- [ ] **Step 4: Commit a release-marker tag**

```bash
git tag fork-v3.3.0-rc.1
```

(Do not push the tag without user approval.)

---

## Deferred / explicitly out of scope

- **Tool-signal → running-wait cancellation propagation.** `runSerial` / `runParallel` accept a reserved `opts` argument and tool handlers receive an `AbortSignal`, but the current `default-deps` `waitForCompletion` creates its own local `AbortController` and does not wire the tool signal into the running subagent's wait. Users who need to interrupt an in-flight orchestration must cancel individual subagents through the widget. Plumbing the tool signal through `runSerial`/`runParallel` → `LauncherDeps.waitForCompletion` is an additive change for a future PR.
- `caller_ping` surfaced distinctly on `OrchestrationResult` (currently folded into `error`). The bare `subagent` tool still exposes it fully.
- `subagent_resume` orchestration wrapper.
- `session-mode: lineage-only | fork` surfaced inside the wrappers (users pass `fork` per task via the bare `subagent` for now).
- Async orchestration mode (`wait: false`) — the pure-async core makes this additive later; see design "Future work".
- Widget-driven pane focus / `subagent_focus` tool.
- Migrating `pi-config/agent/skills/` — follow-up PRs in `pi-config`, not this repo.
- `pi-subagent` retirement — follow-up after cutover is verified.
- Auto-install of the Claude plugin (intentionally manual).
- **Claude plugin installation-health probe / dedicated missing-plugin error.** Today a missing Stop hook makes `watchSubagent` poll indefinitely (see Task 18 Step 3 "Claude plugin install" note). A future PR could add a one-shot "hook installed?" probe on first Claude dispatch, surface a dedicated error, and/or apply a bounded timeout — deferred because it's additive and orthogonal to the fork rebrand + orchestration work.
- **Real automated Claude sentinel roundtrip harness.** Task 17 currently stands up only a skip-gated scaffold. A future PR should drive a real `claude` subagent end-to-end and assert `SubagentResult.transcriptPath` exists after sentinel cleanup.
- **`detach` support on non-tmux backends.** `subagent_parallel` relies on tmux's `split-window -d`; cmux, zellij, and wezterm currently focus the new pane regardless of `focus: false`. Adding detach equivalents on those backends is a per-backend change deferred until a user actually runs parallel orchestration on one of them.
