# pi-interactive-subagent: Fork Design

**Date:** 2026-04-20
**Status:** Draft — awaiting review
**Supersedes (eventually):** `pi-subagent` (to be retired post-cutover)

## Summary

Fork [`HazAT/pi-interactive-subagents`](https://github.com/HazAT/pi-interactive-subagents) into a new project, `pi-interactive-subagent`, that runs alongside the current `pi-subagent` during a staged cutover. Adopt HazAT's interactive TTY-in-mux-pane execution model wholesale. Layer the orchestration features that our skills depend on (serial with `{previous}` interpolation, parallel with concurrency cap, tiered agent discovery) on top as additive wrappers. Migrate skills incrementally; retire `pi-subagent` only once everything is verified on the fork.

## Motivation

### Why not keep evolving pi-subagent?

`pi-subagent` pipes stream-json from a non-interactive `pi -p` / `claude -p` child to the parent. That model:

- Cannot host **interactive subagents** (user typing into the subagent mid-run), which blocks offloading skills like `define-spec` where a subagent needs to converse with the user.
- Has no natural fit for **pane-based observability** — the subagent emits JSON to stdout, not a TUI.

Adding interactive TTY support to `pi-subagent` means implementing from scratch: mux detection (cmux/tmux/zellij/wezterm), pane launch, sentinel-based completion, transcript mining, Claude Stop-hook integration, and a live widget. HazAT has all of this built, tested, and working — ~2,800 LOC of execution core.

### Why not port our features into HazAT's and use theirs directly?

Contribution posture (upstream receptivity, release cadence) is uncertain. To keep momentum and unblock cutover on our schedule, we fork. Useful pieces get upstreamed opportunistically; we carry a fork otherwise.

### Why interactive-only (not observability-only)?

Interactive TTY mode subsumes observability as a side-effect: the subagent runs in a real pane, so the user *can* watch it — they simply choose not to type. A non-interactive observability-only mode would require a second execution core (stdio-piped, as in `pi-subagent` today) and significant branching throughout the orchestration layer. Not worth the complexity.

## Scope

### In scope (v1)

- Fork HazAT's repo into `pi-interactive-subagent`.
- Adopt their execution core (mux detection, pane lifecycle, sentinel, transcript read, Claude Stop hook plugin, live widget, session lineage modes) unchanged.
- Add two orchestration tools layered on top: `subagent_serial` and `subagent_parallel`.
- Add tiered agent discovery (builtin < user < project).
- Migrate `pi-config/agent/skills/` to the new tool surface.
- Rename agent frontmatter: `maxSubagentDepth` → HazAT's `spawning` convention.
- Structural hygiene: orchestration cores implemented as pure async functions to keep a future async-dispatch mode cheap.

### Out of scope (v1)

- **Async orchestration mode** (`wait: false` for either wrapper). Deferred — see "Future work."
- `caller_ping` integration in orchestration (tool remains available from upstream; no wrapper usage yet).
- `subagent_resume` orchestration (exposed as-is).
- Session lineage modes beyond `standalone` in orchestration (users can pass `fork` through per task).
- Widget-to-pane focus affordance (users navigate via native mux shortcuts).
- Retiring `pi-subagent` (separate follow-up after cutover verified).
- Auto-install of the Claude plugin (manual install with docs).
- Model fallback (`fallbackModels` / `withModelFallback`) — dropped; skills own fallback logic.
- Numeric recursion depth guard — replaced by HazAT's boolean `spawning` per-agent field.

## Architecture

### Fork layout

- **Repo:** `github.com/davidsunglee/pi-interactive-subagent` (new), forked from `HazAT/pi-interactive-subagents` at current `main`.
- **Package name:** `@davidsunglee/pi-interactive-subagent`.
- **Top-level directory structure:**
  - Upstream files preserved at their upstream paths (treated as vendored; rebased from upstream periodically).
  - Our additions under `src/orchestration/` clearly segregated, so diffs against upstream are readable.
- **Coexistence:** `pi-subagent` remains installed and functional. Both extensions can be loaded simultaneously via `~/.pi/agent/settings.json.packages`. Skills migrate one-by-one; old skills keep dispatching to `pi-subagent` until their migration PR lands.

### Execution model (adopted from HazAT, unchanged)

1. User invokes a tool (`subagent`, `subagent_serial`, `subagent_parallel`) in the parent session.
2. For each task, detect active mux (cmux / tmux / zellij / wezterm, honoring `PI_SUBAGENT_MUX` override).
3. Spawn the subagent CLI (`pi` or `claude`) inside a new mux pane as a real interactive TTY session (no `-p` flag, no stdio piping).
4. Record `{ id, paneId, sentinelFile }`. Register in the live widget.
5. **Completion signaling:**
   - **Claude:** the Claude plugin's `Stop` hook (`plugin/hooks/on-stop.sh`) fires when Claude finishes a turn autonomously. It checks `stop_hook_active` to distinguish autonomous completion from user interjection. On autonomous completion, it writes `/tmp/pi-claude-<id>-done` (containing `last_assistant_message`) and `/tmp/pi-claude-<id>-done.transcript` (containing the transcript path).
   - **pi:** a `subagent-done` extension (HazAT's `pi-extension/subagents/subagent-done.ts`) is auto-loaded into every pi subagent. It registers a `subagent_done` tool the agent calls on completion (or auto-fires via `PI_SUBAGENT_AUTO_EXIT=1` / `auto-exit: true` frontmatter when the agent's turn ends without user takeover). Both paths write `${PI_SUBAGENT_SESSION}.exit` with `{ type: "done" }` (or `{ type: "ping", message }` for `caller_ping`) and shut the subagent down. The parent watches for that `.exit` file.
6. Orchestration wrappers poll the sentinel file(s). When the sentinel appears, the wrapper reads the transcript, extracts the final assistant message, and continues (serial: substitute `{previous}` in the next task; parallel: record result for aggregation).
7. Aggregated results return to the parent as the tool call result.

### Orchestration layer (our addition)

All orchestration logic lives in `src/orchestration/`:

- `run-serial.ts` — pure async function `runSerial(tasks, opts): Promise<Results>`.
- `run-parallel.ts` — pure async function `runParallel(tasks, opts): Promise<Results>`.
- `sentinel-wait.ts` — polls a sentinel file until it appears; returns `{ finalMessage, transcriptPath }`.
- `transcript-read.ts` — reads a Claude or pi transcript; extracts final assistant message; copies transcript to the sessions archive if present.
- `tool-handlers.ts` — thin tool-handler wrappers that invoke the orchestration cores.

The orchestration cores are **pure async functions** (no tool-handler dependencies) so that a later async-dispatch mode can reuse them unchanged — the tool handler decides whether to await inline (sync) or schedule and return a handle (async).

## Tool surface

### Tools inherited from HazAT (unchanged)

| Tool | Purpose |
|---|---|
| `subagent` | Spawn one subagent in a pane. Async from parent's view: returns `{ id, paneId, sentinelFile }` immediately. Completion delivered via interrupt. |
| `subagent_resume` | Resume a Claude session by transcript id. |
| `subagents_list` | Enumerate available agent definitions. |
| `caller_ping` | Child-to-parent notification during a run. |

### Tools added by our orchestration layer

#### `subagent_serial`

```
subagent_serial({
  tasks: [
    {
      name?: string,           // widget label; auto-generated if omitted ("step-1", ...)
      agent: string,           // agent definition name
      task: string,            // may contain {previous} placeholder
      cli?: "pi" | "claude",
      model?: string,
      thinking?: string,
      cwd?: string,
      interactive?: boolean,   // default true; per-step override
      permissionMode?: string, // for Claude
      focus?: boolean          // per-step override; default true for serial
    },
    ...
  ]
})
→ {
    results: [
      { name, finalMessage, transcriptPath, exitCode, elapsedMs, sessionId? },
      ...
    ],
    isError?: boolean
  }
```

**Semantics:**
- Iterate `tasks` in order. For each: call upstream `subagent()` with the task's fields plus focus derived from per-step or wrapper default. Poll its sentinel until it appears. Read the transcript, extract the final assistant message.
- Substitute `{previous}` in the next task's `task` string with the prior step's final message before spawning.
- Stop on the first failing step (non-zero exit code or error stop reason). Return all completed results plus the failing one, mark `isError: true`. Do not spawn subsequent steps.
- **`{previous}` substitution scope:** only at `task`-string level; no access to transcripts or tool calls. YAGNI.

#### `subagent_parallel`

```
subagent_parallel({
  tasks: [
    {
      name?: string,
      agent: string,
      task: string,
      cli?: "pi" | "claude",
      model?: string,
      thinking?: string,
      cwd?: string,
      interactive?: boolean,
      permissionMode?: string,
      focus?: boolean          // per-task override; default false for parallel
    },
    ...
  ],
  maxConcurrency?: number      // default 4; hard cap 8
})
→ {
    results: [
      { name, finalMessage, transcriptPath, exitCode, elapsedMs, sessionId? },
      ...
    ],
    isError?: boolean           // true if any task failed
  }
```

**Semantics:**
- Spawn tasks up to `maxConcurrency` concurrently. As each task completes (sentinel appears, transcript read), start the next queued task.
- Panes spawned detached by default (tmux `split-window -d`, cmux equivalent). The live widget lists them; user navigates via native mux shortcuts.
- Above the cap of 8 → reject the call with an error directing the caller to split into sub-waves.
- Wait for all tasks. Aggregate results in input order. Partial failures do not cancel siblings — each task's outcome is reported independently. `isError: true` if any failed.

### Shared field semantics

| Field | Notes |
|---|---|
| `cli` | Replaces our former `dispatch`. Values: `"pi"` (default), `"claude"`. |
| `interactive` | HazAT's existing field. Default `true` for both wrappers. Skills that want non-interactive (e.g. scripted recon) pass `false` per task. |
| `focus` | Our addition. Controls whether the newly spawned pane grabs focus. Default `true` for serial, `false` for parallel. Pass-through to the mux spawn (attached vs detached). |
| `name` | User-visible label in the widget. Orchestration auto-generates if omitted. |

### Fields intentionally omitted

- **`fallbackModels`** — dropped. Skills implement fallback themselves, with cross-provider dispatch re-resolution and user notification. Tool-level silent retry would *conflict* with that behavior. No current skill uses the frontmatter field; no behavior loss.
- **`maxSubagentDepth`** — replaced by HazAT's `spawning: true|false` per-agent boolean.
- **`agentScope` / `confirmProjectAgents`** — HazAT's discovery is used as-is; tiered discovery (below) is transparent resolution, not a per-call knob.

## Agent discovery

Three-tier priority preserved from `pi-subagent`:

1. **Builtin** — packaged with the fork at `agents/`.
2. **User** — `~/.pi/agent/agents/`.
3. **Project** — `.pi/agents/` within the active `cwd`.

Later tiers override earlier ones by agent `name`. This is layered inside agent resolution (orchestration layer calls it before invoking HazAT's `subagent()`), not exposed as a per-call parameter.

## Agent frontmatter changes

Rename `maxSubagentDepth` across existing agents:

| Current | New |
|---|---|
| `maxSubagentDepth: 0` | `spawning: false` |
| `maxSubagentDepth: 1` | `spawning: true` (parent) — verify all children have `spawning: false` |

Affected agents in `pi-config/agent/agents/`:
- `verifier.md`, `plan-reviewer.md`, `planner.md`, `coder.md`, `code-reviewer.md` → `spawning: false`.
- `code-refiner.md`, `orchestrator.md` → `spawning: true`; their children (`coder`, `code-reviewer`, `refiner`) all map to `spawning: false`, so no additional action.

**Caveat:** the boolean model fails closed (an agent without `spawning: true` cannot spawn), which is safer than a numeric counter, but requires discipline — every new dispatcher-callable agent must explicitly set `spawning: false` to prevent runaway. The numeric counter was a runtime safety net; this trades the safety net for explicit declaration.

## Skill migration plan

Migration happens in `pi-config/agent/skills/` per-skill, not bulk. Each migration is a self-contained PR in `pi-config`.

| Skill | Migration |
|---|---|
| `generate-plan` | `subagent { agent, task, model, dispatch: "claude" }` → `subagent_serial({ tasks: [{ name, agent, task, model, cli: "claude", interactive: false }] })` for single-step dispatch. Iterative review-edit loop becomes sequential steps. |
| `execute-plan` | Wave dispatch: `subagent { tasks: [...] }` → `subagent_parallel({ tasks: [...], maxConcurrency: 4 })`. Update per-task `dispatch` → `cli`. Keep `MAX_PARALLEL_TASKS` reference at 8 in skill prose (matches wrapper cap). |
| `requesting-code-review` | Single dispatch → `subagent_serial({ tasks: [one step] })` with `interactive: false`. |
| `refine-code` | Same pattern as code-review. |
| `define-spec` | **New use case:** converted from a main-agent skill to a subagent dispatch. `subagent_serial({ tasks: [{ name: "spec", agent: "spec", task: ..., cli: "claude", interactive: true, focus: true }] })`. Pane visible and focused. Parent awaits sentinel, reads transcript, extracts spec file path from final message. |
| `using-git-worktrees` | Tool-name and field-name updates only. |
| `execute-plan/verify-task-prompt.md` | Field renames only. |
| `refine-code/refine-code-prompt.md` | Field renames only. |

Skills that remain on `pi-subagent` during migration continue to work — both extensions are loaded side-by-side.

## Claude plugin distribution

HazAT ships a Claude plugin (`plugin/` in their repo) containing:
- `plugin.json` — plugin manifest.
- `hooks/hooks.json` — wires the `Stop` hook.
- `hooks/on-stop.sh` — writes the sentinel file and transcript path on autonomous turn completion.

Our fork preserves this plugin. Distribution:
- The plugin ships inside the forked repo at its existing path.
- Installation is a **manual user action** — README documents the one-time install step (e.g. `claude plugin install <path>/plugin` or symlink into `~/.claude/plugins/`).
- The plugin is version-matched to the repo. Any breaking change to sentinel format bumps both together.
- **If the plugin is not installed and a `cli: "claude"` task is dispatched:** the sentinel never appears, the wrapper's sentinel wait times out (default ~30s), and the wrapper surfaces a clear, actionable error (`"Claude Stop hook not installed — see README install step"`) rather than silently hanging.

No auto-install: Claude plugins have their own trust model, and automatic filesystem modification is a footgun. Manual install with good docs is the right default.

## Error handling

- **Sentinel timeout** — configurable per wrapper. Heuristic: the wrapper polls the sentinel / `.exit` file and considers the subagent hung if the pane has shown no stdout activity for a quiet period (default ~30s) and no sentinel has appeared. Surfaces as a wrapper-level error with the pane id so the user can inspect the pane manually.
- **Transcript-read failure** (file missing, unparseable) — treated as a failed step; the pane id and sentinel path are included in the error for debugging.
- **Non-zero exit from the subagent CLI** — propagated per task via `exitCode` in the result. Serial stops; parallel reports per-task.
- **Mux detection failure** (no supported multiplexer active) — fail-fast with a clear error; do not silently fall back to stdio piping. If a user wants non-interactive dispatch without a mux, that's a separate concern (the existing `pi-subagent` still exists for that).
- **Agent not found** — fail-fast at the orchestration layer before any spawn; list available agents in the error.

## Testing strategy

Three layers:

1. **Unit tests for orchestration** (`test/orchestration/`):
   - `run-serial.ts` with a mocked `subagent()` + mocked sentinel/transcript primitives: verify input-order execution, `{previous}` substitution, stop-on-error behavior, name auto-generation.
   - `run-parallel.ts` similarly: verify concurrency cap enforcement, input-order aggregation, partial-failure reporting, detached-focus default.
   - No real processes, no real panes.
2. **Integration test for Claude sentinel roundtrip** (`test/integration/`):
   - One end-to-end run launching a trivial `claude` subagent with a short task (e.g. "echo 'hello'"). Verify the plugin's Stop hook writes the sentinel, transcript copies to `~/.pi/agent/sessions/claude-code/`, final message round-trips through the wrapper.
   - Requires `claude` + plugin installed locally; skip in CI if absent; document local-run command.
3. **Smoke test per migrated skill** — for each `pi-config/agent/skills/` migration, one end-to-end manual run in a scratch repo against a trivial todo/plan/spec. Not automated; checklist in the migration PR.

HazAT's existing tests (`test/integration/subagent-lifecycle.test.ts`, `test/system-prompt-mode.test.ts`, `test/integration/mux-surface.test.ts`) come with the fork. They must continue to pass — if any break after our additions, that's the signal we touched something we shouldn't have.

## Future work

### Async orchestration mode

`subagent_serial({ wait: false })` and `subagent_parallel({ wait: false })` — orchestration runs in the background after the tool returns; parent continues other work; completion delivered as an interrupt with aggregated results when the full sequence/batch finishes.

**Use cases:** long-running orchestrations (e.g. a multi-hour `execute-plan` run) where the user wants to continue main-session work and be notified when the whole thing's done.

**Why deferred:** requires a compound-completion watcher ("signal parent when all N per-task sentinels have fired") that does not exist in HazAT today. Estimated ~200-300 LOC total for both wrappers, additive (not a reshape).

**v1 design hygiene that keeps this cheap:**
- Orchestration cores (`runSerial`, `runParallel`) are pure async functions — usable by either a sync or async tool handler.
- Input schemas are forward-compatible with `wait: boolean`.
- Output types distinguish sync (`{ results: [...] }`) from future async (`{ orchestrationId, tasks: [{ name, status: "pending" }, ...] }`). No shared-nullable gymnastics.

### Widget interactivity

Adding keyboard-driven pane focus in the widget (Decision 4B) or a `subagent_focus({ name })` tool (Decision 4C) — deferred. Users rely on native mux shortcuts in v1.

### Upstream contributions

Once the fork is stable and the orchestration layer is proven, evaluate upstreaming:
- Tiered agent discovery (potentially of interest to HazAT).
- `subagent_serial` / `subagent_parallel` (if aligned with their roadmap).
- Detached-pane focus flag on upstream `subagent()`.

Contribution posture depends on HazAT's receptivity; not a blocker for this project.

## Open questions

None — all decisions resolved during brainstorming.

## Decisions log

| Decision | Chosen | Rejected alternatives |
|---|---|---|
| Mode | Interactive TTY only (observability as side-effect) | Observability-only; both as separate modes |
| Build vs adopt | Fork HazAT, layer our features on top | Port HazAT's features into `pi-subagent`; port our features into HazAT's mainline |
| Orchestration shape | New tools (`subagent_serial`, `subagent_parallel`) layered on `subagent()` | Extend upstream `subagent` with `chain` / `tasks` arrays; make skills loop over `subagent()` themselves |
| Dispatch field naming | Adopt HazAT's `cli` (Decision 2B) | Keep `dispatch` with compat shim (Decision 2A) |
| Claude plugin install | Manual user action, documented (Decision 3A) | Auto-install on first run; symlink-based dev setup as primary |
| Parallel focus default | Detached panes, discoverable via widget (Decision 4-detached) | Always focus; no-pane-at-all; configurable only |
| Widget pane focus in v1 | Native mux shortcuts only (Decision 4A) | Widget keybindings; `subagent_focus` tool |
| Model fallback | Drop | Keep as-is; move into orchestration layer |
| Depth guard | Drop, adopt `spawning: false` | Keep numeric counter alongside `spawning` |
| Async wrapper mode | Deferred; v1 structured to make it cheap later | Ship in v1; don't plan for it at all |
