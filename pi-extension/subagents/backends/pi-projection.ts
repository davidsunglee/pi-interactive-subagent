import type { TranscriptContent, TranscriptMessage } from "./types.ts";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

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

// Incrementally reads bytes after `state.offset` from the session jsonl,
// avoiding repeated whole-file reads on each pane-watch tick. Truncation is
// detected via `stat.size < state.offset` and resets state to re-read from 0.
export function tailPiSessionEntries(sessionFile: string, state: PiTailState): PiTailDelta {
  if (!existsSync(sessionFile)) {
    return { messages: [], assistantMessages: [] };
  }

  let size: number;
  try {
    size = statSync(sessionFile).size;
  } catch {
    return { messages: [], assistantMessages: [] };
  }

  if (size < state.offset) {
    state.offset = 0;
    state.pendingTail = "";
  }

  if (size === state.offset) {
    return { messages: [], assistantMessages: [] };
  }

  const length = size - state.offset;
  const buf = Buffer.alloc(length);
  let fd: number;
  try {
    fd = openSync(sessionFile, "r");
  } catch {
    return { messages: [], assistantMessages: [] };
  }
  let bytesRead: number;
  try {
    bytesRead = readSync(fd, buf, 0, length, state.offset);
  } catch {
    try { closeSync(fd); } catch {}
    return { messages: [], assistantMessages: [] };
  } finally {
    try { closeSync(fd); } catch {}
  }

  const chunk = state.pendingTail + buf.subarray(0, bytesRead).toString("utf8");
  state.offset += bytesRead;

  const lines = chunk.split("\n");
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
