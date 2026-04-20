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
 * Deferred (intentionally NOT plumbed here):
 *   - `caller_ping` surfacing — treated as a regular error for now;
 *     a future revision can add an explicit `ping` field on
 *     OrchestrationResult if the wrappers need to differentiate.
 *   - Propagating the tool-execution AbortSignal into the running
 *     subagent's wait — orchestration wrappers construct a local
 *     AbortController today; tying it to the tool signal is future work.
 */
export function makeDefaultDeps(ctx: {
  sessionManager: ExtensionContext["sessionManager"];
  cwd: string;
}): LauncherDeps {
  const handleToRunning = new Map<string, RunningSubagent>();

  return {
    async launch(task: OrchestrationTask, defaultFocus: boolean): Promise<LaunchedHandle> {
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
    async waitForCompletion(handle: LaunchedHandle): Promise<OrchestrationResult> {
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
      const sub = await watchSubagent(running, abort.signal);
      handleToRunning.delete(handle.id);
      return {
        name: handle.name,
        finalMessage: sub.summary,
        transcriptPath: sub.transcriptPath,
        exitCode: sub.exitCode,
        elapsedMs: sub.elapsed * 1000,
        sessionId: sub.claudeSessionId,
        error: sub.error,
      };
    },
  };
}
