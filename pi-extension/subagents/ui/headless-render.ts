import { Container, Markdown, Spacer, Text, type Component } from "@mariozechner/pi-tui";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import {
  COLLAPSED_ITEM_COUNT,
  extractDisplayItems,
  formatToolCall,
  formatUsageStats,
  type Theme as BaseTheme,
} from "./format.ts";
import type { TranscriptMessage, UsageStats } from "../backends/types.ts";
import type { OrchestratedTaskResult } from "../../orchestration/types.ts";

export type RichMode = "single" | "serial" | "parallel";

export interface TaskRow {
  name: string;
  agent?: string;
  state: "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  finalMessage?: string;
  transcript?: TranscriptMessage[];
  usage?: UsageStats;
  task?: string;
  error?: string;
  index?: number;
}

interface Theme extends BaseTheme {
  bold(text: string): string;
}

interface RenderOpts {
  mode: RichMode;
  results: TaskRow[];
  expanded: boolean;
  theme: Theme;
  isError?: boolean;
  inflight?: boolean;
}

function stateIcon(state: TaskRow["state"], theme: Theme): string {
  switch (state) {
    case "completed":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
    case "cancelled":
      return theme.fg("dim", "○");
    case "blocked":
      return theme.fg("warning", "⏸");
    case "running":
      return theme.fg("warning", "⏳");
    case "pending":
    default:
      return theme.fg("dim", "·");
  }
}

function aggregateUsage(rows: TaskRow[]): UsageStats {
  const total: UsageStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
  for (const r of rows) {
    if (!r.usage) continue;
    total.input += r.usage.input ?? 0;
    total.output += r.usage.output ?? 0;
    total.cacheRead += r.usage.cacheRead ?? 0;
    total.cacheWrite += r.usage.cacheWrite ?? 0;
    total.cost += r.usage.cost ?? 0;
    total.turns += r.usage.turns ?? 0;
  }
  return total;
}

function renderTaskBlock(container: Container, r: TaskRow, opts: RenderOpts): void {
  const theme = opts.theme;

  // Header
  const agentSuffix = r.agent ? theme.fg("dim", ` (${r.agent})`) : "";
  let header = `${stateIcon(r.state, theme)} ${theme.bold(r.name)}${agentSuffix}`;
  if (r.state !== "completed") {
    header += theme.fg("dim", ` — ${r.state}`);
  }
  container.addChild(new Text(header, 0, 0));

  if (r.error) {
    container.addChild(new Text(theme.fg("error", `Error: ${r.error}`), 0, 0));
  }

  // Tool calls / display items
  const items = extractDisplayItems(r.transcript ?? []);
  if (opts.expanded) {
    for (const item of items) {
      if (item.type === "toolCall") {
        container.addChild(
          new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme), 0, 0),
        );
      } else if (item.type === "text") {
        container.addChild(new Text(item.text, 0, 0));
      }
    }
  } else {
    const toolCalls = items.filter((it) => it.type === "toolCall");
    const shown = toolCalls.slice(-COLLAPSED_ITEM_COUNT);
    for (const item of shown) {
      if (item.type === "toolCall") {
        container.addChild(
          new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme), 0, 0),
        );
      }
    }
  }

  // Usage line
  if (r.usage) {
    container.addChild(new Text(theme.fg("dim", formatUsageStats(r.usage)), 0, 0));
  }

  // Expanded-only: task + output
  if (opts.expanded) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
    container.addChild(new Text(theme.fg("dim", r.task ?? ""), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
    const finalMsg = (r.finalMessage ?? "").trim();
    if (finalMsg) {
      container.addChild(new Markdown(finalMsg, 0, 0, getMarkdownTheme()));
    } else {
      container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
    }
  }
}

export function renderRichSubagentResult(opts: RenderOpts): Component {
  const container = new Container();
  const theme = opts.theme;

  if (opts.mode === "single") {
    const r = opts.results[0];
    if (r) {
      renderTaskBlock(container, r, opts);
    }
  } else {
    // Aggregate header
    const icon = opts.isError
      ? theme.fg("error", "✗")
      : opts.inflight
        ? theme.fg("warning", "⏳")
        : theme.fg("success", "✓");
    const label = theme.bold(opts.mode === "serial" ? "Serial" : "Parallel");
    const count = theme.fg("accent", `${opts.results.length} task${opts.results.length === 1 ? "" : "s"}`);
    container.addChild(new Text(`${icon} ${label} ${count}`, 0, 0));

    for (const r of opts.results) {
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", r.name)} ${stateIcon(r.state, theme)}`, 0, 0),
      );
      renderTaskBlock(container, r, opts);
    }

    const total = aggregateUsage(opts.results);
    container.addChild(new Text(theme.fg("dim", `Total: ${formatUsageStats(total)}`), 0, 0));
  }

  if (!opts.expanded) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(theme.fg("muted", keyHint("app.tools.expand", "to expand")), 0, 0),
    );
  }

  return container;
}

/**
 * Map orchestration `OrchestratedTaskResult[]` to `TaskRow[]`.
 *
 * Known gap: `OrchestratedTaskResult` does not carry the per-step `agent`
 * identifier or the original `task` text. Both are left undefined here; UI
 * callers that have access to the originating `OrchestrationTask[]` can
 * populate them by post-processing the rows.
 */
export function toTaskRows(results: OrchestratedTaskResult[]): TaskRow[] {
  return results.map((r) => ({
    name: r.name,
    agent: undefined,
    state: r.state ?? "pending",
    finalMessage: r.finalMessage,
    transcript: r.transcript,
    usage: r.usage,
    task: undefined,
    error: r.error,
    index: r.index,
  }));
}
