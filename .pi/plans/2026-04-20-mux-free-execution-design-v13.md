# Mux-Free Execution Implementation Plan (v13)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a headless (stdio-piped, stream-json) backend beside the existing pane backend so `subagent`, `subagent_serial`, and `subagent_parallel` work without a supported multiplexer. Close the two adjacent gaps vs. `pi-subagent`: populate headless `usage` / `transcript[]` on `OrchestrationResult`, and fix Claude tool restriction with an upstream-portable patch.

**Architecture:**
1. **Shared launch contract.** Extract `resolveLaunchSpec()` so pane and headless consume the same normalized launch behavior: agent defaults, cwd/config-root resolution, system-prompt handling, lineage seeding, artifact task delivery, deny-tools, auto-exit, skill expansion, session-file placement, and `resumeSessionId`.
2. **Backend seam + selector.** Add `backends/types.ts`, a thin `pane.ts` adapter, a real `headless.ts`, and `selectBackend()` driven by `PI_SUBAGENT_MODE` plus mux detection. `OrchestrationResult` gains optional headless-only `usage` and `transcript` fields backed by an orchestration-owned `TranscriptMessage` boundary type.
3. **Backend-aware tool entrypoints.** Route all three subagent surfaces through backend-aware preflight and dispatch. The bare `subagent` headless path must still register background work with shutdown/reload cleanup; it cannot become untracked fire-and-forget.

A second named patch in `pi-extension/subagents/index.ts` adds shared `PI_TO_CLAUDE_TOOLS` mapping + Claude `--tools` emission for both pane and headless runs.

**Claude v1 rules:**
- Use `spec.identity` + Claude system-prompt flags; do not read `identityInSystemPrompt` on the Claude path.
- Use `spec.claudeTaskBody`, not `spec.fullTask`, so identity is not duplicated in the task body.
- Warn and drop `skills:` on Claude rather than leaking literal `/skill:...` tokens.
- Discover Claude transcripts by `sessionId`, not by reconstructing Claude's project-slug heuristic.

## Key decisions and invariants

- **One launch contract:** `resolveLaunchSpec()` is the single normalization boundary. Pane and headless should consume the same resolved spec rather than re-deriving behavior independently.
- **Backend selection:** `PI_SUBAGENT_MODE` controls backend choice; `auto` falls back to headless when no supported mux is available.
- **Claude tool restriction:** use `--tools`, not `--allowedTools`, because this path runs in bypass-permissions mode and needs to restrict Claude's built-in tool availability rather than the permission layer.
- **Claude identity placement:** Claude always receives identity through `--system-prompt` / `--append-system-prompt`. `identityInSystemPrompt` is pi-specific and must not change Claude behavior.
- **Claude task body:** Claude consumes `spec.claudeTaskBody`, not `spec.fullTask`, so identity is not duplicated in the prompt body.
- **Claude skills in v1:** warn and drop them; do not leak literal `/skill:...` tokens into Claude task text.
- **Transcript contract:** the orchestration surface exposes `transcript: TranscriptMessage[]`, not pi-ai `Message[]`. Projection happens at the backend boundary.
- **Headless bare-subagent lifecycle:** no-mux `subagent` launches must still be tracked by shutdown/reload cleanup; headless background work cannot become an untracked fire-and-forget process.
- **Headless progress streaming:** `onUpdate` wiring must not lose partials emitted before `waitForCompletion()` attaches. Either attach early or buffer/replay.

**Tech Stack:** TypeScript (Node's native `--test` runner, `node:assert/strict`), `@sinclair/typebox` for tool schemas, `@mariozechner/pi-coding-agent` for the extension API, `node:child_process` `spawn` for stdio-piped CLI launch. `@mariozechner/pi-ai` is not a direct dependency of this fork — the pi headless backend parses raw pi-CLI stream-json payloads through a local `PiStreamMessage` type defined next to the parser boundary in `headless.ts`, capturing exactly the fields the `projectPiMessageToTranscript` projection and usage/stopReason accumulator read. No pi-ai symbol crosses the backend boundary, so `package.json` does not need a direct or transitive dependency claim on `@mariozechner/pi-ai` to hold.

---

## File Structure

**New implementation files**
- `tsconfig.json` — minimal non-strict project config for `npm run typecheck`.
- `pi-extension/subagents/launch-spec.ts` — shared `resolveLaunchSpec()` plus task/system-prompt artifact helpers.
- `pi-extension/subagents/backends/types.ts` — `Backend`, `BackendLaunchParams`, `BackendResult`, `UsageStats`, `TranscriptMessage`.
- `pi-extension/subagents/backends/pane.ts` — thin adapter over existing pane launch/watch primitives.
- `pi-extension/subagents/backends/headless.ts` — headless pi + Claude backend, transcript/usage capture, abort handling, transcript archival, progress buffering.
- `pi-extension/subagents/backends/select.ts` — `PI_SUBAGENT_MODE` + mux-fallback selector.
- `pi-extension/subagents/backends/line-buffer.ts` — newline buffer for stream-json parsing.
- `pi-extension/subagents/backends/claude-stream.ts` — Claude arg builder plus stream/result parsing.
- `pi-extension/subagents/backends/tool-map.ts` — shared pi→Claude tool mapping used by both builders.
- `pi-extension/subagents/preflight-orchestration.ts` — backend-aware preflight for `subagent`, `subagent_serial`, and `subagent_parallel`.

**New tests**
- `test/orchestration/select-backend.test.ts` — selector resolution and warn-once behavior.
- `test/orchestration/preflight-orchestration.test.ts` — backend-aware preflight coverage.
- `test/orchestration/launch-spec.test.ts` — launch-contract normalization and Claude identity/task-body rules.
- `test/orchestration/line-buffer.test.ts` — partial-line buffering.
- `test/orchestration/headless-abort.test.ts` — SIGTERM→5s→SIGKILL escalation keyed off actual exit.
- `test/orchestration/claude-event-transform.test.ts` — Claude event/result parsing, arg building, toolResult projection.
- `test/orchestration/claude-transcript-discovery.test.ts` — session-id transcript lookup under `~/.claude/projects/*/`.
- `test/orchestration/pi-to-claude-tools.test.ts` — shared tool-map coverage against pi built-ins.
- `test/orchestration/claude-skills-warning.test.ts` — shared Claude-skills warning helper.
- `test/orchestration/pi-transcript-projection.test.ts` — pi→`TranscriptMessage` projection contract.
- `test/orchestration/transcript-shape.test.ts` — public transcript boundary type contract.
- `test/integration/pi-pane-smoke.test.ts` — existing pi pane smoke coverage.
- `test/integration/orchestration-headless-no-mux.test.ts` — real registered-tool coverage for no-mux headless entry.
- `test/integration/headless-pi-smoke.test.ts` — headless pi smoke.
- `test/integration/headless-claude-smoke.test.ts` — headless Claude smoke.
- `test/integration/headless-tool-use.test.ts` — real Claude toolCall/toolResult round-trip.
- `test/integration/headless-transcript-archival.test.ts` — pi + Claude transcript archival.
- `test/integration/headless-abort-integration.test.ts` — end-to-end abort behavior.
- `test/integration/headless-enoent.test.ts` — missing-CLI error path.
- `test/integration/headless-claude-resume.test.ts` — `resumeSessionId` round-trip.
- `test/integration/pane-claude-tool-restriction.test.ts` — pane Claude `--tools` restriction and pane skills warning coverage.
- `test/integration/headless-claude-skills-warning.test.ts` — headless Claude skills warning and no-token-leak check.

**Modified files**
- `pi-extension/subagents/cmux.ts` — export `detectMux()`.
- `pi-extension/subagents/index.ts` — baseline type fixes; `resolveLaunchSpec()` adoption; backend-aware preflight; bare `subagent` headless path with lifecycle tracking; Claude `--tools` patch; shared Claude-skills warning; `shellEscape` re-export.
- `pi-extension/orchestration/default-deps.ts` — backend selection/dispatch plus headless result/update mapping.
- `pi-extension/orchestration/types.ts` — optional `usage` / `transcript` fields and update signatures.
- `pi-extension/orchestration/tool-handlers.ts` — forward headless partial updates.
- `pi-extension/orchestration/run-serial.ts` — forward per-step updates.
- `pi-extension/orchestration/run-parallel.ts` — forward per-task updates.
- `package.json` — add `typecheck` script only.
- `README.md` — document backend selection, result fields, tool restriction, and Claude-skills limitation.
- `test/integration/harness.ts` — add `copyTestAgents(dir)`.
- `test/integration/claude-sentinel-roundtrip.test.ts` — replace scaffold with a real pane-Claude roundtrip.
- `test/orchestration/default-deps.test.ts` — assert `makeDefaultDeps()` routes through backend selection.
- `test/orchestration/thinking-effort.test.ts` — cover Claude `--tools`, separator, and system-prompt behavior.

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

export type TranscriptContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "image"; data: string; mimeType: string };

export interface TranscriptMessage {
  role: "user" | "assistant" | "toolResult";
  content: TranscriptContent[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}


export interface BackendResult {
  name: string;
  finalMessage: string;
  transcriptPath: string | null;
  exitCode: number;
  elapsedMs: number;
  sessionId?: string;
  error?: string;
  usage?: UsageStats;
  transcript?: TranscriptMessage[];
}

export interface BackendLaunchParams {
  name?: string;
  agent?: string;
  task: string;
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

const warnedInvalidValues = new Set<string>();

export type BackendKind = "pane" | "headless";

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

let muxProbe: () => boolean = isMuxAvailable;

export function preflightOrchestration(ctx: {
  sessionManager: { getSessionFile(): string | null };
}): ErrorResult | null {
  if (selectBackend() === "pane") {
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
import { selectBackend } from "./backends/select.ts";
import { makeHeadlessBackend } from "./backends/headless.ts";


if (selectBackend() === "headless") {
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

```

Pane-only features — widget refresh, ping-via-sentinel steer messages — are deliberately absent from the headless branch. The headless CLI does not emit the pane sentinel, and there is no pane TUI widget to refresh. The steer-message completion/error pattern is preserved so the parent agent sees the same "sub-agent completed" / "sub-agent failed" / "sub-agent error" shape as pane-mode. Consumers that relied on `result.ping` or `startWidgetRefresh` in pane mode continue to work because the pane branch is untouched.

Lifecycle requirement: the headless bare-`subagent` branch must still register the launched run with the same shutdown/reload cleanup path the pane branch uses today (or an equivalent headless-only registry). The local `watcherAbort` in the sketch above is not enough by itself — `session_shutdown` and `/reload` cleanup must be able to find that run and abort it so headless background work cannot outlive the parent session.

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
import { describe, it, before, after } from "node:test";

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
    assert.equal(selectBackend(), "headless");
  });

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
    const spec = resolveLaunchSpec(
      { name: "X", task: "t", systemPrompt: "you are a sentinel" },
      baseCtx,
    );
    assert.equal(spec.identity, "you are a sentinel");
    assert.equal(spec.identityInSystemPrompt, false);
    assert.match(spec.fullTask, /you are a sentinel/);
  });

  it("resolves identity as agentDefs.body first when both agent body and caller systemPrompt are set", () => {
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
  });

  it("exposes claudeTaskBody without the roleBlock for Claude backends to consume", () => {
    const blank = resolveLaunchSpec(
      { name: "X", task: "do-task", systemPrompt: "you are Y" },
      baseCtx,
    );
    assert.match(blank.fullTask, /you are Y/);
    assert.doesNotMatch(blank.claudeTaskBody, /you are Y/,
      "review-v11 finding 1 regression: identity text leaked into claudeTaskBody — Claude would see it via the flag AND the task body");
    assert.match(blank.claudeTaskBody, /do-task/);

    const fork = resolveLaunchSpec(
      { name: "X", task: "do-task", systemPrompt: "you are Y", fork: true },
      baseCtx,
    );
    assert.equal(fork.claudeTaskBody, "do-task");
  });

  it("places subagentSessionFile under getDefaultSessionDirFor(targetCwd, agentDir)", () => {
    const spec = resolveLaunchSpec({ name: "X", task: "t" }, baseCtx);
    assert.match(spec.subagentSessionFile, /\.jsonl$/);
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
  name: string;
  task: string;
  agent: string | undefined;
  effectiveCli: "pi" | "claude";

  effectiveModel: string | undefined;
  effectiveTools: string | undefined;
  effectiveSkills: string | undefined;
  effectiveThinking: string | undefined;
  skillPrompts: string[];                  // already expanded to "/skill:X" strings

  effectiveCwd: string | null;
  localAgentDir: string | null;
  effectiveAgentDir: string;
  configRootEnv: Record<string, string>;

  identity: string | null;
  identityInSystemPrompt: boolean;
  systemPromptMode: "append" | "replace" | undefined;
  fullTask: string;
  claudeTaskBody: string;

  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
  subagentSessionFile: string;
  artifactDir: string;

  autoExit: boolean;
  denySet: Set<string>;
  resumeSessionId: string | undefined;
  focus: boolean | undefined;

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

### Task 9c: Phase 1 release-sequencing gate

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
- **Defer the registration swap.** In `pi-extension/subagents/index.ts`, keep `preflightSubagent` at both the orchestration-tool registration call and inside the bare `subagent` tool's `execute`, and add a short inline note pointing at Task 11. Swap to `preflightOrchestration` at both sites as one commit immediately after Task 11 lands. If you pick this path, also defer Task 7b Step 4b (the bare-subagent execute `selectBackend()` branch) so the two changes land together — otherwise preflight still blocks on mux while the execute tries to dispatch headless, or vice versa. Stage the two changes as a single commit and hold it until Phase 2 is ready.

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

type PiStreamMessage = {
  role: "user" | "assistant" | "toolResult";
  content: unknown;  // normalized to TranscriptContent[] by projectPiMessageToTranscript
};

export function projectPiMessageToTranscript(msg: PiStreamMessage): TranscriptMessage {
  const rawContent: unknown = msg.content;
  const content: TranscriptContent[] = typeof rawContent === "string"
    ? [{ type: "text", text: rawContent }]
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

async function runPiHeadless(p: RunParams): Promise<BackendResult> {
  const { spec, startTime, abort, ctx } = p;
  const transcript: TranscriptMessage[] = [];
  const usage = emptyUsage();
  let stderr = "";
  let terminalEvent = false;

  if (spec.seededSessionMode) {
    seedSubagentSessionFile({
      mode: spec.seededSessionMode,
      parentSessionFile: ctx.sessionManager.getSessionFile()!,
      childSessionFile: spec.subagentSessionFile,
      childCwd: spec.effectiveCwd ?? ctx.cwd,
    });
  }

  const systemPromptFlag: string[] = [];
  if (spec.identityInSystemPrompt && spec.identity) {
    const flag = spec.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    systemPromptFlag.push(flag, writeSystemPromptArtifact(spec));
  }

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

  let taskArg: string;
  if (spec.taskDelivery === "direct") {
    taskArg = spec.fullTask;
  } else {
    taskArg = `@${writeTaskArtifact(spec)}`;
  }
  const positional: string[] = [];
  if (spec.taskDelivery === "artifact" && spec.skillPrompts.length > 0) {
    positional.push("");
  }
  positional.push(...spec.skillPrompts, taskArg);
  args.push(...positional);

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
        const msg = event.message as PiStreamMessage;
        transcript.push(projectPiMessageToTranscript(msg));
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

describe("projectPiMessageToTranscript", () => {
  it("normalizes a pi UserMessage with content: string into a TextContent block array", () => {
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

describe("headless abort", { timeout: 15_000 }, () => {
  let lastFakeProc: any;
  let killed: string[];
  let backendModule: any;

  function makeFakeProc() {
    const ee = new EventEmitter() as any;
    ee.stdout = new EventEmitter();
    ee.stderr = new EventEmitter();
    ee.killed = false;        // Real Node: only set when kill() successfully sends.
    ee.kill = (sig: string) => {
      killed.push(sig);
      return true;
    };
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
      await new Promise((r) => setImmediate(r));

      controller.abort();
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(killed, ["SIGTERM"]);
      assert.ok(t.scheduled.find((s) => s.ms === 5000), "5s escalation timer must be scheduled");

      lastFakeProc._fakeExit(0);
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

      const fiveSec = t.scheduled.find((s) => s.ms === 5000);
      assert.ok(fiveSec);
      fiveSec!.fn();
      assert.deepEqual(killed, ["SIGTERM", "SIGKILL"],
        `SIGKILL must be sent when child has not exited; got ${killed.join(",")}`);

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

      const possibleRoots = [
        join(homedir(), ".pi", "agent", "sessions"),
        join(dir, ".pi", "agent", "sessions"),
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

Phase 3 completes the headless implementation (Claude path) and lands the security-relevant `--tools` patch on the Claude command builder.

### Task 17: Patch `buildClaudeCmdParts` with `PI_TO_CLAUDE_TOOLS` + `--tools` + required `--` separator + re-export `shellEscape`

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Modify: `test/orchestration/thinking-effort.test.ts` (add a tools-map assertion and a separator-regression assertion to an existing test)
- Create: `test/integration/pane-claude-tool-restriction.test.ts`

This is the second named upstream-portable patch alongside the existing `thinking` patch. It benefits both backends — pane-Claude commands gain tool restriction automatically.

**Why this task exists:**
- Use `--tools`, not `--allowedTools`, because this path runs in bypass-permissions mode and needs to restrict Claude's built-in tool availability rather than the permission layer.
- Emit `--` before the task because `--tools` is variadic and can otherwise consume the prompt.
- Re-export `shellEscape` so tests can import the same helper the builder uses.

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
    const raw = parts[idx + 1].replace(/^'|'$/g, "");
    const mapped = new Set(raw.split(","));
    assert.ok(mapped.has("Read"));
    assert.ok(mapped.has("Bash"));
    assert.ok(mapped.has("Glob"));
    assert.ok(!mapped.has("unknown"), "unmapped tools must be dropped, not passed through");
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
      parts.push("--tools", shellEscape([...claudeTools].join(",")));
    }
  }
```

**Then replace the existing final line** — `parts.push(shellEscape(input.task));` at `pi-extension/subagents/index.ts:687` — with a separator-aware emit:

```ts
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
    warnClaudeSkillsDropped(params.name, effectiveSkills);
```

Finally, add the focused unit test at `test/orchestration/claude-skills-warning.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { warnClaudeSkillsDropped } from "../../pi-extension/subagents/index.ts";

describe("warnClaudeSkillsDropped", () => {
  let captured: string;
  let origWrite: typeof process.stderr.write;

  beforeEach(() => {
    captured = "";
    origWrite = process.stderr.write.bind(process.stderr);
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

function withPrintBeforeSeparator(parts: string[]): string {
  const injected = parts.slice();
  const sepIdx = injected.indexOf("--");
  assert.ok(sepIdx > 0,
    "expected -- separator before the task in buildClaudeCmdParts output; " +
    "a regression that drops the separator would place --print as a positional (v7 finding 2).");
  injected.splice(sepIdx, 0, "--print");
  return injected.join(" ");
}

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
      task:
        `Run this exact bash command and nothing else: echo ${marker} > ${file}. ` +
        `If you cannot run it, say so briefly — do not describe or emulate the command.`,
    });
    const cmd = withPrintBeforeSeparator(parts);
    try { execSync(cmd, { cwd: dir, encoding: "utf8", timeout: 90_000 }); }
    catch { /* refusal-driven non-zero exit is acceptable */ }
    assert.ok(!existsSync(file),
      `--tools restriction failed: Bash wrote ${file}; tool restriction did not hold.`);
  });

  it("same request succeeds when effectiveTools is absent (baseline — rules out generic failure)", () => {
    const { marker, file } = makeMarker(dir, "BASELINE");
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/s-baseline",
      pluginDir: undefined,
      model: "sonnet",
      identity: undefined,                 // v10 — was `appendSystemPrompt`
      systemPromptMode: undefined,         // v10 (review-v11 finding 1)
      resumeSessionId: undefined,
      effectiveThinking: undefined,
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

describe("pane-claude-skills-warning (review-v11 finding 2)", () => {
  it("launchSubagent() emits the warning from the pane Claude branch when effectiveSkills is non-empty", async () => {
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
      });
    } finally {
      (process.stderr as any).write = origWrite;
      rmSync(sessionDir, { recursive: true, force: true });
    }

    assert.ok(captured.includes("pane-subagent"),
      `expected subagent name in warning (review-v11 finding 2 regression: pane call site removed); got: ${JSON.stringify(captured)}`);
    assert.ok(captured.includes("ignoring skills=plan, code-review"),
      `expected skills list in warning; got: ${JSON.stringify(captured)}`);
    assert.ok(captured.includes("Claude path"),
      `expected "Claude path" wording so pane + headless match; got: ${JSON.stringify(captured)}`);
  });

  it("launchSubagent() is silent on stderr when skills are empty on the pane Claude branch", async () => {
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

- [ ] **Step 6: Optional downstream compatibility audit**

If a local `pi-config/agent/agents/` tree is available, run Appendix A.1 and inspect any hits. This is a manual audit, not a phase gate. If any listed agent relies on unrestricted tools despite declaring `tools:`, call that out in the commit body so the Phase 3 merge can be audited.

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
- Create: `test/orchestration/claude-transcript-discovery.test.ts`

This task brings the Claude headless path up to the same resolved-spec contract as the pi headless path.

**Contract:**
- Derive argv from `ResolvedLaunchSpec` (`--model`, `--effort`, shared `--tools`, system-prompt flag selection, and `--resume`).
- Use the shared `PI_TO_CLAUDE_TOOLS` module so pane and headless Claude cannot drift.
- Read identity from `spec.identity` and always place it via Claude's system-prompt flags.
- Use `spec.claudeTaskBody`, not `spec.fullTask`, so identity is not duplicated in the task body.
- Discover transcript files by session id rather than guessing Claude's project-dir slug.
- Preserve transcript completeness, including `toolCall` / `toolResult` pairing for streamed tool use.
- Warn and drop Claude skills in v1 instead of leaking literal `/skill:...` text into the prompt.

The abort path should continue to use the same explicit `exited`-flag pattern as `runPiHeadless`.

- [ ] **Step 1: Add a pure arg-builder + write a failing test**

In `pi-extension/subagents/backends/claude-stream.ts`, append:

```ts
import type { ResolvedLaunchSpec } from "../launch-spec.ts";
import { PI_TO_CLAUDE_TOOLS } from "./tool-map.ts";

const EFFORT_MAP: Record<string, string> = {
  off: "low", minimal: "low", low: "low",
  medium: "medium", high: "high", xhigh: "max",
};

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
    if (claudeTools.size > 0) args.push("--tools", [...claudeTools].join(","));
  }
  if (spec.resumeSessionId) {
    args.push("--resume", spec.resumeSessionId);
  }
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

  it("does not duplicate identity text in the task argv (v10, review-v11 finding 1)", () => {
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
    assert.equal(args.includes("--allowedTools"), false,
      "must not emit --allowedTools (permission rule ignored under bypassPermissions)");
  });

  it("does NOT include /skill:... tokens in the argv when spec.skillPrompts is non-empty (v6 / review-v7 finding 3)", () => {
    const args = buildClaudeHeadlessArgs(
      { ...baseSpec, skillPrompts: ["/skill:plan", "/skill:code-review"] },
      "the real task",
    );
    for (const a of args) {
      assert.ok(!a.startsWith("/skill:"),
        `argv must not contain /skill:... tokens; got: ${args.join(" | ")}`);
    }
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

describe("findClaudeSessionFile", () => {
  let fakeHome: string;
  let origHome: string | undefined;

  before(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "pi-claude-arch-"));
    origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    assert.equal(homedir(), fakeHome);
  });
  after(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("finds <sessionId>.jsonl under an arbitrary project-slug directory (no trailing hyphen)", async () => {
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
import { warnClaudeSkillsDropped } from "../index.ts";
```

Replace the `runClaudeHeadless` stub with:

```ts
async function runClaudeHeadless(p: RunParams): Promise<BackendResult> {
  const { spec, startTime, abort, ctx } = p;
  const transcript: TranscriptMessage[] = [];
  let usage: UsageStats = emptyUsage();
  let stderr = "";
  let terminalResult: ReturnType<typeof parseClaudeResult> | null = null;
  let sessionId: string | undefined;

  warnClaudeSkillsDropped(spec.name, spec.effectiveSkills);

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
          transcript.push({
            role: "assistant",
            content: [{ type: "text", text: terminalResult.finalOutput }],
          });
        }
      } else {
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
    const index = await import("../../pi-extension/subagents/index.ts");
    const claudeStream = await import("../../pi-extension/subagents/backends/claude-stream.ts");
    assert.equal((index as any).PI_TO_CLAUDE_TOOLS, undefined,
      "index.ts must not re-export a local copy; import from backends/tool-map.ts");
    assert.equal((claudeStream as any).PI_TO_CLAUDE_TOOLS, undefined,
      "claude-stream.ts must not re-export a local copy; import from backends/tool-map.ts");
  });

  it("is a frozen/read-only object so a caller cannot mutate the shared map at runtime", () => {
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
        task: "Read the file marker.txt in the current directory and print its contents verbatim.",
        cli: "claude",
        tools: "read",
      },
      false,
    );
    const result = await backend.watch(handle);

    assert.equal(result.exitCode, 0, `expected clean exit; error=${result.error}`);

    const transcript = result.transcript ?? [];

    const toolCallBlocks = transcript
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c): c is { type: "toolCall"; id: string; name: string; arguments: unknown } =>
        c.type === "toolCall");
    assert.ok(toolCallBlocks.length > 0,
      "transcript[] must include at least one assistant-role message with a toolCall content block");

    const toolResultMessages = transcript.filter((m) => m.role === "toolResult");
    assert.ok(toolResultMessages.length > 0,
      "transcript[] must include at least one toolResult-role message " +
        "(v11 / review-v15: regression surface for Claude tool_result parsing)");

    const callIds = new Set(toolCallBlocks.map((c) => c.id));
    const resultIds = new Set(toolResultMessages.map((m) => m.toolCallId));
    for (const id of callIds) {
      assert.ok(resultIds.has(id),
        `toolCall id ${id} has no matching toolResult.toolCallId; ` +
          `callIds=${JSON.stringify([...callIds])}, resultIds=${JSON.stringify([...resultIds])}`);
    }

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

### Task 22b: Integration test — `resumeSessionId` round-trip on headless Claude

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
      {
        task: "Count to 1000 aloud, one number per line, very slowly. Do not stop early.",
        model: "anthropic/claude-haiku-4-5",
      },
      false,
      controller.signal,
    );
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

This is the headline gate for the no-mux goal. Unit tests instantiate `makeHeadlessBackend()` directly, but they do **not** prove that the real `subagent` / `subagent_serial` / `subagent_parallel` tool callbacks reach the headless backend after passing through `preflightOrchestration()` (and, for the bare `subagent` tool, through its new `selectBackend()` branch). This test exercises the full registered-tool path: it loads the extension via `subagentsExtension(pi)` against a captured-tools mock `pi`, then invokes each registered tool's execute callback in two environments: (a) forced `PI_SUBAGENT_MODE=headless` with all mux env vars cleared, and (b) `PI_SUBAGENT_MODE` unset entirely (so the default `"auto"` path is exercised) with the same mux env vars cleared. The two configurations exercise adjacent-but-distinct paths through `selectBackend()` — forced mode returns `"headless"` directly, while auto mode runs the real mux-detection logic in `pi-extension/subagents/cmux.ts:30-83` before falling back to headless. A regression that only broke the auto path (e.g., a `selectBackend()` mux-detection bug, or a preflight that incorrectly required mux when mode was unset) would still fail Case B. For the bare `subagent` path, include one shutdown-path assertion as well: once the background headless launch is registered, `session_shutdown` / reload cleanup must be able to abort it rather than letting it outlive the parent session.

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
      sendUserMessage(message: string) { userMessages.push(message); },
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

const MUX_ENV_KEYS = [
  "PI_SUBAGENT_MODE",
  "CMUX_SOCKET_PATH",
  "TMUX",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "WEZTERM_UNIX_SOCKET",
];

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

    assert.notMatch(JSON.stringify(result), /mux not available/i,
      "no-mux regression: bare subagent preflight blocked headless dispatch");
    assert.match(JSON.stringify(result.content), /launched/i,
      "bare subagent must return a 'launched in background' ack, not a backend error");

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

    assert.notMatch(JSON.stringify(result), /mux not available/i,
      "no-mux regression: orchestration preflight blocked headless dispatch");
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

describe("orchestration-headless-no-mux (auto + no mux env)", { skip: !PI_AVAILABLE, timeout: 180_000 }, () => {
  let saved: Record<string, string | undefined>;
  let dir: string;

  before(() => {
    saved = {};
    for (const k of MUX_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
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

### Task 23c: Integration test — Claude + skills emits warning, does not leak /skill: tokens

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

      assert.match(stderrCapture, /ignoring skills=.*on Claude path/i,
        `expected skills-drop warning in stderr; got:\n${stderrCapture}`);

      assert.ok(!result.finalMessage.includes("/skill:"),
        `Claude response contains /skill: literal — indicates skill tokens leaked into task body.\nfinalMessage: ${result.finalMessage}`);

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
  usage?: UsageStats;
  transcript?: TranscriptMessage[];
}
```

- [ ] **Step 3: Typecheck the full project**

Run: `npm run typecheck 2>&1 | tail -30`
Expected: no errors. If a caller elsewhere still references the old `messages` field, fix the call site (rename to `transcript`); there are no known external consumers but the sweep in Step 4 catches them.

- [ ] **Step 4: Optional downstream caller audit**

If a local `pi-config/agent/skills/` tree is available, run Appendix A.2 and inspect any hits. This is a manual compatibility audit, not a phase gate. Specifically check for any remnant reference to the old `.messages` field — those should be updated to `.transcript` or explicitly tolerated as `undefined`.

- [ ] **Step 5: Add a contract test for the transcript shape (review-v7 finding 2)**

Create `test/orchestration/transcript-shape.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptMessage } from "../../pi-extension/subagents/backends/types.ts";

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

**Invariant:** no headless partial updates may be lost between process start and `waitForCompletion()` attaching its callback. Because headless work begins in `launch()`, this task must either attach the callback at launch time or buffer/replay the latest partial until `watch()` attaches. A late callback attachment with no buffering is not sufficient; fast tasks can emit stream events before the watch path sees them.

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

- [ ] **Step 2: Preserve early partials when wiring `onUpdate` through headless execution**

In `pi-extension/subagents/backends/headless.ts`, change `watch` to accept `onUpdate` and pass it down to the run-helpers. The critical design point is that `launch()` starts the process immediately, so `watch()` may attach after some stream events have already arrived. Do **not** rely on a bare late-bound callback slot. Instead, store the latest partial snapshot on the per-launch `HeadlessLaunch` entry and replay it immediately when `watch()` attaches.

Keep the per-event helper small and copy-on-write:

```ts
function emitPartial(entry: HeadlessLaunch, snapshot: BackendResult) {
  entry.latestPartial = { ...snapshot };
  entry.onUpdate?.({ ...entry.latestPartial });
}
```

Update the per-launch state accordingly:

```ts
interface HeadlessLaunch {
  id: string;
  name: string;
  startTime: number;
  promise: Promise<BackendResult>;
  abort: AbortController;
  latestPartial?: BackendResult;
  onUpdate?: (p: BackendResult) => void;
}
```

When `watch(handle, signal, onUpdate)` is called, set `entry.onUpdate = onUpdate` and, if `entry.latestPartial` is already present, replay it once immediately before awaiting the existing promise. Inside both `runPiHeadless` and `runClaudeHeadless`, call `emitPartial(entry, { ...snapshot })` after each `transcript.push(...)` / `usage` mutation so fast tasks still surface their earliest partials.

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
Expected: all orchestration unit tests still pass. If `run-serial` / `run-parallel` tests construct `opts` without `onUpdate`, they should continue to work (the field is optional). Add or update at least one focused test that proves a partial emitted before `waitForCompletion()` registration is still observable after `watch()` attaches.

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

## Appendix A — Manual audits

These checks are intentionally outside the phase gates. Run them when the referenced downstream trees exist locally; otherwise skip them without treating that as validation.

### A.1 Claude tool-restriction downstream audit

Run: `grep -rn '"tools":\|tools:' pi-config/agent/agents/ 2>/dev/null | head -20 || echo "pi-config not on this host"`

Interpretation: if the tree exists, inspect any hits to confirm agents that declare `tools:` should now receive Claude `--tools` restriction in pane mode. If a caller depends on broader access than its declared tool set, note that explicitly before merging.

### A.2 Orchestration result downstream audit

Run: `grep -rn 'finalMessage\|exitCode\|transcriptPath\|usage\|transcript\|\.messages' pi-config/agent/skills/ 2>/dev/null | grep -v '?' | head -20 || echo "pi-config not on this host"`

Interpretation: if the tree exists, inspect any hits to confirm callers tolerate optional `usage` / `transcript` fields correctly and do not still rely on the old `.messages` field.

## Appendix B — Review provenance

This plan now keeps only the rationale needed to execute safely in the main task flow. Full history remains in the review files.

- **Task 17:** prior reviews established the need for shared Claude tool mapping, `--tools` rather than `--allowedTools`, and the required `--` separator before the task.
- **Task 19:** prior reviews established transcript discovery by session id, symmetric Claude transcript projection, and parity between pane/headless Claude warning behavior.
- **Task 26:** prior reviews established that live update semantics need an explicit no-loss rule; late attachment without buffering is not sufficient.

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

