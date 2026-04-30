# Orchestration Result Artifacts — Implementation Plan

**Source:** `TODO-6f3a2c91`
**Spec:** `.pi/specs/2026-04-29-orchestration-result-artifacts.md`

## Goal

Make orchestration result propagation reliable for any-size child output by writing each child's full `finalMessage` to a per-task artifact file under `<sessionDir>/artifacts/<sessionId>/orchestrations/<orchestrationId>/task-<index>.md` and exposing the path via a new `artifactPath` field on `OrchestratedTaskResult`. The parent process performs the write — children's `tools:` allowlist is unchanged. The sync tool result and async `orchestration_complete` steer both replace the truncated 200-char first-line preview with a hint line and per-task `artifact: <path>` rows. Internal consumers (notably `runSerial`'s `{previous}` substitution) keep reading the in-memory `finalMessage` field, but the registry tombstone drops it once `artifactPath` is set so a long-lived parent does not retain unbounded body strings.

## Architecture summary

The orchestration layer is split: pure runners (`runSerial`, `runParallel`) drive backends via `LauncherDeps`; the tool-handler layer wires the runners to the registry, the tool-framework `content`/`details` envelope, and the steer-back path. Today both runners produce `OrchestrationResult` with `finalMessage` populated; the tool handlers project to `OrchestratedTaskResult` and run `summarize()` to build a truncated `content` string for the LLM. The async path emits an `orchestration_complete` registry event that `subagentsExtension`'s `registryEmitter` packages as a steer with `content` of just the orchestration id and counts.

The plan injects a single new side-effect (artifact write) at one well-defined point per runner — between "result is finalized" and "report via `opts.onTerminal`" — driven by an injected `writeArtifact(taskIndex, body) => string | null` callback the tool handler builds with the orchestration id and session paths. The runners stay pure-ish: they call the callback the tool handler hands them, but they have no fs imports of their own. `summarize()` and the async steer text are rewritten to render `artifact: <path>` rows. The registry's `tryFinalize` memory hygiene is extended to drop `finalMessage` from tombstones whose `artifactPath` is set (the steer payload is constructed before the strip, so the emitted steer still carries both fields).

For sync runs the orchestration id is allocated synthetically (a fresh 8-char hex, same shape as `registry.dispatchAsync`'s ids); for async runs the registry-allocated id is reused so the path scheme is consistent across modes. The serial-resume continuation (`continueSerialFromIndex` in tool-handlers) captures the same `writeArtifact` closure but wraps it with a `startIndex` offset so resumed tail tasks write to `task-<original-index>.md`, not `task-0.md`. Blocked orchestration tasks resumed via the standalone `subagent_resume` path (which terminalizes through `registry.onResumeTerminal` rather than the runner's `onTerminal`) get a separate artifact write at the resume callsite in `pi-extension/subagents/index.ts`, using the existing `artifactDir` already computed there and the `owner.orchestrationId`/`owner.taskIndex` from the registry ownership map.

## Tech stack

- TypeScript, Node.js (`node:fs`, `node:path`, `node:crypto`)
- TypeBox schemas (`OrchestrationTaskSchema` extended for nothing — `artifactPath` is a result-shape change only)
- node:test (`describe` / `it`) + `node:assert/strict`
- Existing `getArtifactDir` helper in `pi-extension/subagents/launch-spec.ts`

## File Structure

- `pi-extension/orchestration/task-artifact.ts` (Create) — Pure helper module exporting `writeOrchestrationTaskArtifact({ artifactDir, orchestrationId, taskIndex, finalMessage })` which mkdir-recursive's `<artifactDir>/orchestrations/<orchestrationId>/` and writes `task-<index>.md`. Returns the absolute path on success, `null` on empty `finalMessage` or write failure. Body is written byte-for-byte with no header, framing, or trailing-newline normalization.
- `pi-extension/orchestration/types.ts` (Modify) — Add `artifactPath?: string | null` to `OrchestrationResult` and `OrchestratedTaskResult`.
- `pi-extension/orchestration/run-serial.ts` (Modify) — Add `writeArtifact?: (taskIndex: number, finalMessage: string) => string | null` to `RunSerialOpts`. Call it after the per-step result is finalized but before pushing to `results[]` and before invoking `opts.onTerminal`. Inject the returned path into both the internal `OrchestrationResult` (for sync `summarize`) and the `OrchestratedTaskResult` carried into `opts.onTerminal`. Skip the call when `finalMessage` is empty (matching the spec's "non-empty `finalMessage`" language; whitespace-only bodies are written through to the artifact unchanged).
- `pi-extension/orchestration/run-parallel.ts` (Modify) — Add `writeArtifact?: (taskIndex: number, finalMessage: string) => string | null` to `RunParallelOpts`, mirroring the serial wiring. Skip the call for tasks left blocked (registry-owned slots) and for empty `finalMessage`.
- `pi-extension/orchestration/tool-handlers.ts` (Modify) — Generate sync orchestration ids via `randomBytes(4).toString("hex")`; allocate the artifact-writing callback with the active session's `getSessionDir()` / `getSessionId()` and the orchestration id; pass it into `runSerial` / `runParallel`. Rewrite `summarize()` to emit the new content shape (header line + hint line + per-task `artifact: <path>` rows where unset rows say `artifact: (none)`). Add `artifactPath` plumbing to `toPublicResults`. Wire the same callback into `continueSerialFromIndex` (resume continuation) so the resumed tail also produces artifacts. The async `wait: false` envelope return path is unchanged (no per-task data is rendered there yet).
- `pi-extension/orchestration/registry.ts` (Modify) — In `tryFinalize`, after `safeEmit(...)` and the existing transcript/usage strip, additionally drop `finalMessage` on any tombstone whose `artifactPath` is set. The emitted steer payload (constructed via `entry.tasks.map((t) => ({ ...t }))` before the strip) continues to carry both fields. No type changes here — `OrchestratedTaskResult` already gets the new field via `types.ts`.
- `pi-extension/subagents/index.ts` (Modify) — Two edits in the same file: (1) Update `registryEmitter` so the `orchestration_complete` steer's `content` text begins with the existing `Orchestration "<id>" completed (<N> task(s), isError=<bool>).` line, then appends the same hint line + per-task `artifact: <path>` rows used by sync `summarize`. The `details` payload is unchanged. The `registerMessageRenderer("orchestration_complete", ...)` body is unchanged (it reads `r.name` / `r.state` from `details.results` only and is unaffected by the new content text). (2) In `subagent_resume.execute`'s post-watcher terminal branch (around line 1942-1953, inside `if (owner)`), call `writeOrchestrationTaskArtifact(...)` against `getArtifactDir(getSessionDir, getSessionId)` for `owner.orchestrationId` / `owner.taskIndex` with the resumed `summary`, then pass the returned `artifactPath` into the `registry.onResumeTerminal({ ... artifactPath, ... })` call so blocked-then-resumed orchestration tasks also satisfy the `artifactPath` contract.
- `test/orchestration/task-artifact.test.ts` (Create) — Unit tests for the new helper: directory creation on demand, byte-for-byte body, null on empty body, null on write failure (e.g. read-only mkdtemp).
- `test/orchestration/run-serial.test.ts` (Modify) — Add cases: `writeArtifact` is invoked once per terminal step with the correct `(taskIndex, finalMessage)`, the returned path is merged into `results[i].artifactPath`, the `onTerminal` payload carries `artifactPath`, and a step with empty `finalMessage` skips the call.
- `test/orchestration/run-parallel.test.ts` (Modify) — Mirror the serial cases for `runParallel`, including that input-ordered slots all carry the artifact path and a blocked slot does not invoke `writeArtifact`.
- `test/orchestration/tool-handlers.test.ts` (Modify) — Add cases: sync `subagent_run_serial` and `subagent_run_parallel` content text matches the new shape (header + hint line + `artifact: <path>` rows); `toPublicResults` propagates `artifactPath`; an empty-finalMessage row renders `artifact: (none)`; a long body (≥ 50KB) round-trips through the artifact and the test cleans up the artifact directory in `after()`. Use a `mkdtempSync` session dir + a fake `sessionManager` with `getSessionId` / `getSessionDir`.
- `test/orchestration/registry-eviction.test.ts` (Modify) — Add a case asserting that once `artifactPath` is set on a task result, the post-finalize tombstone drops `finalMessage` (in addition to the existing `transcript`/`usage` strip), and the emitted aggregated completion still carries `finalMessage` (because the emit happens before the strip).
- `test/orchestration/resume-artifact.test.ts` (Create) — Unit test exercising the blocked-then-resumed artifact write: a serial orchestration's only task blocks, `subagent_resume` drives the resumed terminal, and the resulting `OrchestratedTaskResult` carries `artifactPath` pointing at a file containing the resumed `summary` byte-for-byte. Also asserts the emitted `orchestration_complete` payload retains both `finalMessage` and `artifactPath`. Follows the harness pattern of `test/orchestration/resume-transcript-preservation.test.ts` (uses `__test__.setWatchSubagentOverride`, `setMuxAvailableOverride`, `setSurfaceOverrides`).
- `test/orchestration/block-resume.test.ts` (Modify) — Add a case (Step 8b of Task 5) covering the resumed-tail index offset: a 3-step serial blocks on step 1 and resumes; the continuation runs step 2, and the artifact for step 2 is written under `task-2.md` (the original orchestration index), not `task-0.md` (the local tail index). Alternatively this case lives in a new file `test/orchestration/resume-tail-artifact.test.ts` — Step 8b allows either.
- `test/orchestration/async-dispatch.test.ts` (Modify) — Add a case driving an async `subagent_run_serial` to completion against a `LauncherDeps` returning a multi-line `finalMessage`, capturing the `sendMessage` payload, and asserting the steer's `content` text includes the existing first line plus the hint line plus per-task `artifact: <path>` rows. Cleans up the artifact directory in `after()`.
- `test/integration/agents/test-reviewer-md.md` (Create) — Integration-test child agent that emits a multi-finding markdown review verbatim. Restrictive `tools: read, grep` allowlist (no `write`) exercises the spec's invariant that artifact writes are done by the parent only.
- `test/integration/agents/test-coordinator-md.md` (Create) — Integration-test coordinator that dispatches `test-reviewer-md` via `subagent_run_serial` with a caller-supplied review body. The existing `test-coordinator.md` is hardcoded to dispatch `test-echo` with a fixed message, so a new coordinator is required to pass the review body through faithfully.
- `test/integration/coordinator-orchestration-tools.test.ts` (Modify) — Extend the existing slow-lane coordinator test with new specs: a real pi-CLI coordinator dispatches `test-reviewer-md` via `subagent_run_serial`, parses the `artifact: <path>` row out of the model-visible tool result `content` text, calls its own `read` tool on that path, and emits the artifact body verbatim as its final assistant message. The parent asserts `result.finalMessage` (the coordinator's body) equals the input review body byte-for-byte. The headless backend's `projectPiMessageToTranscript` (`pi-extension/subagents/backends/headless.ts`) drops tool-result `details` from the transcript; only `role`, `content`, `toolCallId`, `toolName`, and `isError` survive — so the test parses paths from `content` text via a regex and never reads `details`. Cleans up the artifact file via `rmSync` in each `it` body.

## Tasks

### Task 1: Add `artifactPath` field to public + internal result types

**Files:**
- Modify: `pi-extension/orchestration/types.ts`

**Steps:**
- [ ] **Step 1: Add `artifactPath` to `OrchestrationResult`** — Inside the `OrchestrationResult` interface (lines 48-62), append `artifactPath?: string | null;` immediately after `transcriptPath: string | null;`. Place it before `exitCode` so the field grouping (path-like fields together) reads naturally.
- [ ] **Step 2: Add `artifactPath` to `OrchestratedTaskResult`** — Inside the `OrchestratedTaskResult` interface (lines 70-82), append `artifactPath?: string | null;` immediately after `transcriptPath?: string | null;`.
- [ ] **Step 3: Add a JSDoc note on the public field** — Above the new `artifactPath` line in `OrchestratedTaskResult`, add a one-line JSDoc: `/** Filesystem path to the per-task final-message artifact. Null when no artifact was written (empty finalMessage, capture failure, or cancelled-before-completion). */` Do not add the same comment to the internal `OrchestrationResult` — that one is internal and the field name is self-explanatory there.

**Acceptance criteria:**
- `OrchestrationResult.artifactPath` exists with the correct optional `string | null` shape.
  Verify: `grep -n "artifactPath?: string | null;" pi-extension/orchestration/types.ts` returns at least two matching lines (one in each interface).
- `OrchestratedTaskResult.artifactPath` carries a JSDoc explaining the null contract.
  Verify: `grep -n -B 1 "artifactPath?: string | null;" pi-extension/orchestration/types.ts | grep "Null when no artifact was written"` returns at least one match.
- Type-check passes against the new field.
  Verify: run `npm run typecheck` and confirm exit code 0.

**Model recommendation:** cheap

---

### Task 2: Implement `writeOrchestrationTaskArtifact` helper

**Files:**
- Create: `pi-extension/orchestration/task-artifact.ts`
- Test: `test/orchestration/task-artifact.test.ts`

**Steps:**
- [ ] **Step 1: Create the helper module** — Create `pi-extension/orchestration/task-artifact.ts` with imports `import { mkdirSync, writeFileSync } from "node:fs";` and `import { join } from "node:path";`. Export a single function:
  ```ts
  export function writeOrchestrationTaskArtifact(args: {
    artifactDir: string;
    orchestrationId: string;
    taskIndex: number;
    finalMessage: string;
  }): string | null {
    if (!args.finalMessage || args.finalMessage.length === 0) return null;
    try {
      const dir = join(args.artifactDir, "orchestrations", args.orchestrationId);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `task-${args.taskIndex}.md`);
      writeFileSync(path, args.finalMessage, "utf8");
      return path;
    } catch {
      return null;
    }
  }
  ```
  Body is written byte-for-byte with `writeFileSync(path, args.finalMessage, "utf8")` — do NOT append a trailing newline, do NOT add a header, do NOT JSON-stringify. The function must be the only place in the module that performs fs writes.
- [ ] **Step 2: Write the failing test file** — Create `test/orchestration/task-artifact.test.ts` with `describe("writeOrchestrationTaskArtifact", ...)` containing four tests:
  1. `it("returns null on empty finalMessage")` — call with `finalMessage: ""`, assert null, assert no directory was created.
  2. `it("writes the body byte-for-byte to the expected path")` — using `mkdtempSync` for the `artifactDir`, write a multi-line markdown body with embedded `\n`, special chars `$$ $& $1`, and a UTF-8 emoji. Assert `readFileSync(returnedPath, "utf8")` equals the input string exactly.
  3. `it("creates the orchestrations/<id>/ subdirectory on demand")` — use a fresh `mkdtempSync` artifactDir, call once with a non-empty body, assert `existsSync(join(artifactDir, "orchestrations", id, "task-0.md"))` is true.
  4. `it("returns null on write failure")` — call with `artifactDir` set to `/dev/null/no-such-dir` (or similar guaranteed-fail path on the test platform). Assert null returned, no throw.
  The test file imports `writeOrchestrationTaskArtifact` from `../../pi-extension/orchestration/task-artifact.ts` and adds an `after()` block that `rmSync(tmpDir, { recursive: true, force: true })` on every `mkdtempSync` directory it created.
- [ ] **Step 3: Run the test and confirm it passes** — Run `node --test test/orchestration/task-artifact.test.ts` and confirm exit code 0 with all four cases passing.
- [ ] **Step 4: Add the new test path to `npm test`** — Open `package.json` and verify the `test` script's glob `test/orchestration/*.test.ts` already covers `task-artifact.test.ts`. No edit required (the glob covers it).

**Acceptance criteria:**
- Helper writes a non-empty body byte-for-byte to `<artifactDir>/orchestrations/<id>/task-<index>.md`.
  Verify: run `node --test test/orchestration/task-artifact.test.ts` and confirm the "writes the body byte-for-byte" case passes.
- Helper returns `null` on empty body and on write failure without throwing.
  Verify: run `node --test test/orchestration/task-artifact.test.ts` and confirm both null-returning cases pass.
- Helper creates `orchestrations/<id>/` on demand under the supplied `artifactDir`.
  Verify: run `node --test test/orchestration/task-artifact.test.ts` and confirm the "creates the orchestrations/<id>/ subdirectory on demand" case passes.
- The helper has no orchestration-runner dependencies (it is purely an fs helper).
  Verify: open `pi-extension/orchestration/task-artifact.ts` and confirm imports are limited to `node:fs` and `node:path` only.

**Model recommendation:** cheap

---

### Task 3: Wire `writeArtifact` callback into `runSerial`

**Files:**
- Modify: `pi-extension/orchestration/run-serial.ts`
- Test: `test/orchestration/run-serial.test.ts`

**Steps:**
- [ ] **Step 1: Extend `RunSerialOpts`** — Open `pi-extension/orchestration/run-serial.ts`. Add a new optional property to the `RunSerialOpts` interface (around line 8-49):
  ```ts
  /**
   * When set, runSerial calls this once per task that reaches a terminal
   * state with a non-empty finalMessage, before invoking onTerminal. The
   * returned path is merged into the internal OrchestrationResult and the
   * OrchestratedTaskResult passed to onTerminal as `artifactPath`. Empty
   * finalMessage skips the call (the task's artifactPath stays absent/null).
   * Returning null also leaves artifactPath as null.
   */
  writeArtifact?: (taskIndex: number, finalMessage: string) => string | null;
  ```
- [ ] **Step 2: Insert the artifact-write hook** — Inside the `for (let i = 0; i < tasks.length; i++)` loop, after `result.state = result.exitCode === 0 && !result.error ? "completed" : "failed";` (currently line 171) and BEFORE `results.push(result);`, insert:
  ```ts
  let artifactPath: string | null | undefined = undefined;
  if (opts.writeArtifact && result.finalMessage && result.finalMessage.length > 0) {
    artifactPath = opts.writeArtifact(i, result.finalMessage);
  }
  if (artifactPath !== undefined) {
    result = { ...result, artifactPath };
  }
  ```
  Note: we mutate the local `result` reference via spread (the `OrchestrationResult` interface already permits `artifactPath` after Task 1).
- [ ] **Step 3: Pass `artifactPath` into the `onTerminal` payload** — In the existing `opts.onTerminal?.(i, { ... })` call (currently around line 173), add `artifactPath: result.artifactPath ?? null,` to the object literal so the registry sees the new field.
- [ ] **Step 4: Cover the blocked branch (no artifact write)** — In the `if (result.ping)` branch (around lines 137-168) where `opts.onBlocked` is set, do NOT call `writeArtifact` — blocked steps haven't reached a terminal state yet. Verify by reading the existing branch that returns early with `{ blocked: true }` before the new hook runs. No code change needed here; the hook lives after the ping branch returns.
- [ ] **Step 5: Cover the pre-aborted branch (no artifact write)** — In the `if (opts.signal?.aborted)` branch at the top of the loop, no `writeArtifact` call is made (the synthetic cancelled result has `finalMessage: ""`). Confirm by reading the branch (lines 76-99) — no edit needed.
- [ ] **Step 6: Add unit tests** — Open `test/orchestration/run-serial.test.ts`. Append a new `describe("runSerial writeArtifact hook", () => { ... })` block with these tests:
  1. `it("calls writeArtifact once per terminal step with (taskIndex, finalMessage)")` — set up `fakeDeps([{ finalMessage: "A body" }, { finalMessage: "B body" }])`. Pass `writeArtifact: (i, body) => { calls.push({ i, body }); return \`/tmp/task-${i}.md\`; }`. Run a 2-step serial. Assert `calls.length === 2`, `calls[0] === { i: 0, body: "A body" }`, `calls[1] === { i: 1, body: "B body" }`.
  2. `it("merges the returned path into results[i].artifactPath")` — same setup as above. Assert `out.results[0].artifactPath === "/tmp/task-0.md"` and `out.results[1].artifactPath === "/tmp/task-1.md"`.
  3. `it("forwards artifactPath into the onTerminal payload")` — capture `onTerminal` calls into an array; assert each captured `result.artifactPath` matches the writeArtifact return value.
  4. `it("skips writeArtifact when finalMessage is empty")` — `fakeDeps([{ finalMessage: "" }])`. Pass `writeArtifact` that pushes to a list. Assert the list is empty after the run, and `out.results[0].artifactPath` is undefined or null (use `assert.equal(out.results[0].artifactPath ?? null, null)`).
  5. `it("treats writeArtifact returning null as artifactPath: null")` — `fakeDeps([{ finalMessage: "body" }])`. Pass `writeArtifact: () => null`. Assert `out.results[0].artifactPath === null`.
  6. `it("does NOT call writeArtifact for a blocked step (early return path)")` — write a deps that returns a result with `ping: { name: "x", message: "?" }` and `sessionKey: "s"`. Provide both `onBlocked: () => {}` and a tracking `writeArtifact`. Assert the writeArtifact tracker is empty after the run.
- [ ] **Step 7: Run the tests and confirm they pass** — Run `node --test test/orchestration/run-serial.test.ts` and confirm exit code 0 with all six new cases passing alongside existing ones.

**Acceptance criteria:**
- `runSerial` calls `writeArtifact(i, finalMessage)` exactly once per terminal step with a non-empty finalMessage, and the returned path lands on `results[i].artifactPath` and the `onTerminal` payload.
  Verify: run `node --test test/orchestration/run-serial.test.ts` and confirm the "calls writeArtifact once per terminal step" and "merges the returned path into results[i].artifactPath" cases pass.
- Empty `finalMessage` and blocked steps do NOT trigger `writeArtifact`.
  Verify: run `node --test test/orchestration/run-serial.test.ts` and confirm the "skips writeArtifact when finalMessage is empty" and "does NOT call writeArtifact for a blocked step" cases pass.
- `writeArtifact` returning null produces `artifactPath: null`.
  Verify: run `node --test test/orchestration/run-serial.test.ts` and confirm the "treats writeArtifact returning null as artifactPath: null" case passes.
- The `{previous}` substitution path is unchanged (no file I/O introduced between steps).
  Verify: read `pi-extension/orchestration/run-serial.ts` and confirm `previous = result.finalMessage;` (the existing assignment at the bottom of the loop) is unchanged — the `writeArtifact` call sits earlier in the loop and does not replace the in-memory finalMessage with a file read.

**Model recommendation:** standard

---

### Task 4: Wire `writeArtifact` callback into `runParallel`

**Files:**
- Modify: `pi-extension/orchestration/run-parallel.ts`
- Test: `test/orchestration/run-parallel.test.ts`

**Steps:**
- [ ] **Step 1: Extend `RunParallelOpts`** — Open `pi-extension/orchestration/run-parallel.ts`. Add to `RunParallelOpts`:
  ```ts
  /**
   * Mirror of runSerial's writeArtifact hook. Called once per task slot that
   * reaches a terminal state with non-empty finalMessage, before onTerminal.
   * Skipped for blocked slots (registry-owned) and synthetic post-loop
   * cancellation rows (empty finalMessage).
   */
  writeArtifact?: (taskIndex: number, finalMessage: string) => string | null;
  ```
- [ ] **Step 2: Insert the artifact-write hook in the worker** — Inside the `worker()` function, after `result.state = result.exitCode === 0 && !result.error ? "completed" : "failed";` (currently around line 157) and BEFORE `results[i] = result;`, insert:
  ```ts
  let artifactPath: string | null | undefined = undefined;
  if (opts.writeArtifact && result.finalMessage && result.finalMessage.length > 0) {
    artifactPath = opts.writeArtifact(i, result.finalMessage);
  }
  if (artifactPath !== undefined) {
    result = { ...result, artifactPath };
  }
  ```
- [ ] **Step 3: Pass `artifactPath` into the `onTerminal` payload** — In the existing `opts.onTerminal?.(i, { ... })` call (around line 159), add `artifactPath: result.artifactPath ?? null,` to the object literal.
- [ ] **Step 4: Confirm the blocked branch and post-loop sweep do not call writeArtifact** — Read the worker's blocked branch (around lines 125-150) — `continue` returns before the new hook runs, so blocked slots get no artifact. Read the post-loop sweep (around lines 181-211) — synthetic cancelled results have `finalMessage: ""`, so the new hook would skip them anyway, but the sweep doesn't call writeArtifact at all. No edit needed in either branch.
- [ ] **Step 5: Add unit tests** — Open `test/orchestration/run-parallel.test.ts`. Append a new `describe("runParallel writeArtifact hook", () => { ... })` block:
  1. `it("calls writeArtifact for each completed task slot in input order")` — drive 4 tasks with finalMessages "a", "b", "c", "d". Pass `writeArtifact: (i, body) => \`/tmp/p-\${i}.md\``. Assert each `out.results[i].artifactPath` is `/tmp/p-${i}.md`. (The hook fires per worker-claim, but each call is keyed by input index — order of the `calls` array is non-deterministic with concurrency > 1, so assert by input index, not by call order.)
  2. `it("does not call writeArtifact for blocked slots")` — emit a ping result for slot 0 with `onBlocked` set, normal completion for slot 1. Track writeArtifact calls. Assert calls only contains the slot-1 invocation.
  3. `it("does not call writeArtifact for synthetic post-loop cancelled rows")` — pre-abort the signal. Provide writeArtifact tracker. Run runParallel with 2 tasks. Assert tracker is empty.
- [ ] **Step 6: Run the tests** — Run `node --test test/orchestration/run-parallel.test.ts` and confirm exit code 0 with all three new cases passing.

**Acceptance criteria:**
- `runParallel` populates `results[i].artifactPath` with the writer's return value for each completed slot.
  Verify: run `node --test test/orchestration/run-parallel.test.ts` and confirm the "calls writeArtifact for each completed task slot" case passes.
- Blocked slots and post-loop cancelled rows do not invoke `writeArtifact`.
  Verify: run `node --test test/orchestration/run-parallel.test.ts` and confirm the "does not call writeArtifact for blocked slots" and "does not call writeArtifact for synthetic post-loop cancelled rows" cases pass.
- The `onTerminal` payload carries `artifactPath`.
  Verify: open `pi-extension/orchestration/run-parallel.ts` and confirm the `opts.onTerminal?.(i, { ... })` object literal in the worker now includes `artifactPath: result.artifactPath ?? null`.

**Model recommendation:** standard

---

### Task 5: Wire artifact writes into the orchestration tool handler

**Files:**
- Modify: `pi-extension/orchestration/tool-handlers.ts`
- Test: `test/orchestration/tool-handlers.test.ts`

**Steps:**
- [ ] **Step 1: Add necessary imports** — At the top of `pi-extension/orchestration/tool-handlers.ts`, add:
  ```ts
  import { randomBytes } from "node:crypto";
  import { writeOrchestrationTaskArtifact } from "./task-artifact.ts";
  import { getArtifactDir } from "../subagents/launch-spec.ts";
  ```
  Place these imports next to the existing `Type` / `runSerial` / `runParallel` imports.
- [ ] **Step 2: Add a synth-id helper for sync runs** — At module scope (above `registerOrchestrationTools`), add:
  ```ts
  function newSyncOrchestrationId(): string {
    return randomBytes(4).toString("hex");
  }
  ```
  This produces an 8-char hex matching the registry's `newHexId` shape so the path scheme is consistent across sync and async modes.
- [ ] **Step 3: Add a small writeArtifact-builder helper** — Above `registerOrchestrationTools`, add:
  ```ts
  function buildArtifactWriter(
    ctx: { sessionManager: { getSessionDir(): string; getSessionId(): string } },
    orchestrationId: string,
  ): ((taskIndex: number, finalMessage: string) => string | null) | undefined {
    let artifactDir: string;
    try {
      artifactDir = getArtifactDir(
        ctx.sessionManager.getSessionDir(),
        ctx.sessionManager.getSessionId(),
      );
    } catch {
      return undefined; // tests pass {} for sessionManager — degrade gracefully
    }
    return (taskIndex, finalMessage) =>
      writeOrchestrationTaskArtifact({
        artifactDir,
        orchestrationId,
        taskIndex,
        finalMessage,
      });
  }
  ```
  The `try/catch` covers test fixtures that pass `{ sessionManager: {} as any }` — production paths always have working sessionManager methods.
- [ ] **Step 4: Allocate orchestrationId for the sync `subagent_run_serial` path** — Inside the sync `subagent_run_serial.execute` block (after the preflight gate, around line 228, just before `const deps = depsFactory(ctx);`), add:
  ```ts
  const orchestrationId = newSyncOrchestrationId();
  const writeArtifact = buildArtifactWriter(ctx, orchestrationId);
  ```
  Then update the `runSerial(...)` call to pass `writeArtifact`:
  ```ts
  const out = await runSerial(
    params.tasks,
    { signal, onUpdate: _onUpdate as any, writeArtifact },
    deps,
  );
  ```
- [ ] **Step 5: Allocate orchestrationId for the sync `subagent_run_parallel` path** — Mirror Step 4 in the sync `subagent_run_parallel.execute` block (around line 355). Pass `writeArtifact` into `runParallel(...)`'s opts.
- [ ] **Step 6: Wire writeArtifact into the async `subagent_run_serial` background runner** — Inside the `if (params.wait === false)` block of `subagent_run_serial.execute` (line 138-226), after `const orchestrationId = registry.dispatchAsync(...)`, add `const writeArtifact = buildArtifactWriter(ctx, orchestrationId);`. Pass `writeArtifact` into the `runSerial(...)` call inside the fire-and-forget IIFE (around line 163). Also update the `onResumeUnblock` continuation at line 148 to pass `writeArtifact` through to `continueSerialFromIndex` (Step 8).
- [ ] **Step 7: Wire writeArtifact into the async `subagent_run_parallel` background runner** — Mirror Step 6 in the async `subagent_run_parallel.execute` block (line 283-353). Pass `writeArtifact` into `runParallel(...)`.
- [ ] **Step 8: Update `continueSerialFromIndex` to forward writeArtifact with original-index offset** — Change the function's signature (line 8-15) to add `writeArtifact: ((taskIndex: number, finalMessage: string) => string | null) | undefined;` to the opts object. The continuation runs `runSerial` over `tasks.slice(startIndex)`, so the inner runner sees local indices `0..n` for the tail; the upstream `writeArtifact` callback was built with the orchestration id and expects the **original** orchestration task index in its path (`task-<index>.md`). Therefore the callback MUST be wrapped to offset before invoking — passing it through unwrapped would cause a resumed original task `startIndex` to write to `task-0.md` and collide with the head step's artifact. Inside the IIFE (around line 24), build:
  ```ts
  const offsetWriteArtifact = opts.writeArtifact
    ? (j: number, body: string) => opts.writeArtifact!(startIndex + j, body)
    : undefined;
  ```
  Then pass `writeArtifact: offsetWriteArtifact` into the `runSerial(...)` call. Update the call site in the async `subagent_run_serial` `onResumeUnblock` callback to include `writeArtifact` (the variable allocated in Step 6) — it is forwarded unchanged into `continueSerialFromIndex`, which performs the offset internally.
- [ ] **Step 8b: Add a unit test covering the resumed-tail index offset** — Open `test/orchestration/block-resume.test.ts` (or add a new file `test/orchestration/resume-tail-artifact.test.ts` with the same harness pattern as `block-resume.test.ts`). The test must NOT import `buildArtifactWriter` (which is module-scope private to `tool-handlers.ts` and not exported) and must NOT call `continueSerialFromIndex` directly (it is also module-scope private and not exported). Drive the public tool-handler path: invoke `subagent_run_serial.execute` (or its async `wait: false` variant) with a fake `sessionManager` whose `getSessionDir: () => tmpDir, getSessionId: () => "sess1"` so the real `buildArtifactWriter` and the real `continueSerialFromIndex` run end-to-end. Add a test that:
  1. Drives a 3-step serial where step 0 completes normally with a known `finalMessage` (e.g. `"step-0 body"`), step 1 (index 1) blocks via a `caller_ping`/`sessionKey` result, then resumes successfully so the continuation runs step 2 (index 2) with a distinct known `finalMessage` (e.g. `"step-2 body"`).
  2. `tmpDir` is a `mkdtempSync(join(tmpdir(), "resume-tail-arts-"))` value passed in as the fake `sessionManager`'s `getSessionDir()` return.
  3. Asserts the resumed continuation writes the tail step's artifact under `<artifactDir>/orchestrations/<id>/task-2.md` (the **original** task index, not `task-0.md`).
  4. Reads `task-2.md` back and asserts byte-equality with the deps' step-2 `finalMessage`.
  5. Asserts that `task-0.md` exists (step 0 legitimately wrote it before the block) but its content equals step 0's `finalMessage`, NOT step 2's `finalMessage` — proving the resumed tail did not collide with the head step's artifact slot. Do NOT assert `existsSync(...task-0.md) === false`: that would contradict the legitimate step-0 write.
  6. Cleans up the tmp dir in `after()`.
- [ ] **Step 9: Rewrite `summarize()` to produce the new content shape** — Replace the body of `summarize` (lines 437-443) and the body of `firstLine` (lines 445-448 — `firstLine` is no longer used; delete it). New `summarize`:
  ```ts
  function summarize(mode: "serial" | "parallel", results: OrchestrationResult[], isError: boolean): string {
    const lines = [
      `${mode} orchestration: ${results.length} task(s), isError=${isError}`,
      `Each task's full final message is at the artifact path. Read it before acting on the result.`,
    ];
    for (const r of results) {
      const path = r.artifactPath ?? null;
      const tail = path ? `artifact: ${path}` : `artifact: (none)`;
      lines.push(`- ${r.name}: exit=${r.exitCode} (${r.elapsedMs}ms) — ${tail}`);
    }
    return lines.join("\n");
  }
  ```
  Note: signature now requires `OrchestrationResult[]`, not `any[]`. Tighten the type.
- [ ] **Step 10: Propagate `artifactPath` through `toPublicResults`** — Update `toPublicResults` (line 421-435) to include `artifactPath: r.artifactPath ?? null,` in the returned object.
- [ ] **Step 11: Update tool-handlers tests** — Open `test/orchestration/tool-handlers.test.ts`. Make the following targeted additions; do not rewrite existing tests beyond the noted edits:
  1. Add `import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";` and `import { tmpdir } from "node:os";` and `import { join } from "node:path";` at the top.
  2. Add a `describe("writeArtifact wiring (sync)", () => { ... })` block at the bottom of the file with these tests, each setting up its own `mkdtempSync` session dir and tearing it down with `rmSync`:
     - `it("subagent_run_serial sync writes one artifact per task and renders the new content shape")` — build a `LauncherDeps` returning multi-line `finalMessage`s. Use a fake `sessionManager` with `getSessionDir: () => tmpDir, getSessionId: () => "sess1"`. Call `serial.execute(...)`. Assert `out.content[0].text` matches the regex `/^serial orchestration: 2 task\(s\), isError=false\nEach task's full final message is at the artifact path\. Read it before acting on the result\.\n- step-1: exit=0 \(\d+ms\) — artifact: .+\/orchestrations\/[0-9a-f]{8}\/task-0\.md\n- step-2: exit=0 \(\d+ms\) — artifact: .+\/task-1\.md$/`. Read each artifact path back via `readFileSync` and assert byte-equal to the deps' `finalMessage`. Assert `out.details.results[0].artifactPath` is set and equals the path in the content text.
     - `it("subagent_run_parallel sync writes per-task artifacts and renders the new content shape")` — mirror with parallel; assert each row's path begins under `tmpDir/artifacts/sess1/orchestrations/<id>/task-<i>.md`.
     - `it("renders 'artifact: (none)' for tasks with empty finalMessage")` — deps returning `finalMessage: ""`; assert content row contains `artifact: (none)`; assert `out.details.results[0].artifactPath === null`.
     - `it("round-trips a >= 50KB markdown body through the artifact path")` — set `finalMessage` to `("# heading\n" + "x".repeat(60_000)).slice(0, 60_000)`. Assert the artifact file's bytes match. In the test's `after()` hook, `rmSync` the tmpDir.
  3. Modify the existing `it("subagent_run_serial.execute invokes runSerial and returns aggregated result")` test to set up a `mkdtempSync` session dir + sessionManager so it exercises the new writeArtifact path; then `rmSync` it in the `after()`.
- [ ] **Step 12: Run the tests** — Run `node --test test/orchestration/tool-handlers.test.ts` and confirm exit code 0 with all new cases passing and existing cases unbroken.

**Acceptance criteria:**
- Sync `subagent_run_serial` and `subagent_run_parallel` produce a `content[0].text` whose first line is `<serial|parallel> orchestration: <N> task(s), isError=<bool>`, second line is exactly `Each task's full final message is at the artifact path. Read it before acting on the result.`, and per-task rows take the form `- <name>: exit=<code> (<ms>ms) — artifact: <path>`.
  Verify: run `node --test test/orchestration/tool-handlers.test.ts` and confirm the two "sync writes one artifact ... and renders the new content shape" cases pass.
- Reading the artifact path returns the child's `finalMessage` byte-for-byte.
  Verify: run `node --test test/orchestration/tool-handlers.test.ts` and confirm the byte-equality assertions inside the two sync-shape cases pass; additionally confirm the ">= 50KB markdown body" case passes.
- A task with empty `finalMessage` renders `artifact: (none)` and `details.results[i].artifactPath === null`.
  Verify: run `node --test test/orchestration/tool-handlers.test.ts` and confirm the "renders 'artifact: (none)' for tasks with empty finalMessage" case passes.
- `toPublicResults` now propagates `artifactPath`.
  Verify: `grep -n "artifactPath: r.artifactPath" pi-extension/orchestration/tool-handlers.ts` returns at least one match.
- The artifact path layout matches `<artifactDir>/orchestrations/<8-char-hex>/task-<index>.md`.
  Verify: run `node --test test/orchestration/tool-handlers.test.ts` and confirm the regex-based path assertion in the sync-serial shape test passes.
- The resumed serial-tail artifact uses the **original** orchestration task index, not the local tail index — a 3-step serial that blocks on step 1 and resumes successfully writes the resumed step-2's body to `task-2.md`, never overwriting `task-0.md`.
  Verify: run `node --test test/orchestration/block-resume.test.ts` (or `node --test test/orchestration/resume-tail-artifact.test.ts` if Step 8b created a new file) and confirm the new "resumed-tail index offset" case passes — specifically that `existsSync(<artifactDir>/orchestrations/<id>/task-2.md)` is true, `readFileSync(...task-2.md, "utf8")` returns the deps' step-2 `finalMessage` byte-for-byte, and `readFileSync(...task-0.md, "utf8")` returns step-0's `finalMessage` (NOT the step-2 body), proving the resumed tail did not collide with the head step's artifact slot.
- `continueSerialFromIndex` wraps the upstream `writeArtifact` to apply the `startIndex` offset.
  Verify: open `pi-extension/orchestration/tool-handlers.ts` and confirm the IIFE inside `continueSerialFromIndex` constructs `offsetWriteArtifact = opts.writeArtifact ? (j, body) => opts.writeArtifact!(startIndex + j, body) : undefined` and passes it as `writeArtifact` into the inner `runSerial(...)` call.

**Model recommendation:** standard

---

### Task 6: Update the async steer content text

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Test: `test/orchestration/async-dispatch.test.ts`

**Steps:**
- [ ] **Step 1: Locate the registry emitter** — Open `pi-extension/subagents/index.ts` and find the `registryEmitter` block at lines 1220-1259 (specifically the `ORCHESTRATION_COMPLETE_KIND` branch starting at line 1223).
- [ ] **Step 2: Build the new content text** — Replace the existing `content:` value (lines 1227-1229) with a function that constructs the new shape. Inline:
  ```ts
  const headerLine =
    `Orchestration "${payload.orchestrationId}" completed ` +
    `(${payload.results.length} task(s), isError=${payload.isError}).`;
  const hintLine =
    `Each task's full final message is at the artifact path. Read it before acting on the result.`;
  const rowLines = payload.results.map((r: any) => {
    const path = r.artifactPath ?? null;
    const tail = path ? `artifact: ${path}` : `artifact: (none)`;
    return `- ${r.name}: exit=${r.exitCode ?? "?"} (${r.elapsedMs ?? 0}ms) — ${tail}`;
  });
  const content = [headerLine, hintLine, ...rowLines].join("\n");
  ```
  Pass `content` (the string variable) into the `pi.sendMessage({...})` call below it. Use `r.exitCode ?? "?"` because cancelled-before-completion rows may legitimately omit `exitCode`; render `?` so the model can spot the abnormal row.
- [ ] **Step 3: Confirm the renderer is unchanged** — Read the renderer at line 2140 (`registerMessageRenderer("orchestration_complete", ...)`). Confirm it still reads `details.results[i].name` and `details.results[i].state` only (no read of the new `content` text). No edit required.
- [ ] **Step 4: Refactor — extract the content-builder helper** — To support both production reuse and a direct unit test, extract the inline `headerLine`/`hintLine`/`rowLines` logic into an exported helper inside `pi-extension/subagents/index.ts`:
  ```ts
  export function buildOrchestrationCompleteContent(payload: {
    orchestrationId: string;
    results: Array<{ name: string; exitCode?: number; elapsedMs?: number; artifactPath?: string | null }>;
    isError: boolean;
  }): string {
    const headerLine = `Orchestration "${payload.orchestrationId}" completed (${payload.results.length} task(s), isError=${payload.isError}).`;
    const hintLine = `Each task's full final message is at the artifact path. Read it before acting on the result.`;
    const rowLines = payload.results.map((r) => {
      const path = r.artifactPath ?? null;
      const tail = path ? `artifact: ${path}` : `artifact: (none)`;
      return `- ${r.name}: exit=${r.exitCode ?? "?"} (${r.elapsedMs ?? 0}ms) — ${tail}`;
    });
    return [headerLine, hintLine, ...rowLines].join("\n");
  }
  ```
  Replace the inline construction in `registryEmitter` with a call to `buildOrchestrationCompleteContent(payload)` so that the production async path emits via this helper.
- [ ] **Step 5: Add an async-dispatch test that drives the production registry-emitter path** — Open `test/orchestration/async-dispatch.test.ts`. Append:
  ```ts
  describe("async orchestration_complete steer content shape (artifact rows)", () => {
    it("emits a sendMessage whose content carries header + hint + per-task artifact rows", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "pi-async-arts-"));
      // ... test body (see steps below)
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });
  ```
  The test must exercise the production async path end-to-end:
  1. Stand up a `pi.sendMessage` recorder that captures every call (`const sent: any[] = []; const pi = { sendMessage: (m: any) => { sent.push(m); } };` or the equivalent shape used by other tests in the same file).
  2. Wire the `subagentsExtension` (or the same `registryEmitter` factory the extension uses in production) so its emit handler routes orchestration_complete events through the real `registryEmitter` into `pi.sendMessage`. Do not bypass `registryEmitter` — the goal is to verify it actually calls `buildOrchestrationCompleteContent` with the runtime payload.
  3. Use a `LauncherDeps` returning `finalMessage: "multi\nline\nbody-N"` per task (e.g. two tasks).
  4. Provide a fake `sessionManager` with `getSessionDir: () => tmpDir, getSessionId: () => "sess1"`.
  5. Run `serial.execute({ wait: false, ... })`. Poll until the captured `sent` array has at least one entry whose payload kind is `orchestration_complete` (use a short polling loop with timeout — same pattern other async tests in this file use).
  6. Assert the captured `sendMessage` payload's `content` string:
     - First line matches `/^Orchestration "[0-9a-f]{8}" completed \(2 task\(s\), isError=false\)\.$/`.
     - Second line equals `Each task's full final message is at the artifact path. Read it before acting on the result.` exactly.
     - Subsequent lines match `- <name>: exit=0 (<ms>ms) — artifact: <path>` where each path is under `${tmpDir}/artifacts/sess1/orchestrations/<id>/task-<i>.md`.
  7. Read each artifact path with `readFileSync(path, "utf8")` and assert it equals the corresponding `LauncherDeps.finalMessage` byte-for-byte. This proves the runner-emitted artifactPath made it into the steer payload (i.e. registryEmitter wired the actual runtime payload through `buildOrchestrationCompleteContent`).
  8. Use `after()` to `rmSync(tmpDir, { recursive: true, force: true })`.
- [ ] **Step 6: Run the tests** — Run `node --test test/orchestration/async-dispatch.test.ts` and confirm exit code 0.

**Acceptance criteria:**
- The async `orchestration_complete` steer's `content` text begins with `Orchestration "<id>" completed (<N> task(s), isError=<bool>).` (verbatim format, including trailing period), followed by the hint line, followed by per-task `- <name>: exit=<code> (<ms>ms) — artifact: <path>` rows (or `artifact: (none)` when `artifactPath` is null).
  Verify: open `pi-extension/subagents/index.ts`, locate `buildOrchestrationCompleteContent`, and read its body to confirm the three components are concatenated in this order with `\n` separators.
- The widget renderer continues to render successfully against the new content shape.
  Verify: read `pi-extension/subagents/index.ts` around line 2140 and confirm the `registerMessageRenderer("orchestration_complete", ...)` body still reads `details.results[i].name` and `details.results[i].state` only — no edit was made to its body.
- `registryEmitter` invokes `buildOrchestrationCompleteContent` with the runtime payload (proving the formatter is on the production async path, not just unit-tested in isolation).
  Verify: `grep -n "buildOrchestrationCompleteContent" pi-extension/subagents/index.ts` returns at least two lines — one for the export and one for the call site inside the `ORCHESTRATION_COMPLETE_KIND` branch of `registryEmitter`.
- The async-dispatch test that drives `serial.execute({ wait: false })` and captures `pi.sendMessage` passes, with `content` matching the header + hint + per-task `artifact:` row shape AND each captured artifact path reading back byte-equal to its task's `finalMessage`.
  Verify: run `node --test test/orchestration/async-dispatch.test.ts` and confirm the new "emits a sendMessage whose content carries header + hint + per-task artifact rows" case passes.

**Model recommendation:** standard

---

### Task 7: Drop `finalMessage` from registry tombstone after artifact write

**Files:**
- Modify: `pi-extension/orchestration/registry.ts`
- Test: `test/orchestration/registry-eviction.test.ts`

**Steps:**
- [ ] **Step 1: Extend the post-emit strip in `tryFinalize`** — In `pi-extension/orchestration/registry.ts`, locate the existing transcript/usage strip loop at lines 183-188. Change the loop body to:
  ```ts
  for (let i = 0; i < entry.tasks.length; i++) {
    const t = entry.tasks[i];
    const stripFinalMessage = t.artifactPath != null && t.finalMessage != null;
    if (t.transcript || t.usage || stripFinalMessage) {
      entry.tasks[i] = {
        ...t,
        transcript: undefined,
        usage: undefined,
        finalMessage: stripFinalMessage ? undefined : t.finalMessage,
      };
    }
  }
  ```
  This preserves the existing strip for transcript/usage and additionally drops `finalMessage` only when an artifact was successfully written. Tasks with no artifact retain `finalMessage` for post-mortem inspection.
- [ ] **Step 2: Add a unit test for the strip** — Open `test/orchestration/registry-eviction.test.ts`. Append a new test inside the existing `describe("registry sheds heavy per-task payloads after completion (review-v1 #4)", ...)` block:
  ```ts
  it("drops finalMessage from the tombstone once artifactPath is set", () => {
    const { emitter, emitted } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskTerminal(id, 0, {
      name: "a",
      index: 0,
      state: "completed",
      finalMessage: "long markdown body",
      artifactPath: "/tmp/orchestrations/abcd/task-0.md",
      exitCode: 0,
      elapsedMs: 1,
    });

    // Emitted aggregated completion still carries finalMessage AND artifactPath.
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].results[0].finalMessage, "long markdown body");
    assert.equal(emitted[0].results[0].artifactPath, "/tmp/orchestrations/abcd/task-0.md");

    // Tombstone drops finalMessage; artifactPath is preserved as the pointer.
    const snap = reg.getSnapshot(id);
    assert.ok(snap);
    assert.equal(snap!.tasks[0].finalMessage, undefined,
      "tombstone must drop finalMessage once artifactPath is set");
    assert.equal(snap!.tasks[0].artifactPath, "/tmp/orchestrations/abcd/task-0.md",
      "tombstone must retain artifactPath as the body pointer");
  });

  it("retains finalMessage on the tombstone when artifactPath is null", () => {
    const { emitter } = makeEmitterSpy();
    const reg = createRegistry(emitter);
    const id = reg.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    reg.onTaskTerminal(id, 0, {
      name: "a",
      index: 0,
      state: "failed",
      finalMessage: "early failure body",
      artifactPath: null,
      exitCode: 1,
      elapsedMs: 1,
      error: "boom",
    });
    const snap = reg.getSnapshot(id);
    assert.equal(snap!.tasks[0].finalMessage, "early failure body",
      "no artifact ⇒ finalMessage must be retained for post-mortem");
  });
  ```
- [ ] **Step 3: Run the tests** — Run `node --test test/orchestration/registry-eviction.test.ts` and confirm exit code 0 with both new cases passing alongside the existing one.

**Acceptance criteria:**
- After `tryFinalize` runs, a task tombstone with non-null `artifactPath` no longer carries `finalMessage`.
  Verify: run `node --test test/orchestration/registry-eviction.test.ts` and confirm the "drops finalMessage from the tombstone once artifactPath is set" case passes.
- The emitted `orchestration_complete` payload still carries `finalMessage` (the strip happens after emit).
  Verify: run `node --test test/orchestration/registry-eviction.test.ts` and confirm the same test's `assert.equal(emitted[0].results[0].finalMessage, "long markdown body")` assertion passes.
- A task with no artifact (`artifactPath: null`) retains `finalMessage` on the tombstone.
  Verify: run `node --test test/orchestration/registry-eviction.test.ts` and confirm the "retains finalMessage on the tombstone when artifactPath is null" case passes.

**Model recommendation:** cheap

---

### Task 8: Write artifact for blocked task's resumed terminal result

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Test: `test/orchestration/resume-artifact.test.ts` (Create)

A blocked orchestration task that later completes via the standalone `subagent_resume` path goes through a different terminal callsite than the runner's `onTerminal`: `pi-extension/subagents/index.ts` (around line 1953) calls `registry.onResumeTerminal(sessionKey, { ..., finalMessage: summary, ... })` directly. Tasks 3 & 4 only wire `writeArtifact` into the runner's `onTerminal` path, so a blocked-then-resumed task currently gets no artifact and `OrchestratedTaskResult.artifactPath` stays absent — violating the spec's contract that every completed task with non-empty `finalMessage` has `artifactPath` populated. This task adds an artifact write at the resume-terminal callsite and merges the path into the result before invoking `registry.onResumeTerminal`.

**Steps:**
- [ ] **Step 1: Add the artifact-helper import** — Open `pi-extension/subagents/index.ts`. The file already imports `getArtifactDir` from `./launch-spec.ts` (line 62/78) and uses it at line 1765 inside `subagent_resume.execute` to compute `artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId)`. Add `import { writeOrchestrationTaskArtifact } from "../orchestration/task-artifact.ts";` next to the other orchestration-related imports (near the top of the file alongside `Registry`, etc.). No `getArtifactDir` change is required — the existing import covers both callsites.
- [ ] **Step 2: Compute `artifactPath` at the resume-terminal callsite** — Locate the `if (owner)` branch inside `subagent_resume.execute`'s post-watcher `.then()` handler (around line 1942 — the "NEW: if orch-owned, re-ingest the terminal result" block). The existing `artifactDir` local (line 1765) is in the same function scope and captured by the `.then()` closure, so it is reachable here without recomputing. Before the `registry.onResumeTerminal(sessionKey, { ... })` call, add:
  ```ts
  let artifactPath: string | null = null;
  if (summary && summary.length > 0) {
    artifactPath = writeOrchestrationTaskArtifact({
      artifactDir,
      orchestrationId: owner.orchestrationId,
      taskIndex: owner.taskIndex,
      finalMessage: summary,
    });
  }
  ```
  `writeOrchestrationTaskArtifact` already returns `null` on empty body or write failure (see Task 2 Step 1), so no extra `try/catch` is needed at this callsite — the helper's null-return contract handles the failure case. The empty-`summary` guard avoids creating a zero-byte artifact file when the resumed session exits without new output.
- [ ] **Step 3: Pass `artifactPath` into the resumed result before terminalizing** — Update the `registry.onResumeTerminal(sessionKey, { ... })` object literal (around line 1953) to include `artifactPath,` alongside the existing `finalMessage`, `transcriptPath`, `elapsedMs`, etc. Place it immediately after `transcriptPath` to mirror the field grouping used in the `OrchestratedTaskResult` interface.
- [ ] **Step 4: Confirm the runner-emitted-then-resumed merge ordering is harmless** — Read `pi-extension/orchestration/registry.ts` `onResumeTerminal` (around lines 303-362). The implementation calls `registry.onTaskTerminal(own.orchestrationId, own.taskIndex, normalized)` which spreads the incoming result over the existing tombstone. Since this task path adds `artifactPath` to the incoming `result`, the spread inside `onTaskTerminal` will set `artifactPath` on the merged tombstone. No registry change is required.
- [ ] **Step 5: Write a unit test exercising the blocked-then-resumed artifact write** — Create `test/orchestration/resume-artifact.test.ts`. Follow the harness pattern from `test/orchestration/resume-transcript-preservation.test.ts`:
  1. Use `__test__.resetRegistry`, `__test__.setMuxAvailableOverride(true)`, `__test__.setSurfaceOverrides(...)`, and `__test__.setWatchSubagentOverride(...)` to drive the `subagent_resume` tool's internal `watchSubagent` call.
  2. Set up a `mkdtempSync(join(tmpdir(), "resume-artifact-"))` for `scratch`. Provide a `sessionManager` with `getSessionFile: () => join(scratch, "parent.jsonl")`, `getSessionId: () => "parent"`, `getSessionDir: () => scratch`.
  3. Drive a registry by hand to the blocked-but-owned state: `registry.dispatchAsync({ config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] } })`, `registry.onTaskLaunched(orchId, 0, {})`, `registry.updateSessionKey(orchId, 0, sessionKey)`, `registry.onTaskBlocked(orchId, 0, { sessionKey, message: "?" })`.
  4. Override `watchSubagent` to return a successful resume: `{ name: "a", task: "t", summary: "resumed body — multi-line\nfinding 1\nfinding 2", transcriptPath: null, exitCode: 0, elapsed: 1, claudeSessionId: <or omit for pi resume> }`.
  5. Invoke the `subagent_resume` tool with the matching session/sessionId for the path under test (start with the pi resume branch — set `sessionPath` to a tmp file under `scratch`).
  6. After the resume tool's promise settles, capture the registry snapshot for the orchestration id and assert `snap!.tasks[0].artifactPath` is a string ending in `/orchestrations/<id>/task-0.md`. Read the file with `readFileSync(snap!.tasks[0].artifactPath!, "utf8")` and assert byte-equality with `summary`.
  7. Capture the `emitted` events array (push from the registry emitter) and assert the emitted `orchestration_complete` payload also carries the same `artifactPath` AND the original `finalMessage` ("resumed body — multi-line\nfinding 1\nfinding 2"), proving the steer payload still includes both fields (the registry's tombstone strip from Task 7 happens AFTER the emit, so the emitted payload retains `finalMessage`).
  8. `afterEach`/`after` cleanup: `rmSync(scratch, { recursive: true, force: true })`, `__test__.resetRegistry()`, override resets.
- [ ] **Step 6: Run the test** — Run `node --test test/orchestration/resume-artifact.test.ts` and confirm exit code 0.

**Acceptance criteria:**
- A blocked orchestration task that resumes successfully has `artifactPath` populated on the merged tombstone, pointing to a file containing the resumed `summary` byte-for-byte.
  Verify: run `node --test test/orchestration/resume-artifact.test.ts` and confirm the test asserting `snap!.tasks[0].artifactPath` is non-null AND `readFileSync(artifactPath, "utf8") === summary` passes.
- The emitted `orchestration_complete` payload for the resumed orchestration still carries `finalMessage` (the runtime body) AND `artifactPath` (the pointer), proving the registry's strip ordering is preserved across the resume path.
  Verify: run `node --test test/orchestration/resume-artifact.test.ts` and confirm the assertions on the captured `emitted[0].results[0].finalMessage` (non-empty) and `emitted[0].results[0].artifactPath` (non-null) both pass.
- The artifact path uses the **original** orchestration task index in `task-<index>.md`.
  Verify: open `pi-extension/subagents/index.ts` at the resume-terminal callsite and confirm the call to `writeOrchestrationTaskArtifact({...})` passes `taskIndex: owner.taskIndex` (the index from the registry ownership map, NOT a local 0).
- The resume-terminal artifact write is gated on a non-empty `summary`; an empty resumed-session summary results in `artifactPath: null`.
  Verify: open `pi-extension/subagents/index.ts` and confirm the `writeOrchestrationTaskArtifact({...})` call sits inside an `if (summary && summary.length > 0) { ... }` guard, and that `artifactPath` is initialized to `null` outside the guard before being passed into `registry.onResumeTerminal({ ..., artifactPath, ... })`.

**Model recommendation:** standard

---

### Task 9: Coordinator-style integration test (slow lane)

**Files:**
- Create: `test/integration/agents/test-reviewer-md.md`
- Create: `test/integration/agents/test-coordinator-md.md`
- Modify: `test/integration/coordinator-orchestration-tools.test.ts`

**Steps:**
- [ ] **Step 1: Add a new test agent for multi-finding markdown emission** — Inside `test/integration/agents/`, create `test-reviewer-md.md` with frontmatter:
  ```
  ---
  name: test-reviewer-md
  description: Integration test agent — emits a multi-finding markdown review verbatim
  model: anthropic/claude-haiku-4-5
  tools: read, grep
  spawning: false
  auto-exit: true
  disable-model-invocation: true
  ---

  You are a test agent. When invoked, your final assistant message must be the literal content given to you in the task — preserving every newline, heading, and special character byte-for-byte.
  ```
  The `tools: read, grep` allowlist matches the spec's exact invariant: the child has no `write` tool, exercising the constraint that artifact writes are done by the parent only.
- [ ] **Step 2: Extend `coordinator-orchestration-tools.test.ts`** — First, update the existing `node:fs` import line at the top of the file so it reads `import { mkdtempSync, rmSync } from "node:fs";` PLUS any additional symbols this task needs. The test below does NOT call `readFileSync` directly (the coordinator agent reads the artifact via its own `read` tool), so no `readFileSync` import is required. If you later add an assertion that opens the artifact in the parent process, also add `readFileSync` to the import list at that time. Then append a new `it(...)` to the existing `describe` block:
  ```ts
  it("parent recovers a multi-finding markdown body via artifactPath without truncation", async () => {
    const reviewBody = [
      "# Review Findings",
      "",
      "## Finding 1: Issue with foo",
      "Severity: high",
      "",
      "## Finding 2: Suggestion for bar",
      "Severity: medium",
      "",
      "## Finding 3: Nit on baz",
      "Severity: low",
      "",
      "$$ literal-dollar test, $& raw, $1 also raw",
      "Final line.",
    ].join("\n");

    const backend = makeHeadlessBackend({
      sessionManager: {
        getSessionFile: () => join(dir, "parent.jsonl"),
        getSessionId: () => "parent",
        getSessionDir: () => dir,
      } as any,
      cwd: dir,
    });
    // The coordinator agent dispatches subagent_run_serial against test-reviewer-md
    // with `task: "<reviewBody>"`, parses the `artifact: <path>` row from the
    // tool result content text, calls `read` on that path, and emits the artifact
    // body verbatim as its own final assistant message. We assert byte-equality
    // between the coordinator's finalMessage and reviewBody. This validates the
    // coordinator-facing contract: the model-visible tool result does NOT
    // contain the child's full finalMessage; coordinators must read the
    // artifact path to recover the full body.
    const handle = await backend.launch(
      {
        name: "coord",
        agent: "test-coordinator-md",
        task: `Run subagent_run_serial with one task: agent=test-reviewer-md, task=${JSON.stringify(reviewBody)}. After it returns, parse the artifact path from the tool result's content text (look for the line "- <name>: ... — artifact: <path>"), call the read tool on that path, and emit the file body verbatim as your final assistant message.`,
      },
      false,
    );
    const result = await backend.watch(handle);
    assert.equal(result.exitCode, 0);

    // Primary assertion: coordinator's finalMessage equals review body
    // byte-for-byte. This proves the full pipeline:
    //   1. Parent wrote the artifact for the child's finalMessage.
    //   2. The model-visible tool result content includes the artifact path.
    //   3. The coordinator successfully read that path with its `read` tool.
    //   4. The artifact body matches the child's last assistant message.
    assert.equal(
      result.finalMessage,
      reviewBody,
      "coordinator's finalMessage (artifact body it read) must equal child's finalMessage byte-for-byte",
    );

    // Cleanup: parse the artifact path from the toolResult content text in the
    // transcript and rmSync it. The headless backend's transcript projection
    // (projectPiMessageToTranscript in pi-extension/subagents/backends/headless.ts)
    // preserves toolResult.content (text blocks) but drops the `details` field,
    // so we MUST parse from content, not from details.
    const transcript = result.transcript ?? [];
    let artifactPath: string | undefined;
    for (const msg of transcript) {
      if (msg.role !== "toolResult" || msg.toolName !== "subagent_run_serial") continue;
      for (const block of msg.content) {
        if ((block as any).type !== "text") continue;
        const text = (block as any).text as string;
        const m = text.match(/—\s*artifact:\s+(\S+\.md)/);
        if (m) {
          artifactPath = m[1];
          break;
        }
      }
      if (artifactPath) break;
    }
    assert.ok(artifactPath, "toolResult content text must contain an `artifact: <path>` row");
    rmSync(artifactPath!, { force: true });
  });
  ```
  Also create `test/integration/agents/test-coordinator-md.md` with the exact contents below. The existing `test-coordinator.md` is hardcoded to dispatch `test-echo` with a fixed message, so it cannot pass an arbitrary review body through. The new coordinator's instructions explicitly require it to (a) parse the artifact path from the tool result content text, (b) call `read` on that path, and (c) emit the artifact body verbatim — exercising the spec's coordinator-visible contract that full child output is recovered through the artifact path, not through the inline content text.

  ```
  ---
  name: test-coordinator-md
  description: Integration test agent — dispatches test-reviewer-md via subagent_run_serial, reads the artifact, and emits its body verbatim
  model: anthropic/claude-haiku-4-5
  cli: pi
  tools: read, bash, subagent_run_serial
  auto-exit: true
  disable-model-invocation: true
  ---

  You are a test coordinator. The caller's task message will instruct you to dispatch a single subagent with a specific review body. Your job is exactly four steps, in order:

  1. Call `subagent_run_serial` exactly once with one task whose `agent` is `test-reviewer-md` and whose `task` is the literal review body the caller specified — preserving every newline, heading, dollar sign, and special character byte-for-byte.
  2. The tool result's `content` text contains a per-task row of the form `- <name>: exit=<code> (<ms>ms) — artifact: <absolute-path-ending-in-.md>`. Extract the `<absolute-path-ending-in-.md>` token from that row.
  3. Call the `read` tool with that absolute path to load the artifact body.
  4. Emit the artifact body verbatim as your final assistant message and stop.

  Do not modify, summarize, paraphrase, or wrap the artifact body. Do not call any other tool. Do not retry. Do not ask questions.
  ```
- [ ] **Step 3: Add a long-output regression case** — Append another `it(...)` exercising the ≥ 50KB constraint. The harness mirrors Step 2 exactly: the coordinator dispatches `test-reviewer-md` with the long body, parses the artifact path from the tool result content text, reads the artifact via its `read` tool, and emits the body verbatim. The parent asserts byte-equality between `result.finalMessage` and the input body. For cleanup, parse the artifact path from the transcript's toolResult content text using the same regex as Step 2 and `rmSync(artifactPath, { force: true })`:
  ```ts
  it("round-trips a >= 50KB markdown body through the artifact path", async () => {
    const body = "# Long output\n" + ("filler line\n".repeat(5000)); // ~60KB

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
        name: "coord",
        agent: "test-coordinator-md",
        task: `Run subagent_run_serial with one task: agent=test-reviewer-md, task=${JSON.stringify(body)}. After it returns, parse the artifact path from the tool result's content text and read it; emit the file body verbatim.`,
      },
      false,
    );
    const result = await backend.watch(handle);
    assert.equal(result.exitCode, 0);
    assert.equal(
      result.finalMessage,
      body,
      ">=50KB body must round-trip through the artifact path byte-for-byte",
    );

    // Cleanup: parse the artifact path from transcript content and remove the file.
    let artifactPath: string | undefined;
    for (const msg of result.transcript ?? []) {
      if (msg.role !== "toolResult" || msg.toolName !== "subagent_run_serial") continue;
      for (const block of msg.content) {
        if ((block as any).type !== "text") continue;
        const m = ((block as any).text as string).match(/—\s*artifact:\s+(\S+\.md)/);
        if (m) {
          artifactPath = m[1];
          break;
        }
      }
      if (artifactPath) break;
    }
    if (artifactPath) rmSync(artifactPath, { force: true });
  });
  ```
- [ ] **Step 4: Add a backend-coverage parametric case** — Append a third `it(...)` that runs the same coordinator scenario with `process.env.PI_SUBAGENT_MODE = "pane"` (set in a `before` block scoped to this `it` via `t.before` if `node:test` allows; otherwise duplicate the test block under a separate `describe` with its own backend env). Assert the same byte-equality. Skip the case under `SHOULD_SKIP` (no mux available) using the existing `skip` flag.
- [ ] **Step 5: Run the slow-lane suite locally** — Set `PI_RUN_SLOW=1` and run `npm run test:integration:slow` against this single file: `PI_RUN_SLOW=1 node --test test/integration/coordinator-orchestration-tools.test.ts`. Confirm all three new cases pass on whatever backend(s) the host supports (mux availability gates the pane case; the headless case runs unconditionally on hosts with `pi` installed).

**Acceptance criteria:**
- A real pi-CLI child emits a multi-finding markdown review under the headless backend; the coordinator reads the artifact path from the tool result content text, calls `read` on it, and emits the artifact body as its own finalMessage; that finalMessage matches the input review body byte-for-byte.
  Verify: with `pi` available and `PI_RUN_SLOW=1`, run `PI_RUN_SLOW=1 node --test test/integration/coordinator-orchestration-tools.test.ts` and confirm the "parent recovers a multi-finding markdown body via artifactPath without truncation" case passes (specifically the `assert.equal(result.finalMessage, reviewBody, ...)` assertion).
- The coordinator agent's instructions explicitly require parsing the artifact path from the tool result content text and calling `read` on it (proving the test exercises the coordinator-visible contract, not just a parent-side file read).
  Verify: open `test/integration/agents/test-coordinator-md.md` and confirm the body contains both the literal phrases `parse the artifact path from the tool result's content text` (or `— artifact: <absolute-path-ending-in-.md>`) AND `Call the \`read\` tool` AND `emit the artifact body verbatim`.
- The cleanup path parses the artifact location from the toolResult `content` text (not from the dropped `details` field).
  Verify: open `test/integration/coordinator-orchestration-tools.test.ts` and confirm the new test bodies use a regex like `/—\s*artifact:\s+(\S+\.md)/` against `(block as any).text` and do NOT reference `details?.results` for path extraction.
- A ≥ 50KB body round-trips through the artifact path without truncation; the test removes the long-output artifact file before teardown.
  Verify: with `pi` available and `PI_RUN_SLOW=1`, run the same command and confirm the "round-trips a >= 50KB markdown body through the artifact path" case passes; additionally `grep -n "rmSync(artifactPath" test/integration/coordinator-orchestration-tools.test.ts` returns at least one match in the long-output test body.
- The pane-backend variant of the coordinator scenario passes when mux is available.
  Verify: on a host with mux + pi + `PI_RUN_SLOW=1`, run the same command and confirm the new pane-backend case passes; on a host without mux, confirm it self-skips via the existing `SHOULD_SKIP` flag (no failure).
- The child agent uses `tools: read, grep` (no `write`) so the spec's allowlist invariant is exercised end-to-end.
  Verify: open `test/integration/agents/test-reviewer-md.md` and confirm the frontmatter line reads exactly `tools: read, grep` (no `write`, no `bash`).

**Model recommendation:** capable

---

### Task 10: End-to-end smoke run + lint/typecheck

**Files:**
- Modify: none (verification only)

**Steps:**
- [ ] **Step 1: Run the typecheck pass** — Execute `npm run typecheck` and confirm exit code 0. The new optional `artifactPath` field on both `OrchestrationResult` and `OrchestratedTaskResult`, plus the new optional `writeArtifact` opts, plus the strip in `tryFinalize`, plus the `buildOrchestrationCompleteContent` export, plus the resume-path artifact write in `pi-extension/subagents/index.ts`, should all type-check cleanly.
- [ ] **Step 2: Run the lint pass** — Execute `npm run lint` and confirm exit code 0. Address any new warnings introduced by the changes (most likely candidates: unused imports if `firstLine` was removed in Task 5 and a stale import was missed).
- [ ] **Step 3: Run the full unit-test suite** — Execute `npm test` and confirm exit code 0 with no `FAIL` lines. The full suite covers:
  - `task-artifact.test.ts` (Task 2)
  - `run-serial.test.ts` writeArtifact additions (Task 3)
  - `run-parallel.test.ts` writeArtifact additions (Task 4)
  - `tool-handlers.test.ts` artifact-shape additions (Task 5)
  - The resumed-tail index-offset case from Task 5 Step 8b (`block-resume.test.ts` or `resume-tail-artifact.test.ts`)
  - `async-dispatch.test.ts` content-builder addition (Task 6)
  - `registry-eviction.test.ts` finalMessage strip (Task 7)
  - `resume-artifact.test.ts` blocked-then-resumed artifact write (Task 8)
  - All pre-existing tests (regression check)
- [ ] **Step 4: Run the fast integration suite** — Execute `npm run test:integration` and confirm exit code 0. Many integration tests exercise the orchestration tool handlers; the new content-text shape must not break any of them (most read `details.results`, not `content`, so they should be unaffected).
- [ ] **Step 5: Run the slow integration suite (if pi is available)** — If `pi` is on PATH and the host supports the slow lane, execute `PI_RUN_SLOW=1 npm run test:integration:slow` and confirm exit code 0. This validates the Task 9 cases plus the existing slow-lane orchestration tests.

**Acceptance criteria:**
- Typecheck passes with no errors.
  Verify: run `npm run typecheck` and confirm exit code 0.
- Lint passes with no errors.
  Verify: run `npm run lint` and confirm exit code 0.
- The full unit-test suite passes.
  Verify: run `npm test` and confirm exit code 0 with no `FAIL` lines in the output.
- The fast integration suite passes.
  Verify: run `npm run test:integration` and confirm exit code 0.
- The slow integration suite passes on a host with `pi` available.
  Verify: with `pi` on PATH, run `PI_RUN_SLOW=1 npm run test:integration:slow` and confirm exit code 0; on a host without `pi`, confirm the suite self-skips via the existing `SHOULD_SKIP` flags (no failure).

**Model recommendation:** cheap

---

## Dependencies

- Task 1 has no dependencies (pure type addition).
- Task 2 depends on: none (the helper module is self-contained, but Task 1 must land first if any imported type is referenced; in practice Task 2 doesn't import either result type).
- Task 3 depends on: Task 1 (uses `OrchestrationResult.artifactPath` and `OrchestratedTaskResult.artifactPath`).
- Task 4 depends on: Task 1 (same).
- Task 5 depends on: Task 1, Task 2, Task 3, Task 4 (uses the helper, both runner hooks, and the new field).
- Task 6 depends on: Task 1, Task 5, Task 8 (the steer references `artifactPath` from registry tasks; Task 5 establishes the path-rendering pattern reused here; Task 8 also edits `pi-extension/subagents/index.ts`, so Task 6 must run after Task 8 to avoid same-file edit conflicts in the `subagents/index.ts` import section and `subagent_resume.execute` neighborhood).
- Task 7 depends on: Task 1 (the `artifactPath` field on `OrchestratedTaskResult`). The implementation only checks `t.artifactPath != null` inside `tryFinalize`, and the unit test directly constructs entries with `artifactPath` set via `onTaskTerminal`, so it does not require the runners (Tasks 3, 4) or the tool-handler wiring (Task 5) to populate the field at runtime — those are runtime concerns, not code-level dependencies. This is what allows Task 7 to land in parallel with Task 5 in Wave 3.
- Task 8 depends on: Task 1, Task 2 (uses the `artifactPath` field on `OrchestratedTaskResult` and the `writeOrchestrationTaskArtifact` helper). It does NOT depend on Tasks 3-7 — it edits a different code path (`pi-extension/subagents/index.ts`'s `subagent_resume.execute` resume-terminal callsite) and its tests directly construct registry entries via `dispatchAsync`/`onTaskBlocked` without going through the runners. This allows Task 8 to land in the same wave as Task 5 / Task 7.
- Task 9 depends on: Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8 (full pipeline must be live for the integration test to round-trip; Task 8 ensures blocked-then-resumed orchestration tasks also produce artifacts in case the integration scenarios trigger that path).
- Task 10 depends on: every prior task.

A reasonable wave structure: Wave 1 = Task 1; Wave 2 = Tasks 2, 3, 4 in parallel; Wave 3 = Tasks 5, 7, 8 in parallel (5, 7, and 8 touch disjoint files — `tool-handlers.ts`, `registry.ts`, `subagents/index.ts` resume callsite — and don't conflict); Wave 4 = Task 6 (depends on Task 5's helpers and reuses `index.ts` for steer-content edits, after Task 8's resume-callsite edit lands); Wave 5 = Task 9; Wave 6 = Task 10.

## Risk Assessment

- **Risk: Test fixtures pass `{} as any` for sessionManager.** Many existing tool-handler unit tests (e.g. `tool-handlers.test.ts`'s `{ sessionManager: {} as any, cwd: "/tmp" }`) construct stub contexts without `getSessionDir` / `getSessionId`. **Mitigation**: `buildArtifactWriter` wraps `getArtifactDir(...)` in a `try/catch` and returns `undefined` on failure. When `writeArtifact` is `undefined`, `runSerial`/`runParallel` skip the call and `artifactPath` stays absent — existing tests continue to pass without modification, and the runner hooks are still exercised by the new tests that DO supply a real session dir. The acceptance criteria for those existing tests do not assert on `artifactPath`; only the new cases do.

- **Risk: The async steer's `details` payload sees `finalMessage` stripped before reaching the renderer.** Spec requires the strip to happen AFTER the steer is emitted; if implementation order is reversed, the renderer/coordinator that reads `details.results[i].finalMessage` (any future consumer) would see undefined. **Mitigation**: in `tryFinalize`, the `safeEmit({ ...results: entry.tasks.map(t => ({ ...t })) ...})` already creates fresh shallow copies BEFORE the strip loop runs. The Task 7 tests assert this ordering explicitly (the emitted payload's `finalMessage` is non-undefined while the snapshot's is).

- **Risk: A pi-backed serial pipeline that calls `subagent_resume` and re-enters via `continueSerialFromIndex` skips artifact writes for the resumed step OR writes to the wrong index.** `continueSerialFromIndex` re-runs `runSerial` for `tasks.slice(startIndex)`, so the inner runner produces local indices `0..n` for the tail. If `writeArtifact` is forwarded raw, a resumed original task `startIndex` writes to `task-0.md` and collides with the head step's artifact (or with another resumed orchestration's head). If `writeArtifact` is not forwarded at all, the resumed tail produces no artifacts. **Mitigation**: Task 5 Step 8 explicitly wraps the upstream `writeArtifact` with an offset (`(j, body) => writeArtifact(startIndex + j, body)`) before passing into the inner `runSerial`, and Step 8b adds a unit test asserting the resumed tail step writes `task-<original-index>.md` (not `task-0.md`). The existing `block-resume` orchestration tests (`test/orchestration/block-resume.test.ts`, `test/integration/orchestration-block-resume-e2e.test.ts`) gate on the broader resume contract and will fail if `writeArtifact` is dropped on the floor in the continuation path.

- **Risk: A blocked orchestration task that resumes via standalone `subagent_resume` produces no artifact, leaving `OrchestratedTaskResult.artifactPath` absent for that task.** The standalone resume path bypasses the runner's `onTerminal` callback (which Tasks 3 & 4 wire `writeArtifact` into) and instead calls `registry.onResumeTerminal(sessionKey, { ... })` directly from `pi-extension/subagents/index.ts`. Without an explicit write at that callsite, the spec's "artifactPath populated for every completed task with non-empty finalMessage" contract is violated for any orchestration that ever blocks. **Mitigation**: Task 8 adds a `writeOrchestrationTaskArtifact(...)` call at the resume-terminal callsite (inside the `if (owner)` branch around line 1942) using `owner.orchestrationId` and `owner.taskIndex`, and threads the returned path into the `registry.onResumeTerminal({ ..., artifactPath, ... })` call. Task 8 also adds `test/orchestration/resume-artifact.test.ts` asserting both that `snap!.tasks[0].artifactPath` is non-null after a successful resume and that the emitted `orchestration_complete` payload still carries `finalMessage` (because the registry's tombstone strip from Task 7 happens after the emit).

- **Risk: Registry tombstones hold `finalMessage` only when `artifactPath` is null** (Task 7), which is desirable, but the long-lived parent could still accumulate multi-MB tombstones if many tasks fail before producing output. **Mitigation**: this is a pre-existing concern unrelated to this spec. The spec explicitly says "no automatic cleanup of artifact files. ... A separate TODO covers cleanup once real disk-pressure data exists." Same applies to in-memory tombstones for failed tasks. No additional mitigation needed in this plan.

- **Risk: `firstLine()` is removed in Task 5 Step 9 but still imported elsewhere.** **Mitigation**: `firstLine` is module-scope private to `tool-handlers.ts` and not exported. `grep -n "firstLine" pi-extension/orchestration/` will confirm no external references before removal.

- **Risk: The integration test's child agent must emit content byte-for-byte with no Claude-CLI-injected formatting.** Real CLI-driven children can subtly alter trailing whitespace, emoji rendering, etc. **Mitigation**: the test runs the child as `pi` (not Claude) per the agent frontmatter (`cli: pi` is the default for unspecified agents on the test fixture model), where the capture chain is sentinel-file → JSONL last assistant message → screen scrape. The first two preserve bytes exactly. If the test discovers a Claude-only encoding wrinkle, gate that branch under `cli: pi` only — the spec covers both backends but does not require the integration test to exercise both CLIs in the byte-equality assertion (only "both backends"). The pane vs headless backend is what's required, not pi vs Claude.

- **Risk: Path injection via task name.** The path scheme uses `task-<index>.md` (numeric index) — names are not in the path. No injection vector. **Mitigation**: confirmed by reading the helper signature in Task 2.

## Test Command

```bash
npm test
```
