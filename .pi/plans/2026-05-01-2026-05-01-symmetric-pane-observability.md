# Symmetric pane subagent observability

**Source:** `TODO-08e81407`
**Spec:** `.pi/specs/2026-05-01-symmetric-pane-observability.md`

## Goal

Bring pane-mode subagent observability up to parity with headless. Today the pane backend never populates `BackendResult.transcript` / `BackendResult.usage` and never fires `onUpdate` mid-run; pane callers see only the post-mortem `summary` + `transcriptPath`. After this work, pane runs (both pi and Claude children) populate `BackendResult.transcript[]` + `BackendResult.usage` and fire live `onUpdate` partials at the same 1Hz cadence the existing widget already polls. The rich rendering surfaces wired up in TODO-4a7c2e91 (`subagent_result`, `orchestration_complete`, `subagent_run_serial` / `_parallel` `renderResult`, persistent widget) inherit pane support automatically because they switch on data presence rather than backend identity.

## Architecture summary

The work is concentrated inside `watchSubagent` (`pi-extension/subagents/index.ts:1004`). On each `pollForExit.onTick` (1Hz), a new file-tail step reads new entries from the child's on-disk jsonl, projects them into `TranscriptMessage[]`, accumulates `UsageStats`, fires the watcher's `onUpdate` callback, and copies the accumulators onto `running.usage` so the widget sees them. Tail state (`offset`, partial-line buffer, `transcript[]`, `usage`) lives in closure variables initialized when `watchSubagent` enters its `pollForExit` block.

Three fan-out boundaries plumb through: `SubagentResult` gains optional `transcript?` / `usage?`; `watchSubagent` accepts a new `onUpdate?: (partial: SubagentResult) => void` opt; `pane.ts:watch()` passes its `onUpdate` parameter into `watchSubagent` and copies the new fields onto `BackendResult`. The orchestration adapter (`default-deps.ts:55-89`) and the bare-subagent watch site (`index.ts:1428-1430`) already forward `partial.usage`/`partial.transcript` through to the rich rendering surfaces — they light up automatically once data flows.

The pi tail uses a new shared projector module that exports `projectPiMessageToTranscript` (lifted out of `headless.ts:290`) plus a fault-tolerant per-tick reader (`tailPiSessionEntries`) that handles torn writes and malformed JSON without throwing. The Claude tail uses the existing `parseClaudeStreamEvent` / `parseClaudeResult` helpers from `claude-stream.ts` — no behavior changes to those parsers. The Claude tail is gated on the `<sentinel>.transcript` pointer becoming readable: pre-pointer the tail is a no-op; post-pointer it reads the active `~/.claude/projects/<slug>/<session-id>.jsonl` and emits partials. A new `SessionStart` hook in the bundled plugin writes the pointer early so the tail starts inside the run, not at end-of-run.

The post-mortem fallback (when the early hook misses or Claude resumes) re-reads the archived jsonl after `copyClaudeSession` and emits a final partial before resolve. This covers Requirement #4.

The persistent widget converges on a single row format: when `agent.usage` is populated, render `formatUsageStats(agent.usage)`; otherwise render `running…` / `starting…` per CLI. The `<entries> msgs (<bytes>)` branch is removed; `RunningSubagent.entries` / `RunningSubagent.bytes` become dead state (we leave the fields in place to avoid churning shape consumers in tests, but the on-tick assignment goes away because the tail step now owns the work).

## Tech stack

- **Languages/runtime:** TypeScript (Node 18+, ES modules)
- **Frameworks:** `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `typebox`
- **Test runner:** `node --test` (`test/orchestration/*.test.ts`, `test/integration/*.test.ts`)
- **Bundled-plugin runtime:** Claude Code plugin hooks JSON + bash scripts; MCP tool via `@modelcontextprotocol/sdk`

## File Structure

- `pi-extension/subagents/backends/pi-projection.ts` (Create) — Shared pi-message projector. Exports `projectPiMessageToTranscript(msg)` (verbatim copy of the body currently in `headless.ts:290`) plus a new fault-tolerant tailing helper `tailPiSessionEntries(running, state)` that reads new bytes from `running.sessionFile` since `state.offset`, splits on `\n`, parses each line as JSON (skipping malformed lines), preserves an unterminated tail in `state.pendingTail`, and returns `{ messages: PiStreamMessage[], usageDelta }`. Encapsulates all "torn writes don't escape" logic.
- `pi-extension/subagents/backends/headless.ts` (Modify) — Replace the in-file `projectPiMessageToTranscript` definition with a re-export from `pi-projection.ts`. No behavior change; the runtime call sites at lines 413 and 440 stay identical.
- `pi-extension/subagents/index.ts` (Modify) — Extend `SubagentResult` with optional `transcript?` and `usage?`. Extend `watchSubagent`'s `opts` parameter with `onUpdate?: (partial: SubagentResult) => void`. Inside `watchSubagent`'s `pollForExit` block, add a per-tick file-tail step (pi branch and Claude branch) that uses `pi-projection.ts` + `claude-stream.ts` to project entries, accumulate `UsageStats`, populate `running.usage`, and call `onUpdate`. Have all return shapes (success / abort / error / Claude / pi) carry the accumulated `transcript` / `usage`. Add a post-mortem emission step on the Claude branch when the hook missed (read archived jsonl, project via `parseClaudeStreamEvent` + `parseClaudeResult`, emit one partial). Update `renderSubagentWidgetLines` to drop the backend branch and render both pane and headless rows uniformly: `formatUsageStats(agent.usage)` when populated, fallback otherwise. Update the `subagent` tool's pane watch site (`index.ts:1529`) to pass an `onUpdate` that updates `running.usage` and the bare subagent's `details` payload. Update the bare-subagent terminal `pi.sendMessage` to spread `transcript` / `usage` into `details` (mirroring the headless branch at lines 1463-1464).
- `pi-extension/subagents/backends/pane.ts` (Modify) — In `watch()`, pass `onUpdate` down into `watchSubagent`'s opts; copy `sub.transcript` / `sub.usage` onto `BackendResult`. No abort-flow changes.
- `pi-extension/subagents/plugin/hooks/on-session-start.sh` (Create) — New early hook. Reads stdin JSON, extracts `transcript_path` and `session_id`, writes the path to `${PI_CLAUDE_SENTINEL}.transcript`. Mirrors `on-stop.sh` with the same env-gate (`[ -z "${PI_CLAUDE_SENTINEL:-}" ] && exit 0`) and the same content (transcript path on first line). Idempotent: if the file already exists with the same content, no-op.
- `pi-extension/subagents/plugin/hooks/hooks.json` (Modify) — Add a `SessionStart` event entry pointing at `${CLAUDE_PLUGIN_ROOT}/hooks/on-session-start.sh` with `timeout: 10`. Stop event stays.
- `pi-extension/subagents/index.ts` — Update `subagent_resume.execute` (line 1925) so the resumed pi watch tail starts at `entryCountBefore` (already captured at line 1807) rather than from offset 0. Pass `entryCountBefore` to `watchSubagent` via the new `opts.tailStartLine` field so the tail does not re-emit history. Resume's terminal-result handler (line 1964) continues to use `findLastAssistantMessage(getNewEntries(...entryCountBefore))` for the pi summary; tail-emitted `transcript`/`usage` reflect only the resumed slice.
- `README.md` (Modify) — Lines 91-94: change `usage` / `transcript` rows from `**headless only (v1)**` to `**both backends**` and rewrite the trailing paragraph to document the caveats: ~1s latency floor on pane, unbounded `transcript[]` growth on long-running pane sessions (same v1-acceptable limitation as headless), Claude-pane resume sessions fall back to post-mortem-only.
- `test/orchestration/pi-projection-tail.test.ts` (Create) — Unit tests for `tailPiSessionEntries`. Covers: clean read, partial-line tail preservation across two ticks, malformed JSON skipped without throwing, empty file returns no messages.
- `test/orchestration/pane-watchsubagent-onupdate-pi.test.ts` (Create) — Unit-level test of `watchSubagent` against a fake pi child. Drives the watcher with a synthetic session jsonl whose contents grow tick-over-tick; asserts `onUpdate` fires with non-empty `transcript`/`usage`, `running.usage` is mutated, and the resolved `SubagentResult` carries the accumulated state.
- `test/orchestration/pane-watchsubagent-onupdate-claude.test.ts` (Create) — Unit-level test of `watchSubagent` against a fake Claude child. Drives the pointer file appearing partway through the run, the active jsonl file growing with stream-shape events, and asserts `onUpdate` fires post-pointer with `transcript`/`usage` and the resolved `SubagentResult` matches.
- `test/orchestration/pane-claude-postmortem-fallback.test.ts` (Create) — Tests the Claude post-mortem fallback path: pointer never appears during the run, but the archived jsonl is readable on resolve. Asserts `BackendResult.transcript` / `usage` are populated from the archive and at least one final `onUpdate` partial fires before resolve.
- `test/orchestration/pane-watchsubagent-abort-partials.test.ts` (Create) — Aborts a pi-pane watch mid-run; asserts the resolved `SubagentResult` carries whatever `transcript`/`usage` accumulated up to abort.
- `test/orchestration/pane-resume-tail-offset.test.ts` (Create) — Covers Requirement #8. Sets up a pi sessionPath with N pre-existing entries, drives `subagent_resume`, has the watcher's tail observe new entries; asserts `onUpdate` partials only contain the resumed slice (transcript starts after offset N, not 0).
- `test/orchestration/widget-pane-uniform.test.ts` (Create) — Asserts `renderSubagentWidgetLines` renders both pane and headless rows with `formatUsageStats(agent.usage)` when `usage` is populated. Asserts a pane row with no `usage` yet shows `running…` / `starting…`. Asserts the `<entries> msgs (<bytes>)` format does NOT appear for any backend.
- `test/orchestration/widget-headless.test.ts` (Modify) — Update the existing test to reflect the new uniform widget shape: pane rows with `usage` use `formatUsageStats`, pane rows without `usage` show `running…`. Replace the `assert.ok(paneRow.includes("msgs ("))` assertion with the new expectation. The headless-with-usage / headless-without-usage cases stay valid.
- `test/orchestration/pi-transcript-projection.test.ts` (Modify) — Update the import path so it imports from `pi-projection.ts` instead of `headless.ts`. No behavior changes; this is purely a structural refactor consequence.
- `test/plugin-session-start-hook.test.ts` (Create) — Mirrors `test/plugin-stop-hook.test.ts`. Drives `on-session-start.sh` with synthetic stdin JSON; asserts the pointer file is written when `PI_CLAUDE_SENTINEL` is set + `transcript_path` exists, and asserts no-op when env is unset, when `transcript_path` is missing, or when the file is already correctly written.
- `test/orchestration/pane-backend-watch-plumbs-onupdate.test.ts` (Create) — Unit test against `makePaneBackend({ overrides })`. Substitutes a fake `watchSubagent` that calls its `opts.onUpdate` once; asserts the pane backend's `onUpdate` parameter receives a `BackendResult`-shaped payload with `transcript` and `usage` copied from `SubagentResult`.

## Tasks

### Task 1: Lift `projectPiMessageToTranscript` into a shared module + add fault-tolerant tail reader

**Files:**
- Create: `pi-extension/subagents/backends/pi-projection.ts`
- Modify: `pi-extension/subagents/backends/headless.ts`
- Modify: `test/orchestration/pi-transcript-projection.test.ts`
- Test: `test/orchestration/pi-projection-tail.test.ts`

**Steps:**

- [ ] **Step 1.1: Create `pi-projection.ts` with the projector** — write `pi-extension/subagents/backends/pi-projection.ts`. Top-of-file imports: `import type { TranscriptContent, TranscriptMessage } from "./types.ts";`. Define and export `type PiStreamMessage = { role: "user" | "assistant" | "toolResult"; content: unknown };`. Copy the body of `projectPiMessageToTranscript` from `headless.ts:290-306` verbatim — same parameter type, same return type, same string-vs-array normalization, same `toolResult` field-preservation. Export it.
- [ ] **Step 1.2: Add the fault-tolerant tail reader** — in the same `pi-projection.ts`, define and export `interface PiTailState { offset: number; pendingTail: string; }` plus `interface PiTailDelta { messages: PiStreamMessage[]; assistantMessages: PiStreamMessage[]; }`. Then export `function tailPiSessionEntries(sessionFile: string, state: PiTailState): PiTailDelta`. Implementation outline:
  - Use `node:fs` `existsSync`, `readFileSync`. Return `{ messages: [], assistantMessages: [] }` if the file does not exist.
  - Read full file to a string (cheap relative to network IO; pi sessions on local disk).
  - Take `raw.slice(state.offset)`. Update `state.offset = raw.length` BEFORE further processing — so a malformed line later does not cause the same byte range to be re-read forever.
  - Concatenate `state.pendingTail + raw.slice(state.offset)` (compute slice before updating offset). Actually: simpler — capture `unread = state.pendingTail + raw.slice(state.offset)`, set `state.offset = raw.length`, set `state.pendingTail = ""`.
  - Split `unread` on `\n`. Pop the last element into `state.pendingTail` (this is either `""` if the read ended on `\n`, or an unterminated trailing line).
  - For each remaining line, skip if `line.trim() === ""`, otherwise `try { JSON.parse(line) } catch { continue; }` and inspect the parsed entry. Only `entry.type === "message" && entry.message` produces output.
  - Push every projected message into `messages`. If `entry.message.role === "assistant"` push the same raw `entry.message` into `assistantMessages` (we need access to `usage` / `stopReason` later, which the projection drops).
- [ ] **Step 1.3: Replace the local definition with an import + re-export in `headless.ts`** — open `pi-extension/subagents/backends/headless.ts`. Delete the local `type PiStreamMessage = …` declaration and the local `export function projectPiMessageToTranscript(...) { … }` (lines 285-306). At the top of the file (with the other backend-relative imports), add a value import that creates a local binding for use by the call sites in this module: `import { projectPiMessageToTranscript, type PiStreamMessage } from "./pi-projection.ts";`. Then, immediately below that import, add a re-export so existing external consumers that import from `headless.ts` continue to resolve: `export { projectPiMessageToTranscript, type PiStreamMessage } from "./pi-projection.ts";`. The local import is what keeps the two existing call sites (`transcript.push(projectPiMessageToTranscript(...))` near lines 413 and 440) compiling — a bare `export ... from` re-export does NOT introduce a local binding usable inside the same module, so the explicit `import` line is required. Verify both lines are present.
- [ ] **Step 1.4: Update the projector test** — open `test/orchestration/pi-transcript-projection.test.ts`. Change line 3 from `import { projectPiMessageToTranscript } from "../../pi-extension/subagents/backends/headless.ts";` to `import { projectPiMessageToTranscript } from "../../pi-extension/subagents/backends/pi-projection.ts";`. No other changes — the four existing tests should pass as-is.
- [ ] **Step 1.5: Write the tail-reader tests** — create `test/orchestration/pi-projection-tail.test.ts`. Use `import { describe, it } from "node:test"; import assert from "node:assert/strict"; import { tailPiSessionEntries } from "../../pi-extension/subagents/backends/pi-projection.ts"; import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";`. Cover four cases:
  - **Clean read**: write three full lines (`{"type":"message","message":{"role":"assistant","content":"hi","usage":{}}}\n` etc.) to a tempfile. Initialize state `{ offset: 0, pendingTail: "" }`. Call `tailPiSessionEntries(path, state)`. Assert `messages.length === 3`, `assistantMessages.length === N` (whichever are role assistant), `state.offset === fileSize`, `state.pendingTail === ""`.
  - **Torn-write tail preservation**: write two full lines + the prefix of a third (no trailing newline). First call should return only the two complete messages and stash the prefix in `state.pendingTail`. Append the rest of the third line + a final `\n`. Second call should return the third message and have `state.pendingTail === ""`.
  - **Malformed line skipped**: write `garbage{not json\n` followed by a valid `{"type":"message","message":{"role":"user","content":"ok"}}\n`. Assert the call does NOT throw, `messages.length === 1`, and the user message body is `"ok"`.
  - **Empty file**: assert `tailPiSessionEntries` returns `{ messages: [], assistantMessages: [] }` and does not throw when the file does not exist or is empty.
- [ ] **Step 1.6: Run the tests** — `node --test test/orchestration/pi-projection-tail.test.ts test/orchestration/pi-transcript-projection.test.ts`. Confirm both files pass.

**Acceptance criteria:**

- `pi-projection.ts` exports `projectPiMessageToTranscript`, `PiStreamMessage`, `tailPiSessionEntries`, `PiTailState`, and `PiTailDelta` with the signatures described in Step 1.2.
  Verify: `grep -nE "^export (function|type|interface|\{)" pi-extension/subagents/backends/pi-projection.ts` returns lines covering all five symbols (`projectPiMessageToTranscript`, `PiStreamMessage`, `tailPiSessionEntries`, `PiTailState`, `PiTailDelta`).
- `headless.ts` both imports `projectPiMessageToTranscript` (for its own local call sites) and re-exports it from `pi-projection.ts` (no in-file definition).
  Verify: `grep -n "projectPiMessageToTranscript" pi-extension/subagents/backends/headless.ts` shows BOTH an `import { projectPiMessageToTranscript` line AND an `export { projectPiMessageToTranscript` line referencing `./pi-projection.ts`, plus the two `projectPiMessageToTranscript(` call sites, with no `function projectPiMessageToTranscript` body remaining.
- The pre-existing projector test still passes against the new module location.
  Verify: run `node --test test/orchestration/pi-transcript-projection.test.ts` and confirm exit code 0 with all four prior tests passing.
- The new tail-reader test passes all four cases (clean, torn write, malformed JSON, empty file).
  Verify: run `node --test test/orchestration/pi-projection-tail.test.ts` and confirm exit code 0 with at least four passing tests, including descriptions matching "clean", "torn", "malformed", and "empty".
- The full project still compiles and the regression suite passes.
  Verify: run `npm run typecheck && npm test` and confirm exit code 0 with no diagnostics naming `pi-projection.ts` or `headless.ts`.

**Model recommendation:** standard

---

### Task 2: Extend `SubagentResult` and `watchSubagent` opts shape

**Files:**
- Modify: `pi-extension/subagents/index.ts`

**Steps:**

- [ ] **Step 2.1: Extend `SubagentResult`** — open `pi-extension/subagents/index.ts`. Locate the `export interface SubagentResult` declaration at line 310. Add after `ping?: { name: string; message: string };`:
  ```ts
    /** Live transcript accumulated during the run; populated for both pi and Claude pane backends. */
    transcript?: TranscriptMessage[];
    /** Live usage stats accumulated during the run; populated for both pi and Claude pane backends. */
    usage?: UsageStats;
  ```
  Confirm `TranscriptMessage` and `UsageStats` are already imported (they are, from `./backends/types.ts` at line 46). Add `TranscriptMessage` to that import if missing.
- [ ] **Step 2.2: Extend `watchSubagent` opts** — change the signature at line 1004-1008 from:
  ```ts
  export async function watchSubagent(
    running: RunningSubagent,
    signal: AbortSignal,
    opts?: { onSessionKey?: (sessionKey: string) => void },
  ): Promise<SubagentResult>
  ```
  to:
  ```ts
  export async function watchSubagent(
    running: RunningSubagent,
    signal: AbortSignal,
    opts?: {
      onSessionKey?: (sessionKey: string) => void;
      onUpdate?: (partial: SubagentResult) => void;
      tailStartLine?: number;
    },
  ): Promise<SubagentResult>
  ```
  `tailStartLine` is the entry-count baseline used by the resume path so the tail does not re-emit pre-resume history (default: 0).
- [ ] **Step 2.3: Confirm no callers broke** — `grep -rn "watchSubagent(" pi-extension/ test/ | grep -v "// "` and confirm every call site either passes `(running, signal)` (works because opts is optional) or passes `(running, signal, { onSessionKey })` (works because the new fields are also optional). No call site changes are required in this task.

**Acceptance criteria:**

- `SubagentResult` declares optional `transcript?: TranscriptMessage[]` and `usage?: UsageStats` fields.
  Verify: open `pi-extension/subagents/index.ts` and confirm the `export interface SubagentResult` declaration starting near line 310 contains both `transcript?: TranscriptMessage[]` and `usage?: UsageStats` lines, immediately after `ping?:`.
- `watchSubagent`'s `opts` parameter accepts `onUpdate` and `tailStartLine` in addition to `onSessionKey`.
  Verify: `grep -nE "onUpdate\?: \(partial: SubagentResult\) => void;" pi-extension/subagents/index.ts` returns at least one match inside the `watchSubagent` declaration block (around line 1004), and `grep -n "tailStartLine\\?: number" pi-extension/subagents/index.ts` returns a match in the same block.
- Type-checking passes with no new diagnostics.
  Verify: run `npm run typecheck` and confirm exit code 0.

**Model recommendation:** cheap

---

### Task 3: Wire pi tail into `watchSubagent`'s 1Hz onTick

**Files:**
- Modify: `pi-extension/subagents/index.ts`

**Steps:**

- [ ] **Step 3.1: Initialize tail state in `watchSubagent`** — open `pi-extension/subagents/index.ts`. Locate `watchSubagent` at line 1004. After the existing `firedSessionKey` / `maybeFire` / `readClaudeSessionId` definitions and before the `try { const result = await pollForExit(...)` block, add:
  ```ts
    const transcript: TranscriptMessage[] = [];
    const usage: UsageStats = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      cost: 0, contextTokens: 0, turns: 0,
    };
    const piTailState = { offset: 0, pendingTail: "" };
    let claudeTranscriptPathForTail: string | null = null;
    let claudeFileOffset = 0;
    let claudePendingTail = "";
    let claudeFinalUsage: UsageStats | null = null;
  ```
  Add `import { tailPiSessionEntries, projectPiMessageToTranscript } from "./backends/pi-projection.ts";` near the other backend imports at the top of the file. Add `import { parseClaudeStreamEvent, parseClaudeResult } from "./backends/claude-stream.ts";` if not already present.
- [ ] **Step 3.2: Honor `tailStartLine` for resume** — immediately after the state declarations above, add:
  ```ts
    if (opts?.tailStartLine && opts.tailStartLine > 0 && running.cli !== "claude" && sessionFile) {
      try {
        if (existsSync(sessionFile)) {
          const raw = readFileSync(sessionFile, "utf8");
          const lines = raw.split("\n");
          let charsConsumed = 0;
          for (let i = 0; i < Math.min(opts.tailStartLine, lines.length); i++) {
            charsConsumed += lines[i].length + 1; // +1 for the \n
          }
          piTailState.offset = Math.min(charsConsumed, raw.length);
        }
      } catch {
        // Defensive: if seeking fails, fall back to offset 0 and accept that the
        // tail emits pre-resume history. Better than throwing during launch.
      }
    }
  ```
- [ ] **Step 3.3: Inline the per-tick pi tail** — replace the existing `onTick()` body at lines 1042-1056. The new body keeps the Claude session-key probe (line 1054) and replaces the entries/bytes accounting with the file tail. New body:
  ```ts
        onTick() {
          if (running.cli !== "claude") {
            try {
              if (sessionFile && existsSync(sessionFile)) {
                const delta = tailPiSessionEntries(sessionFile, piTailState);
                let changed = false;
                for (const msg of delta.messages) {
                  transcript.push(projectPiMessageToTranscript(msg));
                  changed = true;
                }
                for (const am of delta.assistantMessages) {
                  usage.turns++;
                  const u: any = (am as any).usage;
                  if (u) {
                    usage.input += u.input ?? 0;
                    usage.output += u.output ?? 0;
                    usage.cacheRead += u.cacheRead ?? 0;
                    usage.cacheWrite += u.cacheWrite ?? 0;
                    usage.cost += u.cost?.total ?? 0;
                    usage.contextTokens = u.totalTokens ?? usage.contextTokens;
                  }
                  changed = true;
                }
                if (changed) {
                  running.usage = { ...usage };
                  try {
                    opts?.onUpdate?.({
                      name, task, summary: "",
                      transcriptPath: null,
                      exitCode: 0,
                      elapsed: Math.floor((Date.now() - startTime) / 1000),
                      transcript: [...transcript],
                      usage: { ...usage },
                    });
                  } catch { /* defensive: never let an onUpdate throw kill the loop */ }
                }
              }
            } catch { /* defensive: tail must never throw during pollForExit */ }
          } else {
            // Claude branch handled in Task 4; preserve early-session-key probe.
            maybeFire(readClaudeSessionId());
          }
        },
  ```
  Note: `running.entries` / `running.bytes` are no longer assigned — they go away in Task 6.
- [ ] **Step 3.4: Carry pi accumulators into all return shapes** — locate the pi-branch return block at lines 1179-1188 (`return { name, task, summary, exitCode, elapsed, sessionFile, transcriptPath, ping: result.ping }`). Add `transcript: [...transcript], usage: { ...usage },` to that return object. Then locate the abort/error catch block at lines 1195-1214 and add the same `transcript` / `usage` to both shapes (`signal.aborted` branch and the catch-all error branch). Symmetric with `makeAbortedResult` in headless.
- [ ] **Step 3.5: Unit test (pi)** — write `test/orchestration/pane-watchsubagent-onupdate-pi.test.ts`. Setup:
  - Use `mkdtempSync` for a scratch dir; create a session jsonl file inside it.
  - Build a `RunningSubagent` with `cli: undefined` (pi default), `surface: "fake-surface"`, `sessionFile: <path>`, `startTime: Date.now()`.
  - Stub `pollForExit` via a test seam: since `watchSubagent` calls `pollForExit` from `./cmux.ts`, write the test by appending session-jsonl entries into the file from a separate timer, then aborting after a fixed window. Capture `onUpdate` calls.
  - Drive the file: append two complete jsonl entries (`{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"totalTokens":150,"cost":{"total":0.001}},"stopReason":"endTurn"}}\n` and a `toolResult`).
  - To avoid the live `pollForExit` poking real surfaces: the cleanest test seam is to write a complete `<sessionFile>.exit` sidecar containing `{"type":"done"}` after the file is populated, since `pollForExit` returns reason `done` on that sidecar. But — `pollForExit` reads from `options.sessionFile` (the variable passed into `watchSubagent`'s `pollForExit`-call), and the watcher's `onTick` runs first on each iteration. Driver order: write entries → write sidecar → wait for resolve.
  - Assertions: `onUpdate` was called at least once with `transcript.length >= 2` and `usage.turns >= 1`; `running.usage` is mutated; the resolved `SubagentResult` has `transcript` and `usage` populated with the same accumulated values.
- [ ] **Step 3.6: Run the test** — `node --test test/orchestration/pane-watchsubagent-onupdate-pi.test.ts`. Confirm all assertions pass.

**Acceptance criteria:**

- `watchSubagent` initializes tail state (`transcript`, `usage`, `piTailState`) before entering `pollForExit` for pi children.
  Verify: open `pi-extension/subagents/index.ts` at the body of `watchSubagent` (around line 1004) and confirm there is a `const transcript: TranscriptMessage[] = []` declaration above the `try { const result = await pollForExit(` block, alongside an empty `usage` object and a `piTailState`.
- The pi-branch `onTick` calls `tailPiSessionEntries` and fires `opts.onUpdate` with the accumulated state.
  Verify: `grep -nA 5 "tailPiSessionEntries" pi-extension/subagents/index.ts` shows the helper invoked inside the `onTick()` body, with a subsequent `opts?.onUpdate?.(` call when `changed` is true.
- The pi-branch return shape carries `transcript` and `usage` on success, abort, and error paths.
  Verify: open the pi return at the bottom of `watchSubagent` (around line 1179), the abort branch (around line 1196), and the error branch (around line 1206) and confirm each return literal includes both `transcript` and `usage` keys.
- `tailStartLine` shifts the initial pi offset so resume mode tails only new entries.
  Verify: `grep -n "tailStartLine" pi-extension/subagents/index.ts` shows at least one match inside `watchSubagent` that adjusts `piTailState.offset` before the `pollForExit` call.
- The new pi unit test passes.
  Verify: run `node --test test/orchestration/pane-watchsubagent-onupdate-pi.test.ts` and confirm exit code 0 with at least one passing test asserting `onUpdate` called with a non-empty transcript and the resolved result carries the accumulated state.

**Model recommendation:** capable

---

### Task 4: Wire Claude tail (live + post-mortem) into `watchSubagent`'s onTick

**Files:**
- Modify: `pi-extension/subagents/index.ts`

**Steps:**

- [ ] **Step 4.1: Add a Claude pointer-resolution helper** — already present as `readClaudeSessionId()` (line 1022). It returns the session id; we also need the actual jsonl path. Add a sibling helper inside `watchSubagent` (right after `readClaudeSessionId`):
  ```ts
    const readClaudeTranscriptPath = (): string | null => {
      if (running.cli !== "claude" || !running.sentinelFile) return null;
      try {
        const pointer = running.sentinelFile + ".transcript";
        if (!existsSync(pointer)) return null;
        const transcriptPath = readFileSync(pointer, "utf-8").trim();
        return transcriptPath || null;
      } catch { return null; }
    };
  ```
- [ ] **Step 4.2: Add the per-tick Claude tail** — inside the same `onTick()` body (currently the Claude branch at line 1052), replace `maybeFire(readClaudeSessionId());` with:
  ```ts
        // Claude: attempt early session key resolution on each tick.
        maybeFire(readClaudeSessionId());
        if (!claudeTranscriptPathForTail) {
          claudeTranscriptPathForTail = readClaudeTranscriptPath();
          if (claudeTranscriptPathForTail) {
            // Reset offsets when we first lock onto the active jsonl.
            claudeFileOffset = 0;
            claudePendingTail = "";
          }
        }
        if (claudeTranscriptPathForTail) {
          try {
            if (existsSync(claudeTranscriptPathForTail)) {
              const raw = readFileSync(claudeTranscriptPathForTail, "utf8");
              const unread = claudePendingTail + raw.slice(claudeFileOffset);
              claudeFileOffset = raw.length;
              const parts = unread.split("\n");
              claudePendingTail = parts.pop() ?? "";
              let changed = false;
              for (const line of parts) {
                if (!line.trim()) continue;
                let event: any;
                try { event = JSON.parse(line); } catch { continue; }
                if (event.type === "result") {
                  const parsed = parseClaudeResult(event);
                  claudeFinalUsage = parsed.usage;
                  changed = true;
                  continue;
                }
                const msgs = parseClaudeStreamEvent(event);
                if (msgs) {
                  for (const m of msgs) transcript.push(m);
                  changed = true;
                }
              }
              if (changed) {
                if (claudeFinalUsage) Object.assign(usage, claudeFinalUsage);
                running.usage = { ...usage };
                try {
                  opts?.onUpdate?.({
                    name, task, summary: "",
                    transcriptPath: null,
                    exitCode: 0,
                    elapsed: Math.floor((Date.now() - startTime) / 1000),
                    transcript: [...transcript],
                    usage: { ...usage },
                  });
                } catch { /* defensive */ }
              }
            }
          } catch { /* defensive */ }
        }
  ```
- [ ] **Step 4.3: Add post-mortem / final catch-up fallback for Claude** — locate the Claude post-mortem block in `watchSubagent` (lines 1089-1102) where `copyClaudeSession` is invoked. Right after `transcriptPath = archived.archivedPath;` (line 1099), add a final catch-up step. This must run not only when the live tail observed nothing, but also when the live tail observed transcript but missed the terminal `result` event (race: result line written between the last 1Hz tick and child exit). To avoid duplicating transcript messages already captured by the live tail, snapshot the live transcript length and only append new messages beyond that snapshot:
  ```ts
        // Final catch-up (Requirement #4): always reconcile with the archived
        // jsonl on resolve. Two distinct races motivate this:
        //   (a) Live tail saw nothing — early hook missed, resume session,
        //       child SIGKILL'd. transcript/usage are both empty.
        //   (b) Live tail saw transcript messages but missed the terminal
        //       `result` event because it was written between the last 1Hz
        //       tick and child exit. transcript is populated but
        //       claudeFinalUsage is null / usage.turns === 0.
        // Run the projection when EITHER condition holds. Use the live
        // transcript length as the baseline so we never push duplicates of
        // messages the live tail already emitted.
        const needsCatchUp =
          transcript.length === 0 ||
          claudeFinalUsage === null ||
          (usage as any).turns === 0;
        if (needsCatchUp && transcriptPath) {
          try {
            const raw = readFileSync(transcriptPath, "utf8");
            const projected: TranscriptMessage[] = [];
            let projectedUsage: typeof usage | null = null;
            for (const line of raw.split("\n")) {
              if (!line.trim()) continue;
              let event: any;
              try { event = JSON.parse(line); } catch { continue; }
              if (event.type === "result") {
                const parsed = parseClaudeResult(event);
                projectedUsage = parsed.usage;
                continue;
              }
              const msgs = parseClaudeStreamEvent(event);
              if (msgs) for (const m of msgs) projected.push(m);
            }
            // Append only messages beyond what the live tail captured.
            // (Archive ordering matches live ordering; the projection is a
            // superset of what the live tail saw on the same jsonl.)
            let appended = false;
            if (projected.length > transcript.length) {
              for (let i = transcript.length; i < projected.length; i++) {
                transcript.push(projected[i]);
              }
              appended = true;
            }
            // Always prefer the archive's terminal usage when present —
            // claudeFinalUsage may be null if the live tail missed the
            // result event.
            let usageChanged = false;
            if (projectedUsage) {
              Object.assign(usage, projectedUsage);
              claudeFinalUsage = projectedUsage;
              usageChanged = true;
            }
            if (appended || usageChanged) {
              running.usage = { ...usage };
              try {
                opts?.onUpdate?.({
                  name, task, summary: "",
                  transcriptPath,
                  exitCode: 0,
                  elapsed: Math.floor((Date.now() - startTime) / 1000),
                  transcript: [...transcript],
                  usage: { ...usage },
                });
              } catch { /* defensive */ }
            }
          } catch { /* defensive: archive read failures must not kill the resolve */ }
        }
  ```
- [ ] **Step 4.4: Carry Claude accumulators into the success return** — locate the Claude return block at lines 1149-1157. Add `transcript: [...transcript], usage: { ...usage }` to the object literal. The fields render whether or not they're populated (empty array / zeroed usage are valid v1 shapes).
- [ ] **Step 4.5: Unit test (Claude live)** — write `test/orchestration/pane-watchsubagent-onupdate-claude.test.ts`. Setup:
  - Scratch dir, sentinel file `<dir>/sentinel`, fake jsonl file `<dir>/active.jsonl`.
  - `RunningSubagent` with `cli: "claude"`, `sentinelFile: <dir>/sentinel`, etc.
  - Drive the test: write the pointer file `<dir>/sentinel.transcript` containing `<dir>/active.jsonl\n`. Append Claude stream events to `active.jsonl`: an `{"type":"system","subtype":"init","session_id":"…"}` event, an `{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}` event, then an `{"type":"result","subtype":"success","usage":{"input_tokens":100,"output_tokens":50},"total_cost_usd":0.001,"num_turns":1,"result":"final"}` event. Then write the sentinel file (which gates `pollForExit`'s sentinel branch via `cmux.ts:705`).
  - Capture `onUpdate` calls; assert at least one carries a non-empty `transcript` and `usage.turns === 1`. Assert the resolved `SubagentResult` includes the same accumulated `transcript` / `usage`.
- [ ] **Step 4.6: Unit test (Claude post-mortem)** — write `test/orchestration/pane-claude-postmortem-fallback.test.ts`. Setup the same scratch dir but DO NOT write the pointer file mid-run. Write the sentinel file directly (so `pollForExit` returns reason `sentinel`), and write the pointer + active jsonl AFTER the sentinel (so `copyClaudeSession`'s bounded wait at lines 1079-1087 picks them up). Assert `onUpdate` fires at least once at the post-mortem step with a populated `transcript`/`usage`, and the resolved `SubagentResult` carries the same.
- [ ] **Step 4.7: Unit test (Claude live-transcript + missed-result race)** — write `test/orchestration/pane-claude-missed-result-race.test.ts`. Setup the same scratch dir as Step 4.5. Drive the test in this exact order:
  1. Write the pointer file `<dir>/sentinel.transcript` containing `<dir>/active.jsonl\n`.
  2. Append the `system/init` and an `assistant` event to `active.jsonl`. Wait long enough (e.g., >1.5s) for at least one 1Hz tick to observe the live transcript.
  3. Write the sentinel file (so `pollForExit` returns reason `sentinel`) WITHOUT writing the `result` event yet — this simulates the child exiting before the result line is flushed.
  4. While `copyClaudeSession`'s bounded wait (lines 1079-1087) is still pending, append the terminal `{"type":"result",…,"usage":{…},"num_turns":1,…}` event so the archive ends up with it.
  5. Assert: at least one mid-run `onUpdate` carried the assistant transcript message; the resolved `SubagentResult` carries `transcript.length === 1` (no duplication of the assistant message) and `usage.turns === 1` populated by the catch-up path.
- [ ] **Step 4.8: Run the tests** — `node --test test/orchestration/pane-watchsubagent-onupdate-claude.test.ts test/orchestration/pane-claude-postmortem-fallback.test.ts test/orchestration/pane-claude-missed-result-race.test.ts`. Confirm all three pass.

**Acceptance criteria:**

- `watchSubagent`'s Claude branch tails the active jsonl when the pointer file is readable, projects entries via `parseClaudeStreamEvent` / `parseClaudeResult`, and fires `opts.onUpdate` with accumulated `transcript`/`usage`.
  Verify: `grep -nE "claudeTranscriptPathForTail|parseClaudeStreamEvent|parseClaudeResult" pi-extension/subagents/index.ts` shows the variable is initialized in `watchSubagent`'s body and the parsers are invoked inside the Claude branch of `onTick`.
- The post-mortem / final catch-up fallback emits a final partial when the live tail saw nothing OR when the live tail observed transcript but missed the terminal `result` event, and never duplicates messages already captured by the live tail.
  Verify: open `pi-extension/subagents/index.ts` and locate the block following the `copyClaudeSession` call (around line 1095); confirm (a) the entry guard fires when `transcript.length === 0` OR `claudeFinalUsage === null` OR `usage.turns === 0`, (b) the projection iterates the archived jsonl through `parseClaudeStreamEvent` / `parseClaudeResult`, (c) transcript messages are only appended for indices `>= transcript.length` at the start of the block (no duplicates), and (d) `opts?.onUpdate?.(...)` fires only when something was appended or usage changed.
- The Claude success return carries `transcript` and `usage`.
  Verify: open the Claude return literal around line 1149 and confirm both `transcript: [...transcript]` and `usage: { ...usage }` keys are present.
- The Claude live-tail unit test passes.
  Verify: run `node --test test/orchestration/pane-watchsubagent-onupdate-claude.test.ts` and confirm exit code 0 with at least one passing test asserting `onUpdate` fired with non-empty transcript and `usage.turns === 1`.
- The Claude post-mortem fallback unit test passes.
  Verify: run `node --test test/orchestration/pane-claude-postmortem-fallback.test.ts` and confirm exit code 0 with at least one passing test asserting the resolved `SubagentResult` carries `transcript`/`usage` even with no mid-run pointer.
- The Claude missed-terminal-result race unit test passes.
  Verify: run `node --test test/orchestration/pane-claude-missed-result-race.test.ts` and confirm exit code 0 with a passing test asserting the resolved `SubagentResult` has `transcript.length === 1` (no duplicate of the live-observed assistant message) and `usage.turns === 1` populated by the archived-jsonl catch-up path.

**Model recommendation:** capable

---

### Task 5: Plumb `onUpdate`, `transcript`, `usage` through `pane.ts:watch()`

**Files:**
- Modify: `pi-extension/subagents/backends/pane.ts`
- Test: `test/orchestration/pane-backend-watch-plumbs-onupdate.test.ts`

**Steps:**

- [ ] **Step 5.1: Pass `onUpdate` into `watchSubagent` opts** — open `pi-extension/subagents/backends/pane.ts`. Locate the `await watchSubagent(running, abort.signal, { onSessionKey })` call at line 108. Change the opts argument to:
  ```ts
        const sub = await watchSubagent(running, abort.signal, {
          onSessionKey: (key) => hooks?.onSessionKey?.(key),
          onUpdate: onUpdate
            ? (partial) => {
                onUpdate({
                  name: handle.name,
                  finalMessage: partial.summary ?? "",
                  transcriptPath: partial.transcriptPath,
                  exitCode: partial.exitCode,
                  elapsedMs: partial.elapsed * 1000,
                  sessionId: partial.claudeSessionId,
                  sessionKey: running.cli === "claude"
                    ? partial.claudeSessionId
                    : running.sessionFile,
                  error: partial.error,
                  usage: partial.usage,
                  transcript: partial.transcript,
                  ping: partial.ping,
                });
              }
            : undefined,
        });
  ```
- [ ] **Step 5.2: Copy `transcript` / `usage` onto the resolved `BackendResult`** — locate the `return { name, finalMessage, transcriptPath, … }` block at lines 118-128. Add `transcript: sub.transcript, usage: sub.usage,` to the return object. Symmetric with how `claudeSessionId` → `sessionId` already maps.
- [ ] **Step 5.3: Write the plumbing unit test** — create `test/orchestration/pane-backend-watch-plumbs-onupdate.test.ts`. Use `makePaneBackend` with overrides:
  ```ts
  import { makePaneBackend } from "../../pi-extension/subagents/backends/pane.ts";
  ```
  Pass an override `watchSubagent` that synchronously fires `opts.onUpdate?.({ … with transcript:[…], usage:{ … } })` and then resolves with a `SubagentResult` carrying the same. Drive `backend.watch(handle, undefined, capturedOnUpdate)`. Assert:
  - The captured `onUpdate` was called at least once with a `BackendResult`-shaped payload (has `name`, `finalMessage`, `elapsedMs`, etc.).
  - The captured `BackendResult.transcript` and `BackendResult.usage` match what `watchSubagent` emitted.
  - The resolved `BackendResult` returned by `backend.watch(...)` also carries `transcript` and `usage`.
- [ ] **Step 5.4: Run the test** — `node --test test/orchestration/pane-backend-watch-plumbs-onupdate.test.ts`. Confirm it passes.

**Acceptance criteria:**

- `pane.ts:watch()` forwards its `onUpdate` parameter into `watchSubagent`'s `opts.onUpdate`, projecting `SubagentResult` partials into `BackendResult` partials with `transcript` / `usage` copied.
  Verify: open `pi-extension/subagents/backends/pane.ts` at the body of `watch()` (around line 75) and confirm the `await watchSubagent(...)` call site passes an `onUpdate` opt that builds a `BackendResult`-shaped object including `usage: partial.usage` and `transcript: partial.transcript` keys.
- The pane backend's resolved `BackendResult` carries `sub.transcript` and `sub.usage`.
  Verify: open `pi-extension/subagents/backends/pane.ts` at the return block in `watch()` (around line 118) and confirm both `transcript: sub.transcript` and `usage: sub.usage` are present in the return literal.
- The plumbing unit test asserts `onUpdate` is called and the resolved result mirrors it.
  Verify: run `node --test test/orchestration/pane-backend-watch-plumbs-onupdate.test.ts` and confirm exit code 0 with passing assertions naming `transcript`, `usage`, and a non-zero call count for the captured `onUpdate`.

**Model recommendation:** standard

---

### Task 6: Update `renderSubagentWidgetLines` for unified rendering and update bare-subagent watch site

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Modify: `test/orchestration/widget-headless.test.ts`
- Test: `test/orchestration/widget-pane-uniform.test.ts`

**Steps:**

- [ ] **Step 6.1: Drop the backend branch in `renderSubagentWidgetLines`** — locate the function at line 475. Replace the right-side selection block (lines 487-499) with:
  ```ts
      let right: string;
      if (agent.blocked) {
        right = " blocked — awaiting parent ";
      } else if (agent.usage) {
        right = ` ${formatUsageStats(agent.usage)} `;
      } else if (agent.cli === "claude") {
        right = " running… ";
      } else {
        right = " starting… ";
      }
  ```
  Pre-existing `formatBytes` (line 289) is still used elsewhere — leave it; we just stop calling it from the widget. The `agent.entries` / `agent.bytes` fields stay declared on `RunningSubagent` (we'll stop assigning them, but the schema is unchanged to minimize churn in tests).
- [ ] **Step 6.2: Wire `onUpdate` into the bare-subagent pane watch site** — locate `watchSubagent(running, watcherAbort.signal)` at line 1529. Change to:
  ```ts
        watchSubagent(running, watcherAbort.signal, {
          onUpdate: (partial) => {
            if (partial.usage) running.usage = partial.usage;
          },
        })
  ```
  Already-mutating-running is fine because the widget interval re-renders every 1s (see `startWidgetRefresh`).
- [ ] **Step 6.3: Spread `transcript` / `usage` into bare-subagent `details`** — locate the pane-branch terminal `pi.sendMessage` at lines 1561-1577. Change the `details` object to include the new fields, mirroring the headless branch (lines 1463-1464):
  ```ts
              details: {
                name: running.name,
                task: running.task,
                agent: running.agent,
                exitCode: result.exitCode,
                elapsed: result.elapsed,
                sessionFile: result.sessionFile,
                ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
                ...(result.transcript ? { transcript: result.transcript } : {}),
                ...(result.usage ? { usage: result.usage } : {}),
              },
  ```
  This makes the rich `subagent_result` renderer (`subagent-result-renderer.ts:61`) light up for pane runs without renderer changes.
- [ ] **Step 6.4: Update the existing widget test** — open `test/orchestration/widget-headless.test.ts`. Change the pane-row case (`backend: "pane"`, with `entries: 7, bytes: 2048`) so it now also has `usage: { ... }` populated, and assert it renders `formatUsageStats`-style output. Add a second pane row with NO `usage` and assert it renders `running…` (or `starting…` based on `cli`). Replace the line `assert.ok(paneRow.includes("msgs ("), …)` — the `<entries> msgs (<bytes>)` format must NOT appear. The headless cases stay unchanged.
- [ ] **Step 6.5: Add a uniform-widget unit test** — write `test/orchestration/widget-pane-uniform.test.ts`:
  - One pane row with `usage` populated → assert right-side contains `formatUsageStats` output (e.g. token markers `↑` / `↓`, cost `$`).
  - One pane row with no `usage` and `cli: "claude"` → assert right contains `running…`.
  - One pane row with no `usage` and `cli` undefined (pi default) → assert right contains `starting…`.
  - Across all three rows, assert no row contains `msgs (` (regression: the old format must be gone).
- [ ] **Step 6.6: Run the tests** — `node --test test/orchestration/widget-headless.test.ts test/orchestration/widget-pane-uniform.test.ts`. Confirm both pass.

**Acceptance criteria:**

- `renderSubagentWidgetLines` no longer branches on `agent.backend`; the right-side info segment is `formatUsageStats(agent.usage)` when populated, otherwise `running…` / `starting…` per CLI.
  Verify: open `pi-extension/subagents/index.ts` at the body of `renderSubagentWidgetLines` (starts around line 475) and confirm there is no `agent.backend === "headless"` discriminator inside the row loop, and no call to `formatBytes` inside that loop. Confirm the `else if (agent.usage)` branch directly produces the `formatUsageStats(agent.usage)` text for both pane and headless rows.
- The bare-subagent pane watch site passes `onUpdate` and the terminal `details` includes `transcript`/`usage`.
  Verify: `grep -nA 5 "watchSubagent(running, watcherAbort.signal" pi-extension/subagents/index.ts` shows the pane call site (around line 1529) passes an `{ onUpdate: ...}` opts object, and the subsequent `details: {` literal in the same `.then(...)` callback (around line 1566) spreads `...(result.transcript ? { transcript: result.transcript } : {})` and `...(result.usage ? { usage: result.usage } : {})`.
- The updated `widget-headless.test.ts` reflects the new uniform shape (no `msgs (` regression assertion).
  Verify: open `test/orchestration/widget-headless.test.ts` and confirm there is no `assert.ok(paneRow.includes("msgs ("))` line; the pane row case (with `usage` populated) instead asserts the row contains output from `formatUsageStats` (e.g. `↑` or `↓` token markers).
- The new uniform-widget test passes.
  Verify: run `node --test test/orchestration/widget-pane-uniform.test.ts` and confirm exit code 0 with passing assertions for the three pane rows described in Step 6.5 (with `usage`, without `usage` cli=claude, without `usage` cli=pi).

**Model recommendation:** standard

---

### Task 7: Add `SessionStart` hook to the bundled Claude plugin

**Files:**
- Create: `pi-extension/subagents/plugin/hooks/on-session-start.sh`
- Modify: `pi-extension/subagents/plugin/hooks/hooks.json`
- Test: `test/plugin-session-start-hook.test.ts`

**Steps:**

- [ ] **Step 7.1: Write `on-session-start.sh`** — create `pi-extension/subagents/plugin/hooks/on-session-start.sh`. Mirror `on-stop.sh` structure exactly:
  ```bash
  #!/usr/bin/env bash
  # SessionStart hook for pi-spawned Claude sessions.
  # Sole responsibility: surface the transcript path to the watcher so the
  # pane backend's file-tail can lock onto the active jsonl during the run.
  # The Stop hook re-writes this same pointer on exit (idempotent).

  set -euo pipefail

  input=$(cat)

  # Only act for pi-spawned sessions
  [ -z "${PI_CLAUDE_SENTINEL:-}" ] && exit 0

  # Surface the transcript path
  transcript_path=$(printf '%s' "$input" | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).transcript_path||""))')
  [ -n "$transcript_path" ] && [ -f "$transcript_path" ] && \
    printf '%s\n' "$transcript_path" > "${PI_CLAUDE_SENTINEL}.transcript"

  exit 0
  ```
  Differences from `on-stop.sh`:
  - No `stop_hook_active` loop guard (SessionStart is naturally fired only at start).
  - Same env gate, same one-line pointer write.
- [ ] **Step 7.2: Make the hook executable** — use a Bash step inside the test runner (or, since this is a plan: state the requirement). Permissions: `chmod +x pi-extension/subagents/plugin/hooks/on-session-start.sh`. (Implementer must run this; the `Edit` / `Write` tool does not preserve executable bits when creating, so the test sets them or invokes via `bash` explicitly. The hooks.json spec passes the script through `bash`-equivalent invocation by Claude Code's plugin runtime, but the test below invokes via `bash` directly to avoid this issue.)
- [ ] **Step 7.3: Add `SessionStart` to `hooks.json`** — open `pi-extension/subagents/plugin/hooks/hooks.json`. Replace the file contents with:
  ```json
  {
    "hooks": {
      "SessionStart": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "${CLAUDE_PLUGIN_ROOT}/hooks/on-session-start.sh",
              "timeout": 10
            }
          ]
        }
      ],
      "Stop": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "${CLAUDE_PLUGIN_ROOT}/hooks/on-stop.sh",
              "timeout": 10
            }
          ]
        }
      ]
    }
  }
  ```
- [ ] **Step 7.4: Write the hook test** — create `test/plugin-session-start-hook.test.ts`. Mirror `test/plugin-stop-hook.test.ts` structure: `describe`, `before/after` for tempdir, `runHook(input, env)` helper that uses `spawnSync("bash", [HOOK], { input, env, encoding: "utf-8" })` where `HOOK = join(HERE, "..", "pi-extension", "subagents", "plugin", "hooks", "on-session-start.sh")`. Cover:
  - **No env**: with `PI_CLAUDE_SENTINEL=undefined`, exit 0 + no pointer file.
  - **Valid input**: with `PI_CLAUDE_SENTINEL=<path>` and a real `transcript_path`, exit 0 + pointer file written with the path content.
  - **Missing transcript path**: input has no `transcript_path` field, exit 0 + no pointer file.
  - **Idempotent re-fire**: if the pointer already exists with the same content, the hook still exits 0 and the file content is unchanged. (Implementation just overwrites — but the assertion is "exit 0 + same content".)
- [ ] **Step 7.5: Run the test** — `node --test test/plugin-session-start-hook.test.ts test/plugin-stop-hook.test.ts`. Confirm both pass (Stop hook test must still pass after the hooks.json restructure).

**Acceptance criteria:**

- `on-session-start.sh` exists, is shell-executable (or runnable via `bash`), and has the structure described in Step 7.1.
  Verify: open `pi-extension/subagents/plugin/hooks/on-session-start.sh` and confirm it begins with `#!/usr/bin/env bash`, contains a `[ -z "${PI_CLAUDE_SENTINEL:-}" ] && exit 0` env-gate line, extracts `transcript_path` via the same `node -e ` one-liner used in `on-stop.sh`, and writes the result to `${PI_CLAUDE_SENTINEL}.transcript`.
- `hooks.json` declares both `SessionStart` and `Stop` event handlers.
  Verify: `grep -E "SessionStart|Stop" pi-extension/subagents/plugin/hooks/hooks.json` returns at least one line for each event, and the file parses as valid JSON.
- The hook unit test passes all four cases (no env, valid input, missing path, idempotent re-fire).
  Verify: run `node --test test/plugin-session-start-hook.test.ts` and confirm exit code 0 with at least four passing tests whose descriptions cover the no-env / valid-input / missing-path / idempotent cases.
- The pre-existing Stop-hook test still passes.
  Verify: run `node --test test/plugin-stop-hook.test.ts` and confirm exit code 0 with all prior tests still passing.

**Model recommendation:** standard

---

### Task 8: Resume path tail-offset wiring + test

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Test: `test/orchestration/pane-resume-tail-offset.test.ts`

**Steps:**

- [ ] **Step 8.1: Pass `tailStartLine` from `subagent_resume.execute`** — locate `subagent_resume.execute` at line 1774. The pi-resume branch already captures `entryCountBefore = getNewEntries(params.sessionPath!, 0).length;` at line 1807. Locate the watcher dispatch at line 1925-1926:
  ```ts
        const watcher = watchSubagentOverride ?? watchSubagent;
        watcher(running, watcherAbort.signal)
  ```
  Change to:
  ```ts
        const watcher = watchSubagentOverride ?? watchSubagent;
        watcher(running, watcherAbort.signal, {
          tailStartLine: isPiResume ? entryCountBefore : 0,
        })
  ```
- [ ] **Step 8.2: Forward `transcript` and `usage` on the resume terminal `subagent_result`** — in the same `subagent_resume.execute` block, locate the terminal `pi.sendMessage({ customType: "subagent_result", ..., details: { name, task, exitCode, elapsed, sessionFile, sessionId } }, ...)` call (around lines 1977-1992). Spread the watcher's accumulated transcript/usage into `details` so resumed pane results expose the same observable shape as fresh-run results. Change the `details` object to:
  ```ts
              details: {
                name,
                task: params.message ?? (isPiResume ? "resumed session" : "resumed Claude session"),
                exitCode: result.exitCode,
                elapsed: result.elapsed,
                sessionFile: isPiResume ? params.sessionPath : undefined,
                sessionId: isPiResume ? undefined : params.sessionId,
                transcript: result.transcript,
                usage: result.usage,
              },
  ```
  Then locate the orchestration re-ingestion call `registry.onResumeTerminal(sessionKey, { ... })` immediately below (around lines 2006-2016). If `registry.onResumeTerminal`'s payload type already declares optional `transcript`/`usage` fields, add `transcript: result.transcript` and `usage: result.usage` to that object so resumed orchestration results carry the same rich data through `orchestration_complete`. If the payload type does not currently declare those fields, leave a one-line code comment `// transcript/usage on resumed-orchestration re-ingestion is tracked separately — registry payload type does not yet accept them.` and proceed without modifying the registry call. (The terminal `subagent_result` `details` change above is the load-bearing observable behavior the test asserts.)
- [ ] **Step 8.3: Write the resume-offset test** — create `test/orchestration/pane-resume-tail-offset.test.ts`. Setup:
  - `__test__.resetRegistry()` plus the standard mux/surface overrides (see `test/orchestration/resume-transcript-preservation.test.ts:31-43` for the pattern).
  - Create a temp session jsonl file with three pre-existing entries: `{"type":"session",...}` header, then two assistant-message entries.
  - Override `__test__.setWatchSubagentOverride(async (running, signal, opts) => { … })`. Inside the override:
    - Append two MORE assistant entries to the session file (these are the "resume slice").
    - Read the file, slice off `tailStartLine` lines, project the remainder via `projectPiMessageToTranscript`, and resolve with `{ transcript: <projected>, usage: { … }, name, task, summary, transcriptPath: sessionPath, exitCode: 0, elapsed: 1 }`.
  - Drive `subagent_resume.execute` with the temp session path.
  - Assert: the override saw `opts.tailStartLine === 3` (the pre-existing entry count). The captured `result.transcript.length === 2` (only the resumed slice). The forwarded `subagent_result` `details.transcript` matches.
- [ ] **Step 8.4: Run the test** — `node --test test/orchestration/pane-resume-tail-offset.test.ts`. Confirm it passes.

**Acceptance criteria:**

- `subagent_resume.execute` passes `tailStartLine` to the watcher via opts so the resumed pi watch tail starts at the pre-resume baseline.
  Verify: open `pi-extension/subagents/index.ts` near line 1925 and confirm the `watcher(...)` invocation passes `{ tailStartLine: isPiResume ? entryCountBefore : 0 }` as a third argument.
- The terminal `subagent_result` emitted from `subagent_resume.execute` includes `transcript` and `usage` inside `details`, populated from the watcher's resolved result.
  Verify: open `pi-extension/subagents/index.ts` near lines 1977-1992 and confirm the `pi.sendMessage({ customType: "subagent_result", ..., details: { ... } }, ...)` call's `details` object literally contains `transcript: result.transcript` and `usage: result.usage` lines alongside the existing `exitCode`/`elapsed`/`sessionFile`/`sessionId` fields.
- The resume-offset unit test asserts the override receives `tailStartLine === entryCountBefore`, the resolved transcript covers only the resumed slice, and the forwarded `subagent_result` `details.transcript` matches.
  Verify: run `node --test test/orchestration/pane-resume-tail-offset.test.ts` and confirm exit code 0 with at least one passing test whose body asserts `opts.tailStartLine === 3` (or the equivalent integer matching the test's pre-existing entry count), `result.transcript.length === 2`, AND that the captured forwarded `subagent_result` payload's `details.transcript` deep-equals `result.transcript`.

**Model recommendation:** standard

---

### Task 9: Abort and manual-exit must return accumulated partials

**Files:**
- Modify: `pi-extension/subagents/index.ts` (verify Task 3 / Task 4 already did this)
- Test: `test/orchestration/pane-watchsubagent-abort-partials.test.ts`

**Steps:**

- [ ] **Step 9.1: Re-confirm pi abort path returns transcript/usage** — open `watchSubagent` at line 1195. Confirm the `signal.aborted` branch return literal added in Task 3 Step 3.4 includes `transcript` and `usage`. If it does not, add them now:
  ```ts
        return {
          name, task, summary: "Subagent cancelled.",
          exitCode: 1,
          elapsed: Math.floor((Date.now() - startTime) / 1000),
          transcriptPath: null,
          error: "cancelled",
          transcript: [...transcript],
          usage: { ...usage },
        };
  ```
- [ ] **Step 9.2: Re-confirm pi error/throw path** — same for the error catch at line 1206-1214.
- [ ] **Step 9.3: Re-confirm Claude success path** — already added in Task 4 Step 4.4. The Claude branch's manual-exit/abort flows fall through `pollForExit`'s loop and reach the same close-up code, so the same returns apply.
- [ ] **Step 9.4: Write the abort-partials test** — create `test/orchestration/pane-watchsubagent-abort-partials.test.ts`. Setup:
  - `mkdtempSync` for a scratch dir; create a session jsonl file inside it with the standard pi `{"type":"session",...}` header so `getNewEntries` works.
  - Build a `RunningSubagent` with `cli: undefined` (pi default), `surface: "fake-surface"`, `sessionFile: <path>`, `startTime: Date.now()`.
  - Create an `AbortController abortController = new AbortController()`.
  - Call `watchSubagent(running, abortController.signal, { onUpdate: (p) => updates.push(p) })` and capture the returned promise.
  - Use a `setTimeout` to (a) append two complete `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hi"}],"usage":{"input":50,"output":10,"cacheRead":0,"cacheWrite":0,"totalTokens":60,"cost":{"total":0.0001}},"stopReason":"endTurn"}}\n` entries into the session file at t=200ms, then (b) call `abortController.abort()` at t=1500ms (after one full poll tick has fired). The watcher should resolve via the catch-block abort branch.
  - Assert:
    - The watcher resolves with `error === "cancelled"` (per the existing abort branch at line 1196).
    - `result.transcript.length >= 2` (the pre-abort partials are preserved).
    - `result.usage.turns >= 1` and `result.usage.input > 0` (token totals reflect the partial reads).
    - `updates.length >= 1` (at least one mid-run partial fired before the abort landed).
- [ ] **Step 9.5: Run the test** — `node --test test/orchestration/pane-watchsubagent-abort-partials.test.ts`. Confirm it passes.

**Acceptance criteria:**

- All three pi-branch return paths in `watchSubagent` (success, abort, error) carry `transcript` and `usage`.
  Verify: open `pi-extension/subagents/index.ts` and inspect the three return literals near lines 1179 (success), 1196 (abort), and 1206 (error) — each must include both `transcript` and `usage` keys.
- The Claude-branch success path carries `transcript` and `usage`.
  Verify: open `pi-extension/subagents/index.ts` near line 1149 and confirm the Claude return literal includes both `transcript: [...transcript]` and `usage: { ...usage }`.
- The abort-partials test passes.
  Verify: run `node --test test/orchestration/pane-watchsubagent-abort-partials.test.ts` and confirm exit code 0 with at least one passing test asserting `result.transcript.length >= 2` and `result.usage.turns >= 1` after a mid-run abort.

**Model recommendation:** standard

---

### Task 10: Update README

**Files:**
- Modify: `README.md`

**Steps:**

- [ ] **Step 10.1: Update the orchestration result-shape table** — open `README.md`. Find lines 91-92 (the `usage` and `transcript` rows). Change the second column for both rows from `**headless only (v1)**` to `both`. Keep the third column (notes) intact for both.
- [ ] **Step 10.2: Rewrite the trailing paragraph** — replace line 94 (`The \`usage\` / \`transcript\` fields are \`undefined\` on pane-backend results in v1; enriching the pane path is tracked as follow-up work.`) with:
  ```
  Both backends populate `usage` / `transcript`. Caveats on the pane path: ~1s latency floor on partials (1Hz polling matches the widget repaint cadence); long-running sessions accumulate unbounded `transcript[]` entries (same v1-acceptable limitation as headless); Claude pane sessions started via `--resume` may fall back to post-mortem-only because Claude Code does not always re-fire the `SessionStart` hook on resume — the resolved result still carries the full archived transcript and usage in that case.
  ```

**Acceptance criteria:**

- `README.md` documents `usage` and `transcript` as populated on both backends.
  Verify: open `README.md` and inspect the result-shape table around line 91; confirm both `usage` and `transcript` rows have `both` (not `headless only`) in the "Backend filling it" column.
- The trailing paragraph documents the three pane-side caveats (1s latency floor, unbounded transcript growth, Claude resume falls back to post-mortem).
  Verify: open `README.md` near line 94 and confirm the paragraph after the table contains the phrases `~1s latency`, `unbounded`, and `resume` describing the pane caveats.

**Model recommendation:** cheap

---

### Task 11: End-to-end acceptance verification

**Files:**
- Test: full suite under `test/orchestration/` and `test/plugin-*.test.ts`

**Steps:**

- [ ] **Step 11.1: Run the full local test suite** — `npm test`. Confirm exit code 0 with no test failures.
- [ ] **Step 11.2: Run the typecheck** — `npm run typecheck`. Confirm exit code 0 with no diagnostics.
- [ ] **Step 11.3: Run the integration suite (best-effort)** — `npm run test:integration`. Some tests are gated on `which pi` / mux availability; the goal is that none of them fail because of changes here. Tests that are skipped due to environment gates remain skipped.
- [ ] **Step 11.4: Cross-check spec acceptance criteria** — open `.pi/specs/2026-05-01-symmetric-pane-observability.md` lines 90-110. For each numbered criterion, confirm the matching task and test file:
  - Criteria 1, 9 → Task 3 + `pane-watchsubagent-onupdate-pi.test.ts` + `pi-projection-tail.test.ts` (#9 is the torn-write case).
  - Criterion 2 → Task 4 + Task 7 + `pane-watchsubagent-onupdate-claude.test.ts`.
  - Criterion 3 → Task 4 Step 4.3 + `pane-claude-postmortem-fallback.test.ts`.
  - Criterion 4 → Task 9 + `pane-watchsubagent-abort-partials.test.ts`.
  - Criteria 5, 6 → No code change (data-presence inheritance) + Task 6 ensures `details.transcript`/`details.usage` propagate from pane runs.
  - Criterion 7 → Task 6 + `widget-pane-uniform.test.ts`.
  - Criterion 8 → Task 8 + `pane-resume-tail-offset.test.ts`.
  - Criterion 10 → Task 10.

**Acceptance criteria:**

- `npm test` passes.
  Verify: run `npm test` and confirm exit code 0 with no `FAIL` or `failing` lines in the output.
- `npm run typecheck` passes with no new diagnostics.
  Verify: run `npm run typecheck` and confirm exit code 0 with no diagnostics referencing `pi-extension/subagents/backends/pi-projection.ts`, `pi-extension/subagents/backends/pane.ts`, or `pi-extension/subagents/index.ts`.
- Every numbered acceptance criterion in the spec maps to a passing test or a verified code edit.
  Verify: open `.pi/specs/2026-05-01-symmetric-pane-observability.md` and walk lines 90-110 against the cross-check table in Step 11.4; confirm each numbered criterion has at least one corresponding test file or task step listed.

**Model recommendation:** capable

---

## Dependencies

- Task 2 depends on: Task 1 (uses the new `tailPiSessionEntries` import inside opts type plumbing — but only by reference; Task 2 only changes the public surface of `SubagentResult` and `watchSubagent` opts).
- Task 3 depends on: Task 1, Task 2.
- Task 4 depends on: Task 2, Task 3 (Task 3 establishes the per-tick `transcript` / `usage` accumulators that Task 4's Claude branch reuses).
- Task 5 depends on: Task 2, Task 3, Task 4 (the pane backend cannot copy `transcript` / `usage` until `watchSubagent` produces them).
- Task 6 depends on: Task 5 (the bare-subagent watch site needs the new opts shape).
- Task 7 depends on: nothing internal (plugin-only change). Recommended ordering: alongside Task 4 since the Claude live-tail unit test in Task 4 simulates the pointer file directly without exercising the hook.
- Task 8 depends on: Task 2, Task 3.
- Task 9 depends on: Task 3, Task 4 (verifies the partials wiring on abort).
- Task 10 depends on: Task 3, Task 4, Task 5, Task 6 (so the documented behavior matches what shipped).
- Task 11 depends on: all prior tasks.

## Risk Assessment

- **Test seams for the embedded tail.** `__test__.setWatchSubagentOverride` substitutes the entire watcher; finer-grained tests of the tail-projection step happen at the `tailPiSessionEntries` unit level (Task 1.5). For pi/Claude end-to-end coverage of the tail inside `watchSubagent`, Task 3.5 / 4.5 drive real session jsonl files plus the existing `<sessionFile>.exit` sidecar / sentinel-file flow that `pollForExit` already honors. This avoids needing a new test seam inside `watchSubagent`.
- **`pollForExit`'s `onTick` is async-fragile.** The existing `onTick` already has a `try { … } catch {}` wrapper guarding the entries/bytes reads. The new tail steps follow the same defensive pattern (try/catch around every `readFileSync` and around every `onUpdate` call) so a bad partial does not break completion signaling.
- **Claude pane resume sessions may not re-fire `SessionStart`.** The spec acknowledges this in Open Question 2 and accepts the post-mortem-only fallback (Requirement #4 + Task 4 Step 4.3). README documents the behavior in Task 10. No code branch is required because the post-mortem path runs unconditionally when `transcript.length === 0` after `copyClaudeSession`.
- **Hook executable permissions.** New `on-session-start.sh` requires `chmod +x` to be runnable as a hook. The unit test (Task 7.4) explicitly invokes via `bash` to bypass this issue, but in production the plugin must ship with the executable bit set. The implementer must verify `git ls-files --stage pi-extension/subagents/plugin/hooks/on-session-start.sh` shows `100755 …` after staging.
- **Claude `result` event ordering.** `parseClaudeResult` runs only on the terminal `result` event; if the live tail observes the result before the watcher's archival kicks in (rare but possible), the post-mortem fallback at Task 4 Step 4.3 short-circuits because `transcript.length > 0`. Post-mortem only runs when the live tail saw nothing — that is the explicit guard.
- **Memory growth for long-running sessions.** Spec constraint: v1-acceptable per Constraints line 67. We accumulate `TranscriptMessage[]` unbounded, matching headless behavior. Risk is documented in README; not addressed by this plan.

## Test Command

```bash
npm test
```

## Review Notes

_Added by plan reviewer — informational, not blocking._

### Warnings

- **Task 1**: **What:** The File Structure section says `tailPiSessionEntries(running, state)` returns `{ messages: PiStreamMessage[], usageDelta }`, but Task 1 Step 1.2 and its acceptance criteria define `tailPiSessionEntries(sessionFile: string, state: PiTailState): PiTailDelta` returning `{ messages, assistantMessages }` with no `usageDelta`. **Why it matters:** An implementer could follow the File Structure summary and create a different helper signature/return shape than Tasks 1 and 3 expect, causing cross-task integration failures when `watchSubagent` tries to consume `delta.assistantMessages`. **Recommendation:** Make the File Structure entry match the detailed task contract: `tailPiSessionEntries(sessionFile, state)` returns `PiTailDelta` with `messages` and `assistantMessages`; usage is accumulated by `watchSubagent` from assistant messages.

- **Task 4**: **What:** Task 4 Step 4.3 correctly plans the final catch-up to run when `transcript.length === 0 || claudeFinalUsage === null || usage.turns === 0`, covering the missed-terminal-result race. However, the Risk Assessment says post-mortem "runs unconditionally when `transcript.length === 0`" and also says it "short-circuits because `transcript.length > 0`; post-mortem only runs when the live tail saw nothing." **Why it matters:** This directly contradicts Requirement #4 coverage for the result-event race and the task's own Step 4.3/4.7. A worker using the Risk Assessment as guidance could implement the older `transcript.length === 0` guard and miss terminal usage when live transcript was observed but the result event was not. **Recommendation:** Update the Risk Assessment to match Task 4 Step 4.3: final catch-up should also run when terminal usage/result was missed, not only when the live tail saw no transcript.
