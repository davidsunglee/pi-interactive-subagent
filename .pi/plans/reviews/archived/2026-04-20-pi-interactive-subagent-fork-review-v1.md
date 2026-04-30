# Review: `2026-04-20-pi-interactive-subagent-fork.md`

Reviewed: 2026-04-20
Plan: `.pi/plans/2026-04-20-pi-interactive-subagent-fork.md`
Verdict: **Needs revision before implementation**

## Summary

The plan is thoughtful and fairly concrete, but it has a few internal contradictions and at least two implementation bugs baked into the proposed steps. I would not execute it as-is.

## Blocking findings

### 1) Per-tool deny gating is broken for the new orchestration tools

- Task 20 adds:
  - `if (shouldRegister("subagent_serial") || shouldRegister("subagent_parallel")) { registerOrchestrationTools(...) }`
- Task 19's `registerOrchestrationTools()` then registers **both** tools unconditionally.

Result: if one of the two tools is denied, but the other is allowed, both still get registered.

This conflicts with the current `shouldRegister(...)` behavior and also undermines the intended `spawning: false` / deny-tools gating.

### 2) The transcript/sentinel design is internally inconsistent, and Claude transcript paths get lost

The architecture section says the orchestration core should work through injected launcher + sentinel wait + transcript read.

The plan then adds:
- `sentinel-wait.ts`
- `transcript-read.ts`

But Task 17 bypasses both and wires default deps directly to `watchSubagent()`.

Consequences:
- the new `sentinel-wait.ts` / `transcript-read.ts` path is effectively dead code from the main orchestration path
- `OrchestrationResult.transcriptPath` cannot be populated correctly for Claude, because Task 17 maps:
  - `transcriptPath: sub.sessionFile ?? null`
- for Claude, `watchSubagent()` returns `claudeSessionId`, but not a transcript path

So the plan simultaneously promises transcript-read-backed results and implements a watchSubagent-backed result shape that cannot carry the promised Claude transcript path.

### 3) `caller_ping` is not actually surfaced correctly in orchestration results

Task 17's comment says reusing `watchSubagent()` will inherit ping handling and surface it on the orchestration result.

But the proposed mapping only returns:
- `finalMessage`
- `transcriptPath`
- `exitCode`
- `elapsedMs`
- `sessionId`
- `error`

It does **not** map `sub.ping` into anything.

That means a task that exits via `caller_ping` would not be represented distinctly by `subagent_serial` / `subagent_parallel`, despite the Task 17 comment claiming that behavior is inherited.

### 4) The orchestration task schema exposes fields that are never wired

Task 8 adds these fields to `OrchestrationTaskSchema`:
- `interactive`
- `permissionMode`

But Task 17 does not pass them into `launchSubagent()`, and current `SubagentParams` does not support them either.

So the plan would expose parameters that are silently ignored. That's a UX/API bug and should be fixed before implementation.

## Non-blocking findings

### 5) The plan still misses an existing test file in `npm test`

Task 1 rewrites the test script to:

```json
"test": "node --test test/test.ts test/orchestration/*.test.ts"
```

But this repo already has `test/system-prompt-mode.test.ts` in addition to `test/test.ts`.

So the final sweep's claim of running the unit suite is overstated. This is already a coverage gap today, but the plan should either:
- include that file in the verification flow, or
- explicitly say it remains outside `npm test`

### 6) Cancellation is not really designed through

`runSerial` / `runParallel` reserve future abort support, and tool handlers receive an AbortSignal, but the proposed orchestration flow does not propagate cancellation from the tool execution signal into the running waits.

That's probably acceptable for v1, but it should be called out explicitly rather than implied as future plumbing already present.

### 7) Final file-layout check is missing one planned test file

Task 23's expected listing includes:
- `run-parallel.test.ts`
- `run-serial.test.ts`
- `sentinel-wait.test.ts`
- `thinking-effort.test.ts`
- `transcript-read.test.ts`

But it omits the plan's own `test/orchestration/tool-handlers.test.ts`.

Minor, but it means the final verification checklist does not actually match the plan's intended file set.

## Recommended revisions

1. **Fix tool registration gating**
   - Either register `subagent_serial` and `subagent_parallel` separately in `index.ts`, or pass a `shouldRegister` callback into `registerOrchestrationTools()`.

2. **Choose one orchestration completion path and make it consistent**
   - Either:
     - use `watchSubagent()` as the real completion primitive and extend its return shape to include `transcriptPath` / ping classification, **or**
     - use the new `sentinel-wait.ts` + `transcript-read.ts` from `makeDefaultDeps()` and stop claiming the orchestration path reuses `watchSubagent()` end-to-end.

3. **Remove or implement dead schema fields**
   - Drop `interactive` / `permissionMode` from `OrchestrationTaskSchema`, or fully plumb them through if they are truly required.

4. **Tighten verification**
   - Decide what the real unit-test command is.
   - Update the final file-layout assertion so it matches the files the plan creates.

## Bottom line

The plan is close, but I would revise it before execution. The main problems are:
- incorrect registration gating
- inconsistent orchestration completion design
- unsupported parameters in the public schema

Once those are fixed, the rest of the plan looks implementable.
