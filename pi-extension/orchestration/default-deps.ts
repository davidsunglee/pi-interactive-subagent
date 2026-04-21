import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  launchSubagent,
  watchSubagent,
  type RunningSubagent,
} from "../subagents/index.ts";
import type {
  LauncherDeps,
  LaunchedHandle,
  OrchestrationResult,
  OrchestrationTask,
} from "./types.ts";

/**
 * Build a LauncherDeps bound to the active session context.
 *
 * Completion path:
 *   launch = launchSubagent (widget registration + widget-refresh start
 *            + surface creation, all owned by the upstream primitive).
 *   waitForCompletion = watchSubagent (polling, widget updates, pane
 *            cleanup). The SubagentResult returned by watchSubagent now
 *            carries a uniform transcriptPath populated BEFORE cleanup
 *            in both the pi branch (sessionFile) and Claude branch
 *            (archived jsonl under ~/.pi/agent/sessions/claude-code/).
 *
 * No readTranscript layer — the v3 upstream patch made that helper
 * redundant. The transcriptPath on SubagentResult is the single source
 * of truth.
 *
 * Cancellation:
 *   When an orchestration tool's AbortSignal fires, `waitForCompletion`
 *   forwards it into the local `running.abortController` so
 *   `watchSubagent`'s `pollForExit` unblocks. `watchSubagent`'s catch
 *   branch then closes the pane and returns the synthetic "cancelled"
 *   SubagentResult (exitCode: 1, error: "cancelled"), which the run-
 *   serial/parallel cores turn into an aborted OrchestrationResult.
 *
 * Deferred (intentionally NOT plumbed here):
 *   - `caller_ping` surfacing — treated as a regular error for now;
 *     a future revision can add an explicit `ping` field on
 *     OrchestrationResult if the wrappers need to differentiate.
 */
export function makeDefaultDeps(ctx: {
  sessionManager: ExtensionContext["sessionManager"];
  cwd: string;
}): LauncherDeps {
  const handleToRunning = new Map<string, RunningSubagent>();

  return {
    async launch(
      task: OrchestrationTask,
      defaultFocus: boolean,
      _signal?: AbortSignal,
    ): Promise<LaunchedHandle> {
      const resolvedFocus = task.focus ?? defaultFocus;
      const running = await launchSubagent(
        {
          name: task.name ?? "subagent",
          task: task.task,
          agent: task.agent,
          model: task.model,
          thinking: task.thinking,
          systemPrompt: task.systemPrompt,
          skills: task.skills,
          tools: task.tools,
          cwd: task.cwd,
          fork: task.fork,
          resumeSessionId: task.resumeSessionId,
          cli: task.cli,
          focus: resolvedFocus,
        },
        ctx,
      );
      handleToRunning.set(running.id, running);
      return { id: running.id, name: running.name, startTime: running.startTime };
    },
    async waitForCompletion(
      handle: LaunchedHandle,
      signal?: AbortSignal,
    ): Promise<OrchestrationResult> {
      const running = handleToRunning.get(handle.id);
      if (!running) {
        return {
          name: handle.name,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 1,
          elapsedMs: 0,
          error: `no running entry for ${handle.id}`,
        };
      }
      const abort = new AbortController();
      running.abortController = abort;
      // Mirror the tool-execution signal into the local abort so that
      // session_shutdown (which aborts `running.abortController` directly)
      // and caller cancellation share one abort path into watchSubagent.
      let onToolAbort: (() => void) | null = null;
      if (signal) {
        if (signal.aborted) {
          abort.abort();
        } else {
          onToolAbort = () => abort.abort();
          signal.addEventListener("abort", onToolAbort, { once: true });
        }
      }
      try {
        const sub = await watchSubagent(running, abort.signal);
        return {
          name: handle.name,
          finalMessage: sub.summary,
          transcriptPath: sub.transcriptPath,
          exitCode: sub.exitCode,
          elapsedMs: sub.elapsed * 1000,
          sessionId: sub.claudeSessionId,
          error: sub.error,
        };
      } finally {
        if (signal && onToolAbort) signal.removeEventListener("abort", onToolAbort);
        handleToRunning.delete(handle.id);
      }
    },
  };
}
