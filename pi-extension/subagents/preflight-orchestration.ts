import { selectBackend } from "./backends/select.ts";
import { isMuxAvailable, muxSetupHint } from "./cmux.ts";

type ErrorResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { error: string };
};

let muxProbe: () => boolean = isMuxAvailable;

export function preflightOrchestration(ctx: {
  sessionManager: { getSessionFile(): string | null };
}): ErrorResult | null {
  if (selectBackend() === "pane") {
    if (!muxProbe()) {
      return {
        content: [
          { type: "text", text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}` },
        ],
        details: { error: "mux not available" },
      };
    }
  }
  if (!ctx.sessionManager.getSessionFile()) {
    return {
      content: [
        { type: "text", text: "Error: no session file. Start pi with a persistent session to use subagents." },
      ],
      details: { error: "no session file" },
    };
  }
  return null;
}

export const __test__ = {
  setMuxProbe(fn: () => boolean): void {
    muxProbe = fn;
  },
  resetMuxProbe(): void {
    muxProbe = isMuxAvailable;
  },
};
