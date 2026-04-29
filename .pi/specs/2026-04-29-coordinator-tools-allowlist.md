# Coordinator subagents retain orchestration tools under restrictive `tools:` allowlists

Source: TODO-2524bd1c

## Goal

Coordinator agents (e.g., pi-config's `plan-refiner`, `code-refiner`) need to dispatch child subagents while running under a tightened `tools:` allowlist. Today the launch-time tool-resolution path drops orchestration tool tokens (`subagent_run_serial`, `subagent_run_parallel`, etc.) before pi receives `--tools`, leaving the coordinator unable to call them. Allow these tokens to survive resolution when explicitly listed by the agent, validate the misconfiguration where `spawning: false` and an explicit orchestration listing collide, and document the new contract so future coordinators are configured correctly.

## Context

`pi-extension/subagents/launch-spec.ts` already defines `SPAWNING_TOOLS` (the six orchestration tool names: `subagent`, `subagents_list`, `subagent_resume`, `subagent_run_serial`, `subagent_run_parallel`, `subagent_run_cancel`) and uses it as the deny-set expansion when an agent declares `spawning: false`. Today:

- `resolvePiToolsArg(effectiveTools)` filters `effectiveTools` down to `PI_BUILTIN_TOOLS` (the seven pi builtins) and reserves lifecycle tools (`caller_ping`, `subagent_done`). Any token outside the seven builtins is dropped before `--tools` is emitted.
- Both backends emit `--tools` from this same resolver: pane at `pi-extension/subagents/index.ts:799` and headless at `pi-extension/subagents/backends/headless.ts:353`.
- `resolveDenyTools()` expands `spawning: false` into the deny set, which is propagated to children via `PI_DENY_TOOLS` and enforced inside the pi extension at tool-call time (`pi-extension/subagents/subagent-done.ts:101`, `pi-extension/subagents/index.ts:1317`).
- Existing test surface: `test/orchestration/pi-tools-arg.test.ts` (resolver), `test/orchestration/pane-pi-tools-reservation.test.ts` (pane launch-script emission), `test/orchestration/headless-pi-tools-reservation.test.ts` (headless argv emission).
- Bundled agents in `agents/` (`worker`, `scout`, `reviewer`, etc.) are all worker-style with `spawning: false`. There are no in-repo coordinator examples; downstream coordinators (e.g., pi-config's `plan-refiner`, `code-refiner`) consume this contract.
- README's "Tool restriction" paragraph (~line 96) describes worker-side allowlist behavior but does not document the coordinator contract.

## Requirements

- `resolvePiToolsArg()` keeps tokens from both `PI_BUILTIN_TOOLS` and `SPAWNING_TOOLS`. The same `SPAWNING_TOOLS` constant that drives `resolveDenyTools()` drives the allowlist filter — single source of truth.
- A restrictive `--tools` allowlist is emitted whenever at least one builtin **or** orchestration token is present after filtering. Lifecycle tools (`caller_ping`, `subagent_done`) are reserved on every emission.
- A `tools:` declaration containing only unmapped names (e.g., `weird, nonexistent`) still resolves to no `--tools` emission — no lifecycle-only allowlist.
- An agent declaring **both** `spawning: false` **and** any `SPAWNING_TOOLS` member in `tools:` fails at launch with an error that names the conflicting tool(s). The contradiction is rejected immediately rather than left as a runtime denial via `PI_DENY_TOOLS`. Pane and headless paths fail symmetrically.
- Worker agents with `spawning: false` and no orchestration listing in `tools:` retain today's behavior — orchestration tools denied through `PI_DENY_TOOLS`.
- `cli: "pi"` remains the only path on which orchestration tool dispatch works; the Claude pane/headless backends are unchanged by this work.

## Constraints

- No change to `PI_BUILTIN_TOOLS`, lifecycle reservation semantics, the `PI_DENY_TOOLS` env-var contract, or the Claude pane/headless tool-mapping path.
- Reuse `SPAWNING_TOOLS` — do not introduce a parallel `ORCHESTRATION_TOOLS` constant.
- The launch-time validation must surface the conflict from a path both backends invoke, so pane and headless fail with the same error shape.
- The new orchestration-token allowlist applies only when an agent explicitly lists the tool(s) in `tools:`. Default (unrestricted) tool surfaces are unchanged.

## Acceptance Criteria

- `resolvePiToolsArg("read, subagent_run_serial")` returns a `--tools` value containing `read`, `subagent_run_serial`, `caller_ping`, and `subagent_done`.
- `resolvePiToolsArg("subagent_run_serial")` returns a `--tools` value containing `subagent_run_serial`, `caller_ping`, and `subagent_done` (not `undefined`).
- `resolvePiToolsArg("weird, nonexistent")` still returns `undefined` — unknown-only declarations do not emit a lifecycle-only allowlist.
- A pane pi launch with `tools: read, subagent_run_serial` writes a launch script whose `--tools` argv contains all four expected tokens (`read`, `subagent_run_serial`, `caller_ping`, `subagent_done`).
- A headless pi launch with `tools: read, subagent_run_serial` spawns pi with `--tools` argv containing all four expected tokens.
- An agent declaring `spawning: false` together with any `SPAWNING_TOOLS` member in `tools:` fails at launch with an explicit, tool-naming error — observed identically on pane and headless paths.
- An end-to-end integration test launches a pi-backed coordinator with `tools: ..., subagent_run_serial`, the coordinator successfully invokes `subagent_run_serial` against a child, and the child completes.
- Worker agents (`spawning: false`, no orchestration tools listed) still receive `PI_DENY_TOOLS` covering all `SPAWNING_TOOLS` members — no regression.
- README has a new "Coordinator agents" subsection documenting both prongs of the contract (must run on `cli: "pi"`; must explicitly list required orchestration tools when using restrictive `tools:`) with at least one minimal `tools:` example.

## Non-Goals

- Do not enable Claude CLI coordinator sessions to call pi orchestration tools. Coordinators that dispatch children must run on `cli: "pi"`.
- Do not grant orchestration tools to worker agents with `spawning: false` (the new launch-time validation is the rejection path for that misconfiguration).
- Do not grant orchestration tools by default to every restrictive agent — explicit listing in `tools:` is required.
- Do not weaken or alter lifecycle tool injection (`caller_ping`, `subagent_done`) or the `PI_DENY_TOOLS` enforcement path.
- Do not modify bundled agents (`worker`, `scout`, `reviewer`, etc.) in this repo. Downstream coordinator updates (e.g., pi-config's `plan-refiner`, `code-refiner`) are out of scope here.

## Open Questions

- None.
