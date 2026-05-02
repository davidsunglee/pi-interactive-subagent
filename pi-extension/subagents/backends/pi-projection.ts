import type { TranscriptContent, TranscriptMessage } from "./types.ts";
import { existsSync, readFileSync } from "node:fs";

export type PiStreamMessage = {
  role: "user" | "assistant" | "toolResult";
  content: unknown;
};

export function projectPiMessageToTranscript(msg: PiStreamMessage): TranscriptMessage {
  const rawContent: unknown = msg.content;
  const content: TranscriptContent[] = typeof rawContent === "string"
    ? [{ type: "text", text: rawContent }]
    : (rawContent as TranscriptContent[]);
  if (msg.role === "toolResult") {
    const tr = msg as any;
    return {
      role: "toolResult",
      content,
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      isError: tr.isError,
    };
  }
  return { role: msg.role, content };
}

export interface PiTailState {
  offset: number;
  pendingTail: string;
}

export interface PiTailDelta {
  messages: PiStreamMessage[];
  assistantMessages: PiStreamMessage[];
}

export function tailPiSessionEntries(sessionFile: string, state: PiTailState): PiTailDelta {
  if (!existsSync(sessionFile)) {
    return { messages: [], assistantMessages: [] };
  }

  const raw = readFileSync(sessionFile, "utf8");
  const unread = state.pendingTail + raw.slice(state.offset);
  state.offset = raw.length;
  state.pendingTail = "";

  const lines = unread.split("\n");
  state.pendingTail = lines.pop() ?? "";

  const messages: PiStreamMessage[] = [];
  const assistantMessages: PiStreamMessage[] = [];

  for (const line of lines) {
    if (line.trim() === "") continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "message" && entry.message) {
      const msg = entry.message as PiStreamMessage;
      messages.push(msg);
      if (msg.role === "assistant") {
        assistantMessages.push(entry.message);
      }
    }
  }

  return { messages, assistantMessages };
}
