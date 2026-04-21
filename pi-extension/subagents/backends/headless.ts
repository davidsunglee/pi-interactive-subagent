import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
  Backend,
  BackendLaunchParams,
  BackendResult,
  LaunchedHandle,
} from "./types.ts";

export function makeHeadlessBackend(_ctx: {
  sessionManager: ExtensionContext["sessionManager"];
  cwd: string;
}): Backend {
  return {
    async launch(
      _params: BackendLaunchParams,
      _defaultFocus: boolean,
      _signal?: AbortSignal,
    ): Promise<LaunchedHandle> {
      throw new Error(
        "headless backend not implemented yet (Phase 2). " +
          "Unset PI_SUBAGENT_MODE or set PI_SUBAGENT_MODE=pane to use the existing pane backend.",
      );
    },
    async watch(_handle: LaunchedHandle, _signal?: AbortSignal): Promise<BackendResult> {
      throw new Error("headless backend not implemented yet (Phase 2).");
    },
  };
}
