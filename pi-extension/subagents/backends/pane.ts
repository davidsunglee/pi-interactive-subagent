import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  launchSubagent as defaultLaunchSubagent,
  watchSubagent as defaultWatchSubagent,
  type RunningSubagent,
} from "../index.ts";
import type {
  Backend,
  BackendLaunchParams,
  BackendResult,
  BackendWatchHooks,
  LaunchedHandle,
} from "./types.ts";

/**
 * Test seam: lets unit tests substitute the heavy `launchSubagent` /
 * `watchSubagent` implementations without exercising real mux/pane I/O.
 */
export interface PaneBackendOverrides {
  launchSubagent?: typeof defaultLaunchSubagent;
  watchSubagent?: typeof defaultWatchSubagent;
}

export function makePaneBackend(
  ctx: {
    sessionManager: ExtensionContext["sessionManager"];
    cwd: string;
  },
  overrides?: PaneBackendOverrides,
): Backend {
  const handleToRunning = new Map<string, RunningSubagent>();
  const launchSubagent = overrides?.launchSubagent ?? defaultLaunchSubagent;
  const watchSubagent = overrides?.watchSubagent ?? defaultWatchSubagent;

  return {
    async launch(
      params: BackendLaunchParams,
      defaultFocus: boolean,
      _signal?: AbortSignal,
    ): Promise<LaunchedHandle> {
      const resolvedFocus = params.focus ?? defaultFocus;
      const running = await launchSubagent(
        {
          name: params.name ?? "subagent",
          task: params.task,
          agent: params.agent,
          model: params.model,
          thinking: params.thinking,
          systemPrompt: params.systemPrompt,
          skills: params.skills,
          tools: params.tools,
          cwd: params.cwd,
          fork: params.fork,
          resumeSessionId: params.resumeSessionId,
          cli: params.cli,
          focus: resolvedFocus,
        },
        ctx,
      );
      handleToRunning.set(running.id, running);
      // Review-v1 #1: Claude pane launches must NOT advertise the unused pi
      // `subagentSessionFile` placeholder as the resume key. The Claude session
      // id isn't known until system/init writes the pointer; let watch()'s
      // onSessionKey hook late-bind ownership via registry.updateSessionKey.
      const launchSessionKey =
        running.cli === "claude" ? undefined : running.sessionFile;
      return {
        id: running.id,
        name: running.name,
        startTime: running.startTime,
        sessionKey: launchSessionKey,
      };
    },

    async watch(
      handle: LaunchedHandle,
      signal?: AbortSignal,
      onUpdate?: (partial: BackendResult) => void,
      hooks?: BackendWatchHooks,
    ): Promise<BackendResult> {
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
      // Pi children: fire onSessionKey immediately (sessionFile is known at launch).
      if (running.cli !== "claude" && running.sessionFile) {
        try { hooks?.onSessionKey?.(running.sessionFile); } catch { /* defensive */ }
      }
      const abort = new AbortController();
      running.abortController = abort;
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
        const sub = await watchSubagent(running, abort.signal, {
          onSessionKey: (key) => hooks?.onSessionKey?.(key),
        });
        // Review-v1 #1: For Claude, the resume-addressable key is the Claude
        // session id (the value the parent passes back via subagent_resume).
        // The pi `running.sessionFile` placeholder is irrelevant on this path.
        const watchSessionKey =
          running.cli === "claude"
            ? sub.claudeSessionId
            : running.sessionFile;
        return {
          name: handle.name,
          finalMessage: sub.summary,
          transcriptPath: sub.transcriptPath,
          exitCode: sub.exitCode,
          elapsedMs: sub.elapsed * 1000,
          sessionId: sub.claudeSessionId,
          sessionKey: watchSessionKey,
          error: sub.error,
          ping: sub.ping,
        };
      } finally {
        if (signal && onToolAbort) signal.removeEventListener("abort", onToolAbort);
        handleToRunning.delete(handle.id);
      }
    },
  };
}
