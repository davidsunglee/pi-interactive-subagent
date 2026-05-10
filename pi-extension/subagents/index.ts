import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
  statSync,
} from "node:fs";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendLongCommand,
  pollForExit,
  closeSurface,
  shellEscape,
  readScreen,
  sendEscape,
  getMuxBackend,
} from "./cmux.ts";
import {
  findLastAssistantMessage,
  getNewEntries,
  seedSubagentSessionFile,
} from "./session.ts";
import { registerOrchestrationTools } from "../orchestration/tool-handlers.ts";
import { makeDefaultDeps } from "../orchestration/default-deps.ts";
import { preflightOrchestration } from "./preflight-orchestration.ts";
import { createRegistry, type Registry } from "../orchestration/registry.ts";
import { type LauncherDeps } from "../orchestration/types.ts";
import {
  ORCHESTRATION_COMPLETE_KIND,
  BLOCKED_KIND,
} from "../orchestration/notification-kinds.ts";
import { randomUUID } from "node:crypto";
import { selectBackend } from "./backends/select.ts";
import { makeHeadlessBackend } from "./backends/headless.ts";
import { computePiTailResumeOffset, projectPiMessageToTranscript, tailPiSessionEntries } from "./backends/pi-projection.ts";
import { tailJsonlLines, type JsonlTailState } from "./backends/jsonl-tail.ts";
import { parseClaudeStreamEvent, parseClaudeResult } from "./backends/claude-stream.ts";
import { PI_TO_CLAUDE_TOOLS } from "./backends/tool-map.ts";
import type { UsageStats, TranscriptMessage } from "./backends/types.ts";
import { renderRichSubagentResult, toTaskRows } from "./ui/headless-render.ts";
import { createSubagentResultRenderer } from "./ui/subagent-result-renderer.ts";
import {
  SubagentParams,
  type SubagentParamsType,
  type AgentDefaults,
  type ResolvedLaunchSpec,
  type SubagentSessionMode,
  resolveLaunchSpec,
  resolveEffectiveInteractive,
  resolvePiToolsArg,
  writeSystemPromptArtifact,
  writeTaskArtifact,
  loadAgentDefaults,
  resolveSubagentPaths,
  resolveLaunchBehavior,
  resolveEffectiveSessionMode,
  resolveDenyTools,
  getDefaultSessionDirFor,
  getArtifactDir,
  getAgentConfigDir,
  buildPiPromptArgs,
} from "./launch-spec.ts";
import {
  createStatusState,
  type SubagentStatusState,
  type StatusSnapshot,
  type StatusConfig,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
  DEFAULT_STATUS_LINE_LIMIT,
} from "./status.ts";
import {
  type SubagentActivityState,
  type ActivityReadResult,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "./activity.ts";

// Public re-exports so existing callers (other packages/tests) keep working
// unchanged after the Task 9b refactor.
export {
  SubagentParams,
  resolveLaunchSpec,
  resolveEffectiveInteractive,
  loadAgentDefaults,
  resolveSubagentPaths,
  resolveLaunchBehavior,
  resolveEffectiveSessionMode,
  resolveDenyTools,
  getDefaultSessionDirFor,
  getArtifactDir,
  getAgentConfigDir,
  buildPiPromptArgs,
  writeSystemPromptArtifact,
  writeTaskArtifact,
};
export type {
  SubagentParamsType,
  AgentDefaults,
  ResolvedLaunchSpec,
  SubagentSessionMode,
};

type ResumeToolParams = {
  sessionPath?: string;
  sessionId?: string;
  name?: string;
  message?: string;
  autoExit?: boolean;
};

/**
 * Compute auto-exit / interactive flags for a resumed subagent.
 *
 * Ported from upstream commit 4fe6754 (PR #40). The default is `autoExit: true`
 * so resumed autonomous follow-ups close after their next normal completion;
 * callers wanting an interactive handoff opt in with `autoExit: false`.
 *
 * Note: `interactive` is returned for parity with upstream and for use by
 * future status-supervision work (TODO-8c06b75d). It is not yet consumed by
 * the local `RunningSubagent` shape.
 */
export function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): {
  autoExit: boolean;
  interactive: boolean;
} {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

// Defensive fallback: the example config is created in Task 2 so this should
// never fail in practice, but we guard against a missing file at extension load.
let statusConfig = (() => {
  try {
    return loadStatusConfig();
  } catch {
    return { enabled: true, lineLimit: DEFAULT_STATUS_LINE_LIMIT };
  }
})();

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

export function preflightSubagent(ctx: {
  sessionManager: { getSessionFile(): string | null };
}): { content: Array<{ type: "text"; text: string }>; details: { error: string } } | null {
  if (!isMuxAvailable()) {
    return muxUnavailableResult();
  }
  if (!ctx.sessionManager.getSessionFile()) {
    return {
      content: [
        {
          type: "text",
          text: "Error: no session file. Start pi with a persistent session to use subagents.",
        },
      ],
      details: { error: "no session file" },
    };
  }
  return null;
}

export function selfSpawnBlocked(
  agent: string | undefined,
): { content: Array<{ type: "text"; text: string }>; details: { error: string } } | null {
  const currentAgent = process.env.PI_SUBAGENT_AGENT;
  if (!agent || !currentAgent || agent !== currentAgent) return null;
  return {
    content: [
      {
        type: "text",
        text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
      },
    ],
    details: { error: "self-spawn blocked" },
  };
}

export function thinkingToEffort(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase().trim();
  if (v === "off" || v === "minimal" || v === "low") return "low";
  if (v === "medium") return "medium";
  if (v === "high") return "high";
  if (v === "xhigh") return "max";
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  return [...agents.values()];
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
      },
    ],
    details: { error: "mux not available" },
  };
}

/**
 * Try to find and measure a specific session file, or discover
 * the right one from new files in the session directory.
 *
 * When `trackedFile` is provided, measures that file directly.
 * Otherwise scans for new files not in `existingFiles` or `excludeFiles`.
 *
 * Returns { file, entries, bytes } — `file` is the path that was measured,
 * so callers can lock onto it for subsequent calls.
 */
/**
 * Result from running a single subagent.
 */
export interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  claudeSessionId?: string;  // For Claude Code resume capability
  transcriptPath: string | null;
  exitCode: number;
  elapsed: number;
  error?: string;
  ping?: { name: string; message: string };
  /** Live transcript accumulated during the run; populated for both pi and Claude pane backends. */
  transcript?: TranscriptMessage[];
  /** Live usage stats accumulated during the run; populated for both pi and Claude pane backends. */
  usage?: UsageStats;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
export interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  backend: "pane" | "headless";
  startTime: number;
  /** Pane-only: present only for `backend === "pane"`. */
  surface?: string;
  /** Pane-only: path to the subagent's jsonl session file. Headless does not have one at launch time. */
  sessionFile?: string;
  /** Pane Pi-only: byte offset after pre-seeded parent history; live tailing starts here. */
  piTailStartOffset?: number;
  launchScriptFile?: string;
  entries?: number;
  bytes?: number;
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  /** Headless-only: accumulated usage stats, populated as the run progresses. */
  usage?: UsageStats;
  /**
   * Set on virtual rows installed when an orchestration task transitions to
   * `blocked`. Keyed externally on `(orchestrationId, taskIndex)` via the
   * `virtualBlocked` map so the widget keeps rendering the blocked state
   * after the child's own pane closes. Real running subagents never carry
   * this field.
   */
  blocked?: {
    orchestrationId: string;
    taskIndex: number;
    message: string;
  };
  /** Per-row supervision state. Synthetic blocked virtual rows do NOT carry this. */
  statusState?: SubagentStatusState;
  /** Most recent activity snapshot read by the supervision loop. */
  activity?: SubagentActivityState;
  /** Pi children only — path to the child-written activity-snapshot JSON file. */
  activityFile?: string;
  /** Suppress stall/recovered steer messages when true; resolved per the interactive chain. Defaults to false for synthetic rows. */
  interactive?: boolean;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

// ── Headless lifecycle helpers (used by orchestration/default-deps.ts) ──

export function registerHeadlessSubagent(entry: {
  id: string;
  name: string;
  task: string;
  agent?: string;
  cli?: string;
  abortController?: AbortController;
  startTime?: number;
  activityFile?: string;
  interactive?: boolean;
  source?: "pi" | "claude";
}): void {
  const startTimeMs = entry.startTime ?? Date.now();
  const running: RunningSubagent = {
    id: entry.id,
    name: entry.name,
    task: entry.task,
    agent: entry.agent,
    cli: entry.cli,
    backend: "headless",
    startTime: startTimeMs,
    abortController: entry.abortController,
    activityFile: entry.activityFile,
    interactive: entry.interactive ?? false,
    statusState: createStatusState({ source: entry.source ?? "pi", startTimeMs }),
  };
  runningSubagents.set(entry.id, running);
  startWidgetRefresh();
  if (piForRegistry) startStatusRefresh(piForRegistry);
}

export function updateHeadlessSubagentUsage(id: string, usage: UsageStats): void {
  const entry = runningSubagents.get(id);
  if (entry) {
    entry.usage = usage;
    updateWidget();
  }
}

export function unregisterHeadlessSubagent(id: string): void {
  runningSubagents.delete(id);
  updateWidget();
}

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }
  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag} `;
    let right: string;
    if (agent.blocked) {
      right = " blocked — awaiting parent ";
    } else if (statusConfig.enabled && agent.statusState) {
      const snapshot = classifyStatus(agent.statusState, Date.now());
      right = formatWidgetRightLabel(snapshot);
    } else if (agent.cli === "claude") {
      right = " running… ";
    } else {
      right = " starting… ";
    }

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  formatWidgetRightLabel,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveResumeLaunchBehavior,
  resolveEffectiveInteractive,
  buildPiPromptArgs,
  // Task 7b additions:
  setLauncherDepsOverride(deps: LauncherDeps | null) { launcherDepsOverride = deps; },
  getLauncherDepsOverride(): LauncherDeps | null { return launcherDepsOverride; },
  setWatchSubagentOverride(fn: typeof watchSubagent | null) { watchSubagentOverride = fn; },
  getWatchSubagentOverride(): typeof watchSubagent | null { return watchSubagentOverride; },
  getRegistry(): Registry { return registry; },
  resetRegistry() {
    // Drop any virtual blocked rows the previous registry installed so tests
    // don't bleed widget state across cases.
    for (const [, virt] of virtualBlocked) runningSubagents.delete(virt.id);
    virtualBlocked.clear();
    registry = createRegistry(registryEmitter as any, registryHooks);
  },
  setMuxAvailableOverride(value: boolean | null) { muxAvailableOverride = value; },
  getMuxAvailableOverride(): boolean | null { return muxAvailableOverride; },
  setSurfaceOverrides(overrides: typeof surfaceOverrides) { surfaceOverrides = overrides; },
  getSurfaceOverrides() { return surfaceOverrides; },
  // Task 13: widget introspection for tests.
  getRunningSubagents() { return runningSubagents; },
  getVirtualBlocked() { return virtualBlocked; },
  // Step 14.2d: capture the last launch command for Claude-branch tests.
  getLastLaunchCommand(): string | null { return lastLaunchCommand; },
  // Task 7 additions:
  observeRunningSubagent,
  startStatusRefresh,
  activityLabel,
  get statusConfig() { return statusConfig; },
  setStatusConfig(value: StatusConfig) { statusConfig = value; },
  // Task 9 additions:
  resolveInterruptTarget,
  requestSubagentInterrupt,
  handleSubagentInterrupt,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  // Detach from the event loop's keep-alive count — a purely cosmetic widget
  // must not prevent the host process (or the test runner) from exiting once
  // real work is done.
  widgetInterval.unref?.();
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

export function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  if (!running.statusState) return;
  if (running.blocked) return; // synthetic blocked virtual row; never read activity
  if (running.cli === "claude") return; // claude has no activity file

  const file = running.activityFile;
  const read: ActivityReadResult = file
    ? readSubagentActivityFile(file, running.id)
    : { ok: false, reason: "missing" };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  // TypeScript discriminated-union narrowing: `read.ok` is false here.
  const failRead = read as Extract<ActivityReadResult, { ok: false }>;
  running.statusState = observeStatus(running.statusState, {
    snapshot: failRead.reason,
    snapshotError: failRead.error,
  }, observedAt);
}

function resolveInterruptTarget(params: { id?: string; name?: string }):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }
  const requestedName = params.name?.trim();
  if (!requestedName) return { error: "Provide a running subagent id or exact display name." };
  const matches = Array.from(runningSubagents.values()).filter((r) => r.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) return { error: `No running subagent named "${requestedName}".` };
  const candidates = matches.map((r) => `${r.name} [${r.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

function requestSubagentInterrupt(
  running: RunningSubagent,
  sendEscapeKey: (surface: string) => void = sendEscape,
): { ok: true } | { error: string } {
  try {
    sendEscapeKey(running.surface!);
    return { ok: true };
  } catch (error: any) {
    const backend = getMuxBackend() ?? "unknown";
    return { error: `Failed to send Escape to subagent "${running.name}" via ${backend}: ${error?.message ?? String(error)}` };
  }
}

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  sendEscapeKey: (surface: string) => void = sendEscape,
) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return { content: [{ type: "text" as const, text: resolved.error }], details: { error: resolved.error } };
  }
  const running = resolved.running;

  if (running.cli === "claude") {
    const text = "Turn-only Escape interrupt is currently supported only for pane-Pi subagents. Claude-backed semantics have not been verified yet.";
    return { content: [{ type: "text" as const, text }], details: { error: "claude interrupt unsupported", id: running.id, name: running.name } };
  }
  if (running.backend !== "pane") {
    const text = "Turn-only Escape interrupt is currently supported only for pane-Pi subagents. Headless subagents have no surface to receive an Escape.";
    return { content: [{ type: "text" as const, text }], details: { error: "headless interrupt unsupported", id: running.id, name: running.name } };
  }

  const now = Date.now();
  observeRunningSubagent(running, now);

  const interruption = requestSubagentInterrupt(running, sendEscapeKey);
  if ("error" in interruption) {
    return { content: [{ type: "text" as const, text: interruption.error }], details: { error: interruption.error, id: running.id, name: running.name } };
  }

  if (running.statusState) {
    running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  }
  updateWidget();

  return {
    content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

let statusInterval: ReturnType<typeof setInterval> | null = null;

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      if (running.blocked) continue; // synthetic — skip entirely
      if (!running.statusState) continue;

      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);
  statusInterval.unref?.();
  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

interface ClaudeCmdInputs {
  sentinelFile: string;
  pluginDir: string | undefined; // if existsSync, pass --plugin-dir
  model: string | undefined;
  identity: string | null | undefined;
  systemPromptMode: "append" | "replace" | undefined;
  resumeSessionId: string | undefined;
  effectiveThinking: string | undefined;
  effectiveTools?: string;
  task: string;
}

export function buildClaudeCmdParts(input: ClaudeCmdInputs): string[] {
  const parts: string[] = [];
  parts.push(`PI_CLAUDE_SENTINEL=${shellEscape(input.sentinelFile)}`);
  parts.push("claude");
  parts.push("--dangerously-skip-permissions");
  if (input.pluginDir) {
    parts.push("--plugin-dir", shellEscape(input.pluginDir));
  }
  if (input.model) {
    parts.push("--model", shellEscape(input.model));
  }
  const effort = thinkingToEffort(input.effectiveThinking);
  if (effort) {
    parts.push("--effort", effort);
  }
  if (input.identity) {
    const flag = input.systemPromptMode === "replace"
      ? "--system-prompt"
      : "--append-system-prompt";
    parts.push(flag, shellEscape(input.identity));
  }
  if (input.resumeSessionId) {
    parts.push("--resume", shellEscape(input.resumeSessionId));
  }
  // The lifecycle MCP tool is the unified completion signal on the Claude
  // pane backend. Whenever we emit a restrictive --tools list, the MCP tool
  // MUST be present alongside any mapped builtins so the model can actually
  // call it (symmetric to how resolvePiToolsArg always reserves
  // caller_ping,subagent_done on the pi path).
  //
  // Two names are allowlisted because the loaded tool's exposed name depends
  // on how the MCP server was discovered:
  //   - --plugin-dir: Claude namespaces the tool as
  //     `mcp__plugin_<plugin-name>_<server-name>__<tool>`, here
  //     `mcp__plugin_pi-subagent_pi-subagent__subagent_done`.
  //   - --mcp-config (fallback path documented in the spec): Claude exposes
  //     the bare `mcp__<server>__<tool>` form, here
  //     `mcp__pi-subagent__subagent_done`.
  // Including both keeps the allowlist correct for either loading path; an
  // allowlist that only contains the bare name silently disables completion
  // when the plugin is loaded via --plugin-dir (review-v1 finding 1).
  const MCP_LIFECYCLE_TOOLS = [
    "mcp__pi-subagent__subagent_done",
    "mcp__plugin_pi-subagent_pi-subagent__subagent_done",
  ];
  if (input.effectiveTools) {
    const claudeTools = new Set<string>();
    for (const tool of input.effectiveTools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)) {
      const mapped = PI_TO_CLAUDE_TOOLS[tool.toLowerCase()];
      if (mapped) claudeTools.add(mapped);
    }
    for (const t of MCP_LIFECYCLE_TOOLS) claudeTools.add(t);
    parts.push("--tools", shellEscape([...claudeTools].join(",")));
  }
  if (input.task !== "") {
    parts.push("--");
    parts.push(shellEscape(input.task));
  }
  return parts;
}

/**
 * Emit a single-line stderr warning when a Claude subagent has declared
 * `skills:` frontmatter. Claude CLI has no equivalent — we silently drop
 * them on the headless backend too, so pane + headless share this wording
 * for regression-test parity (review-v11 finding 2).
 */
export function warnClaudeSkillsDropped(
  subagentName: string,
  effectiveSkills: string | undefined,
): void {
  if (!effectiveSkills || effectiveSkills.trim() === "") return;
  process.stderr.write(
    `[pi-interactive-subagent] ${subagentName}: ignoring skills=${effectiveSkills} on Claude path — not supported in v1\n`,
  );
}

// Re-export shellEscape so tests can verify exact argv encoding against the
// same helper buildClaudeCmdParts uses — avoids drift if one side changes.
export { shellEscape };

/**
 * Sanitize an agent/name string for safe filesystem use in launch-script names.
 */
function safeScriptName(raw: string | undefined, fallback: string): string {
  return (
    (raw ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || fallback
  );
}

/**
 * Build the `cd <dir> && ` prefix for a pane launch command.
 *
 * Pane and headless share the same default-cwd contract: when the caller does
 * not specify a target cwd, the child must run in the session cwd (ctx.cwd),
 * not in whatever directory the multiplexer happened to open the pane in —
 * wezterm/zellij open splits in `process.cwd()`, which diverges from ctx.cwd
 * whenever the agent is operating on another repo (review-v2 finding 2).
 */
export function buildPaneCdPrefix(
  effectiveCwd: string | null,
  sessionCwd: string,
): string {
  return `cd ${shellEscape(effectiveCwd ?? sessionCwd)} && `;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 *
 * This function is the pane-transport half of a two-layer design: launch-time
 * field resolution lives in `resolveLaunchSpec()` (see launch-spec.ts) and is
 * shared with the headless backend. This function consumes the spec and does
 * the pane-only work: `createSurface`, `sendLongCommand`, widget registration.
 */
export async function launchSubagent(
  params: SubagentParamsType,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string }; cwd: string },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");

  const spec = resolveLaunchSpec(params, ctx);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const surface =
    options?.surface ?? createSurface(params.name, { detach: params.focus === false });
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  // ── Claude Code CLI path ──
  if (spec.effectiveCli === "claude") {
    const sentinelFile = `/tmp/pi-claude-${id}-done`;
    const pluginDir = join(SUBAGENTS_DIR, "plugin");
    const pluginDirResolved = existsSync(pluginDir) ? pluginDir : undefined;

    // Claude CLI has no skills equivalent — emit the shared warning before
    // we build the argv (review-v11 finding 2: pane + headless must warn with
    // identical wording).
    warnClaudeSkillsDropped(params.name, spec.effectiveSkills);

    const cmdParts = buildClaudeCmdParts({
      sentinelFile,
      pluginDir: pluginDirResolved,
      // Claude CLI receives a provider-stripped model string. Pane + headless
      // backends agree here via spec.claudeModelArg.
      model: spec.claudeModelArg,
      // Fold claudeCompletionAddendum into the identity passed to
      // buildClaudeCmdParts so it always reaches Claude via
      // --append-system-prompt — even when spec.identity is null/empty. Fold
      // rule: identity → blank-line separator → addendum. With null identity,
      // the addendum is the sole content.
      identity: (() => {
        const addendum = spec.claudeCompletionAddendum;
        if (!addendum) return spec.identity;
        if (!spec.identity) return addendum;
        return `${spec.identity}\n\n${addendum}`;
      })(),
      systemPromptMode: spec.systemPromptMode,
      resumeSessionId: spec.resumeSessionId,
      effectiveThinking: spec.effectiveThinking,
      effectiveTools: spec.effectiveTools,
      // Claude CLI prompt does not support @file substitution. We hand it the
      // naked task body (roleBlock stripped — identity arrives via the flag).
      task: spec.claudeTaskBody,
    });

    const cdPrefix = buildPaneCdPrefix(spec.effectiveCwd, ctx.cwd);
    const command = `${cdPrefix}${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

    const launchScriptName = `${safeScriptName(params.name, "subagent")}-${id}.sh`;
    const launchScriptFile = join(spec.artifactDir, "subagent-scripts", launchScriptName);

    sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: [
        `# Claude Code subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Surface: ${surface}`,
      ].join("\n"),
    });

    // cli recorded for watchSubagent completion-path dispatch
    const running: RunningSubagent = {
      id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      backend: "pane",
      surface,
      startTime,
      sessionFile: spec.subagentSessionFile,
      launchScriptFile,
      cli: "claude",
      sentinelFile,
      interactive: spec.effectiveInteractive,
      statusState: createStatusState({ source: "claude", startTimeMs: startTime }),
    };

    runningSubagents.set(id, running);
    startWidgetRefresh();   // idempotent via widgetInterval guard
    if (piForRegistry) startStatusRefresh(piForRegistry);
    return running;
  }

  // ── Pi CLI path ──

  const activityFile = getSubagentActivityFile(spec.artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });

  let piTailStartOffset = 0;
  if (spec.seededSessionMode) {
    seedSubagentSessionFile({
      mode: spec.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: spec.subagentSessionFile,
      childCwd: spec.effectiveCwd ?? ctx.cwd,
    });
    try {
      piTailStartOffset = statSync(spec.subagentSessionFile).size;
    } catch {
      piTailStartOffset = 0;
    }
  }

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(spec.subagentSessionFile));

  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  if (spec.effectiveModel) {
    const model = spec.effectiveThinking
      ? `${spec.effectiveModel}:${spec.effectiveThinking}`
      : spec.effectiveModel;
    parts.push("--model", shellEscape(model));
  }

  // Write system-prompt artifact when frontmatter sets `system-prompt:
  // append|replace`. Pi's --append-system-prompt / --system-prompt auto-detect
  // file paths and read their contents — side-steps shell-escaping problems
  // with multiline content.
  const syspromptPath = writeSystemPromptArtifact(spec);
  if (syspromptPath) {
    const flag = spec.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    parts.push(flag, shellEscape(syspromptPath));
  }

  const toolsArg = resolvePiToolsArg(spec.effectiveTools);
  if (toolsArg) {
    parts.push("--tools", shellEscape(toolsArg));
  }

  // Build env prefix: denied tools + subagent identity + config dir propagation
  const envParts: string[] = [];

  for (const [key, value] of Object.entries(spec.configRootEnv)) {
    envParts.push(`${key}=${shellEscape(value)}`);
  }

  if (spec.denySet.size > 0) {
    envParts.push(`PI_DENY_TOOLS=${shellEscape([...spec.denySet].join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (spec.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(spec.subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  const envPrefix = envParts.join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (spec.taskDelivery === "direct") {
    taskArg = spec.fullTask;
  } else {
    taskArg = `@${writeTaskArtifact(spec)}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills: spec.effectiveSkills,
    taskDelivery: spec.taskDelivery,
    taskArg,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths.
  // This was already computed above so session placement, PI_CODING_AGENT_DIR, and cd agree.
  // Default to ctx.cwd (not process.cwd()) so pane + headless match (review-v2 finding 2).
  const cdPrefix = buildPaneCdPrefix(spec.effectiveCwd, ctx.cwd);

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
  const launchScriptName = `${safeScriptName(params.name, "subagent")}-${id}.sh`;
  const launchScriptFile = join(spec.artifactDir, "subagent-scripts", launchScriptName);
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${spec.subagentSessionFile}`,
      `# Surface: ${surface}`,
    ].join("\n"),
  });

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    backend: "pane",
    surface,
    startTime,
    sessionFile: spec.subagentSessionFile,
    piTailStartOffset,
    launchScriptFile,
    cli: "pi",
    activityFile,
    interactive: spec.effectiveInteractive,
    statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
  };

  runningSubagents.set(id, running);
  startWidgetRefresh();   // idempotent via widgetInterval guard
  if (piForRegistry) startStatusRefresh(piForRegistry);
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/tmp",
  ".pi", "agent", "sessions", "claude-code",
);

/**
 * Parse a Claude JSONL transcript and return the text of the last assistant
 * message. Used as a fallback summary when the sentinel file is empty (model
 * called `subagent_done` with omitted/empty `message`) — more reliable than a
 * pane screen-scrape because the transcript is the authoritative artifact
 * `copyClaudeSession` is about to archive. Returns "" on any parse failure.
 */
export function extractLastAssistantMessage(jsonl: string): string {
  let last = "";
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry?.type !== "assistant") continue;
      const content = entry?.message?.content;
      // Only update `last` when this entry actually contributes text. A
      // trailing assistant event that contains only `tool_use` blocks (e.g.
      // the subagent_done call after a textual summary) would otherwise
      // erase the prior summary with "" and force the watcher into the pane
      // screen-scrape fallback (review-v1 finding 3).
      let candidate = "";
      if (typeof content === "string") {
        candidate = content;
      } else if (Array.isArray(content)) {
        candidate = content
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("");
      }
      if (candidate.trim() !== "") last = candidate;
    } catch { /* skip malformed line */ }
  }
  return last;
}

/**
 * Archive the pane-Claude transcript and return the raw session id + archived
 * path. The session id is the `.jsonl` filename stripped of its extension so
 * it matches the raw id the headless Claude backend extracts from `system/init`
 * — feeding either value into `--resume` via `resumeSessionId` must work
 * identically (review-v2 finding 3).
 *
 * Export is intentional: exercised by the unit test that pins this contract.
 */
export function copyClaudeSession(
  sentinelFile: string,
  archiveDir: string = CLAUDE_SESSIONS_DIR,
): { sessionId: string; archivedPath: string } | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(archiveDir, { recursive: true });
    const filename = transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const archivedPath = join(archiveDir, filename);
    copyFileSync(transcriptPath, archivedPath);
    const sessionId = filename.endsWith(".jsonl") ? filename.slice(0, -".jsonl".length) : filename;
    return { sessionId, archivedPath };
  } catch {
    return null;
  }
}

export async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
  opts?: {
    onSessionKey?: (sessionKey: string) => void;
    onUpdate?: (partial: SubagentResult) => void;
    tailStartLine?: number;
  },
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  // ── onSessionKey delivery ──────────────────────────────────────────────────
  // Pi children: sessionFile is known at launch — fire immediately.
  // Claude children: session id is parsed from .transcript pointer file, which
  // Claude writes early in its run. We attempt to resolve it on each poll tick
  // and again synchronously before we return (race-closer).
  let firedSessionKey = false;
  const maybeFire = (key: string | undefined): void => {
    if (!key || firedSessionKey) return;
    firedSessionKey = true;
    try { opts?.onSessionKey?.(key); } catch { /* defensive */ }
  };
  const readClaudeSessionId = (): string | undefined => {
    if (running.cli !== "claude" || !running.sentinelFile) return undefined;
    try {
      const pointer = running.sentinelFile + ".transcript";
      if (!existsSync(pointer)) return undefined;
      const transcriptPath = readFileSync(pointer, "utf-8").trim();
      if (!transcriptPath) return undefined;
      const filename = transcriptPath.split("/").pop() ?? "";
      return filename.endsWith(".jsonl") ? filename.slice(0, -".jsonl".length) : filename;
    } catch { return undefined; }
  };
  const readClaudeTranscriptPath = (): string | null => {
    if (running.cli !== "claude" || !running.sentinelFile) return null;
    try {
      const pointer = running.sentinelFile + ".transcript";
      if (!existsSync(pointer)) return null;
      const transcriptPath = readFileSync(pointer, "utf-8").trim();
      if (!transcriptPath || !existsSync(transcriptPath)) return null;
      return transcriptPath;
    } catch { return null; }
  };

  // ── Task 3: pi-side live transcript / usage tailing ──────────────────────
  const transcript: TranscriptMessage[] = [];
  const usage: UsageStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
  const piTailState: JsonlTailState = { offset: running.piTailStartOffset ?? 0, pendingTail: "" };
  let claudeTranscriptPathForTail: string | null = null;
  const claudeTailState: JsonlTailState = { offset: 0, pendingTail: "" };
  let claudeFinalUsage: UsageStats | null = null;

  const applyClaudeUsage = (u: UsageStats): void => {
    usage.input = u.input;
    usage.output = u.output;
    usage.cacheRead = u.cacheRead;
    usage.cacheWrite = u.cacheWrite;
    usage.cost = u.cost;
    usage.contextTokens = u.contextTokens;
    usage.turns = u.turns;
  };

  // Honor opts.tailStartLine for non-Claude resumes: skip past lines already
  // observed by an earlier watcher so we don't re-emit them on resume.
  if (
    opts?.tailStartLine &&
    opts.tailStartLine > 0 &&
    running.cli !== "claude" &&
    sessionFile
  ) {
    try {
      if (existsSync(sessionFile)) {
        const raw = readFileSync(sessionFile, "utf8");
        piTailState.offset = computePiTailResumeOffset(raw, opts.tailStartLine);
      }
    } catch {
      // Defensive: if seeking fails, fall back to offset 0 rather than failing.
    }
  }

  // Pi children: fire immediately (session file known at launch time).
  if (running.cli !== "claude") maybeFire(running.sessionFile);

  // Shared per-tick + final-drain body for pi tailing. Using one helper keeps
  // the final drain (after pollForExit returns) from drifting away from the
  // per-tick body. Returns true iff state changed (and an onUpdate was emitted).
  const drainPiTail = (): boolean => {
    try {
      if (!sessionFile || !existsSync(sessionFile)) return false;
      const delta = tailPiSessionEntries(sessionFile, piTailState);
      let changed = false;
      for (const msg of delta.messages) {
        transcript.push(projectPiMessageToTranscript(msg));
        changed = true;
      }
      for (const am of delta.assistantMessages) {
        usage.turns++;
        const u: any = (am as any).usage;
        if (u) {
          usage.input += u.input ?? 0;
          usage.output += u.output ?? 0;
          usage.cacheRead += u.cacheRead ?? 0;
          usage.cacheWrite += u.cacheWrite ?? 0;
          usage.cost += u.cost?.total ?? 0;
          usage.contextTokens = u.totalTokens ?? usage.contextTokens;
        }
        changed = true;
      }
      if (changed) {
        running.usage = { ...usage };
        try {
          opts?.onUpdate?.({
            name,
            task,
            summary: "",
            transcriptPath: null,
            exitCode: 0,
            elapsed: Math.floor((Date.now() - startTime) / 1000),
            transcript: [...transcript],
            usage: { ...usage },
          });
        } catch {
          // Defensive: never let an onUpdate throw kill the watcher.
        }
      }
      return changed;
    } catch {
      return false;
    }
  };

  try {
    const result = await pollForExit(surface, AbortSignal.any([signal, getModuleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      sentinelFile: running.sentinelFile,
      onTick() {
        if (running.cli !== "claude") {
          drainPiTail();
        } else {
          // Claude: attempt early session key resolution on each tick.
          maybeFire(readClaudeSessionId());
          try {
            if (claudeTranscriptPathForTail === null) {
              claudeTranscriptPathForTail = readClaudeTranscriptPath();
              claudeTailState.offset = 0;
              claudeTailState.pendingTail = "";
              claudeTailState.decoder = undefined;
            }
            const tp = claudeTranscriptPathForTail;
            if (!tp) return;
            const { lines } = tailJsonlLines(tp, claudeTailState);
            if (lines.length === 0) return;
            let changed = false;
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              let event: any;
              try { event = JSON.parse(trimmed); } catch { continue; }
              if (event?.type === "result") {
                const r = parseClaudeResult(event);
                claudeFinalUsage = r.usage;
                applyClaudeUsage(r.usage);
                changed = true;
                continue;
              }
              const msgs = parseClaudeStreamEvent(event);
              if (msgs && msgs.length > 0) {
                for (const m of msgs) transcript.push(m);
                changed = true;
              }
            }
            if (changed) {
              running.usage = { ...usage };
              try {
                opts?.onUpdate?.({
                  name,
                  task,
                  summary: "",
                  transcriptPath: null,
                  exitCode: 0,
                  elapsed: Math.floor((Date.now() - startTime) / 1000),
                  transcript: [...transcript],
                  usage: { ...usage },
                });
              } catch {
                // Defensive: never let an onUpdate throw kill the watcher.
              }
            }
          } catch {}
        }
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // Final pi-tail drain: pollForExit checks .exit/sentinel BEFORE calling
    // onTick, so a fast subagent that finishes before the first tick — or any
    // subagent that writes its last entries between the final tick and exit —
    // would otherwise return with empty transcript/usage. Replay the same
    // per-tick body once more so the resolved BackendResult always reflects
    // the final session state.
    if (running.cli !== "claude") {
      drainPiTail();
    }

    if (running.cli === "claude") {
      // LOAD-BEARING race-closer: fire onSessionKey synchronously before return
      // so the blocked notification can populate sessionKey even if the tick
      // missed it.
      maybeFire(readClaudeSessionId());

      // Bounded wait for the .transcript pointer so one-turn autonomous
      // sessions don't lose transcript/session metadata. The MCP sentinel
      // (written by subagent_done) and the .transcript pointer (written by
      // the Stop hook) are independent events; in autonomous one-turn
      // completions the MCP write can finish before the Stop hook fires.
      // Without this wait, copyClaudeSession would observe a missing pointer
      // and return null, dropping transcriptPath / sessionId on the floor.
      //
      // Gate the wait narrowly: only when the sentinel file actually exists
      // AND its .transcript pointer is missing. Manual-exit and abort paths
      // never write the sentinel, so this wait is bypassed entirely there
      // (keeping cancel/close snappy). pollForExit's contract is unchanged.
      if (running.sentinelFile && existsSync(running.sentinelFile)) {
        const pointer = running.sentinelFile + ".transcript";
        if (!existsSync(pointer)) {
          const deadline = Date.now() + 2000;
          while (!existsSync(pointer) && Date.now() < deadline) {
            await new Promise((res) => setTimeout(res, 50));
          }
        }
      }

      // Archive Claude session transcript first so the JSONL fallback below
      // has an authoritative artifact to read from. Cleanup of the sentinel +
      // pointer files happens after summary extraction (cleanup unlinks the
      // pointer file, so we must read through it BEFORE unlinking).
      let sessionId: string | null = null;
      let transcriptPath: string | null = null;
      if (running.sentinelFile) {
        const archived = copyClaudeSession(running.sentinelFile);
        if (archived) {
          sessionId = archived.sessionId;
          transcriptPath = archived.archivedPath;
        }
      }

      // Post-mortem catch-up: if the live tail missed the result event or never
      // observed any messages (e.g. one-turn autonomous run where the jsonl was
      // archived/unlinked between ticks), re-parse the archived jsonl.
      if (
        transcriptPath
        && (transcript.length === 0 || claudeFinalUsage === null || usage.turns === 0)
      ) {
        try {
          const archiveContent = readFileSync(transcriptPath, "utf-8");
          const liveLen = transcript.length;
          const archiveTranscript: TranscriptMessage[] = [];
          let archiveTerminalUsage: UsageStats | null = null;
          for (const line of archiveContent.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let event: any;
            try { event = JSON.parse(trimmed); } catch { continue; }
            if (event?.type === "result") {
              archiveTerminalUsage = parseClaudeResult(event).usage;
              continue;
            }
            const msgs = parseClaudeStreamEvent(event);
            if (msgs) archiveTranscript.push(...msgs);
          }
          let appended = false;
          if (archiveTranscript.length > liveLen) {
            for (let i = liveLen; i < archiveTranscript.length; i++) {
              transcript.push(archiveTranscript[i]);
            }
            appended = true;
          }
          let usageChanged = false;
          if (archiveTerminalUsage) {
            claudeFinalUsage = archiveTerminalUsage;
            applyClaudeUsage(archiveTerminalUsage);
            usageChanged = true;
          }
          if (appended || usageChanged) {
            running.usage = { ...usage };
            try {
              opts?.onUpdate?.({
                name,
                task,
                summary: "",
                transcriptPath,
                exitCode: 0,
                elapsed: Math.floor((Date.now() - startTime) / 1000),
                transcript: [...transcript],
                usage: { ...usage },
              });
            } catch {
              // Defensive: never let an onUpdate throw kill the watcher.
            }
          }
        } catch {
          // Defensive: archive parse failures should not kill completion.
        }
      }

      let summary = "";

      // 1. Sentinel file (preferred): non-empty content from subagent_done.
      if (running.sentinelFile) {
        try { summary = readFileSync(running.sentinelFile, "utf-8").trim(); }
        catch {}
      }

      // 2. Transcript JSONL last assistant message — more reliable than the
      //    screen scrape, available whenever we successfully archived.
      if (!summary && transcriptPath) {
        try {
          summary = extractLastAssistantMessage(readFileSync(transcriptPath, "utf-8")).trim();
        } catch {}
      }

      // 3. Pane screen scrape — last-resort fallback.
      if (!summary) {
        summary = readScreen(surface, 200)
          .replace(/__SUBAGENT_DONE_\d+__/, "")
          .trimEnd();
      }

      // 4. Generic exit-code fallback string.
      if (!summary) {
        summary = result.exitCode !== 0
          ? `Claude Code exited with code ${result.exitCode}`
          : "Claude Code exited without output";
      }

      // Cleanup the sentinel + pointer files now that we've extracted everything.
      if (running.sentinelFile) {
        try { unlinkSync(running.sentinelFile); } catch {}
        try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
      }

      closeSurface(surface);
      runningSubagents.delete(running.id);

      // v1 scope (review-v3 #2): Claude-CLI children do not signal `caller_ping`
      // on an initial run — the Claude CLI does not expose that tool, and the
      // bundled Stop hook emits terminal-completion sentinels only. So this
      // branch intentionally omits `ping` from its return shape; Claude-backed
      // tasks run to terminal (success / failure / cancellation). End-to-end
      // Claude ping signaling (MCP tool + Stop-hook sentinel + watcher path) is
      // deferred to phase-2.5.
      return {
        name,
        task,
        summary,
        exitCode: result.exitCode,
        elapsed,
        transcriptPath,
        transcript: [...transcript],
        usage: { ...usage },
        ...(sessionId ? { claudeSessionId: sessionId } : {}),
      };
    }

    // Pi subagent result extraction (existing, unchanged)
    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output");
    } else {
      summary =
        result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    }

    closeSurface(surface);
    runningSubagents.delete(running.id);

    return {
      name,
      task,
      summary,
      exitCode: result.exitCode,
      elapsed,
      sessionFile,
      transcriptPath: existsSync(sessionFile) ? sessionFile : null,
      transcript: [...transcript],
      usage: { ...usage },
      ping: result.ping,
    };
  } catch (err: any) {
    try {
      closeSurface(surface);
    } catch {}
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        transcriptPath: null,
        error: "cancelled",
        transcript: [...transcript],
        usage: { ...usage },
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      transcriptPath: null,
      error: err?.message ?? String(err),
      transcript: [...transcript],
      usage: { ...usage },
    };
  }
}

// ── Task 7b: Module-scope seam state ──────────────────────────────────────────

// Test seam: Task 7b (__test__.setLauncherDepsOverride). Lets real-extension
// tests swap in deterministic fakes for LauncherDeps without mocking the
// tool registrar. null = production default (makeDefaultDeps).
let launcherDepsOverride: LauncherDeps | null = null;

// Test seam: Task 7b (__test__.setWatchSubagentOverride). Applies ONLY to the
// watchSubagent call inside subagent_resume.execute so Task 12/14 resume-
// routing tests can drive ping-during-resume and terminal-resume outcomes
// through the real handler. Does NOT apply to the bare `subagent` tool's
// watch site — that remains the raw watchSubagent to keep its tests simple.
let watchSubagentOverride: typeof watchSubagent | null = null;

// Test seam: Task 7b (__test__.setMuxAvailableOverride). Bypasses the
// isMuxAvailable() short-circuit inside subagent_resume.execute so boundary
// tests can exercise the registry-routing branches on no-mux hosts (CI
// runners). null = honor the real probe (production default).
let muxAvailableOverride: boolean | null = null;

// Test seam: Task 12.2a / Step 14.2d (__test__.setSurfaceOverrides). Stubs
// createSurface + sendLongCommand so boundary tests skip real mux-pane
// construction. null = production default.
let surfaceOverrides: {
  createSurface?: (name: string) => string;
  sendLongCommand?: (surface: string, command: string) => void;
} | null = null;
let lastLaunchCommand: string | null = null;

// Module-scope forward-declared so the registry can be reset via __test__.
// `piForRegistry` is the ExtensionAPI assigned when subagentsExtension runs;
// the emitter reads through it so a test that swaps the pi handle sees it.
let piForRegistry: ExtensionAPI | null = null;

// Virtual blocked widget rows, keyed on `${orchestrationId}:${taskIndex}`.
// Installed when the registry emits `BLOCKED_KIND` so the widget keeps showing
// the blocked state after the child's own pane closes. Cleared on per-task
// terminal transitions and on resume-start (the spec's `blocked -> running`
// leg at the widget layer).
const virtualBlocked = new Map<string, RunningSubagent>();

function dropVirtualBlocked(orchestrationId: string, taskIndex: number): void {
  const key = `${orchestrationId}:${taskIndex}`;
  const virt = virtualBlocked.get(key);
  if (!virt) return;
  runningSubagents.delete(virt.id);
  virtualBlocked.delete(key);
  updateWidget();
}

// Hoisted so resetRegistry() can reconstruct the same wiring.
const registryEmitter = (payload: { kind: string; [k: string]: any }) => {
  if (!piForRegistry) return;
  if (payload.kind === ORCHESTRATION_COMPLETE_KIND) {
    updateWidget();
    const lines: string[] = [
      `Orchestration "${payload.orchestrationId}" completed ` +
        `(${payload.results.length} task(s), isError=${payload.isError}).`,
    ];
    for (const r of payload.results) {
      lines.push("");
      lines.push(`Task "${r.name}" (${r.state}, exit=${r.exitCode}, ${r.elapsedMs}ms):`);
      lines.push("");
      lines.push(r.finalMessage ?? "");
    }
    piForRegistry.sendMessage({
      customType: "orchestration_complete",
      content: lines.join("\n"),
      display: true,
      details: payload,
    }, { triggerTurn: true, deliverAs: "steer" });
  } else if (payload.kind === BLOCKED_KIND) {
    const key = `${payload.orchestrationId}:${payload.taskIndex}`;
    const entry: RunningSubagent = {
      id: `virt-${key}`,
      name: payload.taskName,
      task: "",
      backend: "pane",
      startTime: Date.now(),
      blocked: {
        orchestrationId: payload.orchestrationId,
        taskIndex: payload.taskIndex,
        message: payload.message,
      },
    };
    virtualBlocked.set(key, entry);
    runningSubagents.set(entry.id, entry);
    startWidgetRefresh();
    startStatusRefresh(piForRegistry);
    updateWidget();
    piForRegistry.sendMessage({
      customType: BLOCKED_KIND,
      content:
        `Task "${payload.taskName}" in orchestration "${payload.orchestrationId}" is blocked:\n\n${payload.message}`,
      display: true,
      details: payload,
    }, { triggerTurn: true, deliverAs: "steer" });
  }
};

// Per-task terminal cleanup: drops the virtual blocked row the instant a
// specific (orchestrationId, taskIndex) slot goes terminal, without waiting
// for the whole orchestration to complete.
function onOrchestrationTaskTerminal(orchestrationId: string, taskIndex: number): void {
  dropVirtualBlocked(orchestrationId, taskIndex);
}

// Resume-start cleanup: drops the virtual blocked row the moment a standalone
// subagent_resume starts on the owning sessionKey (the spec's `blocked ->
// running` leg at the widget layer). This prevents the stale virtual row from
// rendering alongside the resumed pane's real RunningSubagent row.
function onOrchestrationResumeStarted(orchestrationId: string, taskIndex: number): void {
  dropVirtualBlocked(orchestrationId, taskIndex);
}

const registryHooks = {
  onTaskTerminal: ({ orchestrationId, taskIndex }: { orchestrationId: string; taskIndex: number }) => {
    onOrchestrationTaskTerminal(orchestrationId, taskIndex);
  },
  onResumeStarted: ({ orchestrationId, taskIndex }: { orchestrationId: string; taskIndex: number }) => {
    onOrchestrationResumeStarted(orchestrationId, taskIndex);
  },
};

// registry is `let` so resetRegistry() can reassign. Constructed once at module
// load; resetRegistry() creates a new instance sharing the same emitter contract.
let registry: Registry = createRegistry(registryEmitter as any, registryHooks);

// ─────────────────────────────────────────────────────────────────────────────

export default function subagentsExtension(pi: ExtensionAPI) {
  // Bind the pi handle for the module-scope registry emitter (Task 7b).
  piForRegistry = pi;

  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (moduleAbort) moduleAbort.abort();
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  // ── subagent tool ──
  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "IMPORTANT: This tool returns IMMEDIATELY — the sub-agent runs asynchronously in the background. " +
        "You will NOT have results when this tool returns. Results are delivered later via a steer message. " +
        "Do NOT fabricate, assume, or summarize results after calling this tool. " +
        "Either wait for the steer message or move on to other work.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "IMPORTANT: This tool returns IMMEDIATELY — the sub-agent runs asynchronously in the background. " +
        "You will NOT have results when this tool returns. Results are delivered later via a steer message. " +
        "Do NOT fabricate, assume, or summarize results after calling this tool. " +
        "Either wait for the steer message or move on to other work.",
      parameters: SubagentParams,

      async execute(_toolCallId: string, params: SubagentParamsType, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        const blocked = selfSpawnBlocked(params.agent);
        if (blocked) return blocked;

        const preflight = preflightOrchestration(ctx);
        if (preflight) return preflight;

        if (selectBackend() === "headless") {
          const backend = makeHeadlessBackend(ctx);
          const handle = await backend.launch(params, params.focus ?? true);

          const id = randomUUID();
          const watcherAbort = new AbortController();
          // Compose with the reload-surviving module signal so /reload aborts
          // in-flight headless children along with session_shutdown. The
          // runningSubagents map is module-local and does not survive reload,
          // so without this linkage the old module's children become orphans
          // the new module cannot track or cancel.
          const effectiveWatchSignal = AbortSignal.any([
            watcherAbort.signal,
            getModuleAbortSignal(),
          ]);
          const running: RunningSubagent = {
            id,
            name: handle.name,
            task: params.task,
            agent: params.agent,
            backend: "headless",
            startTime: Date.now(),
            abortController: watcherAbort,
            cli: params.cli,
          };
          runningSubagents.set(id, running);
          startWidgetRefresh();
          startStatusRefresh(pi);

          backend
            .watch(handle, effectiveWatchSignal, (partial) => {
              if (partial.usage) updateHeadlessSubagentUsage(id, partial.usage);
            })
            .then((result) => {
              const sessionRef = result.sessionId
                ? `\n\nSession id: ${result.sessionId}`
                : "";
              let content: string;
              if (result.exitCode !== 0) {
                // Prefer finalMessage when present, fall back to error, then
                // append error as a suffix when both are populated so the
                // underlying failure reason (missing CLI, backend error, etc.)
                // reaches the model instead of a generic failure line.
                const body = result.finalMessage || result.error || "";
                const errorSuffix =
                  result.finalMessage && result.error
                    ? `\n\nError: ${result.error}`
                    : "";
                content = `Sub-agent "${handle.name}" failed (exit code ${result.exitCode}).\n\n${body}${errorSuffix}${sessionRef}`;
              } else {
                content = `Sub-agent "${handle.name}" completed (${formatElapsed(result.elapsedMs / 1000)}).\n\n${result.finalMessage}${sessionRef}`;
              }
              pi.sendMessage(
                {
                  customType: "subagent_result",
                  content,
                  display: true,
                  details: {
                    name: handle.name,
                    task: params.task,
                    agent: params.agent,
                    exitCode: result.exitCode,
                    elapsed: result.elapsedMs / 1000,
                    ...(result.error ? { error: result.error } : {}),
                    ...(result.sessionId ? { claudeSessionId: result.sessionId } : {}),
                    ...(result.transcript ? { transcript: result.transcript } : {}),
                    ...(result.usage ? { usage: result.usage } : {}),
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
            })
            .catch((err) => {
              const aborted = effectiveWatchSignal.aborted;
              const msg = err?.message ?? String(err);
              pi.sendMessage(
                {
                  customType: "subagent_result",
                  content: aborted
                    ? `Sub-agent "${handle.name}" aborted (session shutdown).`
                    : `Sub-agent "${handle.name}" error: ${msg}`,
                  display: true,
                  details: {
                    name: handle.name,
                    task: params.task,
                    agent: params.agent,
                    error: aborted ? "aborted" : msg,
                    exitCode: aborted ? 130 : 1,
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
            })
            .finally(() => {
              runningSubagents.delete(id);
            });

          return {
            content: [
              {
                type: "text",
                text:
                  `Sub-agent "${params.name}" launched in the background (headless). ` +
                  `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                  `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                  `Until then, move on to other work or tell the user you're waiting.`,
              },
            ],
            details: {
              id,
              name: params.name,
              task: params.task,
              agent: params.agent,
              backend: "headless",
              status: "started",
            },
          };
        }

        // Launch the subagent (creates pane, sends command)
        const running = await launchSubagent(params, ctx);

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh when first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background
        watchSubagent(running, watcherAbort.signal, {
          onUpdate: (partial) => { if (partial.usage) running.usage = partial.usage; },
        })
          .then((result) => {
            updateWidget(); // reflect removal from Map immediately

            if (result.ping) {
              // Subagent is requesting help — steer a ping message with session path for resume
              const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`;
              pi.sendMessage(
                {
                  customType: "subagent_ping",
                  content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
                  display: true,
                  details: {
                    name: result.ping.name,
                    message: result.ping.message,
                    agent: running.agent,
                    sessionFile: result.sessionFile,
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
              return;
            }

            const sessionRef = result.sessionFile
              ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
              : "";
            const content =
              result.exitCode !== 0
                ? `Sub-agent "${running.name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
                : `Sub-agent "${running.name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;

            pi.sendMessage(
              {
                customType: "subagent_result",
                content,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  agent: running.agent,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                  ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
                  ...(result.transcript ? { transcript: result.transcript } : {}),
                  ...(result.usage ? { usage: result.usage } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name: running.name, task: running.task, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const agent = args.agent ? theme.fg("dim", ` (${args.agent})`) : "";
        const cwdHint = args.cwd ? theme.fg("dim", ` in ${args.cwd}`) : "";
        let text =
          "▸ " + theme.fg("toolTitle", theme.bold(args.name ?? "(unnamed)")) + agent + cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        const task = args.task ?? "";
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const first = result.content?.[0];
        const text = first && first.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    } as any);

  // ── subagent_interrupt tool ──
  if (shouldRegister("subagent_interrupt"))
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description: "Send Escape to the active turn of a currently running pane-Pi subagent. The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement and does not emit a subagent_result solely because of this request.",
      promptSnippet: "Send Escape to the active turn of a currently running pane-Pi subagent. The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement and does not emit a subagent_result solely because of this request.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
      }),
      async execute(_toolCallId: string, params: { id?: string; name?: string }) {
        return handleSubagentInterrupt(params);
      },
      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(theme.fg("accent", "▸") + " " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — interrupt turn"), 0, 0);
      },
      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(theme.fg("accent", "▸") + " " + theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) + theme.fg("dim", " — interrupt requested"), 0, 0);
        }
        const first = result.content?.[0];
        const text = first && first.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    } as any);

  // ── subagents_list tool ──
  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    } as any);



  // ── subagent_resume tool ──
  if (shouldRegister("subagent_resume"))
    pi.registerTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "IMPORTANT: Returns IMMEDIATELY — the resumed session runs asynchronously in the background. " +
        "Results are delivered later via a steer message. Do NOT fabricate or assume results. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      promptSnippet:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "IMPORTANT: Returns IMMEDIATELY — the resumed session runs asynchronously in the background. " +
        "Results are delivered later via a steer message. Do NOT fabricate or assume results. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      parameters: Type.Object({
        sessionPath: Type.Optional(Type.String({
          description: "Path to the pi-backed subagent session file. Mutually exclusive with sessionId.",
        })),
        sessionId: Type.Optional(Type.String({
          description: "Claude session id for a Claude-backed subagent. Mutually exclusive with sessionPath.",
        })),
        name: Type.Optional(Type.String({ description: "Display name. Default: 'Resume'" })),
        message: Type.Optional(Type.String({ description: "Follow-up prompt to deliver." })),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              "Whether the resumed session should automatically exit after completing its response. " +
              "Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
          }),
        ),
      }),

      renderCall(args, theme) {
        const name = args.name ?? "Resume";
        const text =
          "▸ " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const first = result.content?.[0];
        const text = first && first.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId: string, params: ResumeToolParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        const name = params.name ?? "Resume";
        const { autoExit: resumeAutoExit } = resolveResumeLaunchBehavior(params);
        const startTime = Date.now();

        // 1. XOR validation — must precede mux gate and existsSync gate.
        if (!!params.sessionPath === !!params.sessionId) {
          return {
            content: [{ type: "text", text: "subagent_resume: provide exactly one of sessionPath or sessionId." }],
            details: { error: "invalid parameters: sessionPath/sessionId XOR" },
            isError: true,
          };
        }
        const sessionKey = params.sessionPath ?? params.sessionId!;

        // 2. Mux gate (test seam).
        const muxAvailable = muxAvailableOverride ?? isMuxAvailable();
        if (!muxAvailable) {
          return muxUnavailableResult();
        }

        // 3. sessionPath branch: existsSync gate + pi resume.
        //    sessionId branch: Claude resume via buildClaudeCmdParts.
        const isPiResume = !!params.sessionPath;
        let entryCountBefore = 0;
        let sentinelFile: string | undefined;

        if (isPiResume) {
          if (!existsSync(params.sessionPath!)) {
            return {
              content: [{ type: "text", text: `Error: session file not found: ${params.sessionPath}` }],
              details: { error: "session not found" },
            };
          }
          entryCountBefore = getNewEntries(params.sessionPath!, 0).length;
        }

        // 4. Create surface.
        const id = Math.random().toString(16).slice(2, 10);
        const surface = surfaceOverrides?.createSurface
          ? surfaceOverrides.createSurface(name)
          : createSurface(name);
        await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

        // 5. Build command per branch.
        let command: string;
        let launchScriptFile: string;
        let resumeMsgFile: string | undefined;
        let resumeActivityFile: string | undefined;

        if (isPiResume) {
          // --- pi sessionPath branch (existing logic, preserved) ---
          const parts = ["pi", "--session", shellEscape(params.sessionPath!)];
          const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
          parts.push("-e", shellEscape(subagentDonePath));

          if (params.message) {
            const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            resumeMsgFile = join(
              artifactDir, "subagent-resume",
              `${name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "resume"}-${msgTimestamp}.md`,
            );
            mkdirSync(dirname(resumeMsgFile), { recursive: true });
            writeFileSync(resumeMsgFile, params.message, "utf8");
            parts.push(shellEscape(`@${resumeMsgFile}`));
          }

          resumeActivityFile = getSubagentActivityFile(artifactDir, id);
          mkdirSync(dirname(resumeActivityFile), { recursive: true });

          const resumeEnvParts: string[] = [];
          if (process.env.PI_CODING_AGENT_DIR) {
            resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
          }
          // Upstream PR #40: auto-exit the resumed session after its next
          // normal completion. The pi-loaded `subagent-done` extension reads
          // PI_SUBAGENT_AUTO_EXIT=1 to enable the auto-exit lifecycle. Skip it
          // when the caller opts into an interactive handoff (autoExit:false).
          if (resumeAutoExit) {
            resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
          }
          resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
          resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(resumeActivityFile)}`);
          const resumeEnvPrefix = resumeEnvParts.length > 0 ? resumeEnvParts.join(" ") + " " : "";
          command = `${resumeEnvPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
          launchScriptFile = join(
            artifactDir, "subagent-scripts",
            `${name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "resume"}-resume-${Date.now()}.sh`,
          );
        } else {
          // --- Claude sessionId branch (NEW, mirrors launchSubagent Claude path) ---
          // v1 gap: if the Claude child rotates its session id after resume, ownership
          // should update via updateSessionKey — not implemented in v1.
          sentinelFile = `/tmp/pi-claude-${id}-done`;
          const pluginDir = join(SUBAGENTS_DIR, "plugin");
          const pluginDirResolved = existsSync(pluginDir) ? pluginDir : undefined;
          const cmdParts = buildClaudeCmdParts({
            sentinelFile,
            pluginDir: pluginDirResolved,
            model: undefined,
            identity: undefined,
            systemPromptMode: undefined,
            resumeSessionId: params.sessionId!,
            effectiveThinking: undefined,
            effectiveTools: undefined,
            task: params.message ?? "",
          });
          command = `${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
          launchScriptFile = join(
            artifactDir, "subagent-scripts",
            `${name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "resume"}-claude-resume-${Date.now()}.sh`,
          );
        }

        // 6. Dispatch.
        lastLaunchCommand = command;
        if (surfaceOverrides?.sendLongCommand) {
          surfaceOverrides.sendLongCommand(surface, command);
        } else {
          sendLongCommand(surface, command, {
            scriptPath: launchScriptFile,
            scriptPreamble: [
              `# Subagent resume script for ${name}`,
              `# Generated: ${new Date().toISOString()}`,
              isPiResume
                ? `# Session path: ${params.sessionPath}`
                : `# Claude session id: ${params.sessionId}`,
              `# Surface: ${surface}`,
              ...(resumeMsgFile ? [`# Resume message file: ${resumeMsgFile}`] : []),
            ].join("\n"),
          });
        }

        // 7. Register RunningSubagent.
        const running: RunningSubagent = {
          id,
          name,
          task: params.message ?? (isPiResume ? "resumed session" : "resumed Claude session"),
          backend: "pane",
          surface,
          startTime,
          sessionFile: isPiResume ? params.sessionPath! : "",
          launchScriptFile,
          ...(isPiResume ? { activityFile: resumeActivityFile } : { cli: "claude" as const, sentinelFile }),
          interactive: !resumeAutoExit,
          statusState: createStatusState({ source: isPiResume ? "pi" : "claude", startTimeMs: startTime }),
        };
        runningSubagents.set(id, running);
        startWidgetRefresh();
        startStatusRefresh(pi);

        // 8. Resume-start lifecycle transition for owned slots.
        registry.onResumeStarted(sessionKey);

        // 9. Fire-and-forget watcher.
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Review-v1 #2: register the watcher's controller so a later
        // subagent_run_cancel can abort this detached resume execution if its
        // sessionKey is owned by the cancelled orchestration. Standalone
        // resumes (unowned) register too — registry simply never aborts them.
        registry.registerResumeController(sessionKey, watcherAbort);

        // Test seam: Task 7b (__test__.setWatchSubagentOverride).
        const watcher = watchSubagentOverride ?? watchSubagent;
        watcher(running, watcherAbort.signal, { tailStartLine: isPiResume ? entryCountBefore : 0 })
          .then((result) => {
            updateWidget();
            // Review-v1 #2: deregister the watcher controller now that this
            // resume execution is no longer in flight. (For ping → re-block,
            // the next resume call will re-register a fresh controller.)
            registry.unregisterResumeController(sessionKey);
            const owner = registry.lookupOwner(sessionKey);

            if (result.ping) {
              // Standalone subagent_ping steer-back (unchanged).
              const sessionRef = isPiResume
                ? `\n\nSession: ${params.sessionPath}\nResume: pi --session ${params.sessionPath}`
                : `\n\nClaude session: ${params.sessionId}`;
              pi.sendMessage(
                {
                  customType: "subagent_ping",
                  content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
                  display: true,
                  details: {
                    name: result.ping.name,
                    message: result.ping.message,
                    sessionFile: isPiResume ? params.sessionPath : undefined,
                    sessionId: isPiResume ? undefined : params.sessionId,
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
              // NEW: if orch-owned, re-block the owning slot.
              if (owner) {
                registry.onTaskBlocked(owner.orchestrationId, owner.taskIndex, {
                  sessionKey,
                  message: result.ping.message,
                });
              }
              return;
            }

            // Terminal path: emit standalone subagent_result, then maybe re-ingest.
            const summary = isPiResume
              ? (findLastAssistantMessage(getNewEntries(params.sessionPath!, entryCountBefore))
                  ?? (result.exitCode !== 0
                    ? `Resumed session exited with code ${result.exitCode}`
                    : "Resumed session exited without new output"))
              : (result.summary ?? (result.exitCode !== 0
                  ? `Resumed Claude session exited with code ${result.exitCode}`
                  : "Resumed Claude session exited"));
            const sessionRef = isPiResume
              ? `\n\nSession: ${params.sessionPath}\nResume: pi --session ${params.sessionPath}`
              : `\n\nClaude session: ${params.sessionId}`;

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `${summary}${sessionRef}`,
                display: true,
                details: {
                  name,
                  task: params.message ?? (isPiResume ? "resumed session" : "resumed Claude session"),
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: isPiResume ? params.sessionPath : undefined,
                  sessionId: isPiResume ? undefined : params.sessionId,
                  transcript: result.transcript,
                  usage: result.usage,
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );

            // NEW: if orch-owned, re-ingest the terminal result.
            if (owner) {
              const snap = registry.getSnapshot(owner.orchestrationId);
              const taskName = snap?.tasks[owner.taskIndex].name ?? `task-${owner.taskIndex + 1}`;
              // Review-v1 #3: preserve the transcript path watchSubagent
              // discovered (archived Claude transcript path on the Claude
              // branch; resumed pi session path on the pi branch). Hard-coding
              // null here erased the only pointer to the resumed child's
              // transcript in the final orchestration_complete payload.
              const transcriptPath =
                result.transcriptPath
                ?? (isPiResume ? params.sessionPath ?? null : null);
              registry.onResumeTerminal(sessionKey, {
                name: taskName,
                index: owner.taskIndex,
                state: result.exitCode === 0 && !result.error ? "completed" : "failed",
                finalMessage: summary,
                transcriptPath,
                elapsedMs: result.elapsed * 1000,
                exitCode: result.exitCode,
                sessionKey,
                error: result.error,
                transcript: result.transcript,
                usage: result.usage,
              });
            }
          })
          .catch((err) => {
            updateWidget();
            registry.unregisterResumeController(sessionKey);
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            sessionPath: params.sessionPath,
            sessionId: params.sessionId,
            launchScriptFile,
            status: "started",
          },
        };
      },
    } as any);

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    return createSubagentResultRenderer(message as any, options, theme as any);
  });

  // ── subagent_ping message renderer ──
  pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
        } else {
          const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── orchestration_complete message renderer ──
  pi.registerMessageRenderer("orchestration_complete", (message, _options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;
    return {
      invalidate() {},
      render(width: number): string[] {
        const mode = details.mode ?? "serial";
        const rows = toTaskRows(details.results ?? []);
        const component = renderRichSubagentResult({
          mode,
          results: rows,
          expanded: _options.expanded,
          theme,
          isError: details.isError,
        });
        const bgFn = !details.isError
          ? (text: string) => theme.bg("toolSuccessBg", text)
          : (text: string) => theme.bg("toolErrorBg", text);
        const box = new Box(1, 1, bgFn);
        box.addChild(component);
        return ["", ...box.render(width)];
      },
    };
  });

  // ── Orchestration tools (our additions) ──
  // Pass shouldRegister through so per-tool deny entries in settings.json
  // (e.g. disabling subagent_run_parallel alone) gate each tool independently.
  // Pass preflightOrchestration so orchestration execute handlers surface the
  // same backend-aware mux/session-file errors as the bare subagent tool.
  // Pass selfSpawnBlocked so orchestration handlers enforce the same
  // PI_SUBAGENT_AGENT recursion guard as the bare subagent tool
  // (v5 review finding #1 — no silent bypass of the existing runtime
  // invariant).

  registerOrchestrationTools(
    pi,
    // Test seam: Task 7b (__test__.setLauncherDepsOverride).
    (ctx) => launcherDepsOverride ?? makeDefaultDeps(ctx),
    shouldRegister,
    preflightOrchestration,
    selfSpawnBlocked,
    { registry },
  );
}
// test
