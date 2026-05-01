import { Box, Text } from "@mariozechner/pi-tui";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { renderRichSubagentResult, type TaskRow } from "./headless-render.ts";
import type { TranscriptMessage, UsageStats } from "../backends/types.ts";

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export function extractFinalMessageFromContent(
  content: string,
  name: string,
  elapsed: string,
  exitCode: number,
): string {
  return content
    .replace(/\n\nSession: .+\nResume: .+$/, "")
    .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
    .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "");
}

interface RendererTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

interface RendererMessage {
  content: unknown;
  details: unknown;
}

interface RendererOptions {
  expanded: boolean;
}

interface RendererHandle {
  invalidate(): void;
  render(width: number): string[];
}

export function createSubagentResultRenderer(
  message: RendererMessage,
  options: RendererOptions,
  theme: RendererTheme,
): RendererHandle | undefined {
  const details = message.details as any;
  if (!details) return undefined;

  return {
    invalidate() {},
    render(width: number): string[] {
      const name = details.name ?? "subagent";
      const exitCode = details.exitCode ?? 0;
      const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";

      // Headless completion: render rich layout when transcript+usage present
      if (details.transcript && details.usage) {
        const rawContent = typeof message.content === "string" ? message.content : "";
        const finalMessage = extractFinalMessageFromContent(rawContent, name, elapsed, exitCode);

        const row: TaskRow = {
          name,
          agent: details.agent,
          state: exitCode === 0 ? "completed" : "failed",
          finalMessage,
          transcript: details.transcript as TranscriptMessage[],
          usage: details.usage as UsageStats,
          task: details.task,
          error: details.error,
        };

        const component = renderRichSubagentResult({
          mode: "single",
          results: [row],
          expanded: options.expanded,
          theme,
        });
        return component.render(width);
      }

      // Pane / legacy shape: original box rendering
      const bgFn =
        exitCode === 0
          ? (text: string) => theme.bg("toolSuccessBg", text)
          : (text: string) => theme.bg("toolErrorBg", text);
      const icon = exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const status = exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;
      const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

      const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
      const rawContent = typeof message.content === "string" ? message.content : "";

      const summary = extractFinalMessageFromContent(rawContent, name, elapsed, exitCode);

      const contentLines = [header];

      if (options.expanded) {
        if (summary) {
          for (const line of summary.split("\n")) {
            contentLines.push(line.slice(0, width - 6));
          }
        }
        if (details.sessionFile) {
          contentLines.push("");
          contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
        }
      } else {
        if (summary) {
          const previewLines = summary.split("\n").slice(0, 5);
          for (const line of previewLines) {
            contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
          }
          const totalLines = summary.split("\n").length;
          if (totalLines > 5) {
            contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
          }
        }
        contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
      }

      const box = new Box(1, 1, bgFn);
      box.addChild(new Text(contentLines.join("\n"), 0, 0));
      return ["", ...box.render(width)];
    },
  };
}
