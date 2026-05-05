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
5. `TODO-70ce56ca` — P5 Upstream sync: decide bundled agents, commands, and skills cleanup

## Commit ledger

| Commit | Upstream subject | Status | Target / owner | Rationale / notes |
|---|---|---:|---|---|
| `9f10962` | `feat: add configurable subagent status supervision and turn-only interruption` | `TO_BE_PROCESSED` | `TODO-8c06b75d` | High-value pane supervision and interrupt work, but conflicts with local headless/Claude/orchestration observability. Manual port only. |
| `eed32a9` | `fix: remove set_tab_title inadvertently reintroduced for subagents` | `SUPERSEDED_OR_ALREADY_COVERED` | none | Local search found no obvious remaining `set_tab_title` usage in subagent code. Re-check during mux/status work, but no dedicated port planned. |
| `aa3d34b` | `test(integration): load working-tree extension instead of installed package` | `TO_BE_PROCESSED` | `TODO-02d7aa5f` | Low-risk test correctness fix. Integration tests should exercise current checkout via `pi -ne -e <working-tree extension>`. |
| `8d803a6` | `chore(release): v3.4.0` | `EXPLICITLY_OUT_OF_SCOPE` | none | Release/version commit only. |
| `48d2513` | `refactor(agents): merge spec agent into planner with lightweight clarification` | `EXPLICITLY_OUT_OF_SCOPE` | `TODO-70ce56ca` | Workflow/product decision, not part of upstream port. Separate cleanup todo may remove bundled agents/commands/skills entirely. |
| `2d343e3` | `chore(release): v3.5.0` | `EXPLICITLY_OUT_OF_SCOPE` | none | Release/version commit only. |
| `269b485` | `feat(subagents): suppress stall steer messages for interactive subagents` | `TO_BE_PROCESSED` | `TODO-8c06b75d` | Adopt upstream-style `interactive` semantics when status supervision is ported: suppress stall/recovery notifications for user-driven panes only. |
| `4c77573` | `chore(release): v3.5.1` | `EXPLICITLY_OUT_OF_SCOPE` | none | Release/version commit only. |
| `b4b0287` | `feat: replace subagent liveness polling with child activity state (#35)` | `TO_BE_PROCESSED` | `TODO-8c06b75d` | High-value child activity model; must be manually adapted around local headless/Claude/orchestration result paths. |
| `e9be4bb` | `chore(release): v3.6.0` | `EXPLICITLY_OUT_OF_SCOPE` | none | Release/version commit only. |
| `4fe6754` | `fix: auto-exit resumed subagents (#40)` | `TO_BE_PROCESSED` | `TODO-02d7aa5f` | Low-risk behavior fix. Our resume path should set/propagate auto-exit where appropriate. |
| `2105cf4` | `fix(subagents): auto-exit after user-driven normal completion (#42)` | `TO_BE_PROCESSED` | `TODO-02d7aa5f` | Low-risk lifecycle fix. Auto-exit should close after normal completion even after user-driven follow-up; abort/Escape should still leave session open. |
| `a0c089a` | `fix(subagents): preserve child control tools with restricted tools (#41)` | `TO_BE_PROCESSED` | `TODO-02d7aa5f` | Preserve arbitrary requested tools in restrictive Pi `--tools` lists while keeping local lifecycle/orchestration reservations. |
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
