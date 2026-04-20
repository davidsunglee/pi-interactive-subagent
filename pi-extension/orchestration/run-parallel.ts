import {
  DEFAULT_PARALLEL_CONCURRENCY,
  MAX_PARALLEL_HARD_CAP,
  type LauncherDeps,
  type OrchestrationResult,
  type OrchestrationTask,
} from "./types.ts";

export interface RunParallelOpts {
  maxConcurrency?: number;
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
        const handle = await deps.launch(task, false /* defaultFocus */);
        result = await deps.waitForCompletion(handle);
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

  return { results, isError };
}
