import type { Static, TObject } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import type {
  TranscriptMessage,
  UsageStats,
} from "../subagents/backends/types.ts";
export type { TranscriptMessage, UsageStats };

export const OrchestrationTaskSchema = Type.Object({
  name: Type.Optional(Type.String({ description: "Widget label; auto-generated if omitted." })),
  agent: Type.String({ description: "Agent definition name." }),
  task: Type.String({ description: "Task string; may contain {previous} in serial mode." }),
  // Fields below mirror the upstream `SubagentParams` surface. Orchestration
  // wrappers are thin over `launchSubagent`, so any field `launchSubagent`
  // already accepts is plumbed through here too — otherwise the wrappers
  // would silently reduce the API surface relative to the bare `subagent`
  // tool. Kept in sync with `SubagentParams` in `pi-extension/subagents/index.ts`.
  cli: Type.Optional(Type.String({ description: "'pi' (default) or 'claude'. Free-form string; unknown values fall back to the pi path." })),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String({ description: "'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'. Free-form string; unknown values are dropped on Claude and pass through as a pi model suffix." })),
  systemPrompt: Type.Optional(Type.String({ description: "Appended (or replaces, per agent frontmatter) the system prompt for this step." })),
  skills: Type.Optional(Type.String({ description: "Comma-separated skills override for this step." })),
  tools: Type.Optional(Type.String({ description: "Comma-separated tools override for this step." })),
  cwd: Type.Optional(Type.String()),
  fork: Type.Optional(Type.Boolean({ description: "Force full-context fork mode for this step, overriding any agent frontmatter session-mode." })),
  resumeSessionId: Type.Optional(Type.String({ description: "Resume a previous Claude Code session by ID for this step." })),
  focus: Type.Optional(Type.Boolean()),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Vestigial compat field. Accepted so legacy callers that still send `interactive` validate cleanly; has no runtime effect in v1.",
    }),
  ),
  // Note: `permissionMode` is intentionally omitted — `launchSubagent()` does not
  // accept it. Add it here only when plumbing all the way through.
});

export type OrchestrationTask = Static<typeof OrchestrationTaskSchema>;

export type OrchestrationState =
  | "pending"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface OrchestrationResult {
  name: string;
  finalMessage: string;
  transcriptPath: string | null;
  exitCode: number;
  elapsedMs: number;
  sessionId?: string;
  error?: string;
  usage?: UsageStats;
  transcript?: TranscriptMessage[];
  state?: OrchestrationState;
  index?: number;
  sessionKey?: string;
  ping?: { name: string; message: string };
}

/**
 * Per-task result on any orchestration (sync or async). Sync runs only
 * populate terminal `state` values; async runs use the full machine and
 * surface pre-terminal states (`pending`, `running`, `blocked`) in
 * intermediate completion notifications.
 */
export interface OrchestratedTaskResult {
  name: string;
  index: number;
  state: OrchestrationState;
  finalMessage?: string;
  transcriptPath?: string | null;
  elapsedMs?: number;
  exitCode?: number;
  sessionKey?: string;
  error?: string;
  usage?: UsageStats;
  transcript?: TranscriptMessage[];
}

/**
 * Envelope returned immediately from `subagent_run_serial` / `subagent_run_parallel`
 * when `wait: false`. Task manifest mirrors input order with `state: "pending"`.
 */
export interface AsyncDispatchEnvelope {
  orchestrationId: string;
  tasks: Array<{ name: string; index: number; state: "pending" }>;
  isError: false;
}

/**
 * Hooks for mid-run session key delivery. Passed as the 4th positional arg to
 * `waitForCompletion` so callers can be notified as soon as a child's
 * resume-addressable key is known (before the child exits).
 */
export interface WaitForCompletionHooks {
  onSessionKey?: (sessionKey: string) => void;
}

/**
 * Dependencies that orchestration cores need injected, so tests can
 * mock all IO (pane spawning, sentinel waits, transcript reads).
 *
 * `signal` is the tool-execution AbortSignal threaded down from
 * `subagent_run_serial` / `subagent_run_parallel`. `waitForCompletion` must
 * observe it so user-initiated cancellation of the tool call aborts
 * the running subagent's poll loop and frees its pane. `launch`
 * accepts the signal symmetrically for future use (e.g. surface
 * creation that honors cancellation).
 */
export interface LauncherDeps {
  launch(
    task: OrchestrationTask,
    defaultFocus: boolean,
    signal?: AbortSignal,
  ): Promise<LaunchedHandle>;
  waitForCompletion(
    handle: LaunchedHandle,
    signal?: AbortSignal,
    onUpdate?: (partial: OrchestrationResult) => void,
    hooks?: WaitForCompletionHooks,
  ): Promise<OrchestrationResult>;
}

export interface LaunchedHandle {
  id: string;
  name: string;
  startTime: number;
  /**
   * Resume-addressable identifier for this child. Same value the parent
   * will pass back through `subagent_resume({ sessionPath })` for pi-backed
   * children, or the Claude session id for Claude-backed children. Used to
   * key the orchestration registry's ownership map.
   */
  sessionKey?: string;
}

export const MAX_PARALLEL_HARD_CAP = 8;
export const DEFAULT_PARALLEL_CONCURRENCY = 4;
