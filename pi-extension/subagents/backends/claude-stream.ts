import type { TranscriptContent, TranscriptMessage, UsageStats } from "./types.ts";
import type { ResolvedLaunchSpec } from "../launch-spec.ts";
import { PI_TO_CLAUDE_TOOLS } from "./tool-map.ts";

const EFFORT_MAP: Record<string, string> = {
  off: "low", minimal: "low", low: "low",
  medium: "medium", high: "high", xhigh: "max",
};

export function buildClaudeHeadlessArgs(
  spec: ResolvedLaunchSpec,
  taskText: string,
): string[] {
  const args: string[] = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
  ];
  if (spec.claudeModelArg) {
    args.push("--model", spec.claudeModelArg);
  }
  if (spec.effectiveThinking) {
    const effort = EFFORT_MAP[spec.effectiveThinking.toLowerCase()];
    if (effort) args.push("--effort", effort);
  }
  if (spec.identity) {
    const flag = spec.systemPromptMode === "replace"
      ? "--system-prompt"
      : "--append-system-prompt";
    args.push(flag, spec.identity);
  }
  if (spec.effectiveTools) {
    const claudeTools = new Set<string>();
    for (const t of spec.effectiveTools.split(",").map((s) => s.trim()).filter(Boolean)) {
      const mapped = PI_TO_CLAUDE_TOOLS[t.toLowerCase()];
      if (mapped) claudeTools.add(mapped);
    }
    if (claudeTools.size > 0) args.push("--tools", [...claudeTools].join(","));
  }
  if (spec.resumeSessionId) {
    args.push("--resume", spec.resumeSessionId);
  }
  if (taskText !== "") {
    args.push("--", taskText);
  }
  return args;
}

export interface ClaudeResult {
  exitCode: number;
  finalOutput: string;
  usage: UsageStats;
  error?: string;
  model?: string;
}

export function parseClaudeStreamEvent(
  event: Record<string, unknown>,
): TranscriptMessage[] | undefined {
  if (event.type === "assistant") {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return undefined;
    const rawContent = message.content;
    const content: TranscriptContent[] = Array.isArray(rawContent)
      ? (rawContent as Array<Record<string, unknown>>).map((block) => {
          if (block.type === "tool_use") {
            return {
              type: "toolCall",
              id: block.id as string,
              name: (block.name as string)?.toLowerCase(),
              arguments: block.input,
            };
          }
          return block as unknown as TranscriptContent;
        })
      : [];
    return [{ role: "assistant", content }];
  }
  if (event.type === "user") {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message || !Array.isArray(message.content)) return undefined;
    const out: TranscriptMessage[] = [];
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result") continue;
      const raw = block.content;
      let content: TranscriptContent[];
      if (typeof raw === "string") {
        content = [{ type: "text", text: raw }];
      } else if (Array.isArray(raw)) {
        content = (raw as Array<Record<string, unknown>>).map((b) => {
          if (b.type === "text") return { type: "text", text: b.text as string };
          if (b.type === "image") {
            const src = (b.source ?? {}) as Record<string, unknown>;
            return {
              type: "image",
              data: (src.data as string) ?? (b.data as string) ?? "",
              mimeType: (src.media_type as string) ?? (b.mimeType as string) ?? "",
            };
          }
          return b as unknown as TranscriptContent;
        });
      } else {
        content = [];
      }
      out.push({
        role: "toolResult",
        content,
        toolCallId: block.tool_use_id as string,
        isError: block.is_error === true,
      });
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

export function parseClaudeResult(json: Record<string, unknown>): ClaudeResult {
  const isError = json.is_error === true;
  const subtype = json.subtype as string | undefined;
  const hasError = isError || (subtype !== undefined && subtype !== "success");

  const usage = (json.usage ?? {}) as Record<string, number>;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cost = (json.total_cost_usd as number) ?? 0;
  const turns = (json.num_turns as number) ?? 0;

  return {
    exitCode: hasError ? 1 : 0,
    finalOutput: (json.result as string) || "",
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      cost,
      contextTokens: input + output + cacheRead + cacheWrite,
      turns,
    },
    error: hasError
      ? ((json.result as string) || subtype || "unknown_error")
      : undefined,
    model: json.model as string | undefined,
  };
}
