# Upstream sync ledger: HazAT/pi-interactive-subagents v3.7.1

Parent todo: `TODO-356d8c41`

This ledger tracks every upstream commit added to <https://github.com/HazAT/pi-interactive-subagents> since this fork diverged at `52cccd8` / upstream `v3.3.0`.

At initial triage:

- Upstream current: `c0e4b35` / `v3.7.1`
- Divergence: `181` local-only commits, `21` upstream-only commits
- Strategy: targeted ports only; no wholesale upstream merge

## Status vocabulary

- `PROCESSED` — the behavior has been brought into our codebase.
- `TO_BE_PROCESSED` — we have decided to bring the change in, but it has not landed yet.
- `EXPLICITLY_OUT_OF_SCOPE` — we have decided not to bring the change in.
- `UNDECIDED` — no final call yet.
- `SUPERSEDED_OR_ALREADY_COVERED` — upstream change appears unnecessary because the local fork already removed or covered the issue differently.

## Child todos / priority order

1. `TODO-f658acb7` — P1 Upstream sync: maintain v3.7.1 commit ledger and triage statuses
2. `TODO-02d7aa5f` — P2 Upstream sync: port low-risk harness, auto-exit, and tool allowlist fixes
3. `TODO-d779e69b` — P3 Upstream sync: port cmux/tmux mux UX fixes; zellij/WezTerm best-effort
4. `TODO-8c06b75d` — P4 Upstream sync: manually port activity/status supervision and subagent_interrupt
5. `TODO-70ce56ca` — P5 Upstream sync: bundled agent/command cleanup decision implemented; project-local maintainer skills retained

## Commit ledger

| Commit | Upstream subject | Status | Target / owner | Rationale / notes |
|---|---|---:|---|---|
| `9f10962` | `feat: add configurable subagent status supervision and turn-only interruption` | `TO_BE_PROCESSED` | `TODO-8c06b75d` | High-value pane supervision and interrupt work, but conflicts with local headless/Claude/orchestration observability. Manual port only. |
| `eed32a9` | `fix: remove set_tab_title inadvertently reintroduced for subagents` | `SUPERSEDED_OR_ALREADY_COVERED` | none | Local search found no obvious remaining `set_tab_title` usage in subagent code. Re-check during mux/status work, but no dedicated port planned. |
| `aa3d34b` | `test(integration): load working-tree extension instead of installed package` | `PROCESSED` | `TODO-02d7aa5f` | Integration harness now invokes pi with the working-tree extension; locked in by `test/integration/harness-extension.test.ts` (3/3). |
| `09f8a59` | `Merge pull request #29 from w-winter/feat/subagent-status-and-interrupt` | `EXPLICITLY_OUT_OF_SCOPE` | none | Merge commit only. Its tree is identical to second parent `aa3d34b`, so it has no independent changes to port; constituent commits `9f10962`, `eed32a9`, and `aa3d34b` are tracked separately. |
| `8d803a6` | `chore(release): v3.4.0` | `EXPLICITLY_OUT_OF_SCOPE` | none | Release/version commit only. |
| `48d2513` | `refactor(agents): merge spec agent into planner with lightweight clarification` | `SUPERSEDED_OR_ALREADY_COVERED` | `TODO-70ce56ca` | Upstream consolidated package-bundled `spec` into package-bundled `planner`; this fork instead removed package-bundled agents and the `/plan` / `/iterate` command surface. No bundled planner/spec workflow remains to port. Project-local maintainer skills are retained separately from shipped agent/command surface. |
| `2d343e3` | `chore(release): v3.5.0` | `EXPLICITLY_OUT_OF_SCOPE` | none | Release/version commit only. |
| `269b485` | `feat(subagents): suppress stall steer messages for interactive subagents` | `TO_BE_PROCESSED` | `TODO-8c06b75d` | Adopt upstream-style `interactive` semantics when status supervision is ported: suppress stall/recovery notifications for user-driven panes only. |
| `4c77573` | `chore(release): v3.5.1` | `EXPLICITLY_OUT_OF_SCOPE` | none | Release/version commit only. |
| `b4b0287` | `feat: replace subagent liveness polling with child activity state (#35)` | `TO_BE_PROCESSED` | `TODO-8c06b75d` | High-value child activity model; must be manually adapted around local headless/Claude/orchestration result paths. |
| `e9be4bb` | `chore(release): v3.6.0` | `EXPLICITLY_OUT_OF_SCOPE` | none | Release/version commit only. |
| `4fe6754` | `fix: auto-exit resumed subagents (#40)` | `PROCESSED` | `TODO-02d7aa5f` | Resumed pi subagents now auto-exit after follow-up work; covered by `test/orchestration/resume-tool-boundary.test.ts` (62/62) without altering Claude pane/headless semantics. |
| `2105cf4` | `fix(subagents): auto-exit after user-driven normal completion (#42)` | `PROCESSED` | `TODO-02d7aa5f` | Auto-exit closes after user-driven normal completion while Escape/abort still leaves the session inspectable; ported alongside `4fe6754`. |
| `a0c089a` | `fix(subagents): preserve child control tools with restricted tools (#41)` | `PROCESSED` | `TODO-02d7aa5f` | `resolvePiToolsArg` now passes every requested tool name (built-in, extension, or custom) through verbatim and always reserves `caller_ping` + `subagent_done`; coordinator orchestration tokens survive because the filter has been removed. Locked in by `test/orchestration/pi-tools-arg.test.ts` (8/8). |
| `d99cd4b` | `Improves Windows support (#39)` | `TO_BE_PROCESSED` | `TODO-d779e69b` | Lowest-priority compatibility port. Bring in small, low-risk pieces if practical; do not require full Windows validation without environment support. |
| `6e336fe` | `fix: preserve mux focus during subagent launch (#36)` | `TO_BE_PROCESSED` | `TODO-d779e69b` | Required mux UX port for cmux/tmux if compatible with local `focus` / tmux-detached behavior. |
| `913dc9c` | `fix(zellij): use available space for subagent panes (#44)` | `TO_BE_PROCESSED` | `TODO-d779e69b` | Nice-to-have / best-effort zellij port. Do not destabilize required cmux/tmux behavior. |
| `e3c1253` | `docs(skills): update integration-test counts and serialize flag` | `UNDECIDED` | none | Docs-only. Fold in opportunistically if still relevant after local integration-test process is updated. |
| `265c93b` | `chore(release): v3.7.0` | `EXPLICITLY_OUT_OF_SCOPE` | none | Release/version commit only. |
| `5b64684` | `docs(subagents): clarify async/no-poll behavior in tool descriptions` | `UNDECIDED` | none | Docs-only. Revisit after behavior ports so docs match local headless/orchestration semantics. |
| `c0e4b35` | `chore(release): v3.7.1` | `EXPLICITLY_OUT_OF_SCOPE` | none | Release/version commit only. |

## Notes on `interactive`

Decision: adopt upstream-style `interactive` behavior only as part of `TODO-8c06b75d` when status supervision is ported.

Intended semantics:

- `interactive` affects only status supervision notifications.
- It does not affect pane focus.
- It does not affect auto-exit lifecycle.
- It does not suppress completion, failure, or `caller_ping`.
- Default should follow upstream if compatible:
  - `auto-exit: true` → autonomous → `interactive: false`
  - no `auto-exit` / `auto-exit: false` → user-driven → `interactive: true`

## Verification policy

All implementation child todos should use TDD where practical and require:

- `npm run build`
- `npm test`
- full integration suite per the project test skill/process, including slow integration tests when available

Backend acceptance priority:

- Required: cmux, tmux
- Nice-to-have / best effort: zellij, WezTerm
- Windows: low-risk compatibility only unless a Windows validation environment is available
