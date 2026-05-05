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
| `9f10962` | `feat: add configurable subagent status supervision and turn-only interruption` | `PROCESSED` | `TODO-8c06b75d` | Status supervision + activity recording ported with local divergences in (i) headless activity wiring, (ii) blocked-row precedence, (iii) `subagent_interrupt` headless rejection branch. See `docs/plans/2026-05-05-subagent-status-supervision-and-interrupt.md`, `test/integration/pane-pi-status-supervision.test.ts`, `test/integration/headless-pi-status-supervision.test.ts`, and `test/integration/orchestration-blocked-supervision.test.ts`. |
| `eed32a9` | `fix: remove set_tab_title inadvertently reintroduced for subagents` | `SUPERSEDED_OR_ALREADY_COVERED` | none | Local search found no obvious remaining `set_tab_title` usage in subagent code. Re-check during mux/status work, but no dedicated port planned. |
| `aa3d34b` | `test(integration): load working-tree extension instead of installed package` | `PROCESSED` | `TODO-02d7aa5f` | Integration harness now invokes pi with the working-tree extension; locked in by `test/integration/harness-extension.test.ts` (3/3). |
| `09f8a59` | `Merge pull request #29 from w-winter/feat/subagent-status-and-interrupt` | `EXPLICITLY_OUT_OF_SCOPE` | none | Merge commit only. Its tree is identical to second parent `aa3d34b`, so it has no independent changes to port; constituent commits `9f10962`, `eed32a9`, and `aa3d34b` are tracked separately. |
| `8d803a6` | `chore(release): v3.4.0` | `EXPLICITLY_OUT_OF_SCOPE` | none | Release/version commit only. |
| `48d2513` | `refactor(agents): merge spec agent into planner with lightweight clarification` | `SUPERSEDED_OR_ALREADY_COVERED` | `TODO-70ce56ca` | Upstream consolidated package-bundled `spec` into package-bundled `planner`; this fork instead removed package-bundled agents and the `/plan` / `/iterate` command surface. No bundled planner/spec workflow remains to port. Project-local maintainer skills are retained separately from shipped agent/command surface. |
| `2d343e3` | `chore(release): v3.5.0` | `EXPLICITLY_OUT_OF_SCOPE` | none | Release/version commit only. |
| `269b485` | `feat(subagents): suppress stall steer messages for interactive subagents` | `PROCESSED` | `TODO-8c06b75d` | Adopt upstream-style `interactive` semantics when status supervision is ported: suppress stall/recovery notifications for user-driven panes only. Ported with local divergences in (i) headless activity wiring, (ii) blocked-row precedence, (iii) `subagent_interrupt` headless rejection branch. See `docs/plans/2026-05-05-subagent-status-supervision-and-interrupt.md` and `test/integration/pane-pi-status-supervision.test.ts`. |
| `4c77573` | `chore(release): v3.5.1` | `EXPLICITLY_OUT_OF_SCOPE` | none | Release/version commit only. |
| `b4b0287` | `feat: replace subagent liveness polling with child activity state (#35)` | `PROCESSED` | `TODO-8c06b75d` | High-value child activity model; manually adapted around local headless/Claude/orchestration result paths with divergences in (i) headless activity wiring, (ii) blocked-row precedence, (iii) `subagent_interrupt` headless rejection branch. See `docs/plans/2026-05-05-subagent-status-supervision-and-interrupt.md`, `test/integration/headless-pi-status-supervision.test.ts`, and `test/integration/orchestration-blocked-supervision.test.ts`. |
| `e9be4bb` | `chore(release): v3.6.0` | `EXPLICITLY_OUT_OF_SCOPE` | none | Release/version commit only. |
| `4fe6754` | `fix: auto-exit resumed subagents (#40)` | `PROCESSED` | `TODO-02d7aa5f` | Resumed pi subagents now auto-exit after follow-up work; covered by `test/orchestration/resume-tool-boundary.test.ts` (62/62) without altering Claude pane/headless semantics. |
| `2105cf4` | `fix(subagents): auto-exit after user-driven normal completion (#42)` | `PROCESSED` | `TODO-02d7aa5f` | Auto-exit closes after user-driven normal completion while Escape/abort still leaves the session inspectable; ported alongside `4fe6754`. |
| `a0c089a` | `fix(subagents): preserve child control tools with restricted tools (#41)` | `PROCESSED` | `TODO-02d7aa5f` | `resolvePiToolsArg` now passes every requested tool name (built-in, extension, or custom) through verbatim and always reserves `caller_ping` + `subagent_done`; coordinator orchestration tokens survive because the filter has been removed. Locked in by `test/orchestration/pi-tools-arg.test.ts` (8/8). |
| `d99cd4b` | `Improves Windows support (#39)` | `PROCESSED` | `TODO-d779e69b` | Ported the two upstream Windows fixes verbatim: `hasCommand` now prefers `where.exe` on win32 with `command -v` fallback, and `pi-extension/subagents/index.ts` resolves bundled paths via `dirname(fileURLToPath(import.meta.url))` through a `SUBAGENTS_DIR` constant. Locked in by the existing `npm run build` / `npm test` gates on macOS; full Windows validation deferred (no win32 environment available). Two local-only call sites in `pi-extension/subagents/launch-spec.ts` and `pi-extension/subagents/backends/headless.ts` still use the unsafe `URL#pathname` form; tracked for a follow-up since they were not part of the upstream commit. |
| `6e336fe` | `fix: preserve mux focus during subagent launch (#36)` | `PROCESSED` | `TODO-d779e69b` | cmux focus snapshot/restore + detached tmux split-window are in place via commit `0c13ee3`; locked in by `parseCmuxFocusedSnapshot` / `parseCmuxPaneRefForSurface` / `buildTmuxSplitArgs` / `shouldSetTmuxPaneTitle` unit suites in `test/test.ts`. Local `focus: false` orchestration semantics are preserved. |
| `913dc9c` | `fix(zellij): use available space for subagent panes (#44)` | `PROCESSED` | `TODO-d779e69b` | Ported the tab-aware tiled-vs-stacked Zellij placement helpers and the `createZellijSurface` lock/selector path; cmux/tmux/wezterm code paths are untouched. Pure helpers (`predictZellijSplitDirection`, `canSplitZellijPane`, `selectZellijPlacement`, `selectZellijStackPlacement`) are exported and locked in by 8 new unit cases in `test/test.ts`. Harness now probes zellij when present; we have no local zellij runtime, so no live integration coverage was attempted. |
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
