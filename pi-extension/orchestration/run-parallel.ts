import {
  DEFAULT_PARALLEL_CONCURRENCY,
  MAX_PARALLEL_HARD_CAP,
  type LauncherDeps,
  type OrchestratedTaskResult,
  type OrchestrationResult,
  type OrchestrationTask,
} from "./types.ts";

export interface RunParallelOpts {
  maxConcurrency?: number;
  /**
   * Tool-execution AbortSignal. When aborted: in-flight task waits are
   * interrupted and those tasks record a "cancelled" synthetic result;
   * workers stop claiming new tasks; any tasks not yet launched at abort
   * time are filled with synthetic "cancelled" results at their INPUT
   * index so the returned `results` array length always matches
   * `tasks.length`. `isError` is set to `true` when any cancellation
   * occurs.
   */
  signal?: AbortSignal;
  /**
   * Tool-framework onUpdate callback. When set, per-task partial snapshots
   * are wrapped in the tool-framework `{ content, details }` shape and
   * forwarded. The details payload carries the full in-flight results
   * array (input-indexed, with `undefined` slots for unstarted tasks) so
   * the UI can render a live-updating grid.
   */
  onUpdate?: (content: {
    content: { type: "text"; text: string }[];
    details: any;
  }) => void;
  /**
   * Registry hook: called just after `deps.launch` resolves. `sessionKey` is
   * the stable resume-addressable identifier for the launched child.
   */
  onLaunched?: (taskIndex: number, info: { sessionKey?: string }) => void;
  /** Registry hook: called once per task as soon as its terminal state is known. */
  onTerminal?: (taskIndex: number, result: OrchestratedTaskResult) => void;
  /**
   * Registry hook: called mid-run as soon as the child's resume-addressable
   * session key is known. For pi children this fires immediately after launch;
   * for Claude children it fires once the Claude process writes its session
   * pointer file. Must be called BEFORE any blocked notification so the
   * registry ownership map is populated before the parent can resume.
   */
  onSessionKey?: (taskIndex: number, sessionKey: string) => void;
  /**
   * Async-mode hook: when set, a ping-carrying step is routed here instead of
   * terminalized. The worker returns without filling results[i] — the registry
   * owns that slot. In async mode, undefined results slots are left alone
   * (the post-loop sweep skips them when onBlocked is set).
   */
  onBlocked?: (taskIndex: number, payload: { sessionKey: string; message: string; partial: OrchestratedTaskResult }) => void;
}

export interface RunParallelOutput {
  results: OrchestrationResult[];
  isError: boolean;
}

export async function runParallel(
  tasks: OrchestrationTask[],
  opts: RunParallelOpts,
  deps: LauncherDeps,
): Promise<RunParallelOutput> {
  const cap = opts.maxConcurrency ?? DEFAULT_PARALLEL_CONCURRENCY;
  if (cap > MAX_PARALLEL_HARD_CAP) {
    throw new Error(
      `subagent_run_parallel: maxConcurrency=${cap} exceeds hard cap ${MAX_PARALLEL_HARD_CAP}. Split into sub-waves.`,
    );
  }
  if (cap < 1) {
    throw new Error(`subagent_run_parallel: maxConcurrency=${cap} must be >= 1.`);
  }

  const results: OrchestrationResult[] = new Array(tasks.length);
  let nextIdx = 0;
  let isError = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (opts.signal?.aborted) return;
      const i = nextIdx++;
      if (i >= tasks.length) return;
      const raw = tasks[i];
      const task: OrchestrationTask = {
        ...raw,
        name: raw.name ?? `task-${i + 1}`,
      };
      // Normalize thrown errors into a synthetic failing result so one
      // worker's throw does not reject Promise.all and cancel siblings.
      // The failing result is placed at the task's INPUT index so the
      // aggregated array remains input-ordered.
      const startedAt = Date.now();
      let result: OrchestrationResult;
      const stepOnUpdate = opts.onUpdate
        ? (partial: OrchestrationResult) => {
            const inflight = results.slice();
            inflight[i] = partial;
            opts.onUpdate!({
              content: [
                { type: "text", text: summarizeInflightParallel(inflight) },
              ],
              details: { results: inflight, isError: false, inflight: true },
            });
          }
        : undefined;
      try {
        const handle = await deps.launch(task, false /* defaultFocus */, opts.signal);
        opts.onLaunched?.(i, { sessionKey: handle.sessionKey });
        result = await deps.waitForCompletion(handle, opts.signal, stepOnUpdate, {
          onSessionKey: (sessionKey) => opts.onSessionKey?.(i, sessionKey),
        });
      } catch (err: any) {
        result = {
          name: task.name!,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 1,
          elapsedMs: Date.now() - startedAt,
          error: err?.message ?? String(err),
        };
      }
      if (result.ping) {
        if (opts.onBlocked && result.sessionKey) {
          opts.onBlocked(i, {
            sessionKey: result.sessionKey,
            message: result.ping.message,
            partial: {
              name: result.name,
              index: i,
              state: "blocked",
              finalMessage: result.finalMessage,
              transcriptPath: result.transcriptPath ?? null,
              elapsedMs: result.elapsedMs,
              exitCode: result.exitCode,
              sessionKey: result.sessionKey,
              usage: result.usage,
              transcript: result.transcript,
            },
          });
          // Leave results[i] undefined — registry owns this slot. Worker exits normally.
          return;
        }
        // Sync path: fold ping.message into finalMessage and mark as completed.
        result = { ...result, finalMessage: result.ping.message, state: "completed" };
        // Fall through to results[i] = result.
      }

      result.index = i;
      result.state = result.exitCode === 0 && !result.error ? "completed" : "failed";
      results[i] = result;
      opts.onTerminal?.(i, {
        name: result.name,
        index: i,
        state: result.state,
        finalMessage: result.finalMessage,
        transcriptPath: result.transcriptPath ?? null,
        elapsedMs: result.elapsedMs,
        exitCode: result.exitCode,
        sessionKey: result.sessionKey,
        error: result.error,
        usage: result.usage,
        transcript: result.transcript,
      });
      if (result.exitCode !== 0 || result.error) {
        isError = true;
      }
    }
  }

  const workers = Array.from({ length: Math.min(cap, tasks.length) }, () => worker());
  await Promise.all(workers);

  if (opts.signal?.aborted) {
    for (let i = 0; i < tasks.length; i++) {
      if (!results[i]) {
        // In async mode (onBlocked set), undefined slots are registry-owned
        // blocked slots. Leave them alone — the registry handles their cleanup.
        if (opts.onBlocked) continue;
        const raw = tasks[i];
        const cancelledResult: OrchestrationResult = {
          name: raw.name ?? `task-${i + 1}`,
          index: i,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 1,
          elapsedMs: 0,
          error: "cancelled",
          state: "cancelled",
        };
        results[i] = cancelledResult;
        opts.onTerminal?.(i, {
          name: cancelledResult.name,
          index: i,
          state: "cancelled",
          finalMessage: cancelledResult.finalMessage,
          transcriptPath: cancelledResult.transcriptPath,
          elapsedMs: cancelledResult.elapsedMs,
          exitCode: cancelledResult.exitCode,
          error: cancelledResult.error,
        });
        isError = true;
      }
    }
  }

  return { results, isError };
}

function summarizeInflightParallel(
  results: (OrchestrationResult | undefined)[],
): string {
  const total = results.length;
  const done = results.filter((r) => r !== undefined).length;
  const lines = [`parallel orchestration (in-flight): ${done}/${total} task(s)`];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r) {
      lines.push(`- [${i + 1}]: (pending)`);
      continue;
    }
    const first = (r.finalMessage ?? "").split("\n").find((l) => l.trim()) ?? "";
    const trimmed = first.length > 200 ? first.slice(0, 200) + "…" : first;
    lines.push(`- ${r.name}: exit=${r.exitCode} (${r.elapsedMs}ms) — ${trimmed}`);
  }
  return lines.join("\n");
}
