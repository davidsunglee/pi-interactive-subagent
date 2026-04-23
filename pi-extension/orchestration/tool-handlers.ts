import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runSerial } from "./run-serial.ts";
import { runParallel } from "./run-parallel.ts";
import { OrchestrationTaskSchema, type LauncherDeps, type OrchestratedTaskResult, type OrchestrationResult, type OrchestrationTask } from "./types.ts";
import type { Registry } from "./registry.ts";

function continueSerialFromIndex(opts: {
  orchestrationId: string;
  startIndex: number;
  previous: string;
  tasks: OrchestrationTask[];
  deps: LauncherDeps;
  registry: Registry;
}): void {
  const { orchestrationId, startIndex, previous, tasks, deps, registry } = opts;
  const signal = registry.getAbortSignal(orchestrationId)!;
  (async () => {
    try {
      const remaining = tasks.slice(startIndex).map((t, j) => ({
        ...t,
        task: j === 0 ? t.task.split("{previous}").join(previous) : t.task,
      }));
      const out = await runSerial(remaining, {
        signal,
        onLaunched: (j, info) => registry.onTaskLaunched(orchestrationId, startIndex + j, info),
        onTerminal: (j, r) => registry.onTaskTerminal(orchestrationId, startIndex + j, { ...r, index: startIndex + j }),
        onSessionKey: (j, key) => registry.updateSessionKey(orchestrationId, startIndex + j, key),
        onBlocked: (j, p) => registry.onTaskBlocked(orchestrationId, startIndex + j, p),
      }, deps);
      if (out.blocked) {
        // Paused again — wait for the next resume. Do NOT cancel the tail.
        return;
      }
      // Post-run fallback sweep (only on true terminal exits).
      const snap = registry.getSnapshot(orchestrationId);
      if (snap) {
        for (const t of snap.tasks) {
          if (t.state === "pending" || t.state === "running") {
            registry.onTaskTerminal(orchestrationId, t.index, {
              ...t, state: "cancelled", exitCode: 1, error: t.error ?? "not launched",
            });
          }
        }
      }
    } catch (err: any) {
      const snap = registry.getSnapshot(orchestrationId);
      if (snap) {
        for (const t of snap.tasks) {
          if (t.state === "pending" || t.state === "running" || t.state === "blocked") {
            registry.onTaskTerminal(orchestrationId, t.index, {
              ...t, state: "failed", exitCode: 1, error: err?.message ?? String(err),
            });
          }
        }
      }
    }
  })();
}

const SerialParams = Type.Object({
  tasks: Type.Array(OrchestrationTaskSchema),
  wait: Type.Optional(Type.Boolean({ description: "Default true. Set false to dispatch asynchronously; tool returns immediately with { orchestrationId, tasks } and delivers aggregated results via steer-back." })),
});

const ParallelParams = Type.Object({
  tasks: Type.Array(OrchestrationTaskSchema),
  maxConcurrency: Type.Optional(Type.Number()),
  wait: Type.Optional(Type.Boolean({ description: "Default true. Set false to dispatch asynchronously; tool returns immediately with { orchestrationId, tasks } and delivers aggregated results via steer-back." })),
});

const CancelParams = Type.Object({
  orchestrationId: Type.String({ description: "Orchestration id returned from a prior wait:false dispatch." }),
});

type ErrorResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { error: string };
};

export type PreflightFn = (ctx: {
  sessionManager: { getSessionFile(): string | null };
}) => ErrorResult | null;

export type SelfSpawnCheckFn = (agent: string | undefined) => ErrorResult | null;

export interface OrchestrationRegistrarExtras {
  registry?: Registry;
}

export function registerOrchestrationTools(
  pi: ExtensionAPI,
  depsFactory: (ctx: { sessionManager: any; cwd: string }) => LauncherDeps,
  shouldRegister: (name: string) => boolean,
  preflight: PreflightFn = () => null,
  selfSpawn: SelfSpawnCheckFn = () => null,
  extras: OrchestrationRegistrarExtras = {},
) {
  const registry = extras.registry;
  if (shouldRegister("subagent_run_serial")) {
    pi.registerTool({
      name: "subagent_run_serial",
      label: "Serial Subagents",
      description:
        "Run a sequence of subagent tasks in order. Each task's output is available to the next " +
        "as `{previous}`. Stops on first failure. Blocks the caller until the full sequence " +
        "completes (or errors). Use for pipelines where step N depends on step N-1.",
      promptSnippet:
        "Run a sequence of subagent tasks in order. Each task's output is available to the next " +
        "as `{previous}`. Stops on first failure. Blocks until the sequence completes.",
      parameters: SerialParams,
      async execute(_id, params, signal, _onUpdate, ctx) {
        for (const task of params.tasks) {
          const blocked = selfSpawn(task.agent);
          if (blocked) return blocked;
        }
        const gate = preflight(ctx);
        if (gate) return gate;

        if (params.wait === false) {
          if (!registry) {
            return {
              content: [{ type: "text", text: "Async orchestration unavailable: registry not configured." }],
              details: { error: "registry unavailable" },
            };
          }
          const deps = depsFactory(ctx);
          const orchestrationId = registry.dispatchAsync({
            config: { mode: "serial", tasks: params.tasks },
            onResumeUnblock: ({ taskIndex, resumedResult }) => {
              continueSerialFromIndex({
                orchestrationId,
                startIndex: taskIndex + 1,
                previous: resumedResult.finalMessage ?? "",
                tasks: params.tasks,
                deps,
                registry,
              });
            },
          });
          const signal = registry.getAbortSignal(orchestrationId)!;
          // Fire-and-forget: background execution with registry bookkeeping.
          (async () => {
            try {
              const out = await runSerial(params.tasks, {
                signal,
                onLaunched: (taskIndex, info) => registry.onTaskLaunched(orchestrationId, taskIndex, info),
                onTerminal: (taskIndex, result) => registry.onTaskTerminal(orchestrationId, taskIndex, result),
                onSessionKey: (taskIndex, sessionKey) => registry.updateSessionKey(orchestrationId, taskIndex, sessionKey),
                onBlocked: (taskIndex, p) => registry.onTaskBlocked(orchestrationId, taskIndex, {
                  sessionKey: p.sessionKey, message: p.message, partial: p.partial,
                }),
              }, deps);

              if (out.blocked) {
                // Paused on a blocked step. Task 11's continuation will re-enter
                // on resume. Do NOT run the post-run sweep — downstream steps
                // must stay pending so they remain launchable after resume.
                return;
              }

              // Post-run cleanup: any slot still pending/running is swept to cancelled
              // (belt & suspenders — runSerial should have reported each step before
              // returning, but if it bailed early for any reason we ensure the
              // orchestration finalizes instead of staying live).
              const snap = registry.getSnapshot(orchestrationId);
              if (snap) {
                for (const t of snap.tasks) {
                  if (t.state === "pending" || t.state === "running") {
                    registry.onTaskTerminal(orchestrationId, t.index, {
                      ...t, state: "cancelled", exitCode: 1, error: t.error ?? "not launched",
                    });
                  }
                }
              }
            } catch (err: any) {
              // Catastrophic failure: mark every non-terminal slot as failed.
              const snap = registry.getSnapshot(orchestrationId);
              if (snap) {
                for (const t of snap.tasks) {
                  if (t.state === "pending" || t.state === "running" || t.state === "blocked") {
                    registry.onTaskTerminal(orchestrationId, t.index, {
                      ...t, state: "failed", exitCode: 1, error: err?.message ?? String(err),
                    });
                  }
                }
              }
            }
          })();
          const envelope = {
            orchestrationId,
            tasks: params.tasks.map((t, i) => ({
              name: t.name ?? `step-${i + 1}`,
              index: i,
              state: "pending" as const,
            })),
            isError: false as const,
          };
          return {
            content: [{
              type: "text",
              text:
                `Orchestration "${orchestrationId}" started asynchronously (${params.tasks.length} task(s)). ` +
                `Do NOT assume results — aggregated completion will be delivered via a steer message.`,
            }],
            details: envelope,
          };
        }

        const deps = depsFactory(ctx);
        try {
          const out = await runSerial(
            params.tasks,
            { signal, onUpdate: _onUpdate as any },
            deps,
          );
          return {
            content: [
              {
                type: "text",
                text: summarize("serial", out.results, out.isError),
              },
            ],
            details: {
              ...out,
              results: toPublicResults(out.results),
            },
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `subagent_run_serial error: ${err?.message ?? String(err)}` }],
            details: { error: err?.message ?? String(err) },
          };
        }
      },
    });
  }

  if (shouldRegister("subagent_run_parallel")) {
    pi.registerTool({
      name: "subagent_run_parallel",
      label: "Parallel Subagents",
      description:
        "Run a batch of subagent tasks concurrently (default 4, hard cap 8). Blocks until all " +
        "tasks complete. Partial failures don't cancel siblings; each result is reported. " +
        "Panes are spawned detached by default on tmux; other mux backends (cmux, zellij, " +
        "wezterm) currently focus the new pane regardless — use the widget or native mux " +
        "shortcuts to navigate. Per-task `focus: true` overrides on any backend.",
      promptSnippet:
        "Run a batch of subagent tasks concurrently (default 4, hard cap 8). Blocks until all " +
        "tasks complete. Partial failures are reported independently. Detached spawn is " +
        "tmux-only; other backends focus the new pane.",
      parameters: ParallelParams,
      async execute(_id, params, signal, _onUpdate, ctx) {
        for (const task of params.tasks) {
          const blocked = selfSpawn(task.agent);
          if (blocked) return blocked;
        }
        const gate = preflight(ctx);
        if (gate) return gate;

        if (params.wait === false) {
          if (!registry) {
            return {
              content: [{ type: "text", text: "Async orchestration unavailable: registry not configured." }],
              details: { error: "registry unavailable" },
            };
          }
          const orchestrationId = registry.dispatchAsync({
            config: { mode: "parallel", tasks: params.tasks, maxConcurrency: params.maxConcurrency },
          });
          const deps = depsFactory(ctx);
          const signal = registry.getAbortSignal(orchestrationId)!;
          // Fire-and-forget: background execution with registry bookkeeping.
          (async () => {
            try {
              await runParallel(params.tasks, {
                signal,
                onLaunched: (taskIndex, info) => registry.onTaskLaunched(orchestrationId, taskIndex, info),
                onTerminal: (taskIndex, result) => registry.onTaskTerminal(orchestrationId, taskIndex, result),
                onSessionKey: (taskIndex, sessionKey) => registry.updateSessionKey(orchestrationId, taskIndex, sessionKey),
                onBlocked: (taskIndex, p) => registry.onTaskBlocked(orchestrationId, taskIndex, {
                  sessionKey: p.sessionKey, message: p.message, partial: p.partial,
                }),
                maxConcurrency: params.maxConcurrency,
              }, deps);
              // Post-run cleanup: any slot still pending/running is swept to cancelled.
              // Blocked slots are already in registry-owned state and are NOT
              // pending/running, so the sweep naturally skips them.
              const snap = registry.getSnapshot(orchestrationId);
              if (snap) {
                for (const t of snap.tasks) {
                  if (t.state === "pending" || t.state === "running") {
                    registry.onTaskTerminal(orchestrationId, t.index, {
                      ...t, state: "cancelled", exitCode: 1, error: t.error ?? "not launched",
                    });
                  }
                }
              }
            } catch (err: any) {
              // Catastrophic failure: mark every non-terminal slot as failed.
              const snap = registry.getSnapshot(orchestrationId);
              if (snap) {
                for (const t of snap.tasks) {
                  if (t.state === "pending" || t.state === "running" || t.state === "blocked") {
                    registry.onTaskTerminal(orchestrationId, t.index, {
                      ...t, state: "failed", exitCode: 1, error: err?.message ?? String(err),
                    });
                  }
                }
              }
            }
          })();
          const envelope = {
            orchestrationId,
            tasks: params.tasks.map((t, i) => ({
              name: t.name ?? `task-${i + 1}`,
              index: i,
              state: "pending" as const,
            })),
            isError: false as const,
          };
          return {
            content: [{
              type: "text",
              text:
                `Orchestration "${orchestrationId}" started asynchronously (${params.tasks.length} task(s)). ` +
                `Do NOT assume results — aggregated completion will be delivered via a steer message.`,
            }],
            details: envelope,
          };
        }

        const deps = depsFactory(ctx);
        try {
          const out = await runParallel(
            params.tasks,
            {
              maxConcurrency: params.maxConcurrency,
              signal,
              onUpdate: _onUpdate as any,
            },
            deps,
          );
          return {
            content: [
              {
                type: "text",
                text: summarize("parallel", out.results, out.isError),
              },
            ],
            details: {
              ...out,
              results: toPublicResults(out.results),
            },
          };
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          const hint = msg.includes("hard cap")
            ? msg
            : `subagent_run_parallel error: ${msg}`;
          return {
            content: [{ type: "text", text: hint }],
            details: {
              error: msg.includes("hard cap") ? "maxConcurrency exceeds hard cap" : msg,
            },
          };
        }
      },
    });
  }

  if (registry && shouldRegister("subagent_run_cancel")) {
    pi.registerTool({
      name: "subagent_run_cancel",
      label: "Cancel Orchestration",
      description:
        "Cancel a running async orchestration by id. Transitions all non-terminal tasks " +
        "to `cancelled` and fires the standard aggregated completion steer-back. " +
        "Idempotent on already-terminal runs.",
      promptSnippet:
        "Cancel a running async orchestration by id. Idempotent on already-terminal runs.",
      parameters: CancelParams,
      async execute(_id, params) {
        const res = registry.cancel(params.orchestrationId);
        return {
          content: [{
            type: "text",
            text: res.alreadyTerminal
              ? `Orchestration "${params.orchestrationId}" already terminal.`
              : `Orchestration "${params.orchestrationId}" cancelled.`,
          }],
          details: res,
        };
      },
    });
  }
}

export function toPublicResults(results: OrchestrationResult[]): OrchestratedTaskResult[] {
  return results.map((r, i) => ({
    name: r.name,
    index: r.index ?? i,
    state: r.state ?? (r.exitCode === 0 && !r.error ? "completed" : "failed"),
    finalMessage: r.finalMessage,
    transcriptPath: r.transcriptPath ?? null,
    elapsedMs: r.elapsedMs,
    exitCode: r.exitCode,
    sessionKey: r.sessionKey,
    error: r.error,
    usage: r.usage,
    transcript: r.transcript,
  }));
}

function summarize(mode: "serial" | "parallel", results: any[], isError: boolean): string {
  const lines = [`${mode} orchestration: ${results.length} task(s), isError=${isError}`];
  for (const r of results) {
    lines.push(`- ${r.name}: exit=${r.exitCode} (${r.elapsedMs}ms) — ${firstLine(r.finalMessage)}`);
  }
  return lines.join("\n");
}

function firstLine(s: string): string {
  const line = (s ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > 200 ? line.slice(0, 200) + "…" : line;
}
