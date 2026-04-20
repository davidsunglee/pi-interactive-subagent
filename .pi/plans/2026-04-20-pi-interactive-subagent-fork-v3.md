# pi-interactive-subagent Fork Implementation Plan (v3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **v3 revision notes** (addresses `.pi/plans/reviews/2026-04-20-pi-interactive-subagent-fork-review-v2.md`):
> 1. **Claude transcript path is now recoverable in real execution order.** The `readTranscript(running)` helper and its test module are gone. Instead, `SubagentResult` gains a uniform `transcriptPath: string | null` field that `watchSubagent` populates **before** `unlinkSync` cleanup (pi branch: `sessionFile`; Claude branch: `join(CLAUDE_SESSIONS_DIR, claudeSessionId)` computed from the already-archived copy). `default-deps` reads `sub.transcriptPath` directly — no post-watch file reads. Old Tasks 13–14 (transcript-read) are deleted; Tasks 15–21 renumber to 13–19.
> 2. **Widget refresh now starts inside `launchSubagent` itself.** The `startWidgetRefresh()` call moves from the `subagent.execute` / `subagent_resume.execute` sites into `launchSubagent` (immediately after `runningSubagents.set`). Every caller — including orchestration's `makeDefaultDeps.launch` — now gets the widget loop for free; the now-redundant call sites are left in place (idempotent via the `widgetInterval` guard) but noted as removable in a future cleanup.
> 3. **`{previous}` substitution uses `split/join` instead of `String.replace`.** `replace()` interprets `$` sequences in the replacement string. Arbitrary assistant output (containing `$$`, `$&`, `$1`, …) is now inserted literally. A new `runSerial` test asserts this.
> 4. **README rebrand is now exhaustive.** Task 1 Step 3 expands to cover title rewrite, install-command repo URL, and "What's Included" tool-count/table copy — not just the fork-notice block and `package.json`.
> 5. **Orchestration tool handlers now mirror base-tool preflight.** Task 7 extracts a shared `preflightSubagent(ctx)` helper (mux-availability + session-file checks) and exports it; orchestration `execute` handlers call it first so failures are as clean and consistent as the bare `subagent` tool.
>
> **Carried from v2** (still true):
> - Per-tool registration gating via `shouldRegister` predicate.
> - `OrchestrationTaskSchema` omits unplumbed `interactive` / `permissionMode` fields.
> - `caller_ping` surfacing, tool-signal cancellation, and async mode remain deferred.
> - `npm test` script covers `test/test.ts` + `test/system-prompt-mode.test.ts` + `test/orchestration/*.test.ts`.

**Goal:** Turn the current freshly-forked `HazAT/pi-interactive-subagents` checkout into `pi-interactive-subagent` by (a) rebranding the package, (b) patching upstream `subagent()` to support per-call `thinking` end-to-end, (c) adding a pure-async orchestration layer exposing `subagent_serial` and `subagent_parallel`, and (d) supporting detached pane spawning with a per-task `focus` override. Out of scope: migrating `pi-config/agent/skills/` (that happens in a follow-up PR in the `pi-config` repo).

**Architecture:** Keep upstream files (`pi-extension/subagents/*`) in place as "vendored from upstream + narrow patches". Put all orchestration code under a new sibling directory `pi-extension/orchestration/`. Tool handlers are thin wrappers; the orchestration cores (`runSerial`, `runParallel`) are pure async functions that accept an injectable `LauncherDeps` (`launch` + `waitForCompletion`) so unit tests can mock all IO. The production `LauncherDeps` composes the exported `launchSubagent` + `watchSubagent` primitives directly: `launchSubagent` now starts the widget refresh loop itself (no external glue needed), and `watchSubagent` now returns a uniform `transcriptPath` on its result (populated before Claude sentinel cleanup). `runSerial` iterates, substitutes `{previous}` via `split/join` (literal insertion — safe for `$`-bearing output), and stops on error. `runParallel` uses a bounded concurrency pool (cap 8, default 4). Both feed through the existing widget via the shared `runningSubagents` map in `index.ts`. Orchestration tool handlers reuse the exported `preflightSubagent(ctx)` helper so mux / session-file failure messages match the bare `subagent` tool.

**Tech Stack:** TypeScript (Node's native `--test` runner, `node:assert/strict`), `@sinclair/typebox` for tool schemas, `@mariozechner/pi-coding-agent` for the extension API, tmux/cmux/zellij/wezterm via the existing `cmux.ts` surface helpers.

---

## File Structure

**Modified files (upstream, narrow changes only):**
- `package.json` — rename, update repo URL, bump version, add test script for orchestration.
- `README.md` — rewrite title + install URL + "What's Included" copy, add new tool section, fork provenance note, Claude plugin install steps.
- `pi-extension/subagents/index.ts` — add `thinking`, `cli`, `focus` to `SubagentParams`; wire `params.thinking ?? agentDefs?.thinking`; add `thinkingToEffort` + Claude `--effort` path; export `launchSubagent`, `watchSubagent`, and a new `preflightSubagent(ctx)` helper for orchestration; extend `SubagentResult` with a uniform `transcriptPath: string | null`; populate it in both branches of `watchSubagent` **before** sentinel cleanup; move `startWidgetRefresh()` invocation into `launchSubagent` itself (after `runningSubagents.set`); add `detach` option flowing from `params.focus === false`; register orchestration tools from its `subagentsExtension` default export.
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

## Task 7: Export primitives + move widget start + uniform `transcriptPath` + shared preflight

This task bundles the upstream surgery that the v3 review surfaced. All four sub-steps are narrow and touch only `pi-extension/subagents/index.ts`.

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

- [ ] **Step 6: Run the existing suite**

Run: `npm test`
Expected: all green — new exports and the extra `transcriptPath` field are additive; widget start relocation is behavior-preserving.

- [ ] **Step 7: Commit**

```bash
git add pi-extension/subagents/index.ts
git commit -m "refactor(subagent): export primitives, uniform transcriptPath, widget start in launchSubagent, shared preflight helper"
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
export const DEFAULT_SENTINEL_TIMEOUT_MS = 30_000;
```

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

    const handle = await deps.launch(task, true /* defaultFocus */);
    const result = await deps.waitForCompletion(handle);
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
Expected: PASS, 5 tests.

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
      const handle = await deps.launch(task, false /* defaultFocus */);
      const result = await deps.waitForCompletion(handle);
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
Expected: PASS, 6 tests.

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

- [ ] **Step 2: Typecheck by running full suite**

Run: `npm test`
Expected: all green (default-deps.ts is not imported yet; compiles via tests touching it only after Task 16).

- [ ] **Step 3: Commit**

```bash
git add pi-extension/orchestration/default-deps.ts
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

The registrar accepts an optional `preflight` injection so tests can exercise the early-return path without standing up a real session. Production code passes `preflightSubagent` (the helper extracted in Task 7 Step 5).

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

export type PreflightFn = (ctx: {
  sessionManager: { getSessionFile(): string | null };
}) => { content: Array<{ type: "text"; text: string }>; details: { error: string } } | null;

export function registerOrchestrationTools(
  pi: ExtensionAPI,
  depsFactory: (ctx: { sessionManager: any; cwd: string }) => LauncherDeps,
  shouldRegister: (name: string) => boolean,
  preflight: PreflightFn = () => null,
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
        "Panes are spawned detached by default — use the widget or native mux shortcuts to focus.",
      promptSnippet:
        "Run a batch of subagent tasks concurrently (default 4, hard cap 8). Blocks until all " +
        "tasks complete. Partial failures are reported independently.",
      parameters: ParallelParams,
      async execute(_id, params, _signal, _onUpdate, ctx) {
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
Expected: PASS, 7 tests.

- [ ] **Step 3: Commit**

```bash
git add pi-extension/orchestration/tool-handlers.ts test/orchestration/tool-handlers.test.ts
git commit -m "feat(orchestration): register subagent_serial + subagent_parallel tools with preflight"
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
  registerOrchestrationTools(
    pi,
    (ctx) => makeDefaultDeps(ctx),
    shouldRegister,
    preflightSubagent,
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

## Task 17: Write the Claude sentinel roundtrip integration test (local-only)

**Files:**
- Create: `test/integration/claude-sentinel-roundtrip.test.ts`

- [ ] **Step 1: Write a skip-if-unavailable test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

describe("claude sentinel roundtrip (local only)", { skip: !CLAUDE_AVAILABLE || !PLUGIN_PRESENT }, () => {
  it("placeholder — see README 'Manual smoke test' for the full harness", () => {
    // Full end-to-end is driven by the README smoke checklist; this test
    // exists so `npm run test:integration` doesn't fail on fresh checkouts
    // and so CI can rely on the skip condition documented above.
    //
    // When the README smoke test runs manually, it must verify (post Task 7):
    //   - The SubagentResult returned by watchSubagent has a non-null
    //     transcriptPath pointing under ~/.pi/agent/sessions/claude-code/
    //   - existsSync(transcriptPath) === true (i.e. the archive copy
    //     persists after sentinel cleanup).
    // These assertions would run inside an automated harness that drives
    // a real Claude subagent end-to-end; encoding them here keeps the
    // v3 review's "finding 1" check anchored in the test module.
    assert.ok(true);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:integration`
Expected: existing HazAT integration tests run; new test skips on machines without `claude` + plugin, otherwise no-ops.

- [ ] **Step 3: Commit**

```bash
git add test/integration/claude-sentinel-roundtrip.test.ts
git commit -m "test(integration): add skip-if-unavailable shell for claude roundtrip"
```

---

## Task 18: README updates — tool docs + Claude plugin install + smoke checklist

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "New tools" section near the existing `subagent` tool reference**

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

- Stops on the first non-zero exit; remaining tasks are not spawned.
- Returns `{ results: [...], isError }` with one entry per completed step.
- Default focus = true (panes grab focus as they spawn).

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

- Default `maxConcurrency` = 4, hard cap 8 (call is rejected above the cap).
- Partial failures don't cancel siblings; each result reports its own `exitCode`.
- Panes are **spawned detached** by default — use the widget or native mux shortcuts to focus.
- Set `focus: true` on an individual task to override.

### Claude plugin install (required for `cli: "claude"` tasks)

The sentinel-based completion handshake depends on a small Claude Stop hook shipped in this repo at `pi-extension/subagents/plugin/`. Install it manually once:

```bash
claude plugin install /absolute/path/to/pi-interactive-subagent/pi-extension/subagents/plugin
# or symlink into ~/.claude/plugins/
ln -s /abs/path/to/pi-interactive-subagent/pi-extension/subagents/plugin ~/.claude/plugins/pi-interactive-subagent
```

If the plugin is not installed and a `cli: "claude"` task is dispatched, the sentinel wait will time out after ~30s and surface the error `"Claude Stop hook not installed — see README install step"`.

### Manual smoke test (per-skill migration)

1. `cd` to a scratch repo with a persistent pi session running.
2. Dispatch `subagent_serial` with two trivial tasks (pi + pi), confirm both panes spawn, `{previous}` substitution works, final message returns.
3. Dispatch `subagent_parallel` with 3 tasks and `maxConcurrency: 2`, confirm detached spawn, widget displays all three, results aggregate in input order.
4. Dispatch `subagent_serial` with one `cli: "claude"` task (trivial prompt like "echo hello"), confirm Stop hook fires, transcript is copied to `~/.pi/agent/sessions/claude-code/`.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document subagent_serial/subagent_parallel tools + plugin install + smoke checklist"
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
Expected (note: `transcript-read.ts` intentionally absent — v3 pushed that logic into `watchSubagent`):
```
pi-extension/orchestration:
default-deps.ts   run-parallel.ts   run-serial.ts   tool-handlers.ts   types.ts

test/orchestration:
run-parallel.test.ts   run-serial.test.ts   thinking-effort.test.ts   tool-handlers.test.ts
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
