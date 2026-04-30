# Mux-Free Execution: Headless Backend Design

**Date:** 2026-04-20
**Status:** Draft — awaiting review
**Supersedes (partially):** reopens a scope decision in `2026-04-20-pi-interactive-subagent-fork-design.md` by adding a second execution backend that does not require a multiplexer.

## Summary

Add a headless (stdio-piped, stream-json) execution backend to `pi-interactive-subagent` alongside the existing pane-based backend, so that `subagent` / `subagent_serial` / `subagent_parallel` dispatches work in environments without a supported multiplexer (CI, headless SSH, IDE-embedded shells). Codify the split behind a `Backend` interface with two implementations (`pane`, `headless`) selected at runtime by mux detection plus a `PI_SUBAGENT_MODE` env override. In the same effort, close two adjacent gaps relative to the old `pi-subagent` extension: (1) populate `usage` and `messages[]` on `OrchestrationResult` from the headless path's stream-json parse (items #6/#7 identified during fork-state review); (2) fix a tool-restriction security regression in the Claude path via a small upstream-portable patch.

This work positions us to retire `pi-subagent` once skills migration, fallback-replacement, and soak gates are met — that retirement itself is explicitly out of scope here.

## Motivation

The current fork (per `2026-04-20-pi-interactive-subagent-fork-design.md`) requires an active multiplexer — cmux, tmux, zellij, or wezterm — to dispatch any subagent. If no mux is detected, dispatch fails fast. This is deliberate for interactive mode (pane TTY, observability via the pane itself) but excludes:

- CI pipelines running `subagent_*` from skills like `execute-plan`.
- Headless SSH sessions.
- IDE-embedded terminals that don't run under a supported mux.
- Any automation that wants to use subagents without staging a multiplexer first.

The old `pi-subagent` extension handles these environments natively — it spawns child processes with piped stdio (`stdio: ["ignore", "pipe", "pipe"]`) and parses stream-json output. Retaining `pi-subagent` indefinitely to cover the headless use case preserves working capability but imposes permanent dual-extension maintenance and prevents a clean unification of the tool surface.

The cleaner answer: fold headless dispatch into the fork as a second backend. The orchestration layer already routes through a `LauncherDeps` interface at `pi-extension/orchestration/default-deps.ts`, which is the seam to extend.

Parsing stream-json for the headless path unlocks two wins observed during fork-state review:

- **Item #6 (stream observability):** each parsed event can flow through `onUpdate` to the parent TUI, matching what `pi-subagent` does today. Parent sees progress without owning a pane.
- **Item #7 (usage/cost aggregation):** stream-json events carry `usage` — input/output/cache tokens, cost, turns. Accumulating these on `OrchestrationResult` lets skills aggregate across waves (e.g. total cost of an `execute-plan` run).

Both wins are specific to the headless path in this spec; the pane path's observability enrichment is deferred to a follow-up spec.

## Scope

### In scope

- Introduce a `Backend` interface in `pi-extension/subagents/backends/types.ts` with `launch()` and `watch()` methods.
- Add `pi-extension/subagents/backends/pane.ts` as a thin adapter over existing `launchSubagent` / `watchSubagent` — zero movement of upstream code.
- Add `pi-extension/subagents/backends/headless.ts` — new stream-json-based implementation for both `pi` and `claude` CLIs.
- Add `pi-extension/subagents/backends/select.ts` — backend selection via `PI_SUBAGENT_MODE` env override + mux detection fallback.
- Modify `pi-extension/orchestration/default-deps.ts` to route through `selectBackend()`.
- Extend `OrchestrationResult` with optional `usage?: UsageStats` and `messages?: Message[]` fields, populated by the headless path only in v1.
- Small named-commit patch to `pi-extension/subagents/index.ts`: add `PI_TO_CLAUDE_TOOLS` mapping + `--allowedTools` emission inside `buildClaudeCmdParts`. Affects both backends (fixes the pane security regression as a side effect). Portable to an upstream PR alongside the existing `thinking` patch.
- Phase 0 baseline integration tests for the existing pane path (confirm HazAT's inherited tests pass; promote `claude-sentinel-roundtrip.test.ts` from scaffold to real; add a pi-pane smoke test).
- Tight unit tests for headless-specific deterministic logic (backend selection, abort timing, event transformation, line-buffer boundaries).
- Integration tests covering headless pi + Claude paths, mid-stream tool-use, transcript archival, abort, and ENOENT.

### Out of scope

- **Symmetric observability on the pane backend** — streaming `onUpdate` events and populating `usage` / `messages[]` from the pane path. Deferred to a follow-up spec ("C-scope" during brainstorming).
- **Model fallback (`fallbackModels`)** — stays dropped per the original fork-design spec. Skills own fallback. Retirement of `pi-subagent` removes the only code path providing retryable-error fallback today; skills must absorb the responsibility before retirement.
- **Numeric recursion depth guard** — `spawning: false` frontmatter remains the convention. Not re-adding `PI_SUBAGENT_DEPTH` env counters.
- **Skills migration from the old `subagent { chain / tasks }` tool surface** — tracked in `2026-04-20-pi-interactive-subagent-fork-design.md`; independent of this spec.
- **Retiring `pi-subagent`** — gated on skills migration, fallback story, and soak time. Intentionally planned separately once soak data is available.
- **Real CI enablement for integration tests** — this spec ensures tests exist and pass locally; provisioning API keys + CLIs in GitHub Actions or equivalent is a separate concern.
- **Plumbing the `interactive` schema field** — treated as vestigial (accept in schema, ignore at runtime). Backend selection is the real axis.

## Architecture

### The `Backend` seam

A minimal interface in `pi-extension/subagents/backends/types.ts`:

```ts
export interface Backend {
  launch(task: OrchestrationTask, defaultFocus: boolean, signal?: AbortSignal): Promise<LaunchedHandle>;
  watch(handle: LaunchedHandle, signal?: AbortSignal): Promise<BackendResult>;
}

export interface BackendResult {
  name: string;
  finalMessage: string;
  transcriptPath: string | null;
  exitCode: number;
  elapsedMs: number;
  sessionId?: string;
  error?: string;
  // Populated by headless backend only in v1; pane leaves undefined:
  usage?: UsageStats;
  messages?: Message[];
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}
```

`LaunchedHandle` and `OrchestrationTask` keep existing definitions from `orchestration/types.ts`.

### Selection

`backends/select.ts`:

```ts
export function selectBackend(): "pane" | "headless" {
  const raw = (process.env.PI_SUBAGENT_MODE ?? "auto").toLowerCase();
  if (raw === "pane") return "pane";
  if (raw === "headless") return "headless";
  if (raw !== "auto") warnOnce(`PI_SUBAGENT_MODE="${raw}" invalid; falling back to auto`);
  return detectMux() ? "pane" : "headless";
}
```

`detectMux()` is exposed as a named export from the existing detection logic in `index.ts` / `cmux.ts` — refactor-by-exposing, no new detection code.

### Zero movement of upstream code

The pane backend is a thin re-export adapter (~30 LOC) over the existing `launchSubagent` and `watchSubagent` in `index.ts`. Upstream-vendored code stays where it is; rebase surface stays as it is today (the carried `thinking` patch plus the new `PI_TO_CLAUDE_TOOLS` patch). The headless backend is entirely in our own files.

This is a deliberate retreat from a cleaner "full extraction" layout proposed during brainstorming — the maintenance cost of permanent conflict surfaces on every upstream rebase outweighed the cosmetic segregation benefit.

## Components

### `backends/types.ts` (new)

Defines the `Backend` interface, `BackendResult`, and `UsageStats`. No runtime logic.

### `backends/pane.ts` (new, ~30 LOC)

Thin adapter. Imports `launchSubagent`, `watchSubagent`, and `RunningSubagent` from `../index.ts` (today's direct imports from `default-deps.ts` move here). Wraps them so the `Backend` interface is satisfied. Does not populate `usage` or `messages` — those remain `undefined`, explicitly documented as follow-up-spec territory.

### `backends/headless.ts` (new, ~400–500 LOC)

Responsibilities, in flow order:

1. **Spawn.** Resolve the child command (pi or Claude) using the same helpers the pane backend uses for model / thinking / skills / tools resolution. Spawn with `stdio: ["ignore", "pipe", "pipe"]`, `shell: false`, `env` including `PI_SUBAGENT_NAME` / `PI_SUBAGENT_AGENT` / `PI_CODING_AGENT_DIR` / `PI_DENY_TOOLS` so the child's `subagent-done.ts` extension still gets identity and tool-deny info (even though headless doesn't depend on its sentinel).
2. **Parse.** Per-CLI stream-json parsers:
   - **pi:** consume `message_end` and `tool_result_end` events; append messages; aggregate usage from `msg.usage` on each assistant message (turns, input, output, cacheRead, cacheWrite, cost).
   - **Claude:** consume `assistant` and `result` events; transform `tool_use` blocks to pi-compatible `toolCall` shape; finalize usage from the terminal `result` event.
3. **Stream `onUpdate`.** On each parsed event, call `onUpdate` with a partial result so the parent TUI renders progress. This is the item-#6 observability win.
4. **Transcript archival.**
   - **pi:** session file is already on disk at `${PI_SUBAGENT_SESSION}` — copy to `~/.pi/agent/sessions/<project>/`, same path the pane backend uses.
   - **Claude:** parse `session_id` from the `system/init` event at stream start; reconstruct `~/.claude/projects/<cwd-slug>/<session_id>.jsonl`; copy to `~/.pi/agent/sessions/claude-code/`. If source file is absent at resolution time, retry-poll for up to 2s; if still absent, set `transcriptPath: null` and log a warning — don't fail the task.
5. **Completion.** Resolve on terminal event + process close. Terminal event is the unambiguous signal (Claude `result`, pi's final `message_end` with terminal `stopReason`). Non-zero exit with no terminal event → error result with stderr included.
6. **Abort.** `SIGTERM` → 5s grace → `SIGKILL` (lifted from `pi-subagent/index.ts:440-446`). `signal.aborted` at launch time → synthetic aborted result, no spawn.

No mux detection, no pane lifecycle, no widget registration — those are pane-backend concerns.

### `backends/select.ts` (new, ~30 LOC)

See Architecture above. `PI_SUBAGENT_MODE` resolution + mux detection fallback. Single exported function.

### `orchestration/default-deps.ts` (modified, ours)

Replaces direct `launchSubagent` / `watchSubagent` imports with a `selectBackend()` call at module initialization time. `LauncherDeps.launch` and `LauncherDeps.waitForCompletion` become trivial dispatchers over the chosen `Backend`. Abort plumbing, `handleToRunning` bookkeeping, and session-shutdown forwarding move into each backend's own scope.

### `orchestration/types.ts` (modified, ours)

Extend `OrchestrationResult` with optional `usage?: UsageStats` and `messages?: Message[]`. Optional fields preserve backward compatibility for existing callers that destructure the result.

### `subagents/index.ts` (carried local patch only)

One additional named-commit patch alongside the existing `thinking` patch:

1. Add `effectiveTools?: string` to the `ClaudeCmdInputs` interface.
2. Pass `effectiveTools` through at the `buildClaudeCmdParts` call site (the caller already resolves `params.tools ?? agentDefs?.tools` — route that value in).
3. Add the constant and the mapping logic inside `buildClaudeCmdParts`:

```ts
// Top of file, shared constant:
const PI_TO_CLAUDE_TOOLS: Record<string, string> = {
  read: "Read", write: "Write", edit: "Edit",
  bash: "Bash", grep: "Grep", find: "Glob", ls: "Glob",
};

// Inside buildClaudeCmdParts, after --effort handling:
if (input.effectiveTools) {
  const claudeTools = new Set<string>();
  for (const tool of input.effectiveTools.split(",").map((t) => t.trim())) {
    const mapped = PI_TO_CLAUDE_TOOLS[tool.toLowerCase()];
    if (mapped) claudeTools.add(mapped);
  }
  if (claudeTools.size > 0) {
    parts.push("--allowedTools", shellEscape([...claudeTools].join(",")));
  }
}
```

This benefits both backends — the pane path also gains Claude tool restriction, closing the security regression identified during fork-state review. Kept in `index.ts` because `buildClaudeCmdParts` is where Claude commands are assembled; splitting into our own files would require forking the command builder itself, which is worse.

Portable to upstream PR when stable.

### Reusable implementation references

Lift into `backends/headless.ts` (adapt; don't copy-paste):

| Source | Purpose |
|---|---|
| `pi-subagent/claude-args.ts:153` `parseClaudeStreamEvent` | Claude stream event → pi-compatible message |
| `pi-subagent/claude-args.ts:176` `parseClaudeResult` | Terminal `result` event → `BackendResult.usage` |
| `pi-subagent/claude-args.ts:11-19` `PI_TO_CLAUDE_TOOLS` | Lands in the `index.ts` patch above, not in `headless.ts` |
| `pi-subagent/index.ts:474-619` pi stream-json loop | `message_end` / `tool_result_end` parsing + usage aggregation |
| `pi-subagent/index.ts:371-471` Claude spawn+parse loop | Spawn lifecycle, abort handling reference |
| `pi-subagent/index.ts:169` `getFinalOutput` | Final assistant-text extraction helper |

Explicitly **not** lifted:

- `pi-subagent/model-fallback.ts` — out of scope (skills own fallback).
- `pi-subagent/depth-guard.ts` — out of scope (`spawning: false` is the convention).
- `pi-subagent/agents.ts` — fork has tiered discovery already.
- `pi-subagent/agent-args.ts` — fork has `buildPiPromptArgs`.

## Data flow and error handling

End-to-end flow for a single headless task:

1. **Tool call arrives.** `default-deps.ts` calls `selectBackend()` once per session; malformed `PI_SUBAGENT_MODE` → warn-once to stderr, silent fallback to `auto`.
2. **Launch.** Agent not found → fail-fast at orchestration layer before any spawn. `effectiveTools` resolved; for Claude, mapped to `--allowedTools` via the patched helper. Spawn with piped stdio. `ENOENT` on child process → synthetic `BackendResult { exitCode: 1, error: "<cli> CLI not found on PATH" }`.
3. **Stream parse loop.** Stdout is line-buffered; partial lines held across `data` events. Each line → `JSON.parse`; parse failures are silently skipped (matches `pi-subagent` leniency). Unparseable stderr bytes accumulate verbatim for the error path. Event-type dispatch per CLI; all other event types ignored. Every append triggers `onUpdate({ content: [...], details: { results: [partial] } })`.
4. **Completion signals.**
   - Claude: `result` event marks completion; process close expected immediately after.
   - pi: final `message_end` with terminal `stopReason` (`endTurn`, `stop`, `error`) + process close.
   - Zero exit with no terminal event → error `"child exited without completion event"` (defensive; shouldn't happen).
   - Non-zero exit → error result with stderr included.
5. **Transcript archival.** pi: copy session file. Claude: reconstruct via session-id slug with 2s retry-poll; null on persistent absence. See `headless.ts` step 4 above.
6. **Abort.** `signal.aborted` pre-launch → synthetic aborted result. Mid-stream abort → `SIGTERM` → 5s → `SIGKILL`; resolve with partial state + `error: "aborted"`. Transcript archival is best-effort on abort.
7. **Return up the stack.** `backend.watch()` → `BackendResult`; `default-deps.waitForCompletion` spreads it into `OrchestrationResult` (now carrying optional `usage` + `messages`). `run-serial` / `run-parallel` aggregate; serial consumers can now read `.usage` per step; `{previous}` substitution still uses `finalMessage` only.

### Error catalog

| Error | Surfaced as |
|---|---|
| Invalid `PI_SUBAGENT_MODE` | stderr warn-once, silent fallback to `auto` |
| Agent not found | Tool error at orchestration layer, no spawn |
| CLI binary not on PATH | `BackendResult.error = "<cli> CLI not found on PATH"`, `exitCode: 1` |
| Unparseable stream-json line | Silently skipped; task continues |
| Process exits non-zero | `exitCode` propagated; stderr captured in `error` |
| Process exits zero but no terminal event | `error = "child exited without completion event"` |
| Transcript source missing after retries | `transcriptPath: null` + stderr warning; task still succeeds |
| Aborted | `error = "aborted"`; partial state preserved |

Notably absent in headless: no sentinel-timeout path (no sentinels), no mux-detection-failure error (mux absence just routes here), no Stop-hook-missing error (Stop hook is pane-only).

## Testing strategy

Three layers. Phase 0 is prerequisite.

### Phase 0 — Baseline integration tests for the existing pane path

1. Confirm HazAT's inherited tests pass: `test/integration/subagent-lifecycle.test.ts`, `test/integration/mux-surface.test.ts`. Currently only run under `npm run test:integration`, not the default target. Fix any breakage or document as known issues before proceeding.
2. Promote `test/integration/claude-sentinel-roundtrip.test.ts` from scaffold to real: launch `claude` with a trivial prompt under the pane path; skip-gate on `which claude` + plugin presence; assert non-null `transcriptPath`, `existsSync` after cleanup, archival location, non-empty summary.
3. Add `test/integration/pi-pane-smoke.test.ts`: same shape for pi with an `auto-exit: true` trivial agent; skip-gate on `which pi`; assert `exitCode: 0`, non-empty summary, session file archived.

All three become the regression safety net. The Phase 1 refactor must leave them green.

### Unit tests — tight, focused

Four files, ~150 LOC total. Run under default `npm test`. Cover only deterministic logic that is awkward to exercise at integration level.

- `test/orchestration/select-backend.test.ts` — `PI_SUBAGENT_MODE` resolution: explicit values, malformed values warn+fallback, auto-mode routes via mocked mux detector.
- `test/orchestration/headless-abort.test.ts` — with mocked spawn: SIGTERM → 5s → SIGKILL timing, partial-state preservation.
- `test/orchestration/claude-event-transform.test.ts` — `parseClaudeStreamEvent`'s `tool_use → toolCall` transformation (pure function).
- `test/orchestration/line-buffer.test.ts` — partial-line buffering across `data` chunk boundaries.

**Explicitly not written:**

- Full synthetic stream-parse fixture tests for pi and Claude. These would encode our model of the stream-json format; when the real format drifts, they stay green and production breaks. Integration tests catch drift; units cannot.
- `claude-tools-map.test.ts` as its own file — one inline assertion in another test suffices for a dictionary lookup.

### Integration tests — load-bearing

Run under `npm run test:integration`; skip-gated on CLI presence.

- `test/integration/headless-pi-smoke.test.ts` — trivial pi task in headless mode: `finalMessage` non-empty, `exitCode: 0`, `usage.turns >= 1`, `messages.length > 0`, `transcriptPath` exists.
- `test/integration/headless-claude-smoke.test.ts` — trivial Claude task: all the above plus `usage.cost > 0`, `sessionId` populated, `transcriptPath` under `~/.pi/agent/sessions/claude-code/`.
- `test/integration/headless-tool-use.test.ts` — prompt that forces tool use mid-stream (e.g. `"Run ls and summarize"`). Asserts `messages` contains a `toolCall` entry and a subsequent tool result; validates mid-stream parsing against a real CLI.
- `test/integration/headless-transcript-archival.test.ts` — after a successful headless run, read the archived jsonl file; assert non-empty, contains expected `session_id`, contains the task prompt as a user message. Covers both pi and Claude paths.
- `test/integration/headless-abort-integration.test.ts` — launch long-running task; trigger abort; verify process reaped within ~6s and `error: "aborted"` surfaces.
- `test/integration/headless-enoent.test.ts` — force `PATH` to exclude the target CLI; verify actionable error message.

Cost check: each test runs a sub-second trivial prompt. Total suite is cents per run at Sonnet rates.

### Skip semantics and CI

- All integration tests use the existing skip-gate pattern (`which <cli>` + capability probes).
- `PI_SUBAGENT_MODE=headless` is set explicitly in every headless integration test so auto-detection doesn't confound results when a CI shell has tmux in its env.
- Real CI enablement (provisioning `pi` + `claude` + API keys in runners) is **follow-up scope**.

### Fork-wide invariants

Two behaviors to assert don't change across the refactor:

- **Tool-restriction patch is additive.** Agents without `tools:` frontmatter continue to get no `--allowedTools` flag, matching today's pane-Claude behavior.
- **`OrchestrationResult` is byte-compatible for pane callers.** New `usage` / `messages` fields are `undefined` there; verify no existing caller destructures without optional-chaining via a `grep` pass across `pi-config/agent/skills/`.

## Implementation phasing

Five PRs. Each leaves the fork in a working state.

### Phase 0 — Baseline pane tests (PR 1)

**Scope.** The three test additions above: confirm HazAT pane tests pass, promote `claude-sentinel-roundtrip`, add `pi-pane-smoke`. Fix whatever's broken in existing tests.

**Gate to Phase 1.** All three new/promoted tests green locally. A fundamentally blocked test is documented with an issue link; proceed with known risk noted.

**Size estimate.** ~300–500 LOC of test code. Zero production-code change.

### Phase 1 — Backend interface + pane adapter (PR 2)

**Scope.** `backends/types.ts`, `backends/pane.ts`, `backends/select.ts`; rewire `orchestration/default-deps.ts`; expose `detectMux()` from `index.ts` / `cmux.ts`.

**Behavior change.** None intended. Phase 0 suite must remain green. `HeadlessBackend` stub returns `"not implemented"` error if selected; simplest alternative is to gate `selectBackend()` to always return `pane` until Phase 2.

**Size estimate.** ~200 LOC new + ~50 LOC modified.

### Phase 2 — Headless pi backend (PR 3)

**Scope.** `backends/headless.ts` pi path — spawn, parse, usage aggregation, transcript archival, abort. Unit tests `select-backend`, `headless-abort`, `line-buffer`. Integration tests `headless-pi-smoke`, `headless-transcript-archival` (pi half), `headless-enoent`.

**Behavior change.** `PI_SUBAGENT_MODE=headless` routes pi tasks to headless. Claude tasks still fall back to pane (or error clearly if no mux).

**Gate to Phase 3.** All Phase 2 tests green. Manual verification: `subagent_serial` with `PI_SUBAGENT_MODE=headless` against a pi agent in a scratch repo matches pane-mode output.

**Size estimate.** ~300 LOC implementation + ~200 LOC tests.

### Phase 3 — Headless Claude backend + tool-restriction patch (PR 4)

**Scope.** `backends/headless.ts` Claude path (parse, transform, session-id extraction, archival via slug reconstruction). `subagents/index.ts` named-commit patch for `PI_TO_CLAUDE_TOOLS` + `--allowedTools`. Unit test `claude-event-transform`. Integration tests `headless-claude-smoke`, `headless-tool-use`, `headless-transcript-archival` (Claude half), `headless-abort-integration`.

**Behavior change.** `PI_SUBAGENT_MODE=headless` fully functional for both CLIs. The `index.ts` patch applies `--allowedTools` to every Claude invocation that has `tools:` frontmatter — including pane mode. Skills currently relying on Claude-pane-mode having unrestricted tools despite their frontmatter need attention; verify via `grep` across `pi-config/agent/agents/`.

**Gate to Phase 4.** All integration tests green. Tool-restriction patch landed as a named commit, ready for upstream PR alongside the `thinking` patch.

**Size estimate.** ~400 LOC implementation + ~250 LOC tests + ~30 LOC patch to `index.ts`.

### Phase 4 — Enrich `OrchestrationResult` (PR 5)

**Scope.** `orchestration/types.ts` field additions. `default-deps.ts` pass-through. Ensure `onUpdate` wiring in headless reaches orchestration tool handlers. README documentation for new result shape, `PI_SUBAGENT_MODE`, tool-restriction behavior.

**Gate to merge.** Optional fields don't break existing callers (`grep` pass). Docs updated.

**Size estimate.** ~50 LOC + docs.

### Phase 5 — Retire `pi-subagent` (separate, out of this spec)

Gated on:

1. Skills migration from the old `subagent { chain / tasks }` tool surface — tracked in the prior fork-design spec.
2. Fallback story resolved — skills implement fallback themselves, or the loss is accepted as a known regression at retirement time, or a separate spec lands a minimal headless-side fallback.
3. Soak time — at least two weeks of daily use with `PI_SUBAGENT_MODE=headless` in real CI or real headless workflows.

Retirement actions when gates are met: remove `~/Code/pi-subagent` from `~/.pi/agent/settings.json.packages`, archive the `pi-subagent` repo on GitHub, add a one-line redirect in the old repo's README pointing at the fork. No code changes in the fork are required.

### Cross-cutting risks

- **Upstream rebase after Phase 3.** The tool-restriction patch adds a second carried commit. Keep both as named commits with descriptive messages so `git rebase -i --autosquash` or a scripted replay stays mechanical.
- **Stream-json format drift.** Claude's stream format could change. Integration tests catch this on every run; unit tests don't. This is why Section on testing leaned integration-first.
- **Transcript archival race in headless-Claude.** Session-id slug reconstruction depends on Claude's file-write timing. Mitigated by 2s retry-poll; if insufficient in practice, follow-up to make the poll window configurable.

## Future work

- **Symmetric observability on the pane backend (C-scope).** Thread stream-events through the pane path so `onUpdate` and `usage` / `messages[]` aggregation are available to pane-mode callers too. Requires tapping pane child stdout without losing the pane-TTY ergonomics — non-trivial but decoupled from this spec.
- **Model fallback replacement.** Skills own fallback per the fork-design spec. A separate spec could add a minimal headless-side fallback utility if skill-side implementation proves insufficient.
- **Real CI enablement.** Provision `pi` + `claude` CLIs + API keys in GitHub Actions (or equivalent) so the integration suite runs on every PR. Scoped separately because it involves secrets management and runner configuration independent of the backend design.
- **Upstream PR for the `PI_TO_CLAUDE_TOOLS` patch.** Paired with the existing `thinking` patch once both are stable.

## Open questions

None — all resolved during brainstorming.

## Decisions log

| Decision | Chosen | Rejected alternatives |
|---|---|---|
| End-state for `pi-subagent` | Unified fork; retire once soak / skills / fallback gates met | Coexist forever (fork owns interactive, old owns headless); coexist as safety-net with no retirement commitment |
| Scope of observability | Mux-free + close items #6/#7 for headless path only; symmetric pane enrichment is follow-up | Mux-free only (tight); symmetric #6/#7 on both backends (widest) |
| `interactive` schema field | Vestigial — accept in schema, ignore at runtime; backend selection is the real axis | Retire from schema entirely; plumb as a real behavioral switch |
| Backend selection mechanism | Auto-detect mux + `PI_SUBAGENT_MODE` env override (auto / pane / headless) | Auto-detect only; env override + per-task `mode` field |
| Headless completion signaling | Stream-json terminal event only (Claude `result`, pi `message_end` + process close) | Reuse `.exit` sentinel + `subagent-done.ts`; hybrid (both active for pi) |
| Code organization | New `backends/` directory; `pane.ts` thin adapter over existing primitives; zero movement of upstream code | Full extraction of pane code from `index.ts`; keep monolithic in `index.ts` |
| Phase 0 baseline tests | In-spec as a prerequisite phase | Separate prerequisite spec; skip baseline and rely on refactor discipline |
| Scope creep from old pi-subagent | Claude tool-restriction patch in (`PI_TO_CLAUDE_TOOLS`); `fallbackModels` + numeric depth guard out | Tight (no scope creep); include `fallbackModels` for headless only; include everything |
| Testing balance | Integration-first; four tight unit tests (select, abort, event-transform, line-buffer) | Full unit suite for stream parsers; integration-only |
| Phase 5 retirement | Outside this spec; gated on skills migration + fallback story + soak | Prescribe retirement PR sequence now; commit to a date |
