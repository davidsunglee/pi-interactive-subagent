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
   * array (input-indexed, dense — pending/running/terminal state on every slot)
   * so the UI can render a live-updating grid.
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
   * terminalized. The results[i] slot stays at state "running" — the registry
   * owns lifecycle of blocked slots and the abort sweep leaves them untouched.
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
  for (let i = 0; i < tasks.length; i++) {
    results[i] = {
      name: tasks[i].name ?? `task-${i + 1}`,
      index: i,
      state: "pending",
      finalMessage: "",
      transcriptPath: null,
      exitCode: 0,
      elapsedMs: 0,
    };
  }
  let nextIdx = 0;
  let isError = false;

  function emitInflight(): void {
    if (!opts.onUpdate) return;
    opts.onUpdate({
      content: [{ type: "text", text: summarizeInflightParallel(results) }],
      details: { results: results.map((r) => ({ ...r })), isError: false, inflight: true },
    });
  }

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
            results[i] = { ...results[i], ...partial, state: "running", index: i };
            emitInflight();
          }
        : undefined;
      try {
        const handle = await deps.launch(task, false /* defaultFocus */, opts.signal);
        opts.onLaunched?.(i, { sessionKey: handle.sessionKey });
        results[i] = { ...results[i], state: "running", ...(handle.sessionKey ? { sessionKey: handle.sessionKey } : {}) };
        emitInflight();
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
          // results[i] stays "running" — registry owns lifecycle of this slot.
          // The worker MUST continue claiming later pending siblings so that
          // maxConcurrency exhaustion by a block does not strand them (review-v3 #1).
          continue;
        }
        // Sync path: fold ping.message into finalMessage and mark as completed.
        result = { ...result, finalMessage: result.ping.message, state: "completed" };
        // Fall through to results[i] = result.
      }

      result.index = i;
      result.state = result.exitCode === 0 && !result.error ? "completed" : "failed";
      results[i] = { ...results[i], ...result, index: i, name: result.name ?? results[i].name };
      emitInflight();
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
      if (results[i].state !== "pending") continue;
      // In async mode (onBlocked set), registry retains lifecycle ownership of
      // registered blocked slots. Pending slots here are truly unstarted.
      if (opts.onBlocked) continue;
      const cancelledResult: OrchestrationResult = {
        ...results[i],
        state: "cancelled",
        finalMessage: "",
        transcriptPath: null,
        exitCode: 1,
        elapsedMs: 0,
        error: "cancelled",
        index: i,
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

  return { results, isError };
}

function summarizeInflightParallel(
  results: (OrchestrationResult | undefined)[],
): string {
  const total = results.length;
  const done = results.filter((r) => r && (r.state === "completed" || r.state === "failed" || r.state === "cancelled")).length;
  const lines = [`parallel orchestration (in-flight): ${done}/${total} task(s)`];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r) {
      lines.push(`- [${i + 1}]: pending`);
      continue;
    }
    const state = r.state ?? deriveInflightState(r);
    lines.push(`- ${r.name}: ${state}`);
  }
  return lines.join("\n");
}

function deriveInflightState(r: OrchestrationResult): string {
  if (r.error) return "failed";
  if (r.exitCode !== 0 && r.exitCode !== undefined) return "failed";
  return "running";
}
