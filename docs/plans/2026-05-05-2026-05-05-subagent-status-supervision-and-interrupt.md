# Subagent activity supervision, interactive suppression, and turn-only interrupt

**Source:** TODO-8c06b75d
**Spec:** `docs/specs/2026-05-05-subagent-status-supervision-and-interrupt.md`

## Goal

Port upstream commits `9f10962`, `269b485`, `b4b0287` into this fork: child-side `SubagentActivityRecorder` that writes JSONL snapshots, parent-side `SubagentStatusState` + 1-second supervision loop that emits `stalled`/`recovered` steer messages, frontmatter + tool param resolution for `interactive`, and a `subagent_interrupt` tool that sends Escape via portable `cmux.sendEscape` to pane-Pi children. Activity recording must work for both pane-Pi and headless-Pi children. Claude paths remain untouched. Local fork features (orchestration registry, blocked virtual rows, live transcript/usage, `caller_ping`, auto-exit, `subagent_run_cancel`) must work identically before and after.

## Architecture summary

1. **Child side (subagent-done.ts)**: A `SubagentActivityRecorder` (ported verbatim from upstream `activity.ts`) is bound at session start. It reads `PI_SUBAGENT_ID` and `PI_SUBAGENT_ACTIVITY_FILE` from env and writes a single JSON snapshot file at `<artifactDir>/subagent-activity/<id>.json` whenever a lifecycle event fires. When either env var is missing the recorder degrades to a no-op.
2. **Parent side (index.ts)**: Each `RunningSubagent` carries `statusState`, `activity`, `activityFile`, and `interactive` fields. A 1-second `startStatusRefresh` interval reads each child's activity file, folds it into `statusState` via `observeStatus`, advances state via `advanceStatusState`, refreshes the widget on kind change, and aggregates `stalled`/`recovered` transitions into a single `subagent_status` steer message — capped at 4 lines, suppressed for `interactive` children.
3. **Widget**: Per-row right-label precedence becomes `blocked > status > "running…/starting…" fallback`. Live `usage` is no longer rendered there; usage continues to flow through `subagent_result`.
4. **`subagent_interrupt` tool**: Resolves a `RunningSubagent` by `id` or exact `name`, rejects Claude and headless targets, calls a new `sendEscape(surface)` helper in `cmux.ts` (covering cmux/tmux/wezterm/zellij), refreshes the activity snapshot, then flips `statusState` to `waiting · interrupted` via `forceStatusAfterInterrupt`. The pane, watcher, and `RunningSubagent` row stay alive. Orchestration-owned slots get the same local ack — no registry transition fires.
5. **Headless backend wiring**: `backends/headless.ts` adds `PI_SUBAGENT_ID` and `PI_SUBAGENT_ACTIVITY_FILE` to `childEnv` and reports the activity-file path on the `LaunchedHandle`/`registerHeadlessSubagent` path so the supervision loop can read from it.
6. **`interactive` resolution**: Resolved as `params.interactive ?? agentDefs?.interactive ?? !(agentDefs?.autoExit ?? false)`. Plumbed onto `ResolvedLaunchSpec.effectiveInteractive` and consumed at the launch sites that build `RunningSubagent`. The orchestration `BackendLaunchParams.interactive` continues to be a structural-only field — orchestration tasks resolve interactive via the same chain inside `resolveLaunchSpec`.
7. **Config**: `parseStatusConfig` reads only `{ "status": { "enabled": boolean } }`. `lineLimit` is hardcoded at 4. Disabling supervision falls the widget back to `running…/starting…` and skips the interval; activity recording, `subagent_interrupt`, orchestration semantics are unaffected.

## Tech stack

- TypeScript / Node 22+, `node:test`
- Pi extension API (`@mariozechner/pi-coding-agent`), pi-tui (`@mariozechner/pi-tui`)
- `typebox` for tool params
- `node:fs`, `node:path`, `node:child_process`
- Multiplexer backends: cmux, tmux, wezterm, zellij (already used by `cmux.ts`)

## File Structure

- `pi-extension/subagents/activity.ts` (Create) — Verbatim port of upstream `activity.ts`. Exports `SubagentActivityState`, `SubagentActivityPhase`, `SubagentActivityScope`, `SubagentActivityEvent`, `SubagentActivityRecorder`, `ActivityReadResult`, `SubagentShutdownReason`, `getSubagentActivityFile`, `readSubagentActivityFile`, `writeSubagentActivityFile`, `createSubagentActivityRecorder`. No-op recorder when `runningChildId`/`activityFile` missing. Throttle: `ACTIVITY_UPDATE_THROTTLE_MS=500`. Disable after `MAX_WRITE_FAILURES=3`.
- `pi-extension/subagents/status.ts` (Create) — Verbatim port of upstream `status.ts`. Exports `SubagentStatusKind`, `SubagentStatusSource`, `SubagentStatusTransition`, `StatusSnapshotState`, `StatusActivityPhase`, `StatusConfig`, `StatusObservation`, `SubagentStatusState`, `StatusSnapshot`, `CappedStatusLines`, `SNAPSHOT_STALLED_AFTER_MS=60_000`, `DEFAULT_STATUS_LINE_LIMIT=4`, `MAX_STATUS_NAME_LENGTH=72`, `MAX_STATUS_LINE_LENGTH=120`, `parseStatusConfig`, `loadStatusConfig`, `formatElapsedDuration`, `createStatusState`, `observeStatus`, `forceStatusAfterInterrupt`, `classifyStatus`, `advanceStatusState`, `formatStatusLine`, `formatTransitionLine`, `capStatusLines`, `formatStatusAggregate`, `normalizeStatusName`. `loadStatusConfig` looks at `<package>/config.json` first then `<package>/config.json.example`.
- `config.json.example` (Create — at repo root, sibling of `package.json`) — Single-line JSON: `{ "status": { "enabled": true } }`.
- `pi-extension/subagents/cmux.ts` (Modify) — Add new exported `sendEscape(surface: string): void` covering cmux (`execFileSync("cmux", ["send", "--surface", surface, ""])`), tmux (`execFileSync("tmux", ["send-keys", "-t", surface, "Escape"])`), wezterm (`execFileSync("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", ""])`), zellij (`zellijActionSync(["write", "27"], surface)`). Uses `requireMuxBackend()`.
- `pi-extension/subagents/launch-spec.ts` (Modify) — Add `interactive?: boolean` to `AgentDefaults`. Parse it in `parseAgentDefaultsFromContent` via `parseOptionalBoolean(getFrontmatterValue(..., "interactive"))`. Add `effectiveInteractive: boolean` to `ResolvedLaunchSpec`. Add `resolveEffectiveInteractive(params, agentDefs)` helper. Rewrite `SubagentParams.interactive` description from "Vestigial compat field" to the real semantics. Compute and assign `effectiveInteractive` inside `resolveLaunchSpec` before the return statement. Add `subagent_interrupt` to `SPAWNING_TOOLS`.
- `pi-extension/subagents/index.ts` (Modify) — Import activity + status + sendEscape. Add `effectiveInteractive` parsing for the bare `subagent` tool (already on spec); add `parseAgentDefinition` parse for `interactive:`. Extend `RunningSubagent` with `statusState`, `activity?`, `activityFile?`, `interactive: boolean`. Compute `activityFile` at pane-Pi launch site (already in upstream). Replace widget right-label switch with `blocked > status > fallback` precedence (skipping status for synthetic blocked rows). Add `STATUS_INTERVAL_KEY` /reload guard. Add `observeRunningSubagent`, `startStatusRefresh`, `resolveInterruptTarget`, `requestSubagentInterrupt`, `handleSubagentInterrupt`. Register `subagent_interrupt` tool. Skip status supervision for `agent.blocked` virtual rows. Surface needed test seams via `__test__`. Wire status interval cleanup in `session_shutdown`. Update `registerHeadlessSubagent` to accept `activityFile` + `interactive` and seed `statusState`. Update `subagent_resume` registration to set `interactive: !autoExit` (consistent with `resolveResumeLaunchBehavior`). Update Claude pane branch in `launchSubagent` to seed `statusState` with `source: "claude"` and `interactive: <resolved>`.
- `pi-extension/subagents/subagent-done.ts` (Modify) — Bind `createSubagentActivityRecorder({ runningChildId: PI_SUBAGENT_ID, activityFile: PI_SUBAGENT_ACTIVITY_FILE })` at module load. Wire all 18 lifecycle events from upstream (`session_start`, `input`, `before_agent_start`, `agent_start`, `agent_end` with done/waiting branch, `turn_start`, `turn_end`, `before_provider_request`, `after_provider_response`, `message_update`, `tool_execution_start`, `tool_call`, `tool_execution_update`, `tool_result`, `tool_execution_end`, `caller_ping`, `subagent_done`, `session_shutdown`). Move shared registration of event handlers above the `if (autoExit)` block so the recorder always observes events even when auto-exit is off. Branch `agent_end` between `agentEndDone()` (when auto-exit + shouldExit) and `agentEndWaiting()` otherwise. Cancel `userTookOver` reset semantics remain unchanged. `caller_ping` and `subagent_done` call recorder's `callerPing()`/`subagentDone()` before writing the `.exit` sidecar.
- `pi-extension/subagents/backends/headless.ts` (Modify) — In `runPiHeadless`, compute `activityFile = getSubagentActivityFile(spec.artifactDir, id)` from a parent-side launch id. Pass `id` and `activityFile` through to `LaunchedHandle` so the parent can seed `RunningSubagent.activityFile`. Add `PI_SUBAGENT_ID` and `PI_SUBAGENT_ACTIVITY_FILE` to `childEnv`. `mkdirSync(dirname(activityFile), { recursive: true })` before spawn. `LaunchedHandle` shape extension: add `activityFile?: string`. Headless Claude path stays unchanged.
- `pi-extension/subagents/backends/types.ts` (Modify) — Add `activityFile?: string` to `LaunchedHandle` (cross-cuts the orchestration layer). Update `BackendLaunchParams.interactive` description to match the spec semantics; orchestration layer plumbs it through but does not branch on it (resolution still happens inside `resolveLaunchSpec`).
- `pi-extension/orchestration/types.ts` (Modify) — Rewrite `OrchestrationTaskSchema.interactive` description from "Vestigial compat field" to match the real semantics. Field stays optional; orchestration's `resolveLaunchSpec` call already consumes it.
- `pi-extension/orchestration/default-deps.ts` (Modify) — On `launch`, when registering the headless `RunningSubagent`, pass through `handle.activityFile` and recompute the `interactive` boolean locally by calling `resolveEffectiveInteractive` with the orchestration `task` and the loaded agent defaults (the resolved value is intentionally not surfaced on the launch handle, to avoid changing the `Backend` contract). Pass that recomputed value to `registerHeadlessSubagent` so it can wire status supervision. New optional fields on `registerHeadlessSubagent`'s parameter object: `activityFile?: string`, `interactive: boolean`, `source: "pi" | "claude"`.
- `test/orchestration/activity-recorder.test.ts` (Create) — Unit tests for the `SubagentActivityRecorder`: state transitions, JSONL roundtrip, `wrong-id` reads, `invalid` reads, `caller_ping` / `subagent_done` mark `done`, `tool_result` after `tool_execution_end` does not resurrect `toolActive`, reload shutdown does not write `done`, throttled writes are cancelled on reload.
- `test/orchestration/status-state.test.ts` (Create) — Unit tests for `observeStatus`, `classifyStatus`, `advanceStatusState`, `forceStatusAfterInterrupt`, plus stale-snapshot rejection (older than `lastActivityAtMs`), local-override blocking semantics, `source: "claude"` always resolves to `kind: "running"`, `SNAPSHOT_STALLED_AFTER_MS` triggering `stalled` from `starting` and from `present`.
- `test/orchestration/status-format.test.ts` (Create) — Unit tests for `formatStatusLine`, `formatTransitionLine`, `capStatusLines`, `formatStatusAggregate`, `normalizeStatusName`, `MAX_STATUS_LINE_LENGTH`, `MAX_STATUS_NAME_LENGTH`, overflow rendering.
- `test/orchestration/status-config.test.ts` (Create) — Unit tests for `parseStatusConfig`, `loadStatusConfig`, the example fallback path, rejection of unknown `status.*` keys, rejection of malformed JSON, type validation of `enabled`.
- `test/orchestration/subagent-interrupt.test.ts` (Create) — Unit tests for `resolveInterruptTarget` (id resolution, name resolution, ambiguity), `requestSubagentInterrupt` (success path, throw path), `handleSubagentInterrupt` Pi-backed success branch (sends Escape, calls `forceStatusAfterInterrupt`, refreshes activity snapshot first, returns `interrupt_requested`), Claude rejection branch ("currently supported only for pane-Pi subagents"), headless rejection branch, Escape-failure branch (status unchanged), orchestration-owned slot success branch (no registry transition fires).
- `test/orchestration/resolve-interactive.test.ts` (Create) — Unit tests for `resolveEffectiveInteractive`: `params.interactive` always wins, `agentDefs.interactive` wins over `autoExit` default, default is `!autoExit`, all four `(autoExit, interactive)` combinations reachable via explicit overrides.
- `test/orchestration/widget-right-label.test.ts` (Create) — Tests for the widget right-label precedence: blocked virtual row renders `blocked — awaiting parent`, pane-Pi with active status renders `active …`, headless-Pi with `stalled` status renders `stalled …`, Claude row renders `running …` even when supervision enabled, fallback path when `statusConfig.enabled === false` renders `starting…/running…`.
- `test/orchestration/interactive-compat.test.ts` (Modify) — Schema validation assertions stay. Flip the `resolveLaunchSpec ignores interactive` assertion to its inverse: the resolved spec must surface `effectiveInteractive` per the resolution chain.
- `test/integration/pane-pi-status-supervision.test.ts` (Create) — Integration: launch a pane-pi child, let it idle past `SNAPSHOT_STALLED_AFTER_MS`, assert the parent receives a single `subagent_status` steer message and the widget kind flipped through `starting → waiting → stalled`. Use real `pi` CLI with a slow-task agent. Skipped (or short-circuited via env override) if mux unavailable.
- `test/integration/headless-pi-status-supervision.test.ts` (Create) — Integration: same as above for headless-pi child.
- `test/integration/orchestration-blocked-supervision.test.ts` (Create) — Integration: an orchestration-owned child that goes blocked still produces the blocked virtual row, and supervision does not crash on it. Synthetic-row activity reads must be skipped.
- `docs/analysis/upstream-sync-ledger-pi.md` (Modify) — Move `9f10962`, `269b485`, `b4b0287` to `PROCESSED`, referencing this plan and its tests.

## Tasks

### Task 1: Port `activity.ts` verbatim

**Files:**
- Create: `pi-extension/subagents/activity.ts`
- Test: `test/orchestration/activity-recorder.test.ts`

**Steps:**
- [ ] **Step 1.1: Write the failing recorder tests** — In `test/orchestration/activity-recorder.test.ts`, write tests that import `getSubagentActivityFile`, `readSubagentActivityFile`, `writeSubagentActivityFile`, `createSubagentActivityRecorder` from `../../pi-extension/subagents/activity.ts`. Cover: (a) recorder writes a snapshot at `<dir>/subagent-activity/<id>.json` reachable by `getSubagentActivityFile`; (b) `readSubagentActivityFile` returns `{ ok: true, activity }` with `phase: "active"` after `toolExecutionStart("tool-1", "bash")`; (c) `readSubagentActivityFile(file, "other")` returns `{ ok: false, reason: "wrong-id" }`; (d) malformed cases (`activeSince: "bad"`, `waitingSince: "bad"`, `activeScope: "database"`, `latestEvent: "unknown"`, `runningChildId: 42`, `toolActive: "yes"`, `toolName: "bad\nname"`) return `{ ok: false, reason: "invalid" }`; (e) `subagentDone()` and `callerPing()` mark phase `done`; (f) `sessionShutdown("reload")` does not write a `done` snapshot (latest event stays `session_start` from prior call); (g) `tool_result` after `tool_execution_end` does not flip `toolActive` back to true.
- [ ] **Step 1.2: Run the tests and confirm they fail** — `npm test -- --test-name-pattern="activity-recorder"` must fail with `Cannot find module 'pi-extension/subagents/activity.ts'` or equivalent.
- [ ] **Step 1.3: Copy upstream `activity.ts` verbatim** — Read `.pi/git/github.com/HazAT/pi-interactive-subagents/pi-extension/subagents/activity.ts` (~512 lines). Write the same content to `pi-extension/subagents/activity.ts`. Do not rename exports. Do not change `MAX_ACTIVITY_STRING_LENGTH=200`, `ACTIVITY_UPDATE_THROTTLE_MS=500`, `MAX_WRITE_FAILURES=3`, `KNOWN_PHASES`, `KNOWN_SCOPES`, `KNOWN_EVENTS`. Keep the temp-file rename pattern (`writeFileSync(tempFile, …); renameSync(tempFile, activityFile)`).
- [ ] **Step 1.4: Run the tests and confirm they pass** — `npm test -- --test-name-pattern="activity-recorder"` exits 0.
- [ ] **Step 1.5: Run typecheck** — `npx tsc --noEmit` exits 0.

**Acceptance criteria:**
- `pi-extension/subagents/activity.ts` exists and exports the upstream surface (`SubagentActivityState`, `SubagentActivityRecorder`, `ActivityReadResult`, `SubagentShutdownReason`, `getSubagentActivityFile`, `readSubagentActivityFile`, `writeSubagentActivityFile`, `createSubagentActivityRecorder`).
  Verify: `grep -n "export" pi-extension/subagents/activity.ts | head -30` shows all eight names above.
- `test/orchestration/activity-recorder.test.ts` covers JSONL roundtrip, validation rejections, `wrong-id`, `caller_ping`/`subagent_done` done transitions, `tool_result` after `tool_execution_end` no resurrection, reload-shutdown no-done.
  Verify: run `node --test test/orchestration/activity-recorder.test.ts` and confirm exit code 0 with at least 7 distinct passing `it(...)` cases.
- Recorder degrades to no-op when `runningChildId` or `activityFile` is missing.
  Verify: read `pi-extension/subagents/activity.ts` and confirm `createSubagentActivityRecorder` returns `createNoopRecorder()` when either trimmed value is empty (lines around 299-301).
- Validation constants match upstream (`MAX_ACTIVITY_STRING_LENGTH=200`, `MAX_WRITE_FAILURES=3`, `ACTIVITY_UPDATE_THROTTLE_MS=500`).
  Verify: `grep -n "MAX_ACTIVITY_STRING_LENGTH\|MAX_WRITE_FAILURES\|ACTIVITY_UPDATE_THROTTLE_MS" pi-extension/subagents/activity.ts` shows exactly those three values.

**Model recommendation:** cheap (verbatim port + test fixtures)

### Task 2: Port `status.ts` verbatim plus `config.json.example`

**Files:**
- Create: `pi-extension/subagents/status.ts`
- Create: `config.json.example` (repo root)
- Test: `test/orchestration/status-state.test.ts`
- Test: `test/orchestration/status-format.test.ts`
- Test: `test/orchestration/status-config.test.ts`

**Steps:**
- [ ] **Step 2.1: Write the failing status-state tests** — In `test/orchestration/status-state.test.ts`, import `createStatusState`, `observeStatus`, `classifyStatus`, `advanceStatusState`, `forceStatusAfterInterrupt`, `SNAPSHOT_STALLED_AFTER_MS` from `../../pi-extension/subagents/status.ts`. Cover: (a) fresh `pi`-source state has `currentKind: "starting"`; (b) `claude`-source state always classifies as `kind: "running"`; (c) feeding a `present` observation with `phase: "active"` flips `currentKind` to `"active"` via `advanceStatusState`; (d) idle past `SNAPSHOT_STALLED_AFTER_MS` from `firstObservationAtMs` (or `startTimeMs`) flips to `stalled`; (e) `forceStatusAfterInterrupt` sets `phase: "waiting"`, `activityLabel: "interrupted"`, and `localOverrideSequence` to the prior `lastActivitySequence`; (f) a stale `present` observation (`updatedAt < lastActivityAtMs`) is rejected; (g) recovery path: state goes `stalled → active` on a fresh observation, transition is `recovered`.
- [ ] **Step 2.2: Write the failing format tests** — In `test/orchestration/status-format.test.ts`, import `formatStatusLine`, `formatTransitionLine`, `capStatusLines`, `formatStatusAggregate`, `normalizeStatusName`, `MAX_STATUS_NAME_LENGTH`, `MAX_STATUS_LINE_LENGTH`. Cover: (a) `formatStatusLine` for kind `starting` → `"<name> running <elapsed>, starting."`; (b) for `active` with label "bash" and duration 2s → `"<name> running <elapsed>, active (bash 2s)."`; (c) for `waiting` with done label adds `(done)`; (d) for `stalled` with snapshot problem text → `"<name> running …, stalled <ms> (… )."`; (e) `formatStatusAggregate(["a","b","c","d","e"], 4)` produces `"Subagent status:\n• a\n• b\n• c\n• d\n• +1 more running."`; (f) `normalizeStatusName(" a   b ")` collapses whitespace and truncates to `MAX_STATUS_NAME_LENGTH`; (g) `formatTransitionLine` for `recovered` includes the word `"recovered"`.
- [ ] **Step 2.3: Write the failing config tests** — In `test/orchestration/status-config.test.ts`, import `parseStatusConfig`, `loadStatusConfig`. Cover: (a) `parseStatusConfig({ status: { enabled: true } })` returns `{ enabled: true, lineLimit: 4 }`; (b) `parseStatusConfig({ status: { enabled: false } })` returns `{ enabled: false, lineLimit: 4 }`; (c) `parseStatusConfig({ status: { enabled: true, lineLimit: 5 } })` throws with message containing `unsupported key(s): lineLimit`; (d) missing `status.enabled` throws; (e) `loadStatusConfig(missing, exampleFile)` reads `exampleFile`; (f) both files missing throws `Missing subagent status config`.
- [ ] **Step 2.4: Run the failing tests** — `npm test -- --test-name-pattern="status-"` must fail.
- [ ] **Step 2.5: Copy upstream `status.ts` verbatim** — Read `.pi/git/github.com/HazAT/pi-interactive-subagents/pi-extension/subagents/status.ts` (~514 lines). Write it to `pi-extension/subagents/status.ts`. The constants `PACKAGE_ROOT` / `DEFAULT_STATUS_CONFIG_PATH` / `STATUS_CONFIG_EXAMPLE_PATH` resolve to `<package>/config.json` / `<package>/config.json.example`. Keep `SNAPSHOT_STALLED_AFTER_MS = 60_000`, `DEFAULT_STATUS_LINE_LIMIT = 4`, `MAX_STATUS_NAME_LENGTH = 72`, `MAX_STATUS_LINE_LENGTH = 120`.
- [ ] **Step 2.6: Create `config.json.example` at repo root** — Write the literal content `{\n  "status": {\n    "enabled": true\n  }\n}\n`.
- [ ] **Step 2.7: Run the tests and confirm they pass** — `npm test -- --test-name-pattern="status-"` exits 0.
- [ ] **Step 2.8: Run typecheck** — `npx tsc --noEmit` exits 0.

**Acceptance criteria:**
- `pi-extension/subagents/status.ts` exists and exports the upstream surface (`createStatusState`, `observeStatus`, `forceStatusAfterInterrupt`, `classifyStatus`, `advanceStatusState`, `formatStatusLine`, `formatTransitionLine`, `capStatusLines`, `formatStatusAggregate`, `normalizeStatusName`, `parseStatusConfig`, `loadStatusConfig`, `SNAPSHOT_STALLED_AFTER_MS`, `DEFAULT_STATUS_LINE_LIMIT`).
  Verify: `grep -n "^export" pi-extension/subagents/status.ts` shows all 14 names.
- `config.json.example` exists at repo root with `{ "status": { "enabled": true } }`.
  Verify: `cat config.json.example` outputs JSON with exactly one top-level `status.enabled: true`; `node -e "JSON.parse(require('fs').readFileSync('config.json.example','utf8'))"` exits 0.
- All three test files pass.
  Verify: `node --test test/orchestration/status-state.test.ts test/orchestration/status-format.test.ts test/orchestration/status-config.test.ts` exits 0 with at least 7 + 7 + 6 = 20 passing cases.
- `parseStatusConfig` rejects any key under `status` other than `enabled`.
  Verify: read `pi-extension/subagents/status.ts` and confirm `rejectUnsupportedKeys(status, ["enabled"], source, "status")` is called inside `parseStatusConfig`.

**Model recommendation:** cheap (verbatim port + tests)

### Task 3: Add `sendEscape` to `cmux.ts`

**Files:**
- Modify: `pi-extension/subagents/cmux.ts`

**Steps:**
- [ ] **Step 3.1: Read the upstream `sendEscape` implementation** — Open `.pi/git/github.com/HazAT/pi-interactive-subagents/pi-extension/subagents/cmux.ts` lines 510-531; copy the four-backend body verbatim.
- [ ] **Step 3.2: Add the new export to `cmux.ts`** — Insert immediately after the existing `sendCommand` function (around line 1204):
  ```ts
  /**
   * Send one Escape keypress to an active pane.
   * Used by `subagent_interrupt` to cancel the current turn without killing the session.
   */
  export function sendEscape(surface: string): void {
    const backend = requireMuxBackend();
    if (backend === "cmux") {
      execFileSync("cmux", ["send", "--surface", surface, ""], { encoding: "utf8" });
      return;
    }
    if (backend === "tmux") {
      execFileSync("tmux", ["send-keys", "-t", surface, "Escape"], { encoding: "utf8" });
      return;
    }
    if (backend === "wezterm") {
      execFileSync("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", ""], { encoding: "utf8" });
      return;
    }
    zellijActionSync(["write", "27"], surface);
  }
  ```
- [ ] **Step 3.3: Run typecheck** — `npx tsc --noEmit` exits 0.
- [ ] **Step 3.4: Run the existing cmux tests** — `node --test test/test.ts` exits 0 — adding `sendEscape` must not break `shellEscape`/`buildTmuxSplitArgs`/zellij tests.

**Acceptance criteria:**
- `cmux.ts` exports `sendEscape(surface: string): void`.
  Verify: `grep -n "^export function sendEscape" pi-extension/subagents/cmux.ts` returns exactly one match.
- All four mux backends are covered (cmux/tmux/wezterm/zellij).
  Verify: read the body of `sendEscape` and confirm it has explicit `if (backend === "cmux")`, `if (backend === "tmux")`, `if (backend === "wezterm")` branches followed by a fallthrough zellij `zellijActionSync(["write", "27"], surface)` call.
- Existing tests still pass.
  Verify: `npm test` exits 0 (full unit suite, not just cmux).

**Model recommendation:** cheap

### Task 4: Wire activity recorder into `subagent-done.ts`

**Files:**
- Modify: `pi-extension/subagents/subagent-done.ts`
- Test: existing `test/test.ts` `subagent-done` tests; new test if needed for env-var degrade.

**Steps:**
- [ ] **Step 4.1: Read the upstream `subagent-done.ts`** — Open `.pi/git/github.com/HazAT/pi-interactive-subagents/pi-extension/subagents/subagent-done.ts`. Note the recorder is bound at module top-level; event handlers fire regardless of `autoExit`. Note `agent_end` calls `agentEndDone()` when `autoExit && shouldAutoExitOnAgentEnd(...)`, otherwise `agentEndWaiting()`. `caller_ping`/`subagent_done` call recorder before `ctx.shutdown()`.
- [ ] **Step 4.2: Add the recorder import** — Add `import { createSubagentActivityRecorder } from "./activity.ts";` near the top of the file.
- [ ] **Step 4.3: Add module-scope recorder construction** — Inside the default-exported function, after the existing `const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";` line, add:
  ```ts
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });
  ```
- [ ] **Step 4.4: Add `recorder.sessionStart()` to the `session_start` handler** — Inside the existing `pi.on("session_start", (_event, ctx) => { … })` block, add `recorder.sessionStart();` as the first line of the handler.
- [ ] **Step 4.5: Add the always-on lifecycle handlers** — Outside the existing `if (autoExit)` block, add separate `pi.on(...)` registrations (these must run for both auto-exit and non-auto-exit subagents):
  ```ts
  pi.on("input", () => { recorder.input(); });
  pi.on("before_agent_start", () => { recorder.beforeAgentStart(); });
  pi.on("agent_start", () => { recorder.agentStart(); });
  pi.on("turn_start", (event) => { recorder.turnStart((event as any).turnIndex); });
  pi.on("turn_end", (event) => { recorder.turnEnd((event as any).turnIndex); });
  pi.on("before_provider_request", () => { recorder.beforeProviderRequest(); });
  pi.on("after_provider_response", () => { recorder.afterProviderResponse(); });
  pi.on("message_update", (event) => { recorder.messageUpdate((event as any).assistantMessageEvent?.type); });
  pi.on("tool_execution_start", (event) => { recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName); });
  pi.on("tool_call", (event) => { recorder.toolCall((event as any).toolCallId, (event as any).toolName); });
  pi.on("tool_execution_update", (event) => { recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName); });
  pi.on("tool_result", (event) => { recorder.toolResult((event as any).toolCallId, (event as any).toolName); });
  pi.on("tool_execution_end", (event) => { recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName); });
  pi.on("session_shutdown", (event) => { recorder.sessionShutdown((event as any).reason); });
  ```
- [ ] **Step 4.6: Refactor the `agent_end` branch** — The current local fork has an `if (autoExit)` block that registers `agent_start` and `input` and the `agent_end` shutdown logic. The new shape:
  - Lift `agentStarted` and `userTookOver` lets to module-default-exported-function scope (outside `if (autoExit)`).
  - The always-on `pi.on("input", ...)` handler now also keeps the user-takeover bookkeeping when `agentStarted === true`. Move that bookkeeping into a single `pi.on("input", ...)` handler.
  - The always-on `pi.on("agent_start", ...)` handler also sets `agentStarted = true`.
  - Replace the existing `pi.on("agent_end", ...)` handler with a single one that:
    1. Computes `shouldExit = autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages)`.
    2. If `shouldExit`: calls `recorder.agentEndDone()`, then `ctx.shutdown()`, returns.
    3. Else: calls `recorder.agentEndWaiting()`. If `autoExit`, resets `userTookOver = false` to allow re-engagement on the next normal completion cycle.
- [ ] **Step 4.7: Add recorder calls inside `caller_ping` and `subagent_done` tools** — Inside the `caller_ping` tool's `execute`, add `recorder.callerPing();` immediately before `writeFileSync` of the `.exit` sidecar. Inside `subagent_done`'s `execute`, add `recorder.subagentDone();` immediately before the `writeFileSync` of the `.exit` sidecar.
- [ ] **Step 4.8: Run the existing subagent-done unit tests** — `node --test test/test.ts` exits 0. The `shouldAutoExitOnAgentEnd` and `shouldMarkUserTookOver` helpers stay byte-identical, so the existing tests keep passing.
- [ ] **Step 4.9: Hand-verify env-var-missing degrade** — Read `pi-extension/subagents/subagent-done.ts` and confirm the recorder is `createSubagentActivityRecorder({ runningChildId: undefined, activityFile: undefined })` when the env vars are missing — `createNoopRecorder()` will be returned per Task 1, so the file emits no I/O.

**Acceptance criteria:**
- `subagent-done.ts` imports and constructs `createSubagentActivityRecorder` once at module load, reading `PI_SUBAGENT_ID` and `PI_SUBAGENT_ACTIVITY_FILE` from env.
  Verify: `grep -n "createSubagentActivityRecorder" pi-extension/subagents/subagent-done.ts` returns exactly one usage; the surrounding lines pass `process.env.PI_SUBAGENT_ID` and `process.env.PI_SUBAGENT_ACTIVITY_FILE`.
- All 18 lifecycle events from upstream are routed to the recorder.
  Verify: `grep -nE "recorder\.(sessionStart|input|beforeAgentStart|agentStart|agentEndWaiting|agentEndDone|turnStart|turnEnd|beforeProviderRequest|afterProviderResponse|messageUpdate|toolExecutionStart|toolCall|toolExecutionUpdate|toolResult|toolExecutionEnd|callerPing|subagentDone|sessionShutdown)" pi-extension/subagents/subagent-done.ts | wc -l` returns ≥ 18.
- `agent_end` calls `agentEndDone()` only when auto-exit is taking effect; `agentEndWaiting()` runs in all other cases.
  Verify: read the new `pi.on("agent_end", ...)` block and confirm the `if (shouldExit) { recorder.agentEndDone(); ctx.shutdown(); return; } recorder.agentEndWaiting();` shape.
- Existing unit tests still pass.
  Verify: `node --test test/test.ts` exits 0.
- The recorder is a no-op when env vars are missing — child code does not crash if `PI_SUBAGENT_ID` or `PI_SUBAGENT_ACTIVITY_FILE` is undefined.
  Verify: read `pi-extension/subagents/subagent-done.ts` and confirm no code path accesses recorder return values; recorder is constructed unconditionally because the no-op branch is internal to `createSubagentActivityRecorder`.

**Model recommendation:** standard (touches lifecycle events that gate auto-exit semantics)

### Task 5: Add `interactive` to `AgentDefaults` and `ResolvedLaunchSpec`

**Files:**
- Modify: `pi-extension/subagents/launch-spec.ts`
- Modify: `pi-extension/subagents/index.ts`
- Test: `test/orchestration/resolve-interactive.test.ts` (Create)
- Test: `test/orchestration/interactive-compat.test.ts` (Modify)

**Steps:**
- [ ] **Step 5.1: Write the failing `resolveEffectiveInteractive` tests** — In `test/orchestration/resolve-interactive.test.ts`, import `__test__` from `pi-extension/subagents/index.ts` and assert `__test__.resolveEffectiveInteractive` exists. Cover:
  ```ts
  // params null/undefined: agent default wins
  resolveEffectiveInteractive({ name, task }, { autoExit: true })  → false
  resolveEffectiveInteractive({ name, task }, { autoExit: false }) → true
  resolveEffectiveInteractive({ name, task }, {})                  → true
  resolveEffectiveInteractive({ name, task }, null)                → true
  // agent frontmatter `interactive` overrides autoExit default
  resolveEffectiveInteractive({ name, task }, { autoExit: true, interactive: true })  → true
  resolveEffectiveInteractive({ name, task }, { autoExit: false, interactive: false }) → false
  // params.interactive wins over everything
  resolveEffectiveInteractive({ name, task, interactive: false }, { autoExit: false, interactive: true }) → false
  resolveEffectiveInteractive({ name, task, interactive: true },  { autoExit: true,  interactive: false }) → true
  ```
- [ ] **Step 5.2: Modify `interactive-compat.test.ts`** — Replace the `resolveLaunchSpec ignores interactive` test (lines 22-47) with a test that asserts `resolveLaunchSpec({ name, task, interactive: true }, ctx).effectiveInteractive === true` and `resolveLaunchSpec({ name, task }, ctx).effectiveInteractive === !(agentDefs?.autoExit ?? false) === true` (no agent → defaults). Keep the schema-validation tests at the top untouched.
- [ ] **Step 5.3: Run the failing tests** — `node --test test/orchestration/resolve-interactive.test.ts test/orchestration/interactive-compat.test.ts` must fail.
- [ ] **Step 5.4: Add `interactive` to `AgentDefaults` in `launch-spec.ts`** — Add `interactive?: boolean;` to the `AgentDefaults` interface, alongside `autoExit?` and `spawning?`.
- [ ] **Step 5.5: Parse `interactive` in `parseAgentDefaultsFromContent`** — Inside `parseAgentDefaultsFromContent`, add `interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),` to the returned object (next to the existing `autoExit` line).
- [ ] **Step 5.6: Mirror in `parseAgentDefinition` inside `index.ts`** — In `pi-extension/subagents/index.ts`, the `parseAgentDefinition` function (around lines 226-257) returns an `AgentDefinition extends AgentDefaults`. Add `interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),` right after the existing `autoExit:` line.
- [ ] **Step 5.7: Add `effectiveInteractive` to `ResolvedLaunchSpec`** — Add `effectiveInteractive: boolean;` to the `ResolvedLaunchSpec` interface in `launch-spec.ts`, near `autoExit`.
- [ ] **Step 5.8: Add `resolveEffectiveInteractive` helper** — In `launch-spec.ts`, just below `resolveLaunchBehavior`, add:
  ```ts
  export function resolveEffectiveInteractive(
    params: SubagentParamsType,
    agentDefs: AgentDefaults | null,
  ): boolean {
    if (params.interactive != null) return params.interactive;
    if (agentDefs?.interactive != null) return agentDefs.interactive;
    return !(agentDefs?.autoExit ?? false);
  }
  ```
- [ ] **Step 5.9: Compute and surface in `resolveLaunchSpec`** — Inside `resolveLaunchSpec`, just before `return { ... }`, add `const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);`. Add `effectiveInteractive,` to the returned object.
- [ ] **Step 5.10: Re-export `resolveEffectiveInteractive` from `index.ts`** — Add `resolveEffectiveInteractive` to the named imports/re-exports block in `pi-extension/subagents/index.ts` (around lines 60-89), and also expose it on the `__test__` object (around line 564).
- [ ] **Step 5.11: Update `SubagentParams.interactive` description** — In `pi-extension/subagents/launch-spec.ts`, replace the `interactive` field description text starting `"Vestigial compat field. Accepted for legacy callers..."` with the upstream description verbatim from `.pi/git/github.com/HazAT/pi-interactive-subagents/pi-extension/subagents/index.ts` line 116, namely `"Mark the subagent as interactive (long-running, user drives the conversation in its own pane). When true, the main session is not woken by status transitions (stalled/recovered) for this subagent. If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit` (agents that auto-exit are autonomous and get stall pings; agents that don't are interactive and stay quiet)."`.
- [ ] **Step 5.12: Update `OrchestrationTaskSchema.interactive` description** — In `pi-extension/orchestration/types.ts`, replace the `interactive` description with text matching the new semantics: `"When true, suppress stall/recovered status steer messages for this orchestration step (the main session is not woken by transitions). Defaults follow the agent frontmatter / auto-exit chain."`.
- [ ] **Step 5.13: Run the new tests** — `node --test test/orchestration/resolve-interactive.test.ts test/orchestration/interactive-compat.test.ts` exits 0.
- [ ] **Step 5.14: Run full unit suite** — `npm test` exits 0.

**Acceptance criteria:**
- `AgentDefaults.interactive?: boolean` is parsed from frontmatter `interactive:` in both `parseAgentDefaultsFromContent` and `parseAgentDefinition`.
  Verify: `grep -n "interactive: parseOptionalBoolean" pi-extension/subagents/launch-spec.ts pi-extension/subagents/index.ts` returns at least one line in each file.
- `ResolvedLaunchSpec.effectiveInteractive: boolean` is computed inside `resolveLaunchSpec`.
  Verify: `grep -n "effectiveInteractive" pi-extension/subagents/launch-spec.ts` shows interface declaration, the `resolveEffectiveInteractive` helper, the `const effectiveInteractive =` assignment, and the field in the returned object.
- `resolveEffectiveInteractive` is exported and resolves all four `(autoExit, interactive)` combinations correctly.
  Verify: run `node --test test/orchestration/resolve-interactive.test.ts` and confirm exit code 0 with at least 8 passing assertions.
- `interactive-compat.test.ts` schema-validation cases still pass and the resolution case asserts `effectiveInteractive` (not `interactive: undefined`).
  Verify: `grep -n "effectiveInteractive" test/orchestration/interactive-compat.test.ts` returns at least one match; `node --test test/orchestration/interactive-compat.test.ts` exits 0.
- `SubagentParams.interactive` description and `OrchestrationTaskSchema.interactive` description both describe the runtime semantics, not "vestigial".
  Verify: `grep -n "Vestigial" pi-extension/subagents/launch-spec.ts pi-extension/orchestration/types.ts` returns zero matches.

**Model recommendation:** standard

### Task 6: Add `RunningSubagent.statusState` / `interactive` / `activityFile` and seed at all launch sites

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Modify: `pi-extension/subagents/backends/headless.ts`
- Modify: `pi-extension/subagents/backends/types.ts`
- Modify: `pi-extension/orchestration/default-deps.ts`

**Steps:**
- [ ] **Step 6.1: Extend `RunningSubagent` shape** — In `pi-extension/subagents/index.ts`, add to the `RunningSubagent` interface (around line 347):
  ```ts
  /** Per-row supervision state. Synthetic blocked virtual rows do NOT carry this. */
  statusState?: SubagentStatusState;
  /** Most recent activity snapshot read by the supervision loop. */
  activity?: SubagentActivityState;
  /** Pi children only — path to the child-written activity-snapshot JSON file. */
  activityFile?: string;
  /** Suppress stall/recovered steer messages when true; resolved per the interactive chain. Defaults to false for synthetic rows. */
  interactive?: boolean;
  ```
- [ ] **Step 6.2: Compute `activityFile` in `launchSubagent` Pi pane path** — In `pi-extension/subagents/index.ts`, inside `launchSubagent` after `const id = …` and before the env-prefix block, add:
  ```ts
  const activityFile = getSubagentActivityFile(spec.artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  ```
  Also add the env vars: `envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);` and `envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);` immediately after the existing `PI_SUBAGENT_SESSION` line. Then assign to the returned `RunningSubagent`: `activityFile`, `interactive: spec.effectiveInteractive`, `statusState: createStatusState({ source: "pi", startTimeMs: startTime })`.
- [ ] **Step 6.3: Seed `RunningSubagent` for the Claude pane path** — In the same `launchSubagent`, the Claude branch (around lines 760-830) constructs a `RunningSubagent` without `activityFile`. Add `interactive: spec.effectiveInteractive` and `statusState: createStatusState({ source: "claude", startTimeMs: startTime })` to that returned object. Do NOT set `activityFile` — Claude children don't write one.
- [ ] **Step 6.4: Seed `RunningSubagent` for the resume path** — In `subagent_resume.execute` in `pi-extension/subagents/index.ts` (around line 2167), the constructed `RunningSubagent` for both Pi and Claude resume needs `interactive: !resumeAutoExit` (matching `resolveResumeLaunchBehavior`) and `statusState: createStatusState({ source: isPiResume ? "pi" : "claude", startTimeMs: startTime })`. Pi resume can also write to an activity file: compute `activityFile = getSubagentActivityFile(artifactDir, id)`, `mkdirSync(dirname(activityFile), { recursive: true })`, set it on `running`, and add `PI_SUBAGENT_ID` + `PI_SUBAGENT_ACTIVITY_FILE` to `resumeEnvParts` (Pi branch only).
- [ ] **Step 6.5: Extend `LaunchedHandle` with `activityFile`** — In `pi-extension/subagents/backends/types.ts`, add `activityFile?: string;` to the `LaunchedHandle` interface. Re-export from `pi-extension/orchestration/types.ts` is automatic because it imports the same type.
- [ ] **Step 6.6: Wire activity env into headless Pi runner** — In `pi-extension/subagents/backends/headless.ts` `runPiHeadless`, just before `childEnv` is built, compute `const activityFile = getSubagentActivityFile(spec.artifactDir, id);` (the `id` already exists at the `makeHeadlessBackend.launch` boundary — pass it through to `runPiHeadless` via a new field on `RunParams`). `mkdirSync(dirname(activityFile), { recursive: true })`. Add to `childEnv`:
  ```ts
  PI_SUBAGENT_ID: id,
  PI_SUBAGENT_ACTIVITY_FILE: activityFile,
  ```
  Update the `LaunchedHandle` returned by `makeHeadlessBackend.launch` to include `activityFile` (Pi branch only).
- [ ] **Step 6.7: Plumb id into `runPiHeadless`** — Add `id: string` to the local `RunParams` type in `headless.ts`. Update the call site in `makeHeadlessBackend.launch` to pass `id`. The Claude branch does not need this; leave `runClaudeHeadless` unchanged.
- [ ] **Step 6.8: Update `registerHeadlessSubagent`** — In `pi-extension/subagents/index.ts`, extend the parameter object with `activityFile?: string`, `interactive?: boolean`, `source?: "pi" | "claude"`. Inside the function body, set `running.activityFile = entry.activityFile`, `running.interactive = entry.interactive ?? false`, `running.statusState = createStatusState({ source: entry.source ?? "pi", startTimeMs: entry.startTime ?? Date.now() })`.
- [ ] **Step 6.9: Plumb activity + interactive through `default-deps.ts`** — In `pi-extension/orchestration/default-deps.ts`, the `launch` function calls `registerHeadlessSubagent` with id/name/task/agent/cli/startTime. Extend the call to also pass `activityFile: handle.activityFile` and `interactive: <resolved>` and `source: <determined from cli>`. Compute `interactive` by re-running `resolveEffectiveInteractive` on the orchestration `task` and the loaded agent defaults — this duplicates the resolution that already happens inside `resolveLaunchSpec` but the resolved value is not currently surfaced on the launch handle, and adding it to the handle would change the `Backend` contract (review-v3-style minor). Compute `source` as `task.cli === "claude" ? "claude" : "pi"`.
- [ ] **Step 6.10: Run typecheck** — `npx tsc --noEmit` exits 0.
- [ ] **Step 6.11: Run unit suite** — `npm test` exits 0.

**Acceptance criteria:**
- `RunningSubagent` interface has `statusState?`, `activity?`, `activityFile?`, `interactive?` declared on it.
  Verify: `grep -nE "statusState\?:|activity\?:|activityFile\?:|interactive\?:" pi-extension/subagents/index.ts | head -10` returns at least 4 matches inside the `RunningSubagent` block (lines 347-380).
- Pi pane launches set `PI_SUBAGENT_ID` and `PI_SUBAGENT_ACTIVITY_FILE` in the env-prefix and assign the same path to `running.activityFile`.
  Verify: `grep -n "PI_SUBAGENT_ID\|PI_SUBAGENT_ACTIVITY_FILE" pi-extension/subagents/index.ts` returns at least 2 lines inside `launchSubagent`'s Pi branch (between lines 832-954).
- Headless Pi launches set the same env vars in `childEnv` and surface `activityFile` on `LaunchedHandle`.
  Verify: `grep -n "PI_SUBAGENT_ID\|PI_SUBAGENT_ACTIVITY_FILE\|activityFile" pi-extension/subagents/backends/headless.ts` returns ≥ 3 matches; open `pi-extension/subagents/backends/types.ts` and confirm `LaunchedHandle.activityFile?: string` is declared.
- `registerHeadlessSubagent` accepts `activityFile`, `interactive`, `source` and seeds the corresponding `RunningSubagent` fields.
  Verify: read `registerHeadlessSubagent` in `pi-extension/subagents/index.ts` and confirm it assigns all four fields (`activityFile`, `interactive`, `statusState` initialized via `createStatusState`).
- Claude pane and Claude headless launches do NOT set `activityFile`.
  Verify: `grep -n "activityFile" pi-extension/subagents/index.ts` shows no assignment inside the `cli === "claude"` `launchSubagent` branch (lines around 813-825); `runClaudeHeadless` in `pi-extension/subagents/backends/headless.ts` does not reference `PI_SUBAGENT_ACTIVITY_FILE`.
- All four launch sites (pane Pi, pane Claude, headless Pi, resume) set `interactive` and `statusState` correctly.
  Verify: read each site and confirm `statusState: createStatusState({ source: …, startTimeMs: startTime })` is present, with `source: "pi"` for Pi paths and `source: "claude"` for Claude paths; `interactive` is set from `spec.effectiveInteractive` (launch) or `!resumeAutoExit` (resume).
- `npm test` and `npx tsc --noEmit` both pass.
  Verify: run both commands and confirm exit code 0.

**Model recommendation:** standard (cross-cuts launch sites and the headless runner)

### Task 7: Implement `observeRunningSubagent` and `startStatusRefresh`

**Files:**
- Modify: `pi-extension/subagents/index.ts`

**Steps:**
- [ ] **Step 7.1: Add the imports** — At the top of `pi-extension/subagents/index.ts`, import from `./activity.ts`: `getSubagentActivityFile`, `readSubagentActivityFile`, `type ActivityReadResult`, `type SubagentActivityState`. Import from `./status.ts`: `type StatusSnapshot`, `type SubagentStatusState`, `advanceStatusState`, `capStatusLines`, `classifyStatus`, `createStatusState`, `forceStatusAfterInterrupt`, `formatStatusAggregate`, `formatTransitionLine`, `observeStatus`, `loadStatusConfig`, `DEFAULT_STATUS_LINE_LIMIT`. Import from `./cmux.ts`: add `sendEscape`, `getMuxBackend`.
- [ ] **Step 7.2: Add `STATUS_INTERVAL_KEY` reload guard** — Right next to `WIDGET_INTERVAL_KEY` (around line 127), add `const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");`. Inside the existing reload block (lines 130-139), add the same `if (prevStatusInterval) clearInterval(prevStatusInterval); …` cleanup pattern.
- [ ] **Step 7.3: Load `statusConfig` once at module top** — After the `POLL_ABORT_KEY` block, add `let statusConfig = loadStatusConfig();` (mutable binding so the `__test__.setStatusConfig` setter in Step 7.9 can reassign it). Wrap the call in a try/catch that falls back to `{ enabled: true, lineLimit: DEFAULT_STATUS_LINE_LIMIT }` if the example file is missing — the local fork is the only consumer, and a missing config should not break extension load. (Alternative: the example file is created in Task 2 so this should never fail; document the fallback as defensive.)
- [ ] **Step 7.4: Add `activityLabel` helper** — Inside `pi-extension/subagents/index.ts`, define:
  ```ts
  function activityLabel(activity: SubagentActivityState): string | undefined {
    if (activity.phase !== "active") return undefined;
    if (activity.activeScope === "tool") return activity.toolName ?? "tool";
    if (activity.activeScope === "provider") return "provider";
    if (activity.activeScope === "streaming") return "streaming";
    return activity.activeScope;
  }
  ```
- [ ] **Step 7.5: Implement `observeRunningSubagent`** — Add (verbatim from upstream lines 667-700, adapted to the local `RunningSubagent` shape):
  ```ts
  export function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
    if (!running.statusState) return;
    if (running.blocked) return; // synthetic blocked virtual row; never read activity
    if (running.cli === "claude") return; // claude has no activity file

    const file = running.activityFile;
    const read: ActivityReadResult = file
      ? readSubagentActivityFile(file, running.id)
      : { ok: false, reason: "missing" };

    if (read.ok) {
      running.activity = read.activity;
      running.statusState = observeStatus(running.statusState, {
        snapshot: "present",
        updatedAt: read.activity.updatedAt,
        sequence: read.activity.sequence,
        phase: read.activity.phase,
        active: read.activity.phase === "active",
        activeScope: read.activity.activeScope,
        activeSince: read.activity.activeSince,
        waitingSince: read.activity.waitingSince,
        latestEvent: read.activity.latestEvent,
        activityLabel: activityLabel(read.activity),
      }, observedAt);
      return;
    }

    running.statusState = observeStatus(running.statusState, {
      snapshot: read.reason,
      snapshotError: read.error,
    }, observedAt);
  }
  ```
- [ ] **Step 7.6: Implement `startStatusRefresh`** — Add (verbatim from upstream lines 787-838):
  ```ts
  let statusInterval: ReturnType<typeof setInterval> | null = null;

  function startStatusRefresh(pi: ExtensionAPI) {
    if (!statusConfig.enabled || statusInterval) return;

    statusInterval = setInterval(() => {
      if (runningSubagents.size === 0) {
        if (statusInterval) {
          clearInterval(statusInterval);
          statusInterval = null;
          (globalThis as any)[STATUS_INTERVAL_KEY] = null;
        }
        return;
      }

      const transitionLines: string[] = [];
      const now = Date.now();
      let shouldRefreshWidget = false;

      for (const running of runningSubagents.values()) {
        if (running.blocked) continue; // synthetic — skip entirely
        if (!running.statusState) continue;

        observeRunningSubagent(running, now);
        const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
        if (nextState.currentKind !== running.statusState.currentKind) {
          shouldRefreshWidget = true;
        }
        running.statusState = nextState;

        if (transition && !running.interactive) {
          transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
        }
      }

      if (shouldRefreshWidget) updateWidget();

      if (transitionLines.length > 0) {
        const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
        pi.sendMessage(
          {
            customType: "subagent_status",
            content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
            display: true,
            details: { lines: capped.visibleLines, overflow: capped.overflow },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      }
    }, 1000);
    statusInterval.unref?.();
    (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
  }
  ```
- [ ] **Step 7.7: Start the supervision interval at every launch site** — In each call site that calls `startWidgetRefresh()` (around lines 408, 952, 1676, 1812, 2179), add `startStatusRefresh(pi);` immediately after — except `startWidgetRefresh` is called inside `registerHeadlessSubagent` and the orchestration emitter, where `pi` is not in scope. For those sites, save the `pi` handle to a module-scope `let piForStatus: ExtensionAPI | null = null` (similar to `piForRegistry`) inside `subagentsExtension` and call `startStatusRefresh(piForStatus)` from the helper sites. Reuse the existing `piForRegistry` instead — it is bound to the same `pi` handle.
- [ ] **Step 7.8: Clean up the status interval on `session_shutdown`** — Inside `pi.on("session_shutdown", …)` (around line 1599), add the same clearInterval pattern for `statusInterval` that exists for `widgetInterval`.
- [ ] **Step 7.9: Surface `__test__` helpers** — Add `observeRunningSubagent`, `startStatusRefresh`, a `statusConfig` getter (`get statusConfig() { return statusConfig; }`), `activityLabel` to the existing `__test__` export object (around line 554). Include `setStatusConfig(value)` setter that reassigns the module-level binding (`statusConfig = value;`) so tests can override.
- [ ] **Step 7.10: Run typecheck and full test suite** — `npx tsc --noEmit && npm test` exits 0. Existing `widget-pane-uniform.test.ts` and `widget-headless.test.ts` will need to be updated in Task 8.

**Acceptance criteria:**
- `observeRunningSubagent` is exported and skips synthetic blocked rows (`running.blocked` truthy) and Claude children.
  Verify: read the function body in `pi-extension/subagents/index.ts` and confirm both early returns are present (`if (running.blocked) return;` and `if (running.cli === "claude") return;`).
- `startStatusRefresh` runs at most one interval and gates on `statusConfig.enabled === true`.
  Verify: read the function in `pi-extension/subagents/index.ts` and confirm the `if (!statusConfig.enabled || statusInterval) return;` early exit.
- The supervision loop emits a `subagent_status` steer message via `pi.sendMessage` only for non-`interactive` children with non-null `transition`.
  Verify: read the loop body and confirm `if (transition && !running.interactive) transitionLines.push(...)` is the only push site, and the steer is built from `transitionLines` only.
- The interval is cleared on `session_shutdown` and on module reload via `STATUS_INTERVAL_KEY`.
  Verify: `grep -n "STATUS_INTERVAL_KEY" pi-extension/subagents/index.ts` returns at least 3 matches: one declaration, one reload-cleanup, one session_shutdown cleanup.
- `npm test` and `npx tsc --noEmit` both pass at this checkpoint.
  Verify: run both commands and confirm exit code 0.

**Model recommendation:** standard

### Task 8: Update widget rendering for `blocked > status > fallback` precedence

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Modify: `test/orchestration/widget-pane-uniform.test.ts`
- Modify: `test/orchestration/widget-headless.test.ts`
- Test: `test/orchestration/widget-right-label.test.ts` (Create)

**Steps:**
- [ ] **Step 8.1: Add `formatWidgetRightLabel`** — In `pi-extension/subagents/index.ts`, add the function (verbatim from upstream lines 415-432):
  ```ts
  function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
    if (snapshot.kind === "starting") return " starting… ";
    if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
    if (snapshot.kind === "active") {
      const label = snapshot.activityLabel ?? snapshot.activeScope;
      const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
      return label ? ` active · ${label}${duration} ` : " active ";
    }
    if (snapshot.kind === "waiting") {
      const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
      const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
      return ` waiting${duration}${detail} `;
    }
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
    return ` stalled${detail}${duration} `;
  }
  ```
- [ ] **Step 8.2: Update `renderSubagentWidgetLines`** — Replace the per-row right-label switch (around lines 510-518) with:
  ```ts
  let right: string;
  if (agent.blocked) {
    right = " blocked — awaiting parent ";
  } else if (statusConfig.enabled && agent.statusState) {
    const snapshot = classifyStatus(agent.statusState, Date.now());
    right = formatWidgetRightLabel(snapshot);
  } else if (agent.cli === "claude") {
    right = " running… ";
  } else {
    right = " starting… ";
  }
  ```
  This drops the `agent.usage` branch from the right-label slot — usage continues to flow through transcript / `subagent_result` paths but no longer renders here.
- [ ] **Step 8.3: Expose `formatWidgetRightLabel` via `__test__`** — Add it to the `__test__` export object so the new widget tests can assert formatting.
- [ ] **Step 8.4: Update `widget-pane-uniform.test.ts`** — The current test asserts that pane rows with usage render the usage stats string. The new contract: pane rows with `statusState` set render the status label; pane rows without status render `running…/starting…`. Update each fixture to add `statusState: createStatusState({ source: "pi", startTimeMs: ... })` (or `source: "claude"` for the claude row), and replace the usage-stats assertions with assertions on the right-label substring (e.g. `claudeRow.includes("running…")` for the Claude row, or `panePiRow.includes("starting…")` for a fresh Pi row whose status is still `starting`). For the row with usage, drop the usage-stats assertion entirely — usage is no longer in the right-label.
- [ ] **Step 8.5: Update `widget-headless.test.ts` similarly** — Same pattern. Replace usage-stats assertions with status-label assertions. Headless rows still get `usage` populated by the runner, but the widget no longer renders usage in the right-label slot — drop those assertions.
- [ ] **Step 8.6: Write `widget-right-label.test.ts`** — In `test/orchestration/widget-right-label.test.ts`, import `__test__` from `pi-extension/subagents/index.ts`. Cover (always with `Date.now` stubbed):
  1. Synthetic blocked row → right label is exactly `" blocked — awaiting parent "`.
  2. Pi row with active status (`observeStatus` fed a `present` observation) renders `" active · …"`.
  3. Claude row (statusState `source: "claude"`) renders `" running …s "`.
  4. With `statusConfig.enabled === false` (use `__test__.setStatusConfig({ enabled: false, lineLimit: 4 })`) a Pi row falls back to `" starting… "`; a Claude row falls back to `" running… "`.
- [ ] **Step 8.7: Run the updated and new widget tests** — `node --test test/orchestration/widget-pane-uniform.test.ts test/orchestration/widget-headless.test.ts test/orchestration/widget-right-label.test.ts` exits 0.
- [ ] **Step 8.8: Run full unit suite** — `npm test` exits 0.

**Acceptance criteria:**
- Widget right-label precedence is `blocked > (status, when enabled) > Claude fallback > Pi fallback`.
  Verify: read `renderSubagentWidgetLines` in `pi-extension/subagents/index.ts` and confirm the four-branch `if/else` order matches: `blocked` → `statusConfig.enabled && agent.statusState` → `cli === "claude"` → default. Verify the live `usage` branch is gone.
- `formatWidgetRightLabel` is added and produces the upstream-shaped strings for `starting/running/active/waiting/stalled`.
  Verify: read the function body and confirm all five `kind` branches are present and produce the upstream substrings (`" starting… "`, `" active · …"`, `" waiting…"`, `" stalled…"`, `" running …s "`).
- Synthetic blocked virtual rows do NOT crash the renderer when `statusState` is missing.
  Verify: read the new `if (agent.blocked)` early branch and confirm it returns the blocked string before any access to `agent.statusState`.
- The new and updated widget tests pass.
  Verify: `node --test test/orchestration/widget-pane-uniform.test.ts test/orchestration/widget-headless.test.ts test/orchestration/widget-right-label.test.ts` exits 0 with at least 3 + 1 + 4 = 8 passing cases.

**Model recommendation:** standard

### Task 9: Implement `subagent_interrupt` tool

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Modify: `pi-extension/subagents/launch-spec.ts`
- Test: `test/orchestration/subagent-interrupt.test.ts` (Create)

**Steps:**
- [ ] **Step 9.1: Write the failing tests** — In `test/orchestration/subagent-interrupt.test.ts`, mirror the upstream test cases at `.pi/git/github.com/HazAT/pi-interactive-subagents/test/test.ts:1386-1660` (subagent interruption block). Use `__test__.runningSubagents` to seed entries. Cover:
  1. `resolveInterruptTarget({ id })` returns the running entry; `{ id: missing }` returns an error.
  2. `resolveInterruptTarget({ name })` returns the entry on a unique name; ambiguous name returns an error containing the matched ids.
  3. `resolveInterruptTarget({})` returns an error.
  4. `requestSubagentInterrupt(running, escapeKey)` returns `{ ok: true }` when escape doesn't throw; returns `{ error: /Failed to send Escape/ }` when it does, and does not abort the running's `abortController`.
  5. `handleSubagentInterrupt({ name }, escapeKey)` succeeds for a Pi pane child: sets `statusState.activityLabel = "interrupted"`, emits `details.status === "interrupt_requested"`, leaves the entry in the map.
  6. `handleSubagentInterrupt` rejects Claude (`cli === "claude"`) before delivery — `delivered === false`, error matches `/currently supported only for pane-Pi subagents/`.
  7. `handleSubagentInterrupt` rejects headless (`backend === "headless"`) before delivery — same shape as Claude rejection but the wording reflects pane-only support.
  8. Failed Escape leaves the previous `statusState.currentKind` untouched (`active` stays `active`).
  9. Repeated calls to `handleSubagentInterrupt` send Escape every time — the entry is not removed.
  10. Orchestration-owned slot acceptance: when `__test__.getRegistry().lookupOwner(sessionFile)` returns a non-null owner, `handleSubagentInterrupt` still returns `interrupt_requested` and does NOT call `registry.onTaskTerminal` or `registry.onTaskBlocked`. Test by spying on the registry methods.
- [ ] **Step 9.2: Run failing tests** — `node --test test/orchestration/subagent-interrupt.test.ts` must fail.
- [ ] **Step 9.3: Add `subagent_interrupt` to `SPAWNING_TOOLS`** — In `pi-extension/subagents/launch-spec.ts`, add `"subagent_interrupt"` to the `SPAWNING_TOOLS` set (around line 160). This wires `spawning: false` to deny `subagent_interrupt` in line with the upstream contract.
- [ ] **Step 9.4: Implement `resolveInterruptTarget`** — Inside `pi-extension/subagents/index.ts`, add (verbatim from upstream 702-724):
  ```ts
  function resolveInterruptTarget(params: { id?: string; name?: string }):
    | { running: RunningSubagent }
    | { error: string } {
    const requestedId = params.id?.trim();
    if (requestedId) {
      const running = runningSubagents.get(requestedId);
      return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
    }
    const requestedName = params.name?.trim();
    if (!requestedName) return { error: "Provide a running subagent id or exact display name." };
    const matches = Array.from(runningSubagents.values()).filter((r) => r.name === requestedName);
    if (matches.length === 1) return { running: matches[0] };
    if (matches.length === 0) return { error: `No running subagent named "${requestedName}".` };
    const candidates = matches.map((r) => `${r.name} [${r.id}]`).join(", ");
    return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
  }
  ```
- [ ] **Step 9.5: Implement `requestSubagentInterrupt`** — Add (verbatim from upstream 726-741):
  ```ts
  function requestSubagentInterrupt(
    running: RunningSubagent,
    sendEscapeKey: (surface: string) => void = sendEscape,
  ): { ok: true } | { error: string } {
    try {
      sendEscapeKey(running.surface!);
      return { ok: true };
    } catch (error: any) {
      const backend = getMuxBackend() ?? "unknown";
      return { error: `Failed to send Escape to subagent "${running.name}" via ${backend}: ${error?.message ?? String(error)}` };
    }
  }
  ```
- [ ] **Step 9.6: Implement `handleSubagentInterrupt`** — Add (adapted from upstream 743-785, plus the local headless rejection branch):
  ```ts
  function handleSubagentInterrupt(
    params: { id?: string; name?: string },
    sendEscapeKey: (surface: string) => void = sendEscape,
  ) {
    const resolved = resolveInterruptTarget(params);
    if ("error" in resolved) {
      return { content: [{ type: "text" as const, text: resolved.error }], details: { error: resolved.error } };
    }
    const running = resolved.running;

    if (running.cli === "claude") {
      const text = "Turn-only Escape interrupt is currently supported only for pane-Pi subagents. Claude-backed semantics have not been verified yet.";
      return { content: [{ type: "text" as const, text }], details: { error: "claude interrupt unsupported", id: running.id, name: running.name } };
    }
    if (running.backend !== "pane") {
      const text = "Turn-only Escape interrupt is currently supported only for pane-Pi subagents. Headless subagents have no surface to receive an Escape.";
      return { content: [{ type: "text" as const, text }], details: { error: "headless interrupt unsupported", id: running.id, name: running.name } };
    }

    const now = Date.now();
    observeRunningSubagent(running, now);

    const interruption = requestSubagentInterrupt(running, sendEscapeKey);
    if ("error" in interruption) {
      return { content: [{ type: "text" as const, text: interruption.error }], details: { error: interruption.error, id: running.id, name: running.name } };
    }

    if (running.statusState) {
      running.statusState = forceStatusAfterInterrupt(running.statusState, now);
    }
    updateWidget();

    return {
      content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` }],
      details: { id: running.id, name: running.name, status: "interrupt_requested" },
    };
  }
  ```
- [ ] **Step 9.7: Register the `subagent_interrupt` tool** — Inside `subagentsExtension`, immediately after the `subagent` tool registration, add:
  ```ts
  if (shouldRegister("subagent_interrupt"))
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description: "Send Escape to the active turn of a currently running pane-Pi subagent. The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement and does not emit a subagent_result solely because of this request.",
      promptSnippet: "Send Escape to the active turn of a currently running pane-Pi subagent. The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement and does not emit a subagent_result solely because of this request.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
      }),
      async execute(_toolCallId: string, params: { id?: string; name?: string }) {
        return handleSubagentInterrupt(params);
      },
      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(theme.fg("accent", "▸") + " " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — interrupt turn"), 0, 0);
      },
      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(theme.fg("accent", "▸") + " " + theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) + theme.fg("dim", " — interrupt requested"), 0, 0);
        }
        const first = result.content?.[0];
        const text = first && first.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    } as any);
  ```
- [ ] **Step 9.8: Expose helpers via `__test__`** — Add `resolveInterruptTarget`, `requestSubagentInterrupt`, `handleSubagentInterrupt` to the `__test__` export object.
- [ ] **Step 9.9: Run the new tests** — `node --test test/orchestration/subagent-interrupt.test.ts` exits 0.
- [ ] **Step 9.10: Run full unit suite** — `npm test` exits 0.

**Acceptance criteria:**
- `subagent_interrupt` is registered in `subagentsExtension` and is denied by `shouldRegister` when `spawning: false`.
  Verify: `grep -n "subagent_interrupt" pi-extension/subagents/index.ts` shows the tool registration; `grep -n "subagent_interrupt" pi-extension/subagents/launch-spec.ts` shows it inside `SPAWNING_TOOLS`.
- The handler resolves targets by id then name, with ambiguity errors when multiple entries share a name.
  Verify: read `resolveInterruptTarget` in `pi-extension/subagents/index.ts` and confirm the `id ? lookup : name ? matches.length switch : error` flow matches upstream verbatim.
- Claude and headless targets are rejected with structured errors before Escape is delivered.
  Verify: read `handleSubagentInterrupt` and confirm `if (running.cli === "claude")` and `if (running.backend !== "pane")` early-return branches both fire before the `requestSubagentInterrupt` call. Run the test cases for each branch and confirm `delivered === false` in the recorded assertions.
- A successful interrupt fires `forceStatusAfterInterrupt` after `observeRunningSubagent` and returns `details.status === "interrupt_requested"`.
  Verify: read the success path and confirm `observeRunningSubagent(running, now)` is called *before* `requestSubagentInterrupt`, and `forceStatusAfterInterrupt(running.statusState, now)` is called *after* a successful Escape.
- A failed Escape returns a structured error and does NOT mutate `statusState`.
  Verify: run the "leaves status unchanged when Escape delivery fails" test case in `test/orchestration/subagent-interrupt.test.ts` and confirm the assertion that `classifyStatus(...).kind === "active"` post-interrupt holds.
- Orchestration-owned slot interrupts succeed locally without firing registry transitions.
  Verify: the orchestration-owned test case spies on `registry.onTaskTerminal` and `registry.onTaskBlocked` and asserts neither is called during a `handleSubagentInterrupt` execution.
- Full unit suite passes.
  Verify: `npm test` exits 0.

**Model recommendation:** standard (handler logic with multiple branches and registry verification)

### Task 10: Verification checkpoint for `interactive-compat.test.ts` rewrite

This is a verification-only checkpoint that confirms the `interactive-compat.test.ts` rewrite performed inside Task 5 (Steps 5.2 and 5.13) is complete and passing. It does not modify the file again. It exists separately so that downstream tasks (and the final `npm run build` task) can depend on a single checkpoint that signals "interactive resolution surface is locked in".

**Files:**
- Verify (no modification): `test/orchestration/interactive-compat.test.ts`

**Steps:**
- [ ] **Step 10.1: Confirm schema-validation tests are still present** — Read the top of the file and confirm the original `it(...)` blocks for schema acceptance of `interactive: true`/`interactive: false` and rejection of `interactive: "yes"` are still present.
- [ ] **Step 10.2: Confirm the resolution test was rewritten in Task 5** — Read the file and confirm it asserts `effectiveInteractive` rather than asserting `interactive` is ignored.
- [ ] **Step 10.3: Run the test** — `node --test test/orchestration/interactive-compat.test.ts` exits 0.

**Acceptance criteria:**
- The schema-validation tests at the top of the file are unchanged from the pre-plan baseline.
  Verify: `head -25 test/orchestration/interactive-compat.test.ts` shows the three `it(...)` schema-check blocks accepting `interactive: true`, accepting `interactive: false`, and rejecting `interactive: "yes"`.
- The resolution-chain test asserts `effectiveInteractive` is surfaced on the resolved spec.
  Verify: `grep -n "effectiveInteractive" test/orchestration/interactive-compat.test.ts` returns at least 2 matches; `grep -n "ignores" test/orchestration/interactive-compat.test.ts` returns zero matches.
- Test passes.
  Verify: `node --test test/orchestration/interactive-compat.test.ts` exits 0.

**Model recommendation:** cheap

### Task 11: Integration tests for status supervision

**Files:**
- Create: `test/integration/pane-pi-status-supervision.test.ts`
- Create: `test/integration/headless-pi-status-supervision.test.ts`
- Create: `test/integration/orchestration-blocked-supervision.test.ts`

**Steps:**
- [ ] **Step 11.1: Read the existing pane-pi smoke test** — Open `test/integration/pi-pane-smoke.test.ts` to learn the harness pattern: it uses `withTestSession` (or similar) to spawn a real pi child via the harness, then asserts on session-file contents. The new tests will reuse the same harness shape.
- [ ] **Step 11.2: Write `pane-pi-status-supervision.test.ts`** — Skip when `!isMuxAvailable()`. Use the harness to launch a pane-pi subagent with a `pi` agent that prompts the model to wait. Use a `Date.now` injection or `SNAPSHOT_STALLED_AFTER_MS` test override to compress the 60s stall threshold to 2s for the test. Drive the supervision loop by calling `__test__.startStatusRefresh(stubPi)` directly (after seeding the running entry) rather than waiting on real time — but observe a real activity file written by the child. Assert: (a) at least one `stubPi.sendMessage` call carried `customType: "subagent_status"`; (b) the running entry's `statusState.currentKind` ended at `"stalled"`; (c) widget `right` strings progressed through `starting → ... → stalled` (sample at 3 timepoints).
- [ ] **Step 11.3: Write `headless-pi-status-supervision.test.ts`** — Same shape but using `makeHeadlessBackend(ctx).launch(...)` directly. Confirm the child writes to the activity file at `getSubagentActivityFile(spec.artifactDir, id)` and that the parent's `RunningSubagent.activityFile` matches. Confirm the supervision loop reads from that file and progresses `currentKind`.
- [ ] **Step 11.4: Write `orchestration-blocked-supervision.test.ts`** — Spawn a coordinator that delegates to a child via `subagent_run_serial`; the child calls `caller_ping`. After the BLOCKED notification fires, run `__test__.startStatusRefresh(stubPi)` once and assert it does NOT throw on the synthetic blocked virtual row (`virt-...` id, no `statusState`). Confirm `runningSubagents` still contains both the virtual row and any other live children, and that no `subagent_status` message is emitted for the virtual row.
- [ ] **Step 11.5: Run the integration tests** — `node --test test/integration/pane-pi-status-supervision.test.ts test/integration/headless-pi-status-supervision.test.ts test/integration/orchestration-blocked-supervision.test.ts` exits 0 (skipping when mux unavailable is acceptable on CI runners that lack pi/cmux).

**Acceptance criteria:**
- Three integration test files exist and exercise the pane, headless, and orchestration paths end-to-end.
  Verify: `ls test/integration/pane-pi-status-supervision.test.ts test/integration/headless-pi-status-supervision.test.ts test/integration/orchestration-blocked-supervision.test.ts` returns all three files.
- Each test asserts `subagent_status` steer message emission for stall transitions, OR an explicit assertion that none was emitted (orchestration-blocked case).
  Verify: read each test and confirm at least one `assert.match` against `customType: "subagent_status"` in the stalled cases, and at least one `assert.equal(noSubagentStatusEmitted, true)` in the orchestration-blocked case.
- Tests cleanly skip when mux/pi tools are unavailable on the CI runner.
  Verify: read each test and confirm the harness gates with `isMuxAvailable()` (or equivalent), and emits a `t.skip(...)` rather than a hard failure when the runtime is missing.
- Running the integration suite per `.pi/skills/run-integration-tests/SKILL.md` shows the new tests passing alongside the existing pane-pi and headless-pi smoke flows.
  Verify: run `npm run test:integration` (with mux available) and confirm exit code 0 with the new tests counted in the summary.

**Model recommendation:** capable (integration harness coordination + activity timing)

### Task 12: Update upstream sync ledger

**Files:**
- Modify: `docs/analysis/upstream-sync-ledger-pi.md`

**Steps:**
- [ ] **Step 12.1: Move ledger entries to PROCESSED** — In `docs/analysis/upstream-sync-ledger-pi.md`, change the status column for `9f10962`, `269b485`, and `b4b0287` from `TO_BE_PROCESSED` to `PROCESSED`. Update the rationale text for each to point to this plan's path and the integration test files (`docs/plans/2026-05-05-2026-05-05-subagent-status-supervision-and-interrupt.md`, `test/integration/pane-pi-status-supervision.test.ts`, etc).
- [ ] **Step 12.2: Add a covering entry note** — In the rationale column for the trio, mention: status supervision + activity recording ported with local divergences in (i) headless activity wiring, (ii) blocked-row precedence, (iii) `subagent_interrupt` headless rejection branch.
- [ ] **Step 12.3: Run final `npm run build`** — Run `npm run build` and confirm exit code 0. This runs ESLint and `build:plugin` in addition to `tsc --noEmit`, covering the spec acceptance criterion that `npm run build` must pass — neither `npx tsc --noEmit` nor `npm test` alone covers ESLint or plugin build.
- [ ] **Step 12.4: Run final `npm test`** — Run `npm test` and confirm exit code 0. This is the full unit-test suite gate prior to integration.
- [ ] **Step 12.5: Run final integration suite** — Run `npm run test:integration` (with mux available) and confirm exit code 0, including the three new integration tests added in Task 11.

**Acceptance criteria:**
- All three commits show `PROCESSED` in the status column.
  Verify: `grep -nE "(9f10962|269b485|b4b0287).*PROCESSED" docs/analysis/upstream-sync-ledger-pi.md` returns exactly 3 lines.
- The rationale references this plan and at least one new test file.
  Verify: `grep -n "2026-05-05-subagent-status-supervision-and-interrupt" docs/analysis/upstream-sync-ledger-pi.md` returns at least one match.
- `npm run build` passes end-to-end (TypeScript + ESLint + plugin build).
  Verify: run `npm run build` and confirm exit code 0 with no ESLint errors and no `build:plugin` failures in stdout.
- `npm test` passes the full unit suite.
  Verify: run `npm test` and confirm exit code 0.
- Integration suite passes with the new tests included.
  Verify: run `npm run test:integration` and confirm exit code 0; grep the output for `pane-pi-status-supervision`, `headless-pi-status-supervision`, `orchestration-blocked-supervision` test names and confirm each appears as passed (or skipped with `t.skip` reason if mux unavailable).

**Model recommendation:** cheap

## Dependencies

- Task 2 depends on: Task 1 (no — they're independent file ports, but the test fixtures share helpers that Task 1 introduces).
- Task 3 depends on: nothing.
- Task 4 depends on: Task 1 (subagent-done.ts imports `createSubagentActivityRecorder`).
- Task 5 depends on: nothing structurally — the `interactive` field plumbing is independent of the status code, but it must complete before Task 6 because Task 6 reads `spec.effectiveInteractive`.
- Task 6 depends on: Task 1, Task 2, Task 5 (consumes `createStatusState`, `getSubagentActivityFile`, `effectiveInteractive`).
- Task 7 depends on: Task 1, Task 2, Task 3, Task 6 (the supervision loop reads from `RunningSubagent.activityFile` / `statusState`, and Step 7.1 imports `sendEscape` from Task 3).
- Task 8 depends on: Task 2, Task 6, Task 7 (widget consumes `classifyStatus`, `RunningSubagent.statusState`, the module-level `statusConfig` introduced in Task 7, and `__test__.setStatusConfig` from Task 7).
- Task 9 depends on: Task 2, Task 3, Task 6, Task 7 (interrupt uses `forceStatusAfterInterrupt`, `sendEscape`, `observeRunningSubagent`).
- Task 10 depends on: Task 5.
- Task 11 depends on: Task 1, Task 2, Task 4, Task 6, Task 7, Task 8 (full pipeline).
- Task 12 depends on: Task 11 (only after full integration coverage is in place).

Recommended execution order:
1. Task 1 (activity port)
2. Task 2 (status port)
3. Task 3 (sendEscape)
4. Task 4 (child recorder wiring)
5. Task 5 (interactive resolution)
6. Task 6 (RunningSubagent extensions + headless env)
7. Task 7 (supervision loop)
8. Task 8 (widget rewrite)
9. Task 9 (interrupt tool)
10. Task 10 (interactive-compat test rewrite)
11. Task 11 (integration tests)
12. Task 12 (ledger update)

## Risk Assessment

- **Risk: Existing widget tests assume usage renders in the right-label.** Two test files (`widget-pane-uniform.test.ts`, `widget-headless.test.ts`) explicitly assert tokens like `↑12k` and `2 turns` in the rendered right side. These assertions must be updated in Task 8 — adding new tests is not enough. Mitigation: Task 8 explicitly modifies both files and adds a new precedence test.
- **Risk: `loadStatusConfig` throwing at module-load time on a fresh checkout where neither `config.json` nor `config.json.example` exists.** The local fork's package layout differs from upstream — `PACKAGE_ROOT` is computed via `import.meta.url` and may resolve under `node_modules` when pi loads the extension via npm linkage. Mitigation: Task 7 step 7.3 wraps the `loadStatusConfig()` call in a try/catch with a defensive default. The example file is created at the repo root in Task 2.
- **Risk: Headless backend `id` is generated inside `runPiHeadless` rather than at the `launch` boundary.** Currently the `runPiHeadless` `RunParams` type does not include `id` — it is generated at the `Backend.launch` callsite (`makeHeadlessBackend.launch`). Plumbing `id` down requires extending `RunParams`. Task 6 step 7 covers this, but the change cuts across the test-only `makeHeadlessBackendWithRunner` path too. Mitigation: keep `RunParams` extension backward-compatible by making `id` required on `RunParams` and having `makeHeadlessBackendWithRunner.launch` synthesize one for tests.
- **Risk: Reload (`/reload`) must clear both `widgetInterval` and `statusInterval`.** Failure to clear leaks two intervals per reload. Mitigation: Task 7 step 7.2 mirrors the existing `WIDGET_INTERVAL_KEY` cleanup pattern.
- **Risk: `subagent_resume` for Pi sets `interactive: !autoExit`, which differs from the resume current local default.** The local resume helper already returns `{ autoExit, interactive: !autoExit }` but the field is currently unconsumed. Wiring it to `RunningSubagent.interactive` flips the behavior for `subagent_resume({ autoExit: true })` from "no stall pings" (status feature absent) to "no stall pings (because interactive: false → enabled stall pings → autoExit subagent shut down quickly anyway)". Net behavior is consistent with the auto-exit semantics. Mitigation: Task 6 step 6.4 explicitly sets `interactive: !resumeAutoExit` for resume, and the upstream parity check confirms behavior alignment.
- **Risk: Synthetic blocked virtual rows (`virt-...` id) participate in the supervision loop unintentionally.** The virtual row has no `statusState` and no `activityFile`; reading its activity would be a no-op but `advanceStatusState` would crash on `null`. Mitigation: Task 7 step 7.6 skips entries with `running.blocked` truthy AND `running.statusState == null`. Documented in `observeRunningSubagent` and `startStatusRefresh`.
- **Risk: Orchestration-owned interrupts fire `forceStatusAfterInterrupt` and the child eventually completes — does the registry see the completion?** Yes — the watcher (`watchSubagent`) keeps polling for `pollForExit`, and on terminal completion the existing `subagent` execute path emits `subagent_result` and calls `registry.onTaskTerminal` via `default-deps`. The interrupt only changes the visible status; it doesn't tear down the watcher. Mitigation: the interrupt tool's pre-condition note documents this. The integration test in Task 11 (orchestration-blocked-supervision) doesn't cover this exact flow but the registry-spy test in Task 9 confirms no transition fires *as a result of the interrupt itself*.
- **Risk: Headless Claude paths must not break.** The Claude headless runner (`runClaudeHeadless`) does not change; only the Pi headless runner gets new env vars. Mitigation: Task 6 step 6.6 explicitly modifies only `runPiHeadless`. Task 11's integration tests cover the Pi paths; Claude headless coverage stays as-is.
- **Risk: Adding `subagent_interrupt` to `SPAWNING_TOOLS` has tool-deny side effects on existing agents.** An agent declared with `spawning: false` already denies `subagent`/`subagent_run_*`/`subagent_resume`; adding `subagent_interrupt` to that set is the upstream-correct behavior because an agent forbidden from spawning shouldn't be interrupting either. Mitigation: explicit tests for `resolveDenyTools({ spawning: false })` already exist (run in Task 9 after the change) and need updating to include the new entry.

## Test Command

```bash
npm test
```
