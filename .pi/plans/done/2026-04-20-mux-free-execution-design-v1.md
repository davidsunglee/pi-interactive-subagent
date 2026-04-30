# Mux-Free Execution Implementation Plan (v1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a headless (stdio-piped, stream-json) execution backend alongside the existing pane backend in the `pi-interactive-subagent` fork, so that `subagent_serial` / `subagent_parallel` work in environments without a supported multiplexer (CI, headless SSH, IDE terminals). Close two adjacent gaps vs. the old `pi-subagent` extension: populate `usage` / `messages[]` on `OrchestrationResult` from the headless path, and fix the tool-restriction security regression on the Claude path via an upstream-portable patch.

**Architecture:** Introduce a `Backend` interface in a new `pi-extension/subagents/backends/` directory with two implementations — `pane.ts` (thin adapter over the existing `launchSubagent` / `watchSubagent` — zero movement of upstream code) and `headless.ts` (new stream-json implementation spawning the CLI with piped stdio). Selection happens once per `makeDefaultDeps` call via `selectBackend()`, which honors `PI_SUBAGENT_MODE=pane|headless|auto` and falls back to mux detection when set to `auto` (default). `orchestration/default-deps.ts` routes through `selectBackend()`; the orchestration cores `run-serial` / `run-parallel` stay untouched. `OrchestrationResult` gains optional `usage?: UsageStats` and `messages?: Message[]` fields populated by the headless backend only (pane leaves them `undefined`, deferred to a follow-up spec). A second named-commit patch to `pi-extension/subagents/index.ts` adds `PI_TO_CLAUDE_TOOLS` mapping + `--allowedTools` emission inside `buildClaudeCmdParts`, fixing tool restriction for both backends.

**Tech Stack:** TypeScript (Node's native `--test` runner, `node:assert/strict`), `@sinclair/typebox` for tool schemas, `@mariozechner/pi-coding-agent` for the extension API, `@mariozechner/pi-ai` for the `Message` type (already transitively available through upstream), `node:child_process` `spawn` for stdio-piped CLI launch.

---

## File Structure

**New files (headless backend + tests):**
- `pi-extension/subagents/backends/types.ts` — `Backend` interface, `BackendResult`, `UsageStats`, shared re-exports of `LaunchedHandle` / `OrchestrationTask`.
- `pi-extension/subagents/backends/pane.ts` — thin adapter over existing `launchSubagent` + `watchSubagent` (~30 LOC).
- `pi-extension/subagents/backends/headless.ts` — new stream-json implementation for both pi and Claude (~400–500 LOC).
- `pi-extension/subagents/backends/select.ts` — `selectBackend()` resolver (`PI_SUBAGENT_MODE` + mux fallback, ~30 LOC).
- `pi-extension/subagents/backends/claude-stream.ts` — `parseClaudeStreamEvent` + `parseClaudeResult` + `ClaudeUsage` type. Lifted from `pi-subagent/claude-args.ts:153-204` (adapted, not copy-pasted).
- `test/orchestration/select-backend.test.ts` — `PI_SUBAGENT_MODE` resolution + mux fallback unit tests.
- `test/orchestration/line-buffer.test.ts` — partial-line buffering across chunk boundaries.
- `test/orchestration/headless-abort.test.ts` — mocked-spawn SIGTERM → 5s → SIGKILL timing.
- `test/orchestration/claude-event-transform.test.ts` — pure `parseClaudeStreamEvent` tool_use → toolCall transformation.
- `test/integration/pi-pane-smoke.test.ts` — smoke test for the existing pane path (pi agent).
- `test/integration/headless-pi-smoke.test.ts` — headless pi path.
- `test/integration/headless-claude-smoke.test.ts` — headless Claude path.
- `test/integration/headless-tool-use.test.ts` — mid-stream tool-use parsing.
- `test/integration/headless-transcript-archival.test.ts` — archival of pi + Claude transcripts.
- `test/integration/headless-abort-integration.test.ts` — long-running task abort.
- `test/integration/headless-enoent.test.ts` — CLI-not-on-PATH error path.

**Modified files (narrow changes):**
- `pi-extension/subagents/cmux.ts` — export a named `detectMux()` alias around existing `isMuxAvailable()` (for backend selection consumers).
- `pi-extension/subagents/index.ts` — **second carried patch** alongside the existing `thinking` patch: add `effectiveTools?: string` to `ClaudeCmdInputs`, route it into `buildClaudeCmdParts`, add shared `PI_TO_CLAUDE_TOOLS` constant and `--allowedTools` emission. No other behavior change.
- `pi-extension/orchestration/types.ts` — add optional `usage?: UsageStats` and `messages?: Message[]` fields to `OrchestrationResult`. Re-export `UsageStats` from the backends module.
- `pi-extension/orchestration/default-deps.ts` — rewire `launch` / `waitForCompletion` to dispatch through `selectBackend()` at module construction, preserving the `handleToRunning` bookkeeping and signal forwarding contract for the pane path, and adding equivalent bookkeeping for headless.
- `package.json` — no metadata change; `test` / `test:integration` scripts already pick up `test/orchestration/*.test.ts` and `test/integration/*.test.ts` globs, so new files are auto-included.
- `README.md` — section describing `PI_SUBAGENT_MODE`, the headless backend's capabilities/limitations, and the new `usage` / `messages` fields. Tool-restriction behavior for Claude is called out as a security fix (both backends).

---

## Phase 0 — Baseline pane tests

Phase 0 establishes a regression safety net for the existing pane path before any refactor. Its gate into Phase 1: the three tests below (or their reasonable skip-paths) pass locally.

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

## Phase 1 — Backend interface + pane adapter

Phase 1 introduces the `Backend` seam without changing observable behavior. `selectBackend()` is hard-gated to always return `"pane"` until Phase 2 lands the headless implementation.

### Task 4: Define the `Backend` interface and shared types

**Files:**
- Create: `pi-extension/subagents/backends/types.ts`

- [ ] **Step 1: Write the interface and result types**

Create `pi-extension/subagents/backends/types.ts`:

```ts
import type { Message } from "@mariozechner/pi-ai";
import type { LaunchedHandle, OrchestrationTask } from "../../orchestration/types.ts";

export type { LaunchedHandle, OrchestrationTask };
export type { Message };

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

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
  /** Headless backend only in v1; pane leaves undefined. */
  messages?: Message[];
}

export interface Backend {
  launch(
    task: OrchestrationTask,
    defaultFocus: boolean,
    signal?: AbortSignal,
  ): Promise<LaunchedHandle>;
  watch(handle: LaunchedHandle, signal?: AbortSignal): Promise<BackendResult>;
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npx tsc --noEmit 2>&1 | head -40`
Expected: no errors mentioning `backends/types.ts`. If `Message` import fails (fresh install without the transitive), confirm `@mariozechner/pi-ai` is resolvable via `ls node_modules/@mariozechner/pi-ai/`. If missing, add it explicitly to `package.json` `peerDependencies` (version `*`, matching the existing pi-coding-agent peerDep convention) and reinstall. The pi-subagent reference uses the same `@mariozechner/pi-ai` import and treats it as a direct dep.

- [ ] **Step 3: Commit**

```bash
git add pi-extension/subagents/backends/types.ts
git commit -m "feat(backends): define Backend interface and shared result types"
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

Run: `npx tsc --noEmit 2>&1 | head -20`
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
  BackendResult,
  LaunchedHandle,
  OrchestrationTask,
} from "./types.ts";

/**
 * Pane backend: thin adapter over existing launchSubagent + watchSubagent.
 *
 * Zero movement of upstream code — this file owns only the mapping
 * between the Backend interface and the existing primitives.
 *
 * `usage` and `messages` on the returned BackendResult are intentionally
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
      task: OrchestrationTask,
      defaultFocus: boolean,
      _signal?: AbortSignal,
    ): Promise<LaunchedHandle> {
      const resolvedFocus = task.focus ?? defaultFocus;
      const running = await launchSubagent(
        {
          name: task.name ?? "subagent",
          task: task.task,
          agent: task.agent,
          model: task.model,
          thinking: task.thinking,
          systemPrompt: task.systemPrompt,
          skills: task.skills,
          tools: task.tools,
          cwd: task.cwd,
          fork: task.fork,
          resumeSessionId: task.resumeSessionId,
          cli: task.cli,
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

Run: `npx tsc --noEmit 2>&1 | head -30`
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

### Task 8: Rewire `default-deps.ts` to dispatch through `selectBackend()`

**Files:**
- Modify: `pi-extension/orchestration/default-deps.ts`

Phase 1 keeps `selectBackend()` pinned to `"pane"` in practice: the `HeadlessBackend` stub throws "not implemented". This Task only changes the dispatch shape; the Phase 0 pane tests must stay green.

- [ ] **Step 1: Write a failing test that exercises headless dispatch selection**

Add to `test/orchestration/default-deps.test.ts` (after the existing `it` block — keep the original `transcriptPath: null` passthrough test intact):

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeDefaultDeps } from "../../pi-extension/orchestration/default-deps.ts";

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
  BackendResult,
  LaunchedHandle,
  OrchestrationTask,
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
      _task: OrchestrationTask,
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
import type { Backend } from "../subagents/backends/types.ts";
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
 * The new optional `usage` / `messages` fields ride along transparently —
 * they're `undefined` when the pane backend produces the result, and
 * populated when the headless backend produces it.
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
      return backend.launch(task, defaultFocus, signal);
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
        messages: r.messages,
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

`types.ts` does not yet declare `usage` / `messages`. `waitForCompletion` is currently constructing a result with extra properties that TypeScript will complain about. Skip this step if typecheck passed; if it did not, apply Task 25 Step 2 early (add the optional fields to `OrchestrationResult`) and re-typecheck. The clean Phase 4 work is the README-and-test pass; the type additions themselves are tiny and safe to land now.

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

const SAVED_KEYS = ["PI_SUBAGENT_MODE", "CMUX_SOCKET_PATH", "TMUX", "ZELLIJ", "WEZTERM_UNIX_SOCKET"];

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

---

## Phase 2 — Headless pi backend

Phase 2 replaces the Phase 1 headless stub with the real pi implementation: spawn, stream-json parse, usage aggregation, transcript archival, abort. Claude dispatch still routes to pane (or the stub throws) in this phase.

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

This Task lifts `pi-subagent/index.ts:474-619` (pi dispatch path) into the fork's own headless implementation. The Claude path stays unimplemented until Phase 3.

- [ ] **Step 1: Overwrite the headless stub with the pi implementation**

Replace `pi-extension/subagents/backends/headless.ts` with:

```ts
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { LineBuffer } from "./line-buffer.ts";
import type {
  Backend,
  BackendResult,
  LaunchedHandle,
  OrchestrationTask,
  UsageStats,
} from "./types.ts";

/** Internal state for a headless launch, keyed by handle id. */
interface HeadlessLaunch {
  id: string;
  name: string;
  startTime: number;
  promise: Promise<BackendResult>;
  /** Aborting this signals the child to SIGTERM → SIGKILL. */
  abort: AbortController;
}

function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of (msg.content as Array<any>) ?? []) {
        if (part.type === "text") return part.text as string;
      }
    }
  }
  return "";
}

/** Per-project session archive root; mirrors the pane path. */
function piSessionArchiveDir(cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(homedir(), ".pi", "agent", "sessions", safePath);
}

/**
 * Headless backend: spawns pi / Claude with piped stdio and parses
 * stream-json. Used when no mux is available (or when PI_SUBAGENT_MODE=headless).
 */
export function makeHeadlessBackend(ctx: {
  sessionManager: ExtensionContext["sessionManager"];
  cwd: string;
}): Backend {
  const launches = new Map<string, HeadlessLaunch>();

  return {
    async launch(
      task: OrchestrationTask,
      _defaultFocus: boolean,
      signal?: AbortSignal,
    ): Promise<LaunchedHandle> {
      const id = Math.random().toString(16).slice(2, 10);
      const name = task.name ?? "subagent";
      const startTime = Date.now();
      const abort = new AbortController();
      if (signal) {
        if (signal.aborted) abort.abort();
        else signal.addEventListener("abort", () => abort.abort(), { once: true });
      }

      const cli = task.cli ?? "pi";
      const promise: Promise<BackendResult> =
        cli === "claude"
          ? runClaudeHeadless({ task, name, startTime, abort: abort.signal, ctx })
          : runPiHeadless({ task, name, startTime, abort: abort.signal, ctx });

      launches.set(id, { id, name, startTime, promise, abort });
      return { id, name, startTime };
    },

    async watch(
      handle: LaunchedHandle,
      signal?: AbortSignal,
    ): Promise<BackendResult> {
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
  task: OrchestrationTask;
  name: string;
  startTime: number;
  abort: AbortSignal;
  ctx: { sessionManager: ExtensionContext["sessionManager"]; cwd: string };
}

/** PI CLI headless path — spawn, stream-json parse, archive session file. */
async function runPiHeadless(p: RunParams): Promise<BackendResult> {
  const { task, name, startTime, abort, ctx } = p;
  const messages: Message[] = [];
  const usage = emptyUsage();
  let stderr = "";
  let terminalEvent = false;

  // Per-call session file so archival is deterministic.
  const sessionRoot = piSessionArchiveDir(ctx.cwd);
  mkdirSync(sessionRoot, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const sessionFile = join(sessionRoot, `headless-${timestamp}-${Math.random().toString(16).slice(2, 8)}.jsonl`);

  const args: string[] = ["--session", sessionFile, "--output-format", "stream-json"];
  if (task.model) {
    const model = task.thinking ? `${task.model}:${task.thinking}` : task.model;
    args.push("--model", model);
  }
  if (task.systemPrompt) {
    args.push("--append-system-prompt", task.systemPrompt);
  }
  if (task.tools) {
    args.push("--tools", task.tools);
  }
  args.push(task.task);

  const childEnv = {
    ...process.env,
    PI_SUBAGENT_NAME: name,
    PI_SUBAGENT_SESSION: sessionFile,
    ...(task.agent ? { PI_SUBAGENT_AGENT: task.agent } : {}),
    ...(process.env.PI_CODING_AGENT_DIR
      ? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }
      : {}),
  };

  if (abort.aborted) {
    return makeAbortedResult(name, startTime, messages, usage);
  }

  return new Promise<BackendResult>((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("pi", args, {
        cwd: task.cwd ?? ctx.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      });
    } catch (err: any) {
      resolve({
        name,
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

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        messages.push(msg);
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
          if (stop === "endTurn" || stop === "stop" || stop === "error") {
            terminalEvent = true;
          }
        }
      } else if (event.type === "tool_result_end" && event.message) {
        messages.push(event.message as Message);
      }
    };

    proc.stdout!.on("data", (data: Buffer) => {
      for (const line of lb.push(data.toString())) processLine(line);
    });
    proc.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const onAbort = () => {
      wasAborted = true;
      try {
        proc.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        if (!proc.killed) {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }
      }, 5000);
    };
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      resolve({
        name,
        finalMessage: "",
        transcriptPath: null,
        exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error:
          err.code === "ENOENT"
            ? "pi CLI not found on PATH"
            : err.message || String(err),
      });
    });

    proc.on("close", (code) => {
      for (const line of lb.flush()) processLine(line);
      const elapsedMs = Date.now() - startTime;
      const archived = existsSync(sessionFile) ? sessionFile : null;
      const exitCode = code ?? 0;

      if (wasAborted) {
        resolve({
          name,
          finalMessage: getFinalOutput(messages),
          transcriptPath: archived,
          exitCode: 1,
          elapsedMs,
          error: "aborted",
          usage,
          messages,
        });
        return;
      }
      if (exitCode !== 0) {
        resolve({
          name,
          finalMessage: getFinalOutput(messages),
          transcriptPath: archived,
          exitCode,
          elapsedMs,
          error: stderr.trim() || `pi exited with code ${exitCode}`,
          usage,
          messages,
        });
        return;
      }
      if (!terminalEvent) {
        resolve({
          name,
          finalMessage: getFinalOutput(messages),
          transcriptPath: archived,
          exitCode: 1,
          elapsedMs,
          error: "child exited without completion event",
          usage,
          messages,
        });
        return;
      }
      resolve({
        name,
        finalMessage: getFinalOutput(messages),
        transcriptPath: archived,
        exitCode: 0,
        elapsedMs,
        usage,
        messages,
      });
    });
  });
}

/** Phase 2 Claude stub — Phase 3 overwrites with the real implementation. */
async function runClaudeHeadless(p: RunParams): Promise<BackendResult> {
  return {
    name: p.name,
    finalMessage: "",
    transcriptPath: null,
    exitCode: 1,
    elapsedMs: Date.now() - p.startTime,
    error: "headless Claude backend not implemented yet (Phase 3)",
  };
}

function makeAbortedResult(
  name: string,
  startTime: number,
  messages: Message[],
  usage: UsageStats,
): BackendResult {
  return {
    name,
    finalMessage: "",
    transcriptPath: null,
    exitCode: 1,
    elapsedMs: Date.now() - startTime,
    error: "aborted",
    usage,
    messages,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | head -40`
Expected: no errors. If `OrchestrationResult` still lacks `usage` / `messages`, see Task 25 Step 2 and apply now.

- [ ] **Step 3: Commit**

```bash
git add pi-extension/subagents/backends/headless.ts
git commit -m "feat(backends): add headless pi implementation with spawn + stream-json"
```

### Task 12: Unit-test the headless abort path with a mocked spawn

**Files:**
- Create: `test/orchestration/headless-abort.test.ts`

Abort behavior is the highest-value piece of this backend to exercise without a real CLI. The test stubs `child_process.spawn` via a module-level flag so the real function isn't called.

- [ ] **Step 1: Write the failing test**

Create `test/orchestration/headless-abort.test.ts`:

```ts
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

/**
 * Mocks `node:child_process` `spawn` before loading the headless
 * backend. This exercises the SIGTERM → 5s → SIGKILL timing and the
 * aborted synthetic result without launching a real CLI.
 */
describe("headless abort", { timeout: 15_000 }, () => {
  let fakeProc: any;
  let killed: string[];
  let closeResolve: ((code: number) => void) | null = null;
  let backendModule: any;

  before(async () => {
    const cp = await import("node:child_process");
    mock.method(cp, "spawn", () => {
      const ee = new EventEmitter() as any;
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.killed = false;
      ee.kill = (sig: string) => {
        killed.push(sig);
        if (sig === "SIGKILL") {
          ee.killed = true;
          closeResolve?.(137);
        }
        return true;
      };
      fakeProc = ee;
      return ee;
    });
    backendModule = await import("../../pi-extension/subagents/backends/headless.ts");
  });

  after(() => {
    mock.restoreAll();
  });

  it("sends SIGTERM immediately then SIGKILL after 5s on abort", async () => {
    killed = [];
    closeResolve = null;
    const origSetTimeout = globalThis.setTimeout;
    const scheduled: Array<{ ms: number; fn: () => void }> = [];
    (globalThis as any).setTimeout = ((fn: () => void, ms: number) => {
      scheduled.push({ ms, fn });
      return { unref: () => {} } as any;
    }) as any;

    try {
      const ctx = {
        sessionManager: {
          getSessionFile: () => "/tmp/fake",
          getSessionId: () => "test",
          getSessionDir: () => "/tmp",
        } as any,
        cwd: "/tmp",
      };
      const backend = backendModule.makeHeadlessBackend(ctx);
      const controller = new AbortController();
      const handle = await backend.launch(
        { agent: "x", task: "spin", cli: "pi" },
        false,
        controller.signal,
      );
      // Let the spawn attach listeners.
      await new Promise((r) => origSetTimeout(r, 10));

      // Abort — SIGTERM should fire immediately and a 5s timer should be scheduled.
      controller.abort();
      await new Promise((r) => origSetTimeout(r, 10));

      assert.deepEqual(killed, ["SIGTERM"], `expected only SIGTERM so far, got ${killed.join(",")}`);
      const fiveSec = scheduled.find((s) => s.ms === 5000);
      assert.ok(fiveSec, "a 5000ms timer must be scheduled");

      // Simulate the 5s timer firing — SIGKILL should be sent.
      fiveSec!.fn();
      await new Promise<void>((resolve) => {
        closeResolve = () => resolve();
        // Fire close via SIGKILL path inside kill().
        fakeProc.kill("SIGKILL");
      });

      assert.ok(killed.includes("SIGKILL"), "SIGKILL must be sent after timer");

      const result = await backend.watch(handle);
      assert.equal(result.error, "aborted");
      assert.equal(result.exitCode, 1);
    } finally {
      (globalThis as any).setTimeout = origSetTimeout;
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- --test-name-pattern='headless abort' 2>&1 | tail -40`
Expected: PASS. If the mock of `spawn` fails because `node:test` `mock.method` can't intercept an ESM function, switch to using a test-only injection — e.g. add a module-private `_spawnImpl` symbol in `headless.ts` that the test can override via an exported `__test__` hook. Prefer that path if the mock approach doesn't take.

- [ ] **Step 3: Commit**

```bash
git add test/orchestration/headless-abort.test.ts
git commit -m "test(backends): cover SIGTERM→5s→SIGKILL timing and aborted result"
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
 * Cost: sub-second Haiku turn — a few cents per run.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
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

describe("headless-pi-smoke", { skip: !PI_AVAILABLE, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-smoke-"));
  });

  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a trivial pi task and returns non-empty usage + messages + transcript", async () => {
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
        agent: "scout",
        task: "Reply with exactly: OK",
        model: "anthropic/claude-haiku-4-5",
      },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);
    assert.ok(result.finalMessage.trim().length > 0, "finalMessage must be non-empty");
    assert.ok(result.usage, "usage must be set on headless result");
    assert.ok(result.usage!.turns >= 1, `usage.turns must be >=1, got ${result.usage!.turns}`);
    assert.ok(result.messages && result.messages.length > 0, "messages array must be non-empty");
    assert.ok(result.transcriptPath, "transcriptPath must be set");
    assert.ok(existsSync(result.transcriptPath!), "archived session file must exist");
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
 *  - be under ~/.pi/agent/sessions/<project-slug>/
 *  - contain the task prompt as a user message
 *
 * Claude-half assertions are appended in Phase 3 (headless Claude
 * backend), gated on `which claude`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
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

describe("headless-transcript-archival [pi]", { skip: !PI_AVAILABLE, timeout: 120_000 }, () => {
  let origMode: string | undefined;
  let dir: string;

  before(() => {
    origMode = process.env.PI_SUBAGENT_MODE;
    process.env.PI_SUBAGENT_MODE = "headless";
    dir = mkdtempSync(join(tmpdir(), "pi-headless-archival-"));
  });

  after(() => {
    if (origMode === undefined) delete process.env.PI_SUBAGENT_MODE;
    else process.env.PI_SUBAGENT_MODE = origMode;
    rmSync(dir, { recursive: true, force: true });
  });

  it("archives the pi session file with the task prompt present", async () => {
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
        agent: "scout",
        task: `Reply with exactly: OK. (Do not mention ${uniqueMarker}.)`,
        model: "anthropic/claude-haiku-4-5",
      },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0);
    assert.ok(result.transcriptPath, "transcriptPath must be set");
    assert.ok(existsSync(result.transcriptPath!));
    const archiveRoot = join(homedir(), ".pi", "agent", "sessions");
    assert.ok(
      result.transcriptPath!.startsWith(archiveRoot),
      `transcriptPath must be under ${archiveRoot}, got ${result.transcriptPath}`,
    );
    const body = readFileSync(result.transcriptPath!, "utf8");
    assert.ok(body.includes(uniqueMarker), "archived transcript must include the task prompt text");
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

If `pi` is present locally, run a `subagent_serial` call with `PI_SUBAGENT_MODE=headless` in a scratch repo against the `scout` agent; confirm the output shape matches a pane-mode run (clean exit, non-empty finalMessage, session file under `~/.pi/agent/sessions/`). Capture any divergence in a follow-up note; don't block Phase 3 on cosmetic differences.

---

## Phase 3 — Headless Claude backend + tool-restriction patch

Phase 3 completes the headless implementation (Claude path) and lands the security-relevant `--allowedTools` patch on the Claude command builder.

### Task 17: Patch `buildClaudeCmdParts` with `PI_TO_CLAUDE_TOOLS` + `--allowedTools`

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Modify: `test/orchestration/thinking-effort.test.ts` (add a tools-map assertion to an existing test)

This is the second named upstream-portable patch alongside the existing `thinking` patch. It benefits both backends — pane-Claude commands gain tool restriction automatically.

- [ ] **Step 1: Write a failing assertion in the existing Claude-cmd test file**

Append to `test/orchestration/thinking-effort.test.ts` (inside the `describe("buildClaudeCmdParts", …)` block, after the existing tests):

```ts
  it("emits --allowedTools with mapped Claude tool names when effectiveTools is set", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      appendSystemPrompt: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      effectiveTools: "read, bash, find, ls, unknown",
      task: "do things",
    });
    const idx = parts.indexOf("--allowedTools");
    assert.notEqual(idx, -1, "--allowedTools must be present");
    // Values are shell-escaped in single quotes; strip the quotes for the set check.
    const raw = parts[idx + 1].replace(/^'|'$/g, "");
    const mapped = new Set(raw.split(","));
    assert.ok(mapped.has("Read"));
    assert.ok(mapped.has("Bash"));
    // find + ls both map to Glob — de-dup'd via Set in the builder.
    assert.ok(mapped.has("Glob"));
    assert.ok(!mapped.has("unknown"), "unmapped tools must be dropped, not passed through");
  });

  it("omits --allowedTools when effectiveTools is absent (no regression for agents without tools: frontmatter)", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s",
      pluginDir: undefined,
      model: "sonnet-4-6",
      appendSystemPrompt: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do things",
    });
    assert.equal(parts.includes("--allowedTools"), false);
  });
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `npm test -- --test-name-pattern='buildClaudeCmdParts' 2>&1 | tail -30`
Expected: FAIL — `effectiveTools` is not in the `ClaudeCmdInputs` type and no `--allowedTools` is emitted.

- [ ] **Step 3: Patch `ClaudeCmdInputs` + `buildClaudeCmdParts`**

In `pi-extension/subagents/index.ts`, locate the `ClaudeCmdInputs` interface (currently around line 656) and extend it:

```ts
interface ClaudeCmdInputs {
  sentinelFile: string;
  pluginDir: string | undefined;
  model: string | undefined;
  appendSystemPrompt: string | undefined;
  resumeSessionId: string | undefined;
  effectiveThinking: string | undefined;
  effectiveTools: string | undefined;  // NEW
  task: string;
}
```

Near the top of the file (right after `const SPAWNING_TOOLS = new Set([...])` so the constant lives with its kin), add:

```ts
/** Map pi tool names to Claude Code --allowedTools names. */
const PI_TO_CLAUDE_TOOLS: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
};
```

Then inside `buildClaudeCmdParts`, immediately after the `if (effort) { parts.push("--effort", effort); }` block, add:

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
      parts.push("--allowedTools", shellEscape([...claudeTools].join(",")));
    }
  }
```

Finally, at the call site (currently around line 748 inside `launchSubagent`'s Claude branch), thread the already-resolved `effectiveTools` through:

```ts
    const cmdParts = buildClaudeCmdParts({
      sentinelFile,
      pluginDir: pluginDirResolved,
      model: effectiveModel,
      appendSystemPrompt: params.systemPrompt ?? agentDefs?.body,
      resumeSessionId: params.resumeSessionId,
      effectiveThinking,
      effectiveTools,        // NEW — already computed at line 707
      task: params.task,
    });
```

- [ ] **Step 4: Run the new tests; expect all buildClaudeCmdParts tests pass**

Run: `npm test -- --test-name-pattern='buildClaudeCmdParts' 2>&1 | tail -30`
Expected: PASS.

- [ ] **Step 5: Invariant check — sweep for callers that would regress**

Run: `grep -rn '"tools":\|tools:' pi-config/agent/agents/ 2>/dev/null | head -20 || echo "pi-config not on this host"`
Expected: either a short list of agents that declare `tools:` frontmatter (they will now get `--allowedTools` in pane-Claude mode — confirm that matches intent), or the "not on this host" message. If any listed agent relies on unrestricted tools despite declaring `tools:`, call that out in the commit body so the Phase 3 merge can be audited.

- [ ] **Step 6: Commit (named for upstream portability)**

```bash
git add pi-extension/subagents/index.ts test/orchestration/thinking-effort.test.ts
git commit -m "feat(subagents): emit --allowedTools on Claude path via PI_TO_CLAUDE_TOOLS map

Closes the tool-restriction security regression identified during
fork-state review. Kept as a discrete named commit portable to an
upstream PR alongside the existing thinking patch."
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
    }) as any;
    assert.equal(result.role, "assistant");
    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[1].type, "toolCall");
    assert.equal(result.content[1].id, "abc");
    assert.equal(result.content[1].name, "read");
    assert.deepEqual(result.content[1].arguments, { path: "/tmp/x" });
  });

  it("returns undefined for non-assistant events", () => {
    assert.equal(parseClaudeStreamEvent({ type: "result", result: "ok" }), undefined);
    assert.equal(parseClaudeStreamEvent({ type: "system", subtype: "init" }), undefined);
  });

  it("passes through text-only assistant messages unchanged in shape", () => {
    const r = parseClaudeStreamEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    }) as any;
    assert.equal(r.content[0].type, "text");
    assert.equal(r.content[0].text, "done");
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
import type { UsageStats } from "./types.ts";

export interface ClaudeResult {
  exitCode: number;
  finalOutput: string;
  usage: UsageStats;
  error?: string;
  model?: string;
}

/**
 * Parse an intermediate Claude Code stream-json event.
 *
 * Returns the assistant message object for "assistant" events (with
 * `tool_use` blocks transformed to pi-compatible `toolCall` shape).
 * Returns undefined for any other event type.
 *
 * Lifted from pi-subagent/claude-args.ts:153 (adapted — imports UsageStats
 * from our shared types module rather than a local redefinition).
 */
export function parseClaudeStreamEvent(
  event: Record<string, unknown>,
): unknown | undefined {
  if (event.type !== "assistant") return undefined;
  const message = event.message as Record<string, unknown> | undefined;
  if (!message || !Array.isArray(message.content)) return message;
  const transformed = {
    ...message,
    content: (message.content as Array<Record<string, unknown>>).map((block) => {
      if (block.type === "tool_use") {
        return {
          type: "toolCall",
          id: block.id,
          name: (block.name as string)?.toLowerCase(),
          arguments: block.input,
        };
      }
      return block;
    }),
  };
  return transformed;
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

Run: `npm test -- --test-name-pattern='parseClaudeStreamEvent|parseClaudeResult' 2>&1 | tail -30`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add pi-extension/subagents/backends/claude-stream.ts test/orchestration/claude-event-transform.test.ts
git commit -m "feat(backends): add claude-stream parser with tool_use→toolCall transform"
```

### Task 19: Implement `runClaudeHeadless` (spawn, parse, session-id extraction)

**Files:**
- Modify: `pi-extension/subagents/backends/headless.ts` (overwrite the Phase 2 Claude stub)

- [ ] **Step 1: Replace the `runClaudeHeadless` stub**

In `pi-extension/subagents/backends/headless.ts`, add imports at the top:

```ts
import { parseClaudeStreamEvent, parseClaudeResult } from "./claude-stream.ts";
```

Replace the `runClaudeHeadless` stub with:

```ts
async function runClaudeHeadless(p: RunParams): Promise<BackendResult> {
  const { task, name, startTime, abort, ctx: _ctx } = p;
  const messages: Message[] = [];
  let usage: UsageStats = emptyUsage();
  let stderr = "";
  let terminalResult: ReturnType<typeof parseClaudeResult> | null = null;
  let sessionId: string | undefined;

  const args: string[] = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
  ];
  if (task.model) {
    // Strip provider prefix ("anthropic/" etc.) for Claude CLI.
    const slashIdx = task.model.indexOf("/");
    args.push("--model", slashIdx >= 0 ? task.model.slice(slashIdx + 1) : task.model);
  }
  if (task.thinking) {
    const effortMap: Record<string, string> = {
      off: "low", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
    };
    const effort = effortMap[task.thinking.toLowerCase()];
    if (effort) args.push("--effort", effort);
  }
  if (task.systemPrompt) {
    args.push("--system-prompt", task.systemPrompt);
  }
  if (task.tools) {
    const claudeTools = new Set<string>();
    const map: Record<string, string> = {
      read: "Read", write: "Write", edit: "Edit",
      bash: "Bash", grep: "Grep", find: "Glob", ls: "Glob",
    };
    for (const t of task.tools.split(",").map((s) => s.trim()).filter(Boolean)) {
      const mapped = map[t.toLowerCase()];
      if (mapped) claudeTools.add(mapped);
    }
    if (claudeTools.size > 0) args.push("--allowedTools", [...claudeTools].join(","));
  }
  args.push("--", task.task);

  if (abort.aborted) {
    return makeAbortedResult(name, startTime, messages, usage);
  }

  return new Promise<BackendResult>((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("claude", args, {
        cwd: task.cwd ?? p.ctx.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (err: any) {
      resolve({
        name, finalMessage: "", transcriptPath: null, exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err?.message ?? String(err),
      });
      return;
    }

    const lb = new LineBuffer();
    let wasAborted = false;

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
        sessionId = event.session_id;
      }
      if (event.type === "result") {
        terminalResult = parseClaudeResult(event);
        usage = terminalResult.usage;
        if (terminalResult.finalOutput) {
          messages.push({
            role: "assistant",
            content: [{ type: "text", text: terminalResult.finalOutput }],
          } as unknown as Message);
        }
      } else {
        const msg = parseClaudeStreamEvent(event);
        if (msg) messages.push(msg as Message);
      }
    };

    proc.stdout!.on("data", (data: Buffer) => {
      for (const line of lb.push(data.toString())) processLine(line);
    });
    proc.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const onAbort = () => {
      wasAborted = true;
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        if (!proc.killed) {
          try { proc.kill("SIGKILL"); } catch {}
        }
      }, 5000);
    };
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      resolve({
        name, finalMessage: "", transcriptPath: null, exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err.code === "ENOENT"
          ? "claude CLI not found on PATH"
          : err.message || String(err),
      });
    });

    proc.on("close", async (code) => {
      for (const line of lb.flush()) processLine(line);
      const elapsedMs = Date.now() - startTime;
      const exitCode = code ?? 0;
      const finalMessage = terminalResult?.finalOutput ?? "";
      // Archive transcript via session-id slug reconstruction.
      const transcriptPath = sessionId ? await archiveClaudeTranscript(sessionId, task.cwd ?? p.ctx.cwd) : null;

      if (wasAborted) {
        resolve({
          name, finalMessage, transcriptPath, exitCode: 1, elapsedMs,
          error: "aborted", sessionId, usage, messages,
        });
        return;
      }
      if (exitCode !== 0 || terminalResult?.error) {
        resolve({
          name, finalMessage, transcriptPath, exitCode: exitCode !== 0 ? exitCode : 1, elapsedMs,
          error: terminalResult?.error ?? (stderr.trim() || `claude exited with code ${exitCode}`),
          sessionId, usage, messages,
        });
        return;
      }
      if (!terminalResult) {
        resolve({
          name, finalMessage, transcriptPath, exitCode: 1, elapsedMs,
          error: "child exited without completion event",
          sessionId, usage, messages,
        });
        return;
      }
      resolve({
        name, finalMessage, transcriptPath, exitCode: 0, elapsedMs,
        sessionId, usage, messages,
      });
    });
  });
}

/**
 * Claude CLI persists its session to ~/.claude/projects/<cwd-slug>/<session_id>.jsonl.
 * Copy it to our archive root (~/.pi/agent/sessions/claude-code/) so callers
 * have a stable path. Retry-poll for up to 2s to tolerate the CLI's file-write
 * timing on process close. Returns null on persistent absence.
 */
async function archiveClaudeTranscript(sessionId: string, cwd: string): Promise<string | null> {
  const cwdSlug = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  const sourceDir = join(homedir(), ".claude", "projects", `-${cwdSlug}-`);
  const source = join(sourceDir, `${sessionId}.jsonl`);
  const destDir = join(homedir(), ".pi", "agent", "sessions", "claude-code");
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, `${sessionId}.jsonl`);

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (existsSync(source)) {
      try {
        copyFileSync(source, dest);
        return dest;
      } catch {
        // fall through to retry
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  process.stderr.write(
    `[pi-interactive-subagent] Claude session file not found at ${source} after 2s; ` +
      `transcriptPath will be null. Set a longer poll window if this happens often.\n`,
  );
  return null;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | head -40`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add pi-extension/subagents/backends/headless.ts
git commit -m "feat(backends): implement headless Claude path with session-id archival"
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
      { agent: "scout", task: "Reply with exactly: OK", cli: "claude" },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);
    assert.ok(result.finalMessage.trim().length > 0, "finalMessage must be non-empty");
    assert.ok(result.usage, "usage must be set");
    assert.ok(result.usage!.cost >= 0, "usage.cost must be set (may be 0 for cached)");
    assert.ok(result.usage!.turns >= 1, `usage.turns must be >=1, got ${result.usage!.turns}`);
    assert.ok(result.sessionId, "sessionId must be populated from system/init event");
    assert.ok(result.messages && result.messages.length > 0, "messages array must be non-empty");
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
 * the parsed messages array contains a toolCall entry. Exercises the
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

  it("captures a mid-stream toolCall entry in messages[]", async () => {
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
        agent: "scout",
        task: "Read the file marker.txt in the current directory and print its contents verbatim.",
        cli: "claude",
        tools: "read",
      },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);
    const toolCalls = (result.messages ?? [])
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .filter((c: any) => c.type === "toolCall");
    assert.ok(toolCalls.length > 0, "messages[] must include at least one toolCall entry");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- --test-name-pattern='headless-tool-use' 2>&1 | tail -30`
Expected: PASS or skipped.

- [ ] **Step 3: Commit**

```bash
git add test/integration/headless-tool-use.test.ts
git commit -m "test(integration): verify mid-stream tool_use transformation against real Claude CLI"
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
      { agent: "scout", task: "Reply: OK", cli: "claude" },
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
      {
        agent: "scout",
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

### Task 24: Phase 3 gate — full suite green

**Files:** none modified; read-only gate.

- [ ] **Step 1: Run all tests**

Run: `npm test 2>&1 | tail -40 && npm run test:integration 2>&1 | tail -60`
Expected: every test passes or skips cleanly. No unexpected failures.

- [ ] **Step 2: Inspect the tool-restriction patch as a discrete commit**

Run: `git log --oneline -- pi-extension/subagents/index.ts | head -5`
Expected: the most recent commit touching `index.ts` is the named `feat(subagents): emit --allowedTools ...` from Task 17 — ready to cherry-pick into an upstream PR alongside the existing `thinking` commit.

---

## Phase 4 — Enrich `OrchestrationResult` + docs

Phase 4 finalizes the `OrchestrationResult` shape, wires `onUpdate` from headless into the orchestration tool handlers, and updates the README. (If `OrchestrationResult` was already extended opportunistically in Phase 1, this phase is a short docs+callback pass.)

### Task 25: Add optional fields to `OrchestrationResult`

**Files:**
- Modify: `pi-extension/orchestration/types.ts`

- [ ] **Step 1: Check whether the fields are already present from Task 8/11**

Run: `grep -n 'usage\|messages' pi-extension/orchestration/types.ts`
Expected: either the fields are present (done) or absent (apply Step 2).

- [ ] **Step 2: If absent, append the fields and re-export `UsageStats` + `Message`**

In `pi-extension/orchestration/types.ts`, add imports and extend the `OrchestrationResult` interface:

```ts
import type { UsageStats } from "../subagents/backends/types.ts";
import type { Message } from "@mariozechner/pi-ai";

export type { UsageStats, Message };

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
  /** Populated by the headless backend only in v1. */
  messages?: Message[];
}
```

- [ ] **Step 3: Typecheck the full project**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: no errors.

- [ ] **Step 4: Invariant check — sweep callers for destructure-without-optional-chaining**

Run: `grep -rn 'finalMessage\|exitCode\|transcriptPath\|usage\|messages' pi-config/agent/skills/ 2>/dev/null | grep -v '?' | head -20 || echo "pi-config not on this host"`
Expected: either the "not on this host" message, or a short list. Manually inspect each hit to confirm no existing caller destructures `usage` / `messages` without optional chaining. If a consumer does, note it in the commit body as a known regression surface for follow-up.

- [ ] **Step 5: Commit**

```bash
git add pi-extension/orchestration/types.ts
git commit -m "feat(orchestration): add optional usage/messages fields on OrchestrationResult"
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
    task: OrchestrationTask,
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

- [ ] **Step 2: Pipe `onUpdate` from the headless watch through to per-event callbacks**

In `pi-extension/subagents/backends/headless.ts`, change `watch` to accept `onUpdate` and pass it down to the run-helpers; inside both `runPiHeadless` and `runClaudeHeadless`, call `onUpdate?.({ ...snapshot })` after each `messages.push(...)` / `usage` mutation, passing a current partial shape:

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
// in the stream-json callbacks:
emitPartial(currentOnUpdate, {
  name, finalMessage: getFinalOutput(messages), transcriptPath: null,
  exitCode: 0, elapsedMs: Date.now() - startTime, usage, messages,
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
          messages: partial.messages,
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
- **headless** (default when no multiplexer is available) — spawns each subagent as a child process with piped stdio and parses stream-json. Works in CI, headless SSH sessions, and IDE-embedded terminals. Populates `usage` (tokens, cost, turns) and `messages[]` (full parsed transcript) on the orchestration result.

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
| `transcriptPath` | both                   | Path to the archived session file under `~/.pi/agent/sessions/`.      |
| `exitCode`       | both                   | 0 on success, 1 on error / cancellation.                              |
| `elapsedMs`      | both                   | Wall time from launch to completion.                                  |
| `sessionId`      | both (Claude only)     | Claude session id — useful for `subagent_resume`.                     |
| `error`          | both                   | Non-empty when the run didn't cleanly finish.                         |
| `usage`          | **headless only (v1)** | `{ input, output, cacheRead, cacheWrite, cost, contextTokens, turns }` |
| `messages`       | **headless only (v1)** | Full parsed assistant + tool-result message array.                    |

The `usage` / `messages` fields are `undefined` on pane-backend results in v1; enriching the pane path is tracked as follow-up work.

## Tool restriction

Agents declaring `tools:` frontmatter have that restriction enforced in **both** backends for both CLIs (`pi` and `claude`). On the Claude path, the pi tool names are mapped to the equivalent Claude tools (`read → Read`, `bash → Bash`, `find`/`ls → Glob`, etc.) and emitted as `--allowedTools`. Agents without `tools:` frontmatter still run with full tool access on both CLIs.
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
Expected: the most recent two touching `index.ts` are (a) `feat(subagents): emit --allowedTools ...` (Task 17) and (b) an earlier `thinking` patch. Both are portable as-is to an upstream PR.

- [ ] **Step 3: Final commit (if README or test-list adjustments happened during the sweep)**

If nothing to commit, skip. Otherwise:

```bash
git add -A
git commit -m "chore(mux-free): finalize suite sweep and patch inspection"
```

---

## Out of scope reminders

The following are **explicitly out of scope for this plan** (see the spec for rationale):

- Symmetric observability on the pane backend (`usage` / `messages` / `onUpdate` on pane results). Deferred.
- `fallbackModels` replacement. Skills own fallback.
- Numeric recursion depth guard. `spawning: false` remains the convention.
- Skills migration from the old `subagent { chain / tasks }` surface. Tracked in the fork-design spec.
- Retiring `pi-subagent`. Gated on skills migration + fallback story + soak.
- Real CI enablement for integration tests (provisioning CLIs and API keys in runners).
- Plumbing the `interactive` schema field as a real behavioral switch. Vestigial in v1.

When implementing, if a task's scope drifts into any of the above, stop and note the drift in the PR description — do not expand the plan inline.
