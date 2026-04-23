import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runSerial } from "./run-serial.ts";
import { runParallel } from "./run-parallel.ts";
import { OrchestrationTaskSchema, type LauncherDeps, type OrchestratedTaskResult, type OrchestrationResult } from "./types.ts";
import type { Registry } from "./registry.ts";

const SerialParams = Type.Object({
  tasks: Type.Array(OrchestrationTaskSchema),
  wait: Type.Optional(Type.Boolean({ description: "Default true. Set false to dispatch asynchronously; tool returns immediately with { orchestrationId, tasks } and delivers aggregated results via steer-back." })),
});

const ParallelParams = Type.Object({
  tasks: Type.Array(OrchestrationTaskSchema),
  maxConcurrency: Type.Optional(Type.Number()),
  wait: Type.Optional(Type.Boolean({ description: "Default true. Set false to dispatch asynchronously; tool returns immediately with { orchestrationId, tasks } and delivers aggregated results via steer-back." })),
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
          const orchestrationId = registry.dispatchAsync({
            config: { mode: "serial", tasks: params.tasks },
          });
          const deps = depsFactory(ctx);
          // Fire-and-forget: background execution with registry bookkeeping.
          (async () => {
            try {
              await runSerial(params.tasks, {
                // No signal: async runs are cancelled via subagent_run_cancel, not AbortSignal.
                onLaunched: (taskIndex, info) => registry.onTaskLaunched(orchestrationId, taskIndex, info),
                onTerminal: (taskIndex, result) => registry.onTaskTerminal(orchestrationId, taskIndex, result),
                // Phase 2 also wires onBlocked here (Task 10). Left unset in Phase 1.
              }, deps);
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
          // Fire-and-forget: background execution with registry bookkeeping.
          (async () => {
            try {
              await runParallel(params.tasks, {
                onLaunched: (taskIndex, info) => registry.onTaskLaunched(orchestrationId, taskIndex, info),
                onTerminal: (taskIndex, result) => registry.onTaskTerminal(orchestrationId, taskIndex, result),
                maxConcurrency: params.maxConcurrency,
                // Phase 2 also wires onBlocked here (Task 10). Left unset in Phase 1.
              }, deps);
              // Post-run cleanup: any slot still pending/running is swept to cancelled.
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
