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
   * Mark the launch as interactive (long-running, user drives the conversation
   * in its own pane). The backend only carries this field structurally; launch
   * resolution computes the effective value and parent-side supervision uses it
   * to suppress stalled/recovered status steer messages.
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
