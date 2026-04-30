# Mux-Free Execution Implementation Plan (v3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a headless (stdio-piped, stream-json) execution backend alongside the existing pane backend in the `pi-interactive-subagent` fork, so that `subagent_serial` / `subagent_parallel` work in environments without a supported multiplexer (CI, headless SSH, IDE terminals). Close two adjacent gaps vs. the old `pi-subagent` extension: populate `usage` / `messages[]` on `OrchestrationResult` from the headless path, and fix the tool-restriction security regression on the Claude path via an upstream-portable patch.

**What's new in v3 (vs. v2):** the two blocking review-v2 findings and three non-blocking notes from `.pi/plans/reviews/2026-04-20-mux-free-execution-design-review-v3.md` are remediated — see the "v3 changelog" section at the bottom of this document for the full list. In summary: (1) a real `tsconfig.json` plus a `typecheck` npm script are added in a new Phase 0 prep task (Task 0) so every type-gate across the plan is runnable as `npm run typecheck`; (2) the headline no-mux integration test (Task 23b) now uses a fake `ExtensionAPI` that implements the full set of methods `subagentsExtension(...)` touches during initialization (`registerTool`, `registerCommand`, `registerMessageRenderer`, `on`, `emit`); (3) `preflightOrchestration.ts` uses a static import (no `require()`) and exposes a `__test__` hook so unit tests can swap the mux probe deterministically; (4) the pi transcript-archival test and README copy describe session paths as "under the resolved session root" rather than an unconditional `~/.pi/agent/sessions/...` (Claude's archive path remains the hardcoded `~/.pi/agent/sessions/claude-code/` tree it has always been); (5) the preflight pane-mode test uses the injected mux-probe hook rather than the host-dependent `TMUX=/tmp/tmux-fake` env trick.

**Architecture (v3 — three layered changes, unchanged from v2):**

1. **Shared launch resolution above the backend seam.** Lift the launch normalization currently buried inside `launchSubagent()` into a pure `resolveLaunchSpec()` helper (new `pi-extension/subagents/launch-spec.ts`). The spec resolves agent defaults (`model` / `tools` / `skills` / `thinking` / `cli` / `body`), `cwd` and config-root (`localAgentDir` vs. propagated `PI_CODING_AGENT_DIR`), `system-prompt` mode (append/replace/agent-body fallback), seeded session / `fork` / `session-mode` lineage, artifact-backed task delivery, deny-tools, auto-exit, skill prompt expansion, `subagent-done` extension wiring, `subagentSessionFile` placement under `getDefaultSessionDirFor(...)`, and `resumeSessionId`. Both backends consume the same spec — they differ only in transport, observation, and archival. This eliminates the v1 risk of headless mode silently dropping or reinterpreting major chunks of the existing launch contract.
2. **Backend interface + selector.** Introduce a `Backend` interface in a new `pi-extension/subagents/backends/` directory with two implementations — `pane.ts` (thin adapter over the existing `launchSubagent` / `watchSubagent` — zero movement of upstream behavior) and `headless.ts` (new stream-json implementation that consumes a `ResolvedLaunchSpec` and spawns the CLI with piped stdio). Selection happens once per `makeDefaultDeps` call via `selectBackend()`, which honors `PI_SUBAGENT_MODE=pane|headless|auto` and falls back to mux detection when set to `auto` (default). `orchestration/default-deps.ts` routes through `selectBackend()`; the orchestration cores `run-serial` / `run-parallel` stay untouched. `OrchestrationResult` gains optional `usage?: UsageStats` and `messages?: Message[]` fields populated by the headless backend only (pane leaves them `undefined`, deferred to a follow-up spec).
3. **Backend-aware orchestration preflight.** A new `preflightOrchestration()` is registered for `subagent_serial` / `subagent_parallel` in place of `preflightSubagent`. It only requires a multiplexer when `selectBackend()` resolves `pane`. When `selectBackend()` returns `headless`, the orchestration tools execute against the headless backend without raising the mux error. The bare `subagent` tool keeps using `preflightSubagent` unchanged in v1 (its single-pane TUI assumption is unchanged). End-to-end tests invoke the real registered tool's `execute` callback in a no-mux environment to prove the path is reachable from the actual orchestration entrypoint.

A second named-commit patch to `pi-extension/subagents/index.ts` adds `PI_TO_CLAUDE_TOOLS` mapping + `--allowedTools` emission inside `buildClaudeCmdParts`, fixing tool restriction for both backends.

**Tech Stack:** TypeScript (Node's native `--test` runner, `node:assert/strict`), `@sinclair/typebox` for tool schemas, `@mariozechner/pi-coding-agent` for the extension API, `@mariozechner/pi-ai` for the `Message` type (added as a direct `devDependencies` + `peerDependencies` entry by Task 4 — see review note 3 — rather than relying on transitive resolution from upstream), `node:child_process` `spawn` for stdio-piped CLI launch.

---

## File Structure

**New files (shared launch resolution + headless backend + tests + typecheck wiring):**
- `tsconfig.json` — new minimal project config so `tsc --noEmit` is runnable via `npm run typecheck`. Non-strict (kept permissive so the existing codebase typechecks without forced refactors) — the gate catches gross type breakage when new files land. Added by Task 0.
- `pi-extension/subagents/launch-spec.ts` — pure `resolveLaunchSpec()` extracted from `launchSubagent()`; produces a `ResolvedLaunchSpec` consumed by both backends.
- `pi-extension/subagents/backends/types.ts` — `Backend` interface, `BackendResult`, `UsageStats`, shared re-exports of `LaunchedHandle` / `OrchestrationTask` / `ResolvedLaunchSpec`.
- `pi-extension/subagents/backends/pane.ts` — thin adapter over existing `launchSubagent` + `watchSubagent` (~30 LOC).
- `pi-extension/subagents/backends/headless.ts` — new stream-json implementation for both pi and Claude. Consumes `ResolvedLaunchSpec` for parity with the pane path (~500–600 LOC).
- `pi-extension/subagents/backends/select.ts` — `selectBackend()` resolver (`PI_SUBAGENT_MODE` + mux fallback, ~30 LOC).
- `pi-extension/subagents/backends/claude-stream.ts` — `parseClaudeStreamEvent` + `parseClaudeResult` + `ClaudeUsage` type. Lifted from `pi-subagent/claude-args.ts:153-204` (adapted, not copy-pasted).
- `pi-extension/subagents/preflight-orchestration.ts` — backend-aware preflight gate used by `subagent_serial` / `subagent_parallel`; only requires mux when `selectBackend() === "pane"`.
- `test/orchestration/select-backend.test.ts` — `PI_SUBAGENT_MODE` resolution + mux fallback unit tests.
- `test/orchestration/preflight-orchestration.test.ts` — verifies orchestration preflight passes in headless mode without mux, and still surfaces `no session file` errors in both modes.
- `test/orchestration/launch-spec.test.ts` — unit tests for `resolveLaunchSpec()` (model/tools/skills/thinking/cli/cwd/system-prompt-mode/session-mode/deny-tools/auto-exit/skill-prompts/`resumeSessionId`).
- `test/orchestration/line-buffer.test.ts` — partial-line buffering across chunk boundaries.
- `test/orchestration/headless-abort.test.ts` — mocked-spawn SIGTERM → 5s → SIGKILL timing keyed off an explicit `exited` flag (not `proc.killed`).
- `test/orchestration/claude-event-transform.test.ts` — pure `parseClaudeStreamEvent` tool_use → toolCall transformation; also covers Claude headless `--resume` arg construction.
- `test/integration/pi-pane-smoke.test.ts` — smoke test for the existing pane path (pi agent).
- `test/integration/orchestration-headless-no-mux.test.ts` — invokes the real `subagent_serial` / `subagent_parallel` registered tool callbacks under `PI_SUBAGENT_MODE=headless`, proving the orchestration entrypoint reaches headless without raising the mux error.
- `test/integration/headless-pi-smoke.test.ts` — headless pi path (uses repo-local `test-echo` agent).
- `test/integration/headless-claude-smoke.test.ts` — headless Claude path (no agent — direct fields).
- `test/integration/headless-tool-use.test.ts` — mid-stream tool-use parsing (uses repo-local `test-echo` agent which already declares `tools: read, bash, write, edit`).
- `test/integration/headless-transcript-archival.test.ts` — archival of pi + Claude transcripts.
- `test/integration/headless-abort-integration.test.ts` — long-running task abort.
- `test/integration/headless-enoent.test.ts` — CLI-not-on-PATH error path.
- `test/integration/headless-claude-resume.test.ts` — `resumeSessionId` round-trip for headless Claude (a focused gate for review finding 4).

**Modified files (narrow changes):**
- `pi-extension/subagents/cmux.ts` — export a named `detectMux()` alias around existing `isMuxAvailable()` (for backend selection consumers).
- `pi-extension/subagents/index.ts` — three carried changes:
  1. **Refactor** `launchSubagent()` to delegate launch normalization to `resolveLaunchSpec()` (Task 10b). Behavior-preserving — pane tests must remain green.
  2. **Second named patch** alongside the existing `thinking` patch: add `effectiveTools?: string` to `ClaudeCmdInputs`, route it into `buildClaudeCmdParts`, add shared `PI_TO_CLAUDE_TOOLS` constant and `--allowedTools` emission (Task 17).
  3. **Registration wiring** swaps `preflightSubagent` for `preflightOrchestration` on the orchestration tools only (Task 7b).
- `pi-extension/orchestration/types.ts` — add optional `usage?: UsageStats` and `messages?: Message[]` fields to `OrchestrationResult`. Re-export `UsageStats` from the backends module.
- `pi-extension/orchestration/default-deps.ts` — rewire `launch` / `waitForCompletion` to dispatch through `selectBackend()` at module construction, preserving the `handleToRunning` bookkeeping and signal forwarding contract for the pane path, and adding equivalent bookkeeping for headless.
- `package.json` — two additions: (1) a new `"typecheck": "tsc --noEmit"` script entry under `scripts` (Task 0), and (2) `@mariozechner/pi-ai` in both `peerDependencies` and `devDependencies` so the headless backend's `Message` import is no longer dependent on transitive resolution from upstream (Task 4 Step 2, review-v2 note 3).
- `README.md` — section describing `PI_SUBAGENT_MODE`, the headless backend's capabilities/limitations, and the new `usage` / `messages` fields. Tool-restriction behavior for Claude is called out as a security fix (both backends).

---

## Phase 0 — Baseline pane tests + typecheck wiring

Phase 0 establishes a regression safety net for the existing pane path before any refactor, and wires up the `npm run typecheck` gate that every subsequent phase relies on (review-v3 blocking finding 1 — the v2 plan called `npx tsc --noEmit` in six places but no `tsconfig.json` existed in this repo).

Phase 0's gate into Phase 1: Task 0's typecheck is runnable cleanly against the current codebase, **and** the three Phase 0 baseline integration tests below (or their reasonable skip-paths) pass locally.

### Task 0: Wire up `npm run typecheck` so every subsequent type-gate is runnable

**Files:**
- Create: `tsconfig.json`
- Modify: `package.json` (add `"typecheck"` script)

This Task closes review-v3 blocking finding 1. The v2 plan calls `npx tsc --noEmit` six times as a pass/fail gate, but the repo has no `tsconfig.json` today. Running `npx tsc --noEmit` from a fresh clone prints the TypeScript help banner and exits non-zero, which makes every downstream "Expected: no errors" step impossible to satisfy as written. We fix this by adding a minimal `tsconfig.json` that matches how Node runs the code today (native TypeScript stripping via `node --test`, `.ts` suffix imports) and a `typecheck` script that wires `tsc --noEmit` to it.

The config is **intentionally permissive** — `strict: false`, `noImplicitAny: false`. The gate's purpose is to catch gross type breakage introduced by new files (missing imports, wrong shapes, typos in exported identifier names) without forcing an audit of the entire existing codebase before Phase 1 can start. If a future hardening pass wants `strict: true`, that's a separate follow-up.

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

- [ ] **Step 4: Run the typecheck against the current codebase**

Run: `npm run typecheck 2>&1 | tail -40`
Expected: **clean exit (code 0), no errors**. If errors do surface, they represent pre-existing issues in the codebase that were invisible before. Triage:
- If the error is a trivial missing import / wrong identifier in code touched by Phase 0+ work, fix it in place.
- If it's a pre-existing cross-cutting issue (e.g. the upstream `ExtensionAPI` type drifted), relax the corresponding option in `tsconfig.json` (e.g. add `"skipLibCheck": true` if not already present, or scope `exclude` more narrowly) — not the code.
- If the error is in `pi-extension/subagents/plugin/**`, widen the `exclude` glob. That directory is carried verbatim from the Claude plugin and is not part of our TypeScript surface.

The goal is a green baseline so subsequent tasks can trust `npm run typecheck` as a real signal.

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json package.json package-lock.json
git commit -m "build(typecheck): add tsconfig.json and npm run typecheck for downstream type gates"
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

Selector behavior in Phase 1: `selectBackend()` honors `PI_SUBAGENT_MODE` and the auto/no-mux fallback exactly as it will in Phase 2 (see Task 7 below). The Phase 1 `HeadlessBackend` is a stub that throws "not implemented" — so anyone who explicitly resolves to headless (either via `PI_SUBAGENT_MODE=headless` or via auto-no-mux) gets a clean, actionable error rather than silent fallback. Phase 2 replaces the stub with the real implementation; the selector itself is final after Task 7. The bare `subagent` tool keeps using `preflightSubagent` and continues to require mux in Phase 1 — the orchestration tools route through `preflightOrchestration` (Task 7b) and are the only tools whose mux requirement becomes conditional.

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

- [ ] **Step 2: Add `@mariozechner/pi-ai` as a direct dependency**

Do not rely on transitive resolution from `@mariozechner/pi-coding-agent` — review v2 note 3 calls this out explicitly. Edit `package.json` to add the package to both dependency fields:

```jsonc
{
  "peerDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "@sinclair/typebox": "*"
  },
  "devDependencies": {
    "@mariozechner/pi-ai": "^0.65.0",
    "@mariozechner/pi-coding-agent": "^0.65.0",
    "@mariozechner/pi-tui": "^0.65.0",
    "@sinclair/typebox": "^0.34.49"
  }
}
```

Use the same version constraint that upstream `@mariozechner/pi-coding-agent` publishes today (check `node_modules/@mariozechner/pi-coding-agent/package.json`'s dependency on `pi-ai`). If they diverge, prefer the version already resolved by upstream so layout stays consistent. Then reinstall:

Run: `npm install 2>&1 | tail -5`
Expected: installation succeeds; `ls node_modules/@mariozechner/pi-ai/` shows the package.

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck 2>&1 | tail -40`
Expected: no errors mentioning `backends/types.ts` or the `Message` import.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json pi-extension/subagents/backends/types.ts
git commit -m "feat(backends): define Backend interface, shared result types, and add pi-ai direct dep"
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

### Task 7b: Add backend-aware `preflightOrchestration` and wire it into orchestration tool registration

**Files:**
- Create: `pi-extension/subagents/preflight-orchestration.ts`
- Modify: `pi-extension/subagents/index.ts` (registration call only — line ~1794-1799)
- Create: `test/orchestration/preflight-orchestration.test.ts`

This Task closes review finding 1 (the headline no-mux orchestration path being blocked at preflight before backend selection). The bare `subagent` tool keeps using `preflightSubagent` unchanged. The orchestration tools route through a new gate that only requires mux when `selectBackend()` resolves `pane`.

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

const MUX_KEYS = ["CMUX_SOCKET_PATH", "TMUX", "ZELLIJ", "WEZTERM_UNIX_SOCKET"];
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
 * Orchestration-tool preflight gate.
 *
 * Differs from preflightSubagent (used by the bare `subagent` tool) in
 * one specific way: it consults selectBackend() and only requires a
 * multiplexer when the active backend is "pane". When the active
 * backend is "headless" (either because PI_SUBAGENT_MODE=headless was
 * set, or because no mux was detected in auto mode), the mux error is
 * suppressed — orchestration runs against the headless backend.
 *
 * The session-file check is unchanged: orchestration always needs a
 * persistent parent session to resolve artifact paths and sessionDir
 * placement. That requirement holds in both backends.
 *
 * The bare `subagent` tool intentionally keeps using preflightSubagent
 * (mux-required) in v1 — its single-pane TUI assumption hasn't changed.
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

- [ ] **Step 4: Wire `preflightOrchestration` into orchestration tool registration**

In `pi-extension/subagents/index.ts`, replace the `preflightSubagent` argument with `preflightOrchestration` in the orchestration registration call. Currently around line 1794-1799:

```ts
import { preflightOrchestration } from "./preflight-orchestration.ts";
// ...
registerOrchestrationTools(
  pi,
  (ctx) => makeDefaultDeps(ctx),
  shouldRegister,
  preflightOrchestration,    // was preflightSubagent
  selfSpawnBlocked,
);
```

The bare `subagent` tool registration (which uses `preflightSubagent` directly inside its `execute`) is untouched.

- [ ] **Step 5: Re-run the unit tests; expect all pass**

Run: `npm test -- --test-name-pattern='preflightOrchestration' 2>&1 | tail -30`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add pi-extension/subagents/preflight-orchestration.ts test/orchestration/preflight-orchestration.test.ts pi-extension/subagents/index.ts
git commit -m "feat(orchestration): backend-aware preflight unblocks no-mux subagent_serial/parallel"
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
  /** Wrapped task body (with role block + mode hint + summary instruction) for blank-session modes. Equals raw task in fork mode. */
  fullTask: string;

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
- `skillPrompts` — current `buildPiPromptArgs()`'s skill expansion at line 619-625, broken out so the headless backend can prepend them to the `--message`/positional task.
- `configRootEnv` — equivalent to lines 877-881: `{ PI_CODING_AGENT_DIR: ... }` only when applicable.
- `autoExit` — `agentDefs?.autoExit === true`.
- `artifactDir` — `getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId())`.
- `resumeSessionId / focus` — pass-throughs from params.

Also expose `agentDefs` and the underlying agent body so the pane Claude path (which calls `buildClaudeCmdParts({ appendSystemPrompt: params.systemPrompt ?? agentDefs?.body, ... })`) and the headless Claude path can both compute the same `appendSystemPrompt`.

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

Move the artifact-write side-effects (system-prompt file at line 855-858, task artifact at line 905-916) from `launchSubagent` into helper functions inside `launch-spec.ts` (e.g. `writeSystemPromptArtifact(spec)`, `writeTaskArtifact(spec)`) so the pane and headless paths share them. Pane keeps calling them; headless calls them too when `spec.taskDelivery === "artifact"`.

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
import type { Message } from "@mariozechner/pi-ai";
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
  BackendResult,
  LaunchedHandle,
  OrchestrationTask,
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
      task: OrchestrationTask,
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
      // semantics match the pane path 1:1.
      const spec = resolveLaunchSpec(
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
          focus: task.focus,
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

/** PI CLI headless path — spawn pi consuming the resolved launch spec. */
async function runPiHeadless(p: RunParams): Promise<BackendResult> {
  const { spec, startTime, abort, ctx } = p;
  const messages: Message[] = [];
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

  if (abort.aborted) return makeAbortedResult(spec, startTime, messages, usage);

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
          if (stop === "endTurn" || stop === "stop" || stop === "error") terminalEvent = true;
        }
      } else if (event.type === "tool_result_end" && event.message) {
        messages.push(event.message as Message);
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
      const final = getFinalOutput(messages);

      if (wasAborted) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode: 1, elapsedMs, error: "aborted", usage, messages });
        return;
      }
      if (exitCode !== 0) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode, elapsedMs,
                  error: stderr.trim() || `pi exited with code ${exitCode}`,
                  usage, messages });
        return;
      }
      if (!terminalEvent) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode: 1, elapsedMs,
                  error: "child exited without completion event", usage, messages });
        return;
      }
      resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                exitCode: 0, elapsedMs, usage, messages });
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
  messages: Message[],
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
    messages,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck 2>&1 | tail -40`
Expected: no errors. If `OrchestrationResult` still lacks `usage` / `messages`, see Task 25 Step 2 and apply now.

- [ ] **Step 3: Commit**

```bash
git add pi-extension/subagents/backends/headless.ts
git commit -m "feat(backends): add headless pi implementation driven by ResolvedLaunchSpec"
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

  it("runs a trivial pi task and returns non-empty usage + messages + transcript", async () => {
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
      assert.ok(result.messages && result.messages.length > 0, "messages array must be non-empty");
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

### Task 19: Implement `runClaudeHeadless` driven by `ResolvedLaunchSpec` (spawn, parse, session-id extraction, `--resume` support)

**Files:**
- Modify: `pi-extension/subagents/backends/headless.ts` (overwrite the Phase 2 Claude stub)
- Modify: `pi-extension/subagents/backends/claude-stream.ts` (add a pure `buildClaudeHeadlessArgs(spec)` so unit tests can assert arg construction without spawning Claude)

This Task closes review findings 2 (parity) and 4 (`resumeSessionId`). The pi headless path already consumes `ResolvedLaunchSpec`; the Claude headless path now does too. Specifically the Claude args include:

- `--model <claude-id>` derived from `spec.effectiveModel` (provider prefix stripped for Claude CLI)
- `--effort <off|low|medium|high|max>` derived from `spec.effectiveThinking`
- `--allowedTools <Mapped,Names>` from `spec.effectiveTools` via `PI_TO_CLAUDE_TOOLS` (also added to the pane builder by Task 17 — both backends call the same map)
- `--append-system-prompt <body-or-systemPrompt>` from `spec.identity` when applicable. When `spec.systemPromptMode === "replace"`, the equivalent Claude flag is `--system-prompt`. The flag selection mirrors pane: `params.systemPrompt ?? agentDefs?.body` is the source of truth.
- `--resume <id>` from `spec.resumeSessionId` — review finding 4 (was dropped in v1).
- task body: `spec.fullTask` for `direct` delivery (i.e. fork mode), or the artifact-handoff text for `artifact` delivery (Claude CLI does not consume `@<path>`, so we read the artifact file's content into the prompt for the artifact case)

The abort escalation uses the same `exited`-flag pattern as `runPiHeadless` (review finding 3).

- [ ] **Step 1: Add a pure arg-builder + write a failing test**

In `pi-extension/subagents/backends/claude-stream.ts`, append:

```ts
import type { ResolvedLaunchSpec } from "../launch-spec.ts";

/** Map pi tool names to Claude CLI --allowedTools names. Mirrors the pane builder (Task 17). */
const PI_TO_CLAUDE_TOOLS: Record<string, string> = {
  read: "Read", write: "Write", edit: "Edit",
  bash: "Bash", grep: "Grep", find: "Glob", ls: "Glob",
};

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
    if (claudeTools.size > 0) args.push("--allowedTools", [...claudeTools].join(","));
  }
  if (spec.resumeSessionId) {
    args.push("--resume", spec.resumeSessionId);
  }
  args.push("--", taskText);
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
    systemPromptMode: undefined, fullTask: "do",
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

  it("emits --allowedTools with mapped Claude tool names; drops unknowns", () => {
    const args = buildClaudeHeadlessArgs(
      { ...baseSpec, effectiveTools: "read, bash, find, ls, unknown" }, "do");
    const idx = args.indexOf("--allowedTools");
    assert.notEqual(idx, -1);
    const mapped = new Set(args[idx + 1].split(","));
    assert.ok(mapped.has("Read"));
    assert.ok(mapped.has("Bash"));
    assert.ok(mapped.has("Glob"));    // find + ls both map to Glob, deduped
    assert.ok(!mapped.has("unknown"));
  });
});
```

Run: `npm test -- --test-name-pattern='buildClaudeHeadlessArgs' 2>&1 | tail -30`
Expected: FAIL — `buildClaudeHeadlessArgs` does not exist yet.

- [ ] **Step 2: Replace the `runClaudeHeadless` stub**

In `pi-extension/subagents/backends/headless.ts`, add imports at the top:

```ts
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { buildClaudeHeadlessArgs, parseClaudeStreamEvent, parseClaudeResult } from "./claude-stream.ts";
```

Replace the `runClaudeHeadless` stub with:

```ts
async function runClaudeHeadless(p: RunParams): Promise<BackendResult> {
  const { spec, startTime, abort, ctx } = p;
  const messages: Message[] = [];
  let usage: UsageStats = emptyUsage();
  let stderr = "";
  let terminalResult: ReturnType<typeof parseClaudeResult> | null = null;
  let sessionId: string | undefined;

  // Body of the prompt:
  //   - direct delivery (fork): spec.fullTask is the raw task (parent context inherited)
  //   - artifact delivery: Claude CLI doesn't accept @file, so we read the
  //     materialized task artifact and inline its contents.
  let taskText: string;
  if (spec.taskDelivery === "direct") {
    taskText = spec.fullTask;
  } else {
    const artifactPath = writeTaskArtifact(spec);
    taskText = readFileSync(artifactPath, "utf8");
  }

  const args = buildClaudeHeadlessArgs(spec, taskText);

  if (abort.aborted) return makeAbortedResult(spec, startTime, messages, usage);

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
        ? await archiveClaudeTranscript(sessionId, spec.effectiveCwd ?? ctx.cwd)
        : null;

      if (wasAborted) {
        resolve({ name: spec.name, finalMessage, transcriptPath, exitCode: 1, elapsedMs,
                  error: "aborted", sessionId, usage, messages });
        return;
      }
      if (exitCode !== 0 || terminalResult?.error) {
        resolve({ name: spec.name, finalMessage, transcriptPath,
                  exitCode: exitCode !== 0 ? exitCode : 1, elapsedMs,
                  error: terminalResult?.error
                    ?? (stderr.trim() || `claude exited with code ${exitCode}`),
                  sessionId, usage, messages });
        return;
      }
      if (!terminalResult) {
        resolve({ name: spec.name, finalMessage, transcriptPath, exitCode: 1, elapsedMs,
                  error: "child exited without completion event",
                  sessionId, usage, messages });
        return;
      }
      resolve({ name: spec.name, finalMessage, transcriptPath, exitCode: 0, elapsedMs,
                sessionId, usage, messages });
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
      } catch { /* retry */ }
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

- [ ] **Step 3: Run all unit tests**

Run: `npm test 2>&1 | tail -40`
Expected: every unit test passes, including `buildClaudeHeadlessArgs` (5 cases) and the existing `parseClaudeStreamEvent` / `parseClaudeResult` cases.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck 2>&1 | tail -40`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add pi-extension/subagents/backends/headless.ts pi-extension/subagents/backends/claude-stream.ts test/orchestration/claude-event-transform.test.ts
git commit -m "feat(backends): headless Claude consumes ResolvedLaunchSpec; thread --resume; exit-tracked SIGKILL"
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

### Task 23b: Integration test — `subagent_serial` / `subagent_parallel` reach headless in a no-mux environment (review finding 1)

**Files:**
- Create: `test/integration/orchestration-headless-no-mux.test.ts`

This is the headline gate for review finding 1. The proposed unit tests instantiate `makeHeadlessBackend()` directly, but they do **not** prove that the real `subagent_serial` / `subagent_parallel` tool callbacks reach the headless backend after passing through `preflightOrchestration()`. This test exercises the full registered-tool path: it loads the extension via `subagentsExtension(pi)` against a captured-tools mock `pi`, then invokes the registered `subagent_serial` execute callback under `PI_SUBAGENT_MODE=headless` with no mux env vars present. A pass means the orchestration entrypoint actually delivers the no-mux unblocking the plan claims.

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
 */
function makeFakePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const renderers = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
  return {
    tools,
    commands,
    renderers,
    api: {
      registerTool(spec: any) { tools.set(spec.name, spec); },
      registerCommand(name: string, spec: any) { commands.set(name, spec); },
      registerMessageRenderer(type: string, fn: any) { renderers.set(type, fn); },
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

describe("orchestration-headless-no-mux", { skip: !PI_AVAILABLE, timeout: 180_000 }, () => {
  let saved: Record<string, string | undefined>;
  let dir: string;

  before(() => {
    saved = {};
    for (const k of ["PI_SUBAGENT_MODE", "CMUX_SOCKET_PATH", "TMUX", "ZELLIJ", "WEZTERM_UNIX_SOCKET"]) {
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

  it("subagent_serial executes through the real registered tool callback under no-mux + headless", async () => {
    const fake = makeFakePi();
    subagentsExtension(fake.api as any);

    const serial = fake.tools.get("subagent_serial");
    assert.ok(serial, "subagent_serial must be registered");

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
      const result = await serial.execute(
        "test-call-id",
        { tasks: [{ agent: "test-echo", task: "Reply with exactly: OK" }] },
        new AbortController().signal,
        () => {},
        ctx,
      );

      // Most important: did NOT short-circuit on the mux preflight.
      assert.notMatch(JSON.stringify(result), /mux not available/i,
        "review finding 1 regression: orchestration preflight blocked headless dispatch");
      // Real headless run completed.
      assert.equal(result.details.isError, false, `serial errored: ${JSON.stringify(result.details)}`);
      assert.equal(result.details.results.length, 1);
      assert.equal(result.details.results[0].exitCode, 0);
      assert.ok(result.details.results[0].finalMessage.trim().length > 0);
    } finally {
      process.chdir(origCwd);
    }
  });

  it("subagent_parallel executes through the real registered tool callback under no-mux + headless", async () => {
    const fake = makeFakePi();
    subagentsExtension(fake.api as any);

    const parallel = fake.tools.get("subagent_parallel");
    assert.ok(parallel, "subagent_parallel must be registered");

    const ctx = {
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      },
      cwd: dir,
    };
    fake.api.emit("session_start", {}, ctx);

    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      const result = await parallel.execute(
        "test-call-id",
        {
          tasks: [
            { agent: "test-echo", task: "Reply with exactly: A" },
            { agent: "test-echo", task: "Reply with exactly: B" },
          ],
          maxConcurrency: 2,
        },
        new AbortController().signal,
        () => {},
        ctx,
      );

      assert.notMatch(JSON.stringify(result), /mux not available/i);
      assert.equal(result.details.isError, false, `parallel errored: ${JSON.stringify(result.details)}`);
      assert.equal(result.details.results.length, 2);
      for (const r of result.details.results) {
        assert.equal(r.exitCode, 0);
      }
    } finally {
      process.chdir(origCwd);
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm run test:integration -- --test-name-pattern='orchestration-headless-no-mux' 2>&1 | tail -40`
Expected: both tests PASS or skip (when `pi` is missing). A regression of review finding 1 manifests as the first assertion failing with "review finding 1 regression: orchestration preflight blocked headless dispatch".

- [ ] **Step 3: Commit**

```bash
git add test/integration/orchestration-headless-no-mux.test.ts
git commit -m "test(integration): exercise subagent_serial/parallel via real registered tool callbacks under no-mux+headless"
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

Run: `npm run typecheck 2>&1 | tail -30`
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
| `transcriptPath` | both                   | Path to the session/transcript file. For pi runs, this is `getDefaultSessionDirFor(effectiveCwd, effectiveAgentDir)` — typically `~/.pi/agent/sessions/<project-slug>/`, but project-local `.pi/agent/` and `PI_CODING_AGENT_DIR` override it. For Claude runs, this is always under `~/.pi/agent/sessions/claude-code/`. |
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

---

## v2 changelog (vs. v1)

The four blocking findings and three non-blocking notes from `2026-04-20-mux-free-execution-design-review-v2.md` were addressed as follows:

**Blocking 1 — orchestration entrypoint reaches headless in no-mux environments**
- New Task 7b: `preflightOrchestration()` only requires mux when `selectBackend() === "pane"`. Wired into `subagent_serial` / `subagent_parallel` registration; the bare `subagent` tool keeps the original `preflightSubagent`.
- New Task 23b: integration test that loads `subagentsExtension(pi)` against a captured-tools mock, then invokes the real registered `subagent_serial` / `subagent_parallel` `execute` callbacks under `PI_SUBAGENT_MODE=headless` with no mux env vars present.

**Blocking 2 — shared launch resolution above the backend seam**
- New Task 9b: extract `resolveLaunchSpec()` from `launchSubagent()` into `pi-extension/subagents/launch-spec.ts`. Pure function; both pane (refactored) and headless (Task 11 / 19) consume the same `ResolvedLaunchSpec`. Spec covers model/tools/skills/thinking/cli, cwd + local agent dir resolution, system-prompt mode, seeded session / fork / lineage, deny-tools, auto-exit, artifact-backed task delivery, skill prompt expansion, `subagent-done` extension wiring, session placement parity (`getDefaultSessionDirFor(...)`), and `resumeSessionId`.
- Tasks 11 and 19 rewritten to consume `ResolvedLaunchSpec` instead of forwarding a reduced subset.
- Headless integration tests (Tasks 13, 15, 20, 21, 22, 23) switched off the host-dependent `scout` agent. Pi-side tests now use the repo-local `test-echo` fixture (seeded into the temp dir via the new `copyTestAgents()` harness helper from Task 12b). Claude-side tests use no agent + direct fields. The abort test (Task 23) uses no agent (test-echo's `auto-exit: true` would short-circuit it).

**Blocking 3 — abort escalation tracks an explicit `exited` flag**
- Task 11 and Task 19 implementations replace `!proc.killed` with an explicit `exited` boolean set from `close`/`exit` events.
- Task 12 unit test rewritten: the fake `ChildProcess` mirrors real Node semantics (`kill(SIGTERM)` does NOT mark the process exited), and the test now has two cases — clean exit after SIGTERM (no SIGKILL escalation) and stuck child (SIGKILL must fire after 5s).

**Blocking 4 — `resumeSessionId` parity on headless Claude**
- Task 19 adds `--resume <id>` arg construction via the new pure `buildClaudeHeadlessArgs(spec, taskText)` in `claude-stream.ts`.
- Unit tests in Task 19 Step 1 cover `--resume`, `--model` provider-prefix stripping, thinking → effort mapping, system-prompt mode (append vs replace), and `--allowedTools` mapping/dedup.
- New Task 22b: focused integration test that resumes a Claude session by id and asserts the same `sessionId` plus transcript continuity.

**Non-blocking 1 — Task 8 test snippet imports**
- Task 8 Step 1 rewritten: instead of appending top-level imports below code (which would be invalid ESM), the snippet says to extend the existing top-of-file `import { describe, it } from "node:test"` with `before, after` and append the new `describe(...)` block (without its own imports).

**Non-blocking 2 — Phase 1 selector narrative**
- The Phase 1 intro line claiming `selectBackend()` is "hard-gated to always return pane" was removed. Replaced with the accurate description: the selector behaves identically in Phase 1 and Phase 2 (honors `PI_SUBAGENT_MODE` + auto/no-mux fallback); the Phase 1 `HeadlessBackend` is a stub that throws "not implemented", giving callers who resolve to headless a clean error rather than silent fallback.

**Non-blocking 3 — `@mariozechner/pi-ai` direct dependency**
- Task 4 Step 2 now adds `@mariozechner/pi-ai` to both `peerDependencies` (`*`) and `devDependencies` (matching `pi-coding-agent`'s version). The fallback-only language is gone; the dep is explicit. The intro Tech Stack and File Structure sections both call this out.

---

## v3 changelog (vs. v2)

The two blocking findings and three non-blocking notes from `2026-04-20-mux-free-execution-design-review-v3.md` were addressed as follows:

**Blocking 1 — `npm run typecheck` is now a real, runnable gate**
- New Task 0 (Phase 0 prep): adds a minimal `tsconfig.json` at the repo root and a `"typecheck": "tsc --noEmit"` npm script. Intentionally permissive (strict/noImplicitAny both `false`) so the existing codebase typechecks cleanly without forced refactors — the gate catches gross breakage from new code rather than auditing legacy code.
- Every previous `Run: npx tsc --noEmit` step across six tasks is replaced with `Run: npm run typecheck 2>&1 | tail -N`. Six substitutions total, no wording changes to the surrounding "Expected: no errors" lines — those now reference a command that actually exists in this repo.
- File Structure adds `tsconfig.json` to the new-files list and documents the `package.json` `"typecheck"` script addition alongside the existing `pi-ai` dependency note.

**Blocking 2 — the fake `ExtensionAPI` in Task 23b now implements every init-time method**
- `makeFakePi()` in `test/integration/orchestration-headless-no-mux.test.ts` (Task 23b Step 1) gains no-op `registerCommand(name, spec)` and `registerMessageRenderer(type, fn)` methods. `subagentsExtension(...)` calls both during initialization (`pi-extension/subagents/index.ts:1612-1622`, `1624-1652`, `1654-1717`, `1719-1753`, `1755-1778`), so the v2 draft would have thrown before the orchestration tools were even registered. A block comment on `makeFakePi()` explains why each stub is there so later changes don't quietly drop them again.
- The fake also exposes captured `commands` and `renderers` maps (same shape as `tools`) so follow-up tests can, if needed, invoke the registered `/iterate` / `/subagent` / `/plan` commands — not exercised in v1, but cheap to preserve.

**Non-blocking 1 — `preflightOrchestration.ts` uses a static import**
- The v2 dynamic `require("./cmux.ts")` is replaced with a top-level `import { isMuxAvailable, muxSetupHint } from "./cmux.ts"`. The package is ESM (`"type": "module"`), so `require` was not a safe fallback. The static-import rationale is called out in a short note after the code block in Task 7b Step 3.

**Non-blocking 2 — transcript-path wording is no longer overly global**
- Task 15's integration-test docstring and assertion accept any of the resolved session roots (home-based `~/.pi/agent/sessions`, project-local `<cwd>/.pi/agent/sessions`, or `$PI_CODING_AGENT_DIR/sessions`) rather than hardcoding `~/.pi/agent/sessions` — matching how `getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir)` actually behaves (`pi-extension/subagents/index.ts:308-326, 716-730, 875-880`).
- Task 16's manual-smoke note swaps the host-dependent `scout` agent reference for "any agent you actually have installed" and says "the resolved session root" instead of a hardcoded path.
- README copy (Task 27 Step 2) explicitly distinguishes pi's resolved session root from Claude's always-hardcoded `~/.pi/agent/sessions/claude-code/` archive tree.
- The v2-era `~/.pi/agent/sessions/claude-code/` statements in Claude-specific sites (`claude-sentinel-roundtrip.test.ts`, Task 22's Claude archival test, Task 20's smoke test, `archiveClaudeTranscript()`) remain unchanged — they describe Claude's actual behavior.

**Non-blocking 3 — preflight pane-mode test no longer depends on `tmux` being on PATH**
- `pi-extension/subagents/preflight-orchestration.ts` (Task 7b Step 3) exposes a module-private `__test__.setMuxProbe(fn)` / `__test__.resetMuxProbe()` pair so unit tests can swap the mux probe deterministically. Default behavior is unchanged — production callers still go through the real `isMuxAvailable()`.
- The v2 test at Task 7b Step 1 that wrote `process.env.TMUX = "/tmp/tmux-fake"` to simulate "pane mode with mux present" now uses `preflightTest.setMuxProbe(() => true)` instead. The test no longer assumes `tmux` is on PATH, so it passes on headless hosts too. `beforeEach` / `afterEach` call `resetMuxProbe()` so no global state leaks between cases.
