import { detectMux as realDetectMux } from "../cmux.ts";

const warnedInvalidValues = new Set<string>();

// Indirection: the auto-mode branch reads through a mutable reference so the
// unit test in Task 9 can force the `auto -> pane` case by swapping in a stub
// detector. Production callers still resolve `realDetectMux` because
// `__test__.restoreDetectMux()` is the default. Keep this as a module-level
// `let` rather than a parameter so the call sites in index.ts / default-deps
// stay `selectBackend()` with no args.
let detectMuxImpl: () => boolean = realDetectMux;

export type BackendKind = "pane" | "headless";

export function selectBackend(): BackendKind {
  const raw = (process.env.PI_SUBAGENT_MODE ?? "auto").toLowerCase();
  if (raw === "pane") return "pane";
  if (raw === "headless") return "headless";
  if (raw !== "auto" && !warnedInvalidValues.has(raw)) {
    warnedInvalidValues.add(raw);
    process.stderr.write(
      `[pi-interactive-subagent] PI_SUBAGENT_MODE="${raw}" invalid; ` +
        `falling back to auto (valid: pane | headless | auto)\n`,
    );
  }
  return detectMuxImpl() ? "pane" : "headless";
}

export const __test__ = {
  resetWarnedValues(): void {
    warnedInvalidValues.clear();
  },
  setDetectMux(fn: () => boolean): void {
    detectMuxImpl = fn;
  },
  restoreDetectMux(): void {
    detectMuxImpl = realDetectMux;
  },
};
