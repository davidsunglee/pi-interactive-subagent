I've examined the diff, the test results, and the surrounding code. Here's the review.

### Strengths

- **Single source of truth invariant preserved.** `SPAWNING_TOOLS` drives both `resolveDenyTools` (deny-set expansion) and `resolvePiToolsArg` (allowlist filter), as the plan stipulates. No parallel `ORCHESTRATION_TOOLS` constant was introduced. `pi-extension/subagents/launch-spec.ts:159-167,194-203,319-337,509-524`
- **Validator placement guarantees pre-side-effect failure.** `validateSpawningToolsConflict` runs at `launch-spec.ts:551`, and both backends call `resolveLaunchSpec` before any I/O: pane at `index.ts:681` (six lines before `createSurface` at `index.ts:687`) and headless at `headless.ts:182` (200+ lines before `spawnImpl` at `headless.ts:384`). The pane test pins this with a `walk(...)` over `<sessionDir>/artifacts/` asserting no `.sh` was written; the headless test asserts `lastSpawn === null`.
- **Symmetric error wording across backends.** Both pane and headless conflict tests use `assert.rejects(..., /subagent_run_serial/)`, anchoring that the error originates from `validateSpawningToolsConflict` and not from divergent backend-side checks. `test/orchestration/pane-pi-tools-reservation.test.ts:130`, `test/orchestration/headless-pi-tools-reservation.test.ts:128`
- **Strong test coverage for the resolver semantics.** Three new unit cases hit the three meaningful shapes (mixed, orchestration-only, all-six). `test/orchestration/pi-tools-arg.test.ts:50-83`. Plus a regression test pinning that `spawning: false` without orchestration listing still produces the full deny set, with explicit `assert.ok` lines for each of the six SPAWNING_TOOLS members.
- **Cleanup hygiene.** Every new test that uses `mkdtempSync` cleans up in `finally` with `rmSync(..., { force: true })`. The pane conflict test cleans both the project root and session dir.
- **Correct test gating.** The e2e test self-skips on `!PI_AVAILABLE || !SLOW_LANE_OPT_IN`, lives only in `test:integration:slow`, and is absent from `test` and `test:integration`. `package.json:22`, `test/integration/coordinator-orchestration-tools.test.ts:10-19`
- **All checks pass.** `npm test` → 316/316 green, `npm run typecheck` clean, `npm run lint` clean.

### Issues

#### Critical (Must Fix)
None.

#### Important (Should Fix)
None.

#### Minor (Nice to Have)

1. **Validator triggers on `cli: claude` configs that wouldn't reach pi anyway**
   - File: `pi-extension/subagents/launch-spec.ts:509-524`
   - The validator throws on any `spawning: false` × orchestration-token conflict regardless of `effectiveCli`. For `cli: claude`, the orchestration tools aren't even exposed; the throw is still correct (the config is nonsense) but the error message refers only to `spawning: false` and conflicting tokens — a Claude-CLI user might be puzzled why "subagent_run_serial" matters at all.
   - Impact: low — probably never hit, since coordinators must run on `cli: pi` per the README contract.
   - Fix (optional): no change needed; if anything, the README's prong 1 already explains this.

2. **README YAML example omits `description:` while bundled coordinators include one**
   - File: `README.md:108-114`
   - The minimal example shows `name`, `cli`, `tools` only. Real coordinator agents almost always carry `description:` (used by listings). Not wrong — the example is intentionally minimal — but a reader could copy-paste it and end up with a discoverability gap.
   - Impact: very low. Stylistic.

3. **Integration test's `model: anthropic/claude-haiku-4-5` is hardcoded**
   - File: `test/integration/agents/test-coordinator.md:4`
   - Matches the existing `test-echo.md` style, so this is consistent — but slow-lane runs that lack credentials for the Anthropic provider will fail rather than skip. The plan accepts this tradeoff (slow lane is opt-in via `PI_RUN_SLOW=1`), so this is informational.

4. **Pane conflict test's `as any` casts on `ctx` and `params`**
   - File: `test/orchestration/pane-pi-tools-reservation.test.ts:122,127`
   - The pre-existing `captureLaunchScript` helper already uses `as any` casts, so this is consistent with the file's style. Minor type-safety drift; not a regression.

### Recommendations

- The plan is implemented faithfully end-to-end with test coverage at every layer (unit / pane / headless / e2e / docs) and no scope creep. No further changes required to land.
- Consider a future tightening: if the conflict error fires on `cli: claude` configs, append a one-line hint pointing the user at the README's "Coordinator agents" section. Not blocking.

### Assessment

**Ready to merge: Yes**

**Reasoning:** The diff exactly matches the plan: resolver retains `SPAWNING_TOOLS` tokens via a single-source-of-truth filter, the validator is wired into `resolveLaunchSpec` so both backends throw symmetrically before any side effect, and tests at every layer pin the contract (including pane "no dangling launch script" and headless "no spawn" invariants). Typecheck, lint, and the full 316-test suite all pass.
