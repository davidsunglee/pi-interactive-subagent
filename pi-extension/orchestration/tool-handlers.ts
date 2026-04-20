import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runSerial } from "./run-serial.ts";
import { runParallel } from "./run-parallel.ts";
import { OrchestrationTaskSchema, type LauncherDeps } from "./types.ts";

const SerialParams = Type.Object({
  tasks: Type.Array(OrchestrationTaskSchema),
});

const ParallelParams = Type.Object({
  tasks: Type.Array(OrchestrationTaskSchema),
  maxConcurrency: Type.Optional(Type.Number()),
});

type ErrorResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { error: string };
};

export type PreflightFn = (ctx: {
  sessionManager: { getSessionFile(): string | null };
}) => ErrorResult | null;

export type SelfSpawnCheckFn = (agent: string | undefined) => ErrorResult | null;

export function registerOrchestrationTools(
  pi: ExtensionAPI,
  depsFactory: (ctx: { sessionManager: any; cwd: string }) => LauncherDeps,
  shouldRegister: (name: string) => boolean,
  preflight: PreflightFn = () => null,
  selfSpawn: SelfSpawnCheckFn = () => null,
) {
  if (shouldRegister("subagent_serial")) {
    pi.registerTool({
      name: "subagent_serial",
      label: "Serial Subagents",
      description:
        "Run a sequence of subagent tasks in order. Each task's output is available to the next " +
        "as `{previous}`. Stops on first failure. Blocks the caller until the full sequence " +
        "completes (or errors). Use for pipelines where step N depends on step N-1.",
      promptSnippet:
        "Run a sequence of subagent tasks in order. Each task's output is available to the next " +
        "as `{previous}`. Stops on first failure. Blocks until the sequence completes.",
      parameters: SerialParams,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        for (const task of params.tasks) {
          const blocked = selfSpawn(task.agent);
          if (blocked) return blocked;
        }
        const gate = preflight(ctx);
        if (gate) return gate;
        const deps = depsFactory(ctx);
        try {
          const out = await runSerial(params.tasks, {}, deps);
          return {
            content: [
              {
                type: "text",
                text: summarize("serial", out.results, out.isError),
              },
            ],
            details: out,
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `subagent_serial error: ${err?.message ?? String(err)}` }],
            details: { error: err?.message ?? String(err) },
          };
        }
      },
    });
  }

  if (shouldRegister("subagent_parallel")) {
    pi.registerTool({
      name: "subagent_parallel",
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
      async execute(_id, params, _signal, _onUpdate, ctx) {
        for (const task of params.tasks) {
          const blocked = selfSpawn(task.agent);
          if (blocked) return blocked;
        }
        const gate = preflight(ctx);
        if (gate) return gate;
        const deps = depsFactory(ctx);
        try {
          const out = await runParallel(
            params.tasks,
            { maxConcurrency: params.maxConcurrency },
            deps,
          );
          return {
            content: [
              {
                type: "text",
                text: summarize("parallel", out.results, out.isError),
              },
            ],
            details: out,
          };
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          const hint = msg.includes("hard cap")
            ? msg
            : `subagent_parallel error: ${msg}`;
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
