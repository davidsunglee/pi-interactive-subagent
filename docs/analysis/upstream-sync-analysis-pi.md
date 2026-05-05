# Upstream sync analysis: HazAT/pi-interactive-subagents

Checked against upstream repository: <https://github.com/HazAT/pi-interactive-subagents>

## Summary

Our fork diverged from upstream at `v3.3.0` (`52cccd8`). Upstream is now at `v3.7.1` (`c0e4b35`). At the time of analysis:

- Upstream-only commits: 21
- Local-only commits: 181
- Recommendation: selectively port upstream changes; do **not** merge upstream wholesale.

The local fork has substantial headless execution, Claude support, orchestration tools, transcript/usage observability, and result-rendering changes that upstream does not have. A direct merge would be noisy and high-risk.

## Upstream commits since fork point

Upstream-only commits observed from `52cccd8..hazat/main`:

```text
9f10962 feat: add configurable subagent status supervision and turn-only interruption
eed32a9 fix: remove set_tab_title inadvertently reintroduced for subagents
aa3d34b test(integration): load working-tree extension instead of installed package
8d803a6 chore(release): v3.4.0
48d2513 refactor(agents): merge spec agent into planner with lightweight clarification
2d343e3 chore(release): v3.5.0
269b485 feat(subagents): suppress stall steer messages for interactive subagents
4c77573 chore(release): v3.5.1
b4b0287 feat: replace subagent liveness polling with child activity state (#35)
e9be4bb chore(release): v3.6.0
4fe6754 fix: auto-exit resumed subagents (#40)
2105cf4 fix(subagents): auto-exit after user-driven normal completion (#42)
a0c089a fix(subagents): preserve child control tools with restricted tools (#41)
d99cd4b Improves Windows support (#39)
6e336fe fix: preserve mux focus during subagent launch (#36)
913dc9c fix(zellij): use available space for subagent panes (#44)
e3c1253 docs(skills): update integration-test counts and serialize flag
265c93b chore(release): v3.7.0
5b64684 docs(subagents): clarify async/no-poll behavior in tool descriptions
c0e4b35 chore(release): v3.7.1
```

## Worth taking

### 1. Resume / auto-exit fixes

Relevant commits:

- `4fe6754` — `fix: auto-exit resumed subagents (#40)`
- `2105cf4` — `fix(subagents): auto-exit after user-driven normal completion (#42)`

These look worth porting. Our `subagent_resume` path still does not set `PI_SUBAGENT_AUTO_EXIT`, and our `subagent-done.ts` still uses the older user-takeover auto-exit behavior. The practical failure mode is that resumed or user-touched agents can remain open unexpectedly after completing normally.

Suggested handling:

- Port the resume `autoExit` behavior into our resume path.
- Adapt upstream's revised `shouldAutoExitOnAgentEnd` semantics into our plugin while keeping local `caller_ping`, Claude, and orchestration behavior intact.
- Add/adjust regression tests around resumed Pi sessions and user-driven normal completion.

### 2. Tool allowlist preservation

Relevant commit:

- `a0c089a` — `fix(subagents): preserve child control tools with restricted tools (#41)`

We already reserve `caller_ping` and `subagent_done` in `resolvePiToolsArg`, and we have additional orchestration-tool handling. However, upstream's implementation preserves arbitrary requested tool names when a child agent has a restrictive `tools:` declaration. Our current Pi tool projection filters to known built-ins and orchestration tools, which may drop custom extension tools.

Suggested handling:

- Keep our lifecycle/orchestration reservations.
- Change the Pi `--tools` construction so requested tool names survive unless we have a concrete reason to drop them.
- Preserve tests for coordinator orchestration tools and lifecycle tools under restrictive allowlists.

### 3. Child activity/status snapshots and `subagent_interrupt`

Relevant commits:

- `9f10962` — `feat: add configurable subagent status supervision and turn-only interruption`
- `269b485` — `feat(subagents): suppress stall steer messages for interactive subagents`
- `b4b0287` — `feat: replace subagent liveness polling with child activity state (#35)`

This is the largest valuable upstream feature. Upstream moved Pi-backed status away from session-file growth and toward a child-written activity snapshot. It enables widget states like `starting`, `active`, `waiting`, `stalled`, or fallback `running`; stall/recovery steer messages; and a `subagent_interrupt` tool that sends Escape to cancel only the current Pi-backed turn.

This would materially improve pane UX and supervision, but it is not a trivial cherry-pick because our fork has:

- headless backend support,
- Claude pane/headless behavior,
- orchestration registry and blocked-task virtual rows,
- transcript and usage updates in the widget/result paths.

Suggested handling:

- Treat as a manual feature port, not a merge.
- Introduce upstream's `activity.ts` / `status.ts` concepts into our pane Pi path first.
- Make the widget combine our existing usage/transcript display with upstream status labels.
- Decide how status should map for headless and Claude children; upstream uses `running` fallback for non-snapshot backends.
- Add `subagent_interrupt` only for Pi-backed pane children unless semantics are later verified for Claude/headless.
- Preserve interactive compatibility: our public `interactive` parameter is currently documented as vestigial for orchestration/headless compatibility, while upstream gives it real status-notification meaning.

### 4. Multiplexer UX fixes

Relevant commits:

- `6e336fe` — `fix: preserve mux focus during subagent launch (#36)`
- `913dc9c` — `fix(zellij): use available space for subagent panes (#44)`
- `d99cd4b` — `Improves Windows support (#39)`

These are worth taking if we care about pane UX across cmux/zellij/Windows.

Potential value:

- cmux/tmux focus preservation during launch,
- better zellij pane placement using available space, including stacked panes/tabs when splitting would leave unusable panes,
- Windows command detection via `where.exe` fallback.

Suggested handling:

- Port `cmux.ts` changes carefully around our existing `focus` / tmux-detached behavior.
- Keep local behavior where orchestration wrappers can request detached/non-focused launches.
- Add mux-surface tests for focus behavior and zellij placement if the environment supports them.

### 5. Integration harness correctness

Relevant commit:

- `aa3d34b` — `test(integration): load working-tree extension instead of installed package`

This is low risk and useful. Upstream changed integration tests to run pi with `-ne -e <working tree extension>` so tests exercise the current checkout rather than whatever version is installed as a pi package.

Suggested handling:

- Port this to `test/integration/harness.ts`.
- Account for our broader integration suite and slow-lane split.

## Local cleanup decision now implemented

### Bundled agents and planning slash commands

Relevant commit:

- `48d2513` — `refactor(agents): merge spec agent into planner with lightweight clarification`

Upstream removed the separate package-bundled `spec` agent and folded lightweight requirements clarification into the package-bundled `planner` agent. This fork has now taken a different product direction: no package-bundled agent definitions ship, `pi-extension/subagents/plan-skill.md` has been removed, and neither `/plan` nor `/iterate` is registered. Users provide their own agents in `.pi/agents/` or `~/.pi/agent/agents/`.

Result:

- There is no local bundled `spec`/`planner` workflow left to consolidate.
- `48d2513` remains intentionally unported because the local agent/command cleanup supersedes its local applicability.
- Project-local `.pi/skills/` entries are retained as maintainer workflow documentation; they are not package-bundled agent definitions or extension slash commands.

## Probably skip or already covered

- Release/version commits: `8d803a6`, `2d343e3`, `4c77573`, `e9be4bb`, `265c93b`, `c0e4b35`.
- `eed32a9` (`set_tab_title` cleanup) appears effectively handled locally; no obvious remaining `set_tab_title` usage was found in our subagent plugin.
- Documentation-only upstream updates can be folded in opportunistically if they still apply after local orchestration/headless docs.

## Suggested port order

1. Port integration harness fix (`aa3d34b`).
2. Port resume/auto-exit fixes (`4fe6754`, `2105cf4`).
3. Port tool allowlist preservation (`a0c089a`) while preserving local lifecycle/orchestration reservations.
4. Port mux focus/zellij/Windows improvements (`6e336fe`, `913dc9c`, `d99cd4b`).
5. Plan a dedicated feature branch for activity/status snapshots and `subagent_interrupt` (`9f10962`, `269b485`, `b4b0287`).

No planner/spec workflow consolidation remains to port; the local cleanup removed the bundled planning agents and `/plan` / `/iterate` command surface instead.

## Bottom line

There are useful upstream changes, especially around auto-exit, tool allowlists, pane status supervision, interrupt support, and mux UX. The fork is now far enough ahead in orchestration/headless functionality that we should treat upstream as a source of targeted patches rather than a branch to merge directly. Bundled planning-agent changes from upstream no longer apply directly because this fork now ships no package-bundled agents or planning slash commands.
