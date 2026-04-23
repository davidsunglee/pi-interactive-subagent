import type {
  LauncherDeps,
  OrchestratedTaskResult,
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
   * terminalized. runSerial returns early with blocked:true. Downstream steps
   * remain untouched (pending) — the dispatcher must NOT run the cancellation
   * sweep when blocked:true is returned.
   */
  onBlocked?: (taskIndex: number, payload: { sessionKey: string; message: string; partial: OrchestratedTaskResult }) => void;
}

export interface RunSerialOutput {
  results: OrchestrationResult[];
  isError: boolean;
  /** True when runSerial returned early because a step blocked; downstream steps remain untouched. */
  blocked?: boolean;
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
      const cancelledResult: OrchestrationResult = {
        name: task.name!,
        index: i,
        finalMessage: "",
        transcriptPath: null,
        exitCode: 1,
        elapsedMs: 0,
        error: "cancelled",
        state: "cancelled",
      };
      results.push(cancelledResult);
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
        // Async path: transition to blocked and stop. Downstream steps stay
        // pending — the dispatcher must NOT run the cancellation sweep.
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
        return { results, isError: false, blocked: true };
      }
      // Sync path: preserve today's behavior — fold ping.message into
      // finalMessage and record as completed. The terminal-annotation below
      // sees state "completed" and pushes.
      result = {
        ...result,
        finalMessage: result.ping.message,
        state: "completed",
      };
      // Fall through to terminal-annotation.
    }

    result.index = i;
    result.state = result.exitCode === 0 && !result.error ? "completed" : "failed";
    results.push(result);
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
