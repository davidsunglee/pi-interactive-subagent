import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { makeHeadlessBackend } from "../subagents/backends/headless.ts";
import { makePaneBackend } from "../subagents/backends/pane.ts";
import { selectBackend } from "../subagents/backends/select.ts";
import type { Backend, BackendLaunchParams } from "../subagents/backends/types.ts";
import type {
  LauncherDeps,
  LaunchedHandle,
  OrchestrationResult,
  OrchestrationTask,
  WaitForCompletionHooks,
} from "./types.ts";

/**
 * Build a LauncherDeps bound to the active session context.
 *
 * Select a backend (pane or headless) once per makeDefaultDeps() call via
 * selectBackend(), then adapt that backend's launch/watch surface to the
 * orchestration layer's existing LauncherDeps contract.
 *
 * The pane backend preserves the current launchSubagent/watchSubagent path,
 * including transcriptPath population and abort forwarding. The headless
 * backend owns its own launch/watch behavior behind the same interface.
 *
 * OrchestrationTask -> BackendLaunchParams is a structural widening only:
 * the orchestration tools require `agent`, while the backend interface keeps
 * it optional to match the broader bare-subagent surface.
 */
export function makeDefaultDeps(ctx: {
  sessionManager: ExtensionContext["sessionManager"];
  cwd: string;
}): LauncherDeps {
  const backend: Backend =
    selectBackend() === "headless" ? makeHeadlessBackend(ctx) : makePaneBackend(ctx);

  return {
    async launch(
      task: OrchestrationTask,
      defaultFocus: boolean,
      signal?: AbortSignal,
    ): Promise<LaunchedHandle> {
      const params: BackendLaunchParams = task;
      return backend.launch(params, defaultFocus, signal);
    },

    async waitForCompletion(
      handle: LaunchedHandle,
      signal?: AbortSignal,
      onUpdate?: (partial: OrchestrationResult) => void,
      hooks?: WaitForCompletionHooks,
    ): Promise<OrchestrationResult> {
      const result = await backend.watch(
        handle,
        signal,
        onUpdate
          ? (partial) => {
              onUpdate({
                name: partial.name,
                finalMessage: partial.finalMessage,
                transcriptPath: partial.transcriptPath,
                exitCode: partial.exitCode,
                elapsedMs: partial.elapsedMs,
                sessionId: partial.sessionId,
                error: partial.error,
                usage: partial.usage,
                transcript: partial.transcript,
                sessionKey: partial.sessionKey,
                ping: partial.ping,
              });
            }
          : undefined,
        hooks,
      );
      return {
        name: result.name,
        finalMessage: result.finalMessage,
        transcriptPath: result.transcriptPath,
        exitCode: result.exitCode,
        elapsedMs: result.elapsedMs,
        sessionId: result.sessionId,
        error: result.error,
        usage: result.usage,
        transcript: result.transcript,
        sessionKey: result.sessionKey,
        ping: result.ping,
      };
    },
  };
}
