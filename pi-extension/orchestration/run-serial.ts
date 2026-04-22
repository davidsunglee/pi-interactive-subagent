import type {
  LauncherDeps,
  OrchestrationResult,
  OrchestrationTask,
} from "./types.ts";

export interface RunSerialOpts {
  /**
   * Tool-execution AbortSignal. When aborted: the in-flight step's wait
   * is interrupted (surface closed, result recorded as a "cancelled"
   * synthetic failure), remaining steps are not launched, and the run
   * returns with `isError: true` carrying all prior + cancelled results.
   */
  signal?: AbortSignal;
  /**
   * Tool-framework onUpdate callback. When set, partial snapshots emitted
   * by the active step's backend are wrapped in the tool-framework
   * `{ content, details }` shape (with the summary string reflecting the
   * work-in-progress result list) and forwarded here. Intermediate steps'
   * completed results are also re-forwarded so the UI keeps prior rows.
   */
  onUpdate?: (content: {
    content: { type: "text"; text: string }[];
    details: any;
  }) => void;
}

export interface RunSerialOutput {
  results: OrchestrationResult[];
  isError: boolean;
}

export async function runSerial(
  tasks: OrchestrationTask[],
  opts: RunSerialOpts,
  deps: LauncherDeps,
): Promise<RunSerialOutput> {
  const results: OrchestrationResult[] = [];
  let previous = "";

  for (let i = 0; i < tasks.length; i++) {
    const raw = tasks[i];
    const task: OrchestrationTask = {
      ...raw,
      name: raw.name ?? `step-${i + 1}`,
      // split/join inserts `previous` literally. `String.replace` would
      // interpret `$$`, `$&`, `$1`, ... in the assistant's output.
      task: raw.task.split("{previous}").join(previous),
    };

    if (opts.signal?.aborted) {
      results.push({
        name: task.name!,
        finalMessage: "",
        transcriptPath: null,
        exitCode: 1,
        elapsedMs: 0,
        error: "cancelled",
      });
      return { results, isError: true };
    }

    // Normalize thrown errors from deps.launch / deps.waitForCompletion
    // into a synthetic failing OrchestrationResult. Without this, an upstream
    // throw (e.g. mux/surface creation failure) would reject this promise and
    // discard all prior results, breaking the "prior + failing step" contract.
    const startedAt = Date.now();
    let result: OrchestrationResult;
    // Wrap the per-step partial into the tool-framework update shape. Surfaces
    // prior completed results + the in-flight step's latest snapshot so the UI
    // can render a live-updating aggregate view.
    const stepOnUpdate = opts.onUpdate
      ? (partial: OrchestrationResult) => {
          const inflight = [...results, partial];
          opts.onUpdate!({
            content: [
              { type: "text", text: summarizeInflight("serial", inflight) },
            ],
            details: { results: inflight, isError: false, inflight: true },
          });
        }
      : undefined;
    try {
      const handle = await deps.launch(task, true /* defaultFocus */, opts.signal);
      result = await deps.waitForCompletion(handle, opts.signal, stepOnUpdate);
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
    results.push(result);

    if (result.exitCode !== 0 || result.error) {
      return { results, isError: true };
    }
    previous = result.finalMessage;
  }

  return { results, isError: false };
}

function summarizeInflight(
  mode: "serial" | "parallel",
  results: OrchestrationResult[],
): string {
  const lines = [`${mode} orchestration (in-flight): ${results.length} task(s)`];
  for (const r of results) {
    const first = (r.finalMessage ?? "").split("\n").find((l) => l.trim()) ?? "";
    const trimmed = first.length > 200 ? first.slice(0, 200) + "…" : first;
    lines.push(`- ${r.name}: exit=${r.exitCode} (${r.elapsedMs}ms) — ${trimmed}`);
  }
  return lines.join("\n");
}
