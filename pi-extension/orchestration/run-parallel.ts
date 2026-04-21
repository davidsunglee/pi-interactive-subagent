import {
  DEFAULT_PARALLEL_CONCURRENCY,
  MAX_PARALLEL_HARD_CAP,
  type LauncherDeps,
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
      `subagent_parallel: maxConcurrency=${cap} exceeds hard cap ${MAX_PARALLEL_HARD_CAP}. Split into sub-waves.`,
    );
  }
  if (cap < 1) {
    throw new Error(`subagent_parallel: maxConcurrency=${cap} must be >= 1.`);
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
      try {
        const handle = await deps.launch(task, false /* defaultFocus */, opts.signal);
        result = await deps.waitForCompletion(handle, opts.signal);
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
      results[i] = result;
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
        const raw = tasks[i];
        results[i] = {
          name: raw.name ?? `task-${i + 1}`,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 1,
          elapsedMs: 0,
          error: "cancelled",
        };
        isError = true;
      }
    }
  }

  return { results, isError };
}
