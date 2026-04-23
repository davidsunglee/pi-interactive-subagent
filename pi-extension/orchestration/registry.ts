import { randomBytes } from "node:crypto";
import type {
  OrchestratedTaskResult,
  OrchestrationState,
  OrchestrationTask,
} from "./types.ts";
import {
  ORCHESTRATION_COMPLETE_KIND,
  BLOCKED_KIND,
} from "./notification-kinds.ts";

export type OrchestrationMode = "serial" | "parallel";

export interface OrchestrationConfig {
  mode: OrchestrationMode;
  tasks: OrchestrationTask[];
  maxConcurrency?: number;
}

export interface OrchestrationCompleteEvent {
  kind: typeof ORCHESTRATION_COMPLETE_KIND;
  orchestrationId: string;
  results: OrchestratedTaskResult[];
  isError: boolean;
}

export interface OrchestrationBlockedEvent {
  kind: typeof BLOCKED_KIND;
  orchestrationId: string;
  taskIndex: number;
  taskName: string;
  /**
   * The identifier the parent will pass back via the existing
   * `subagent_resume({ sessionPath })` tool — for pi-backed children this is
   * the subagent session file path; for Claude-backed children it is the
   * Claude session id. Field name matches the spec's public API surface.
   */
  sessionKey: string;
  message: string;
}

export type RegistryEmission =
  | OrchestrationCompleteEvent
  | OrchestrationBlockedEvent;

export type RegistryEmitter = (payload: RegistryEmission) => void;

/**
 * Internal in-process subscriber for per-task lifecycle transitions. NOT a
 * user-facing notification kind — this fires alongside the emitter so the
 * extension layer can clear virtual widget rows as soon as a specific slot
 * transitions to a terminal state, even if the rest of the orchestration is
 * still running. Spec's "no per-task intermediate notifications" rule applies
 * to steer-back notifications; this local hook is not a notification.
 */
export interface RegistryHooks {
  onTaskTerminal?: (ctx: {
    orchestrationId: string;
    taskIndex: number;
    state: OrchestrationState; // always one of completed | failed | cancelled
  }) => void;
  /**
   * Fired when an owned slot transitions `blocked -> running` because a
   * standalone `subagent_resume` started on its sessionKey. Lets the
   * extension layer drop the virtual blocked widget row at resume-start
   * time rather than only at terminal time.
   */
  onResumeStarted?: (ctx: {
    orchestrationId: string;
    taskIndex: number;
  }) => void;
}

interface OrchestrationEntry {
  id: string;
  config: OrchestrationConfig;
  tasks: OrchestratedTaskResult[];
  overallState: "running" | "completed";
  sessionKeys: Map<number, string>; // taskIndex -> sessionKey (when known)
}

export interface Registry {
  dispatchAsync(params: { config: OrchestrationConfig }): string;
  onTaskLaunched(orchestrationId: string, taskIndex: number, info: { sessionKey?: string }): void;
  updateSessionKey(orchestrationId: string, taskIndex: number, sessionKey: string): void;
  onTaskTerminal(orchestrationId: string, taskIndex: number, result: OrchestratedTaskResult): void;
  onTaskBlocked(orchestrationId: string, taskIndex: number, payload: {
    sessionKey: string;
    message: string;
    partial?: Partial<OrchestratedTaskResult>;
  }): void;
  onResumeStarted(sessionKey: string): void;
  onResumeTerminal(sessionKey: string, result: OrchestratedTaskResult): void;
  cancel(orchestrationId: string): { ok: true; alreadyTerminal?: boolean };
  getSnapshot(orchestrationId: string): { tasks: OrchestratedTaskResult[] } | null;
  lookupOwner(sessionKey: string): { orchestrationId: string; taskIndex: number } | null;
  listActive(): string[];
}

function newHexId(): string {
  return randomBytes(4).toString("hex");
}

function isTerminalState(s: OrchestrationState): boolean {
  return s === "completed" || s === "failed" || s === "cancelled";
}

export function createRegistry(emit: RegistryEmitter, hooks: RegistryHooks = {}): Registry {
  const entries = new Map<string, OrchestrationEntry>();
  const ownership = new Map<string, { orchestrationId: string; taskIndex: number }>();

  function notifyTaskTerminal(orchestrationId: string, taskIndex: number, state: OrchestrationState): void {
    try {
      hooks.onTaskTerminal?.({ orchestrationId, taskIndex, state });
    } catch {
      // Defensive: hook errors must never break registry state transitions.
    }
  }

  function tryFinalize(entry: OrchestrationEntry): void {
    if (entry.overallState !== "running") return;
    const allTerminal = entry.tasks.every((t) => isTerminalState(t.state));
    if (!allTerminal) return;
    entry.overallState = "completed";
    const isError = entry.tasks.some((t) => t.state !== "completed");
    emit({
      kind: ORCHESTRATION_COMPLETE_KIND,
      orchestrationId: entry.id,
      results: entry.tasks.map((t) => ({ ...t })),
      isError,
    });
    // Clear ownership entries for this orchestration.
    for (const [key, own] of ownership) {
      if (own.orchestrationId === entry.id) ownership.delete(key);
    }
  }

  const registry: Registry = {
    dispatchAsync({ config }) {
      const id = newHexId();
      const tasks: OrchestratedTaskResult[] = config.tasks.map((t, i) => ({
        name: t.name ?? (config.mode === "serial" ? `step-${i + 1}` : `task-${i + 1}`),
        index: i,
        state: "pending",
      }));
      entries.set(id, {
        id,
        config,
        tasks,
        overallState: "running",
        sessionKeys: new Map(),
      });
      return id;
    },

    onTaskLaunched(orchestrationId, taskIndex, info) {
      const entry = entries.get(orchestrationId);
      if (!entry) return;
      const task = entry.tasks[taskIndex];
      if (!task) return;
      if (task.state === "pending") task.state = "running";
      if (info.sessionKey) {
        entry.sessionKeys.set(taskIndex, info.sessionKey);
        ownership.set(info.sessionKey, { orchestrationId, taskIndex });
        task.sessionKey = info.sessionKey;
      }
    },

    updateSessionKey(orchestrationId, taskIndex, sessionKey) {
      const entry = entries.get(orchestrationId);
      if (!entry) return;
      const task = entry.tasks[taskIndex];
      if (!task) return;
      // No-op if we already have a key for this slot. Late-binding is only
      // meant to fill in Claude session ids that were not available at launch.
      if (entry.sessionKeys.has(taskIndex)) return;
      entry.sessionKeys.set(taskIndex, sessionKey);
      ownership.set(sessionKey, { orchestrationId, taskIndex });
      task.sessionKey = sessionKey;
    },

    onTaskTerminal(orchestrationId, taskIndex, result) {
      const entry = entries.get(orchestrationId);
      if (!entry) return;
      const existing = entry.tasks[taskIndex];
      if (!existing) return;
      // Merge: keep pre-terminal sessionKey / name if missing in result.
      entry.tasks[taskIndex] = {
        ...existing,
        ...result,
        name: result.name ?? existing.name,
        index: taskIndex,
      };
      // Clear ownership for this sessionKey — no longer blockable/resumable.
      const key = entry.sessionKeys.get(taskIndex);
      if (key) ownership.delete(key);
      const finalState = entry.tasks[taskIndex].state;
      if (isTerminalState(finalState)) {
        notifyTaskTerminal(orchestrationId, taskIndex, finalState);
      }
      tryFinalize(entry);
    },

    onTaskBlocked(orchestrationId, taskIndex, payload) {
      const entry = entries.get(orchestrationId);
      if (!entry) return;
      const existing = entry.tasks[taskIndex];
      if (!existing) return;
      entry.tasks[taskIndex] = {
        ...existing,
        ...(payload.partial ?? {}),
        state: "blocked",
        sessionKey: payload.sessionKey,
        index: taskIndex,
      };
      entry.sessionKeys.set(taskIndex, payload.sessionKey);
      ownership.set(payload.sessionKey, { orchestrationId, taskIndex });
      emit({
        kind: BLOCKED_KIND,
        orchestrationId,
        taskIndex,
        taskName: entry.tasks[taskIndex].name,
        sessionKey: payload.sessionKey,
        message: payload.message,
      });
    },

    onResumeStarted(sessionKey) {
      const own = ownership.get(sessionKey);
      if (!own) return; // standalone resume, nothing to transition
      const entry = entries.get(own.orchestrationId);
      if (!entry) return;
      const task = entry.tasks[own.taskIndex];
      if (!task) return;
      // Only transition if the slot is currently blocked. A non-blocked slot
      // shouldn't be resumable, but guard against races (e.g. cancellation
      // landing during the resume launch).
      if (task.state !== "blocked") return;
      task.state = "running";
      try {
        hooks.onResumeStarted?.({ orchestrationId: own.orchestrationId, taskIndex: own.taskIndex });
      } catch {
        // Defensive: hook errors must never break registry state transitions.
      }
    },

    onResumeTerminal(sessionKey, result) {
      const own = ownership.get(sessionKey);
      if (!own) return;
      registry.onTaskTerminal(own.orchestrationId, own.taskIndex, result);
    },

    cancel(orchestrationId) {
      const entry = entries.get(orchestrationId);
      if (!entry || entry.overallState !== "running") {
        return { ok: true, alreadyTerminal: true };
      }
      const cancelledIndices: number[] = [];
      for (let i = 0; i < entry.tasks.length; i++) {
        const t = entry.tasks[i];
        if (!isTerminalState(t.state)) {
          entry.tasks[i] = {
            ...t,
            state: "cancelled",
            exitCode: t.exitCode ?? 1,
            error: t.error ?? "cancelled",
          };
          cancelledIndices.push(i);
        }
      }
      for (const idx of cancelledIndices) {
        notifyTaskTerminal(orchestrationId, idx, "cancelled");
      }
      tryFinalize(entry);
      return { ok: true };
    },

    getSnapshot(orchestrationId) {
      const entry = entries.get(orchestrationId);
      if (!entry) return null;
      return { tasks: entry.tasks.map((t) => ({ ...t })) };
    },

    lookupOwner(sessionKey) {
      const own = ownership.get(sessionKey);
      return own ? { ...own } : null;
    },

    listActive() {
      return [...entries.values()]
        .filter((e) => e.overallState === "running")
        .map((e) => e.id);
    },
  };

  return registry;
}
