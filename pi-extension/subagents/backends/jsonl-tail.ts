import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

// Mutable per-tailer state. `decoder` is created lazily so callers can keep
// constructing the public fields with object literals. Holding the decoder
// across reads is what gives us torn-write fault tolerance for multibyte
// UTF-8: bytes that arrive split across reads (e.g., 2 of 4 bytes for a 🌍
// emoji) are buffered inside the decoder and only emitted once the rest of
// the sequence arrives, instead of decoding to U+FFFD and corrupting the
// line we then try to JSON.parse.
export interface JsonlTailState {
  offset: number;
  pendingTail: string;
  decoder?: StringDecoder;
}

export interface JsonlTailDelta {
  lines: string[];
}

// Reads bytes after `state.offset` from `path`, decodes UTF-8 with a
// persistent StringDecoder, and returns complete newline-terminated lines.
// Truncation (`size < state.offset`) resets the offset, line tail, AND
// decoder so leftover partial bytes from the prior file aren't applied to
// the new content.
export function tailJsonlLines(path: string, state: JsonlTailState): JsonlTailDelta {
  if (!existsSync(path)) return { lines: [] };

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { lines: [] };
  }

  if (size < state.offset) {
    state.offset = 0;
    state.pendingTail = "";
    state.decoder = new StringDecoder("utf8");
  }

  if (size === state.offset) return { lines: [] };

  const length = size - state.offset;
  const buf = Buffer.alloc(length);
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { lines: [] };
  }
  let bytesRead = 0;
  let readFailed = false;
  try {
    bytesRead = readSync(fd, buf, 0, length, state.offset);
  } catch {
    readFailed = true;
  } finally {
    try { closeSync(fd); } catch {}
  }
  if (readFailed) return { lines: [] };

  if (!state.decoder) state.decoder = new StringDecoder("utf8");
  const decoded = state.decoder.write(buf.subarray(0, bytesRead));
  state.offset += bytesRead;

  const chunk = state.pendingTail + decoded;
  const parts = chunk.split("\n");
  state.pendingTail = parts.pop() ?? "";
  return { lines: parts };
}
