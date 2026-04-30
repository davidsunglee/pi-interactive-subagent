# Orchestration result artifacts for full child finalMessage propagation

Source: TODO-6f3a2c91

## Goal

Make orchestration result propagation reliable for any-size child output. Today, both `subagent_run_serial` and `subagent_run_parallel` truncate each child's `finalMessage` to a single 200-character first-line preview before the coordinator's model sees the tool result, leaving coordinators (e.g. a `plan-refiner` driving review/remediation loops) unable to persist review artifacts, parse findings, or launch follow-on passes. Replace the truncated preview with a per-task artifact file: write each child's full `finalMessage` to disk under the existing session artifact directory and expose its location through a new first-class field on the orchestration result. Coordinators always read the artifact for the full body; the inline `finalMessage` field on the runtime result stays populated so internal stitching like `{previous}` substitution keeps working unchanged.

## Context

The orchestration tools (`subagent_run_serial`, `subagent_run_parallel`, `subagent_run_cancel`) live in `pi-extension/orchestration/tool-handlers.ts` and aggregate per-task results from `pi-extension/orchestration/run-serial.ts` and `pi-extension/orchestration/run-parallel.ts`. Each task resolves to an `OrchestrationResult` (`pi-extension/orchestration/types.ts:48`) carrying `finalMessage` plus terminal metadata; tool handlers project these into `OrchestratedTaskResult[]` (`types.ts:70`) for return.

Today the tool handler emits two channels:

- `content` — the array the LLM sees as the tool result. Built by `summarize()` (`tool-handlers.ts:437`) which truncates each task's `finalMessage` to its first non-blank line capped at 200 chars via `firstLine()` (`tool-handlers.ts:445`).
- `details` — full structured payload. Documented in `node_modules/@mariozechner/pi-agent-core/dist/types.d.ts:262` as "Arbitrary structured details for logs or UI rendering." Not delivered to the model.

The async path is even thinner: `tryFinalize()` in `pi-extension/orchestration/registry.ts:155` emits an `orchestration_complete` payload that the message bridge at `pi-extension/subagents/index.ts:1227` ships as a steer with `content` of just `Orchestration "<id>" completed (<n> task(s), isError=<bool>)` — no per-task body at all. Full payload again only in `details`.

For comparison, the bare `subagent` tool's terminal steer (`pi-extension/subagents/index.ts:1397`) inlines the full `finalMessage` directly into `content` so the model sees the whole body. The orchestration wrappers diverge from that contract.

The codebase already has an artifact-directory pattern: `getArtifactDir(sessionDir, sessionId)` at `pi-extension/subagents/launch-spec.ts:403` returns `<sessionDir>/artifacts/<sessionId>/`. `writeSystemPromptArtifact` and `writeTaskArtifact` (`launch-spec.ts:673`, `launch-spec.ts:694`) write child sysprompt and task-body artifacts under `<artifactDir>/context/`. None of these are auto-cleaned; archived Claude transcripts under `~/.pi/agent/sessions/claude-code/` also persist indefinitely. Children dispatched as workers/reviewers commonly run with restrictive `tools:` allowlists that omit `write` — every existing artifact in this directory is written by the parent's pi extension, not by the child.

`finalMessage` is captured by the parent's watcher in `watchSubagent` (`pi-extension/subagents/index.ts:956`) for the pane backend and in the equivalent paths inside `pi-extension/subagents/backends/headless.ts`, then surfaced as `BackendResult.finalMessage` (`pi-extension/subagents/backends/types.ts:32`). `runSerial` uses `result.finalMessage` for `{previous}` substitution at `run-serial.ts:190`. Per-step `onUpdate` callbacks (`run-serial.ts:110`, `run-parallel.ts` equivalent) feed the widget UI with `summarizeInflight()` snapshots; partial updates are not delivered to the model.

`tryFinalize`'s existing memory hygiene (`registry.ts:183-188`) strips heavy `transcript`/`usage` fields off in-memory tombstones once an orchestration completes. `finalMessage` is currently retained on those tombstones.

A prior TODO (`.pi/todos/cd852fb0.md`, 2026-04-22) addressed an empty-`finalMessage` regression on the serial path; that fix is unrelated — the field is now reliably populated, just truncated before the LLM sees it.

## Requirements

- After every task in `runSerial` / `runParallel` reaches a terminal state with non-empty `finalMessage`, the parent process writes that `finalMessage` verbatim to a per-task artifact file under `<sessionDir>/artifacts/<sessionId>/orchestrations/<orchestrationId>/task-<index>.md`. The directory is created on demand. The file contents are the child's last assistant message body, byte-for-byte, with no wrapper, header, or framing added.
- `OrchestratedTaskResult` (`pi-extension/orchestration/types.ts`) gains a new optional field `artifactPath` (string | null). It is populated whenever the artifact was written; it is `null` (or absent) when no artifact was written (e.g. empty `finalMessage`, capture failure, cancelled-before-completion).
- `OrchestratedTaskResult.finalMessage` continues to be populated at runtime with the same body the artifact contains. Existing in-process consumers (notably `runSerial`'s `{previous}` substitution at `run-serial.ts:190`) keep reading from `finalMessage` and do **not** perform file I/O between steps.
- The sync `subagent_run_serial` and `subagent_run_parallel` tool results return `content` text matching this shape:

  ```
  <serial|parallel> orchestration: <N> task(s), isError=<bool>
  Each task's full final message is at the artifact path. Read it before acting on the result.
  - <name>: exit=<code> (<ms>ms) — artifact: <path>
  ...
  ```

  When a task has no artifact, its row says `artifact: (none)` and the model is expected to fall through to error/exit-code reasoning for that task.

- The async `orchestration_complete` steer's `content` (currently emitted at `pi-extension/subagents/index.ts:1227`) carries the same hint line + per-task `artifact:` rows. The steer continues to identify itself with `Orchestration "<id>" completed (<N> task(s), isError=<bool>)` as its first line so coordinators can correlate by orchestrationId.
- Artifact writes are performed by the parent's pi extension. Children do not need `write` in their `tools:` allowlist. The `tools:` contract on dispatched children is unchanged.
- The registry's `tryFinalize` memory hygiene is extended so that, once `artifactPath` is populated on a tombstoned task, the in-memory `finalMessage` field on that tombstone is dropped. The steer payload emitted by `tryFinalize` still carries both fields (it is constructed before the strip); only the long-lived in-memory entry is leaned out.
- Per-step `onUpdate` snapshots in `runSerial`/`runParallel` (`summarizeInflight`) are unchanged. They feed the widget UI; the model does not see them, and changing their format is out of scope.
- Both `cli: pi` and `cli: claude` children (and both the `pane` and `headless` backends) participate equally — artifact writing happens after the parent's existing capture chain (sentinel → transcript JSONL → screen scrape) resolves, regardless of which backend produced the body.

## Constraints

- No change to children's `tools:` allowlist contract. Children continue to NOT need `write`. Artifact writes are done by the parent's orchestration glue code.
- No change to `BackendResult.finalMessage` capture or shape. The existing sentinel-file → transcript-JSONL → screen-scrape chain is correct and stays untouched.
- No automatic cleanup of artifact files. Artifacts persist alongside existing session artifacts (sysprompt, task body, archived Claude transcripts), all of which already accumulate without any sweep. A separate TODO covers cleanup once real disk-pressure data exists.
- The existing sync-vs-async dispatch model (`wait: true` returns inline; `wait: false` returns envelope + steer) is preserved. Only the result-content shape changes, not the dispatch surface.
- The bare `subagent` tool path (`pi-extension/subagents/index.ts:1325`) is out of scope. Its terminal steer already inlines `finalMessage` and is unchanged.
- The `subagent_resume` standalone terminal steer (`pi-extension/subagents/index.ts:1924`) is out of scope. It already inlines the full body.
- No new env vars or configuration knobs for the artifact layout. The path follows the existing `getArtifactDir` convention without surface configurability.
- No new tools, new schemas, or new MCP surfaces to retrieve artifacts — coordinators read them with whatever read primitive their `tools:` allowlist already grants.

## Acceptance Criteria

- A `subagent_run_serial` call where each child returns a multi-line markdown final message yields a tool result whose `content` text contains the hint line and an `artifact:` path per task; reading those files returns the children's `finalMessage` bodies verbatim with no truncation, encoding change, or added framing.
- A `subagent_run_parallel` call satisfies the same property.
- An async (`wait: false`) `subagent_run_serial` call delivers an `orchestration_complete` steer whose `content` text includes the hint line and per-task `artifact:` rows in the same shape as the sync result.
- `OrchestratedTaskResult.artifactPath` is populated for every completed task with non-empty `finalMessage` and is `null` (or absent) when no artifact was written.
- A coordinator-style integration test launches a real pi-CLI child that emits a multi-finding markdown review; the parent recovers the full review text by reading `artifactPath`; the body matches the child's last assistant message exactly.
- A long-output regression test (≥ 50KB markdown body) round-trips through the artifact path with no truncation. The test removes the long-output artifact file before teardown so the test directory is not left polluted.
- `runSerial`'s `{previous}` substitution still works — a 2-step serial pipeline where step 2 references `{previous}` produces the correct stitched task string with no file I/O between steps.
- A child running with restrictive `tools: read, grep` (no `write`) successfully completes inside an orchestration and its artifact is written by the parent. Exercised under both the `pane` and `headless` backends.
- Registry memory after `tryFinalize` does not retain per-task `finalMessage` strings once `artifactPath` is set, verifiable via a unit test against the registry tombstones.
- The existing `orchestration_complete` widget renderer (`registerMessageRenderer("orchestration_complete", ...)` at `pi-extension/subagents/index.ts:2140`) continues to render without errors against the new `content` text shape.

## Non-Goals

- No artifact cleanup mechanism (TTL sweep, session-end purge, finalize-time delete). Captured by a separate TODO once disk-usage data exists.
- No change to the bare `subagent` tool, `subagent_resume`, or any `caller_ping`/blocked-task content shapes. They already inline the full body.
- No change to the per-step `onUpdate` (live progress) snapshots in `runSerial` / `runParallel`. They are UI-facing only.
- No new tools, schemas, or APIs for artifact retrieval.
- No deprecation of `finalMessage` on `OrchestratedTaskResult`. It remains the in-memory convenience field for `{previous}` substitution and other in-process consumers.
- No change to `BackendResult` shape, the capture chain, or backend selection logic.
- No change to the public dispatch API (`wait: true|false`, parameter shapes, error envelopes, async cancel).
- No modification of bundled in-tree agent definitions under `agents/`. Downstream coordinator agents (e.g. `plan-refiner`, `code-refiner`) are out of repo and adopt the new contract on their own schedule.

## Open Questions

- None.
