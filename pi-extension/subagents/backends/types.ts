import type { LaunchedHandle, OrchestrationTask } from "../../orchestration/types.ts";

export type { LaunchedHandle, OrchestrationTask };

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export type TranscriptContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | { type: "image"; data: string; mimeType: string };

export interface TranscriptMessage {
  role: "user" | "assistant" | "toolResult";
  content: TranscriptContent[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}


export interface BackendResult {
  name: string;
  finalMessage: string;
  transcriptPath: string | null;
  exitCode: number;
  elapsedMs: number;
  sessionId?: string;
  error?: string;
  usage?: UsageStats;
  transcript?: TranscriptMessage[];
  sessionKey?: string;
  ping?: { name: string; message: string };
}

export interface BackendWatchHooks {
  onSessionKey?: (sessionKey: string) => void;
}

export interface BackendLaunchParams {
  name?: string;
  agent?: string;
  task: string;
  cli?: string;
  model?: string;
  thinking?: string;
  systemPrompt?: string;
  skills?: string;
  tools?: string;
  cwd?: string;
  fork?: boolean;
  resumeSessionId?: string;
  focus?: boolean;
  /**
   * Vestigial compat field. The spec requires `interactive` to be accepted on
   * public schemas for legacy callers, but neither backend honors it at
   * runtime. Declared here so `OrchestrationTask` values (which accept the
   * field after Task 4b) flow through `backend.launch(task, ...)` without
   * structural mismatch. Do NOT branch on this field inside any backend.
   */
  interactive?: boolean;
}

export interface Backend {
  launch(
    params: BackendLaunchParams,
    defaultFocus: boolean,
    signal?: AbortSignal,
  ): Promise<LaunchedHandle>;
  watch(
    handle: LaunchedHandle,
    signal?: AbortSignal,
    onUpdate?: (partial: BackendResult) => void,
    hooks?: BackendWatchHooks,
  ): Promise<BackendResult>;
}
