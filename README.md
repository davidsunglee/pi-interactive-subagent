# pi-interactive-subagent

> **Fork notice.** This is a fork of [`HazAT/pi-interactive-subagents`](https://github.com/HazAT/pi-interactive-subagents). `pi-extension/subagents/` is upstream-derived and periodically rebased, but it carries local patches for orchestration integration and related fixes (spawning-tool gating, CLI/focus parameters, tmux detached spawn, Claude transcript archiving, and orchestration-tool registration from the extension entrypoint, plus the original `thinking` fix). The new orchestration tools (`subagent_serial`, `subagent_parallel`) live under `pi-extension/orchestration/`. Local patches against the vendored tree are tracked as named commits with intent to upstream where applicable.

Async subagents for [pi](https://github.com/badlogic/pi-mono) — spawn, orchestrate, and manage sub-agent sessions in multiplexer panes. **Mixed-mode execution** — the bare `subagent` / `subagent_resume` tools are non-blocking (they return immediately after spawning the pane); the new `subagent_serial` / `subagent_parallel` orchestration tools block the caller until all tasks in the batch complete.

https://github.com/user-attachments/assets/30adb156-cfb4-4c47-84ca-dd4aa80cba9f

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all running agents with elapsed time and progress. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)    8 msgs (5.1KB)   │
│ 00:45  Scout: DB (scout)     12 msgs (9.3KB)   │
╰─────────────────────────────────────────────────╯
```

For parallel execution, just call `subagent` multiple times — they all run concurrently:

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
subagent({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

## Install

```bash
pi install git:github.com/davidsunglee/pi-interactive-subagent
```

Supported multiplexers:

- [cmux](https://github.com/manaflow-ai/cmux)
- [tmux](https://github.com/tmux/tmux)
- [zellij](https://zellij.dev)
- [WezTerm](https://wezfurlong.org/wezterm/) (terminal emulator with built-in multiplexing)

Start pi inside one of them:

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
# just run pi inside WezTerm — no wrapper needed
```

Optional: set `PI_SUBAGENT_MUX=cmux|tmux|zellij|wezterm` to force a specific backend.

If your shell startup is slow and subagent commands sometimes get dropped before the prompt is ready, set `PI_SUBAGENT_SHELL_READY_DELAY_MS` to a higher value (defaults to `500`):

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500
```

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

## What's Included

### Extensions

**Subagents** — 5 tools + 3 commands:

| Tool                | Description                                                                     |
| ------------------- | ------------------------------------------------------------------------------- |
| `subagent`          | Spawn a sub-agent in a dedicated multiplexer pane (async — returns immediately) |
| `subagents_list`    | List available agent definitions                                                |
| `subagent_resume`   | Resume a previous sub-agent session (async)                                     |
| `subagent_serial`   | Run a pipeline of subagents in order (blocks; `{previous}` substitution)        |
| `subagent_parallel` | Fan out a batch of subagents concurrently (blocks; default cap 4, hard cap 8)   |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/plan`                    | Start a full planning workflow       |
| `/iterate`                 | Fork into a subagent for quick fixes |
| `/subagent <agent> <task>` | Spawn a named agent directly         |

### Bundled Agents

| Agent             | Model                  | Role                                                                                     |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| **planner**       | Opus (medium thinking) | Brainstorming — clarifies requirements, explores approaches, writes plans, creates todos |
| **scout**         | Haiku                  | Fast codebase reconnaissance — maps files, patterns, conventions                         |
| **worker**        | Sonnet                 | Implements tasks from todos — writes code, runs tests, makes polished commits            |
| **reviewer**      | Opus (medium thinking) | Reviews code for bugs, security issues, correctness                                      |
| **visual-tester** | Sonnet                 | Visual QA via Chrome CDP — screenshots, responsive testing, interaction testing          |

Agent discovery follows priority: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Override any bundled agent by placing your own version in the higher-priority location.

---

## Async Subagent Flow

```
1. Agent calls subagent()         → returns immediately ("started")
2. Sub-agent runs in mux pane     → widget shows live progress
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as interrupt
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. The live widget above the input tracks all running agents:

```
╭─ Subagents ──────────────────────── 3 running ─╮
│ 01:23  Scout: Auth (scout)      15 msgs (12KB) │
│ 00:45  Researcher (researcher)   8 msgs (6KB)  │
│ 00:12  Scout: DB (scout)             starting…  │
╰─────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full summary and session file path.

---

## Spawning Subagents

```typescript
// Named agent with defaults from agent definition
subagent({ name: "Scout", agent: "scout", task: "Analyze the codebase..." });

// Force a full-context fork for this spawn
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Agent defaults can choose a different session-mode via frontmatter
subagent({ name: "Planner", agent: "planner", task: "Work through the design with me" });

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

### Parameters

| Parameter        | Type    | Default  | Description                                                             |
| ---------------- | ------- | -------- | ----------------------------------------------------------------------- |
| `name`           | string  | required | Display name (shown in widget and pane title)                           |
| `task`           | string  | required | Task prompt for the sub-agent                                           |
| `agent`          | string  | —        | Load defaults from agent definition                                     |
| `fork`           | boolean | `false`  | Force the full-context fork mode for this spawn, overriding any agent `session-mode` frontmatter |
| `model`          | string  | —        | Override agent's default model                                          |
| `systemPrompt`   | string  | —        | Append to system prompt                                                 |
| `skills`         | string  | —        | Comma-separated skill names                                             |
| `tools`          | string  | —        | Comma-separated tool names                                              |
| `cwd`            | string  | —        | Working directory for the sub-agent (see [Role Folders](#role-folders)) |
| `cli`            | string  | —        | `'pi' \| 'claude'` — overrides agent frontmatter. Unknown values fall back silently to the pi path. |
| `thinking`       | string  | —        | `off \| minimal \| low \| medium \| high \| xhigh` — pi folds into `<model>:<thinking>`; Claude maps via `thinkingToEffort` to `--effort`. Unknown values are dropped on Claude and pass through as a pi model suffix. |
| `focus`          | boolean | `true`   | Whether the spawned pane grabs focus. Honored on tmux only; other backends focus the new pane regardless. |

---

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
- **Cancellation:** the tool-execution AbortSignal is threaded through the run. Cancelling the call aborts the in-flight step's wait (pane is closed, step is recorded with `error: "cancelled"`) and no further steps are launched; the cancelled run returns `isError: true` with prior + cancelled results.
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
- **Cancellation:** the tool-execution AbortSignal is threaded through the run. Cancelling the call aborts every in-flight task's wait (panes are closed, tasks are recorded with `error: "cancelled"`) and stops workers from launching not-yet-started tasks (those are filled with synthetic cancelled entries at their input index, preserving the `results.length === tasks.length` invariant). The cancelled run returns `isError: true`.
- Default `focus` = `false` for each task. Honored only on tmux (spawned via `split-window -d`); **other backends (cmux, zellij, wezterm) currently focus the new pane regardless** — documented backend limitation. Use the widget or native mux shortcuts to navigate.
- Set `focus: true` on an individual task to override.

### Task schema

Each entry in `subagent_serial.tasks` / `subagent_parallel.tasks` accepts the full per-call `SubagentParams` surface that the bare `subagent` tool already exposes: `agent`, `task`, `name`, `cli`, `model`, `thinking`, `systemPrompt`, `skills`, `tools`, `cwd`, `fork`, `resumeSessionId`, plus the `focus` override. The only `SubagentParams`-adjacent fields not plumbed today are `interactive` and `permissionMode` (upstream `launchSubagent` doesn't accept them yet).

### Claude plugin (bundled, auto-loaded — no manual install required)

The sentinel-based completion handshake is driven by a small Claude Stop hook that **ships inside this repo** at `pi-extension/subagents/plugin/`. It is not something you install globally; the launch path in `pi-extension/subagents/index.ts` resolves that directory relative to the compiled extension, checks `existsSync`, and appends `--plugin-dir <repo-local plugin path>` to the `claude` invocation (the `buildClaudeCmdParts` helper in that file contains the exact wiring). As long as you run pi from a checkout of this repo (or an install that preserves the `pi-extension/subagents/plugin/` subtree), the Stop hook is loaded automatically every time a `cli: "claude"` task is dispatched.

There is no `claude plugin install` step for this fork. If you previously symlinked the plugin into `~/.claude/plugins/`, you can remove that symlink — the `--plugin-dir` flag is authoritative and does not depend on global Claude plugin state.

What the bundled plugin actually provides is the **clean completion signal**: the Stop hook writes `PI_CLAUDE_SENTINEL` and the `<sentinel>.transcript` pointer, which `watchSubagent` consumes to populate `SubagentResult.summary`, `claudeSessionId`, and (after the v3 archive step) `SubagentResult.transcriptPath` pointing at the preserved jsonl under `~/.pi/agent/sessions/claude-code/`.

If for some reason the bundled plugin directory is missing (e.g. a truncated install that drops the `plugin/` subtree), the launch path simply omits `--plugin-dir` and Claude runs without the Stop hook. In that degraded mode, **completion is still detected** — `launchSubagent` appends `; echo '__SUBAGENT_DONE_'$?'__'` to every Claude command, and `pollForExit` in `pi-extension/subagents/cmux.ts` scans the pane screen for `__SUBAGENT_DONE_(\d+)__` and returns an `exitCode` from that match. What you lose is:

- the archived Claude transcript under `~/.pi/agent/sessions/claude-code/` (no `.transcript` pointer → nothing to copy),
- `SubagentResult.transcriptPath` (falls back to `null` in the Claude-branch completion path when no sentinel is produced), and
- `SubagentResult.claudeSessionId`,

and the summary falls back to screen-scraped tail output rather than the Stop hook's structured final message. Orchestration still returns a result for that step; it just carries `transcriptPath: null` and a scraped summary.

Known limitations in this degraded path: a dedicated "bundled-plugin directory not found" error, an installation-health probe, and a bounded fallback timeout are not yet implemented.

### Manual smoke test (per-skill migration)

1. `cd` to a scratch repo with a persistent pi session running.
2. Dispatch `subagent_serial` with two trivial tasks (pi + pi), confirm both panes spawn, `{previous}` substitution works, final message returns.
3. Dispatch `subagent_parallel` with 3 tasks and `maxConcurrency: 2` on tmux, confirm detached spawn (panes appear but focus stays on the caller), widget displays all three, results aggregate in input order. On non-tmux backends, confirm the new panes take focus (documented limitation).
4. Dispatch `subagent_serial` with one `cli: "claude"` task (trivial prompt like "echo hello"), confirm the Stop hook fires and the transcript is copied to `~/.pi/agent/sessions/claude-code/`.
5. Verify `SubagentResult.transcriptPath` (visible via the orchestration tool's `details.results[i].transcriptPath`) points at a file that still `existsSync` after sentinel cleanup — this is the v3 archived-transcript fix and the behavior an automated integration test is expected to cover in a future revision.

---

## caller_ping — Child-to-Parent Help Request

The `caller_ping` tool lets a subagent request help from its parent agent. When called, the child session **exits** and the parent receives a notification with the help message. The parent can then **resume** the child session with a response using `subagent_resume`.

**Parameters:**
- `message` (required): What you need help with

**Interaction flow:**
1. Child calls `caller_ping({ message: "Not sure which schema to use" })`
2. Child session exits (like `subagent_done`)
3. Parent receives a steer notification: *"Sub-agent Worker needs help: Not sure which schema to use"*
4. Parent resumes the child session via `subagent_resume` with the response
5. Child picks up where it left off with the parent's guidance

**Example:**
```typescript
// Inside a worker subagent
await caller_ping({
  message: "Found two conflicting migration files — should I use v1 or v2?"
});
// Session exits here. Parent receives the ping, then resumes this session
// with guidance like "Use v2, v1 is deprecated"
```

> **Note:** `caller_ping` is only available inside subagent contexts. Calling it from a standalone pi session returns an error.

---

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline.

```
/plan Add a dark mode toggle to the settings page
```

```
Phase 1: Investigation    → Quick codebase scan
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm todos, adjust if needed
Phase 4: Execute          → Scout + sequential workers implement todos
Phase 5: Review           → Reviewer subagent checks all changes
```

Tab/window titles update to show current phase:

```
🔍 Investigating: dark mode → 💬 Planning: dark mode
→ 🔨 Executing: 1/3 → 🔎 Reviewing → ✅ Done
```

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This always forks the current session into a subagent with full conversation context. It does not inherit an agent default `session-mode`. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## Custom Agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global):

```markdown
---
name: my-agent
description: Does something specific
model: anthropic/claude-sonnet-4-6
thinking: minimal
tools: read, bash, edit, write
session-mode: lineage-only
spawning: false
---

# My Agent

You are a specialized agent that does X...
```

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Agent name (used in `agent: "my-agent"`)                                                                                                                                                                                                                                    |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Default model (e.g. `anthropic/claude-sonnet-4-6`)                                                                                                                                                                                                                          |
| `cli`         | string  | CLI to use for this agent: `'pi'` (default) or `'claude'`. Also accepted as a per-call tool parameter override (overrides frontmatter).                                                                                                                                     |
| `thinking`    | string  | Thinking level: `off \| minimal \| low \| medium \| high \| xhigh`. Also accepted as a per-call tool parameter override.                                                                                                                                                    |
| `tools`       | string  | Comma-separated **native pi tools only**: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`                                                                                                                                                                             |
| `skills`      | string  | Comma-separated skill names to auto-load                                                                                                                                                                                                                                    |
| `session-mode` | string | Default child-session mode: `standalone`, `lineage-only`, or `fork` |
| `spawning`    | boolean | Set `false` to deny all subagent-spawning tools                                                                                                                                                                                                                             |
| `deny-tools`  | string  | Comma-separated extension tool names to deny                                                                                                                                                                                                                                |
| `auto-exit`   | boolean | Auto-shutdown when the agent finishes its turn — no `subagent_done` call needed. If the user sends any input, auto-exit is permanently disabled and the user takes over the session. Recommended for autonomous agents (scout, worker); not for interactive ones (planner). |
| `cwd`         | string  | Default working directory (absolute or relative to project root)                                                                                                                                                                                                            |
| `disable-model-invocation` | boolean | Hide this agent from discovery surfaces like `subagents_list`. The agent still remains directly invokable by explicit name via `subagent({ agent: "name", ... })`. |

---

Discovery still resolves precedence before visibility filtering. If a project-local hidden agent has the same name as a visible global or bundled agent, the hidden project agent wins and the lower-precedence agent does not appear in `subagents_list`.

### `session-mode`

Choose how a subagent session starts:

- `standalone` — default fresh session with no lineage link to the caller
- `lineage-only` — fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns.

`fork: true` on the tool call always forces the `fork` mode for that specific spawn. `/iterate` uses this explicit override on purpose.

```yaml
---
name: planner
session-mode: lineage-only
---
```

### `auto-exit`

When set to `true`, the agent session shuts down automatically as soon as the agent finishes its turn — no explicit `subagent_done` call is needed.

**Behavior:**

- The session closes after the agent's final message (on the `agent_end` event)
- If the user sends **any input** before the agent finishes, auto-exit is permanently disabled for that session — the user takes over interactively
- The modeHint injected into the agent's task is adjusted accordingly: autonomous agents see "Complete your task autonomously." rather than instructions to call `subagent_done`

**When to use:**

- ✅ Autonomous agents (scout, worker, reviewer) that run to completion
- ❌ Interactive agents (planner, iterate) where the user drives the session

```yaml
---
name: scout
auto-exit: true
---
```

---

## Tool Access Control

By default, every sub-agent can spawn further sub-agents. Control this with frontmatter:

### `spawning: false`

Denies all spawning tools (`subagent`, `subagents_list`, `subagent_resume`, `subagent_serial`, `subagent_parallel`):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over individual extension tools:

```yaml
---
name: focused-agent
deny-tools: subagent
---
```

To deny only the parallel orchestration tool while still allowing serial and bare spawning:

```yaml
---
name: focused-agent
deny-tools: subagent_parallel
---
```

### Recommended Configuration

| Agent      | `spawning`  | Rationale                                    |
| ---------- | ----------- | -------------------------------------------- |
| planner    | _(default)_ | Legitimately spawns scouts for investigation |
| worker     | `false`     | Should implement tasks, not delegate         |
| researcher | `false`     | Should research, not spawn                   |
| reviewer   | `false`     | Should review, not spawn                     |
| scout      | `false`     | Should gather context, not spawn             |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+J)              ← collapsed
[scout] — 12 available  (Ctrl+J to collapse)          ← expanded
  read, bash, edit, write, todo, ...
  denied: subagent, subagents_list, ...
```

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- One supported multiplexer:
  - [cmux](https://github.com/manaflow-ai/cmux)
  - [tmux](https://github.com/tmux/tmux)
  - [zellij](https://zellij.dev)
  - [WezTerm](https://wezfurlong.org/wezterm/)

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
# just run pi inside WezTerm
```

Optional backend override:

```bash
export PI_SUBAGENT_MUX=cmux   # or tmux, zellij, wezterm
```

## License

MIT
