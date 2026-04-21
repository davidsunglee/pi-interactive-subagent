import { Type, type Static } from "@sinclair/typebox";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

/**
 * Launch-spec normalization for subagent launches.
 *
 * This module extracts the launch-time resolution logic from `launchSubagent()`:
 * agent defaults, effective model/tools/skills/thinking/cli, working directory
 * + config-root resolution, session-file placement, system-prompt handling,
 * fork/lineage session-mode logic, skill expansion, and deny-tool resolution.
 *
 * Pane and headless backends both consume the `ResolvedLaunchSpec` so they see
 * identical normalization semantics. Pane-only side-effects (`createSurface`,
 * `sendLongCommand`, widget updates) stay in `index.ts`.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

// Re-declared here (rather than imported from index.ts) so launch-spec.ts has
// no dependency edge back into the pane module. index.ts imports this type
// via its own re-export for API stability.
export const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        "Resume a previous Claude Code session by its ID. Loads the conversation history and continues where it left off. The session ID is returned in details of every claude tool call. Use this to retry cancelled runs or ask follow-up questions.",
    }),
  ),
  cli: Type.Optional(
    Type.String({
      description:
        "CLI to launch for this subagent. One of 'pi' (default) or 'claude'. Overrides the agent frontmatter `cli` field.",
    }),
  ),
  thinking: Type.Optional(
    Type.String({
      description:
        "Thinking/effort override. Values: off, minimal, low, medium, high, xhigh. For pi: folded into the model string as `<model>:<thinking>`. For Claude: mapped to --effort (off/minimal/low→low, medium, high, xhigh→max). Overrides agent frontmatter.",
    }),
  ),
  focus: Type.Optional(
    Type.Boolean({
      description:
        "Whether the newly spawned pane grabs focus. Default true. Only honored on tmux today (other backends ignore). Orchestration wrappers default this to false for parallel, true for serial.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Vestigial compat field. Accepted for legacy callers but has no runtime effect in v1 — neither the pane nor the headless backend honors it. Do not rely on this field.",
    }),
  ),
});

export type SubagentParamsType = Static<typeof SubagentParams>;

export interface ResolvedLaunchSpec {
  name: string;
  task: string;
  agent: string | undefined;
  effectiveCli: "pi" | "claude" | string;

  effectiveModel: string | undefined;
  /** Claude-only projection of `effectiveModel`: strips a leading `<provider>/` prefix. */
  claudeModelArg: string | undefined;
  effectiveTools: string | undefined;
  effectiveSkills: string | undefined;
  effectiveThinking: string | undefined;
  /** Skill names expanded to `/skill:<name>` strings. */
  skillPrompts: string[];

  effectiveCwd: string | null;
  localAgentDir: string | null;
  effectiveAgentDir: string;
  /** Env-var prefix map for `PI_CODING_AGENT_DIR` when propagation applies. Empty object otherwise. */
  configRootEnv: Record<string, string>;

  identity: string | null;
  identityInSystemPrompt: boolean;
  systemPromptMode: "append" | "replace" | undefined;
  fullTask: string;
  /** Task body for Claude backends — NEVER includes the `roleBlock`; identity reaches Claude via the system-prompt flag. */
  claudeTaskBody: string;

  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
  subagentSessionFile: string;
  artifactDir: string;

  autoExit: boolean;
  denySet: Set<string>;
  resumeSessionId: string | undefined;
  focus: boolean | undefined;

  agentDefs: AgentDefaults | null;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Tools gated by `spawning: false`. */
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagents_list",
  "subagent_resume",
  "subagent_serial",
  "subagent_parallel",
]);

// ── Helpers ────────────────────────────────────────────────────────────────

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getBundledAgentsDir(): string {
  return join(dirname(new URL(import.meta.url).pathname), "../../agents");
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

function parseAgentDefaultsFromContent(content: string): AgentDefaults | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
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
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

/**
 * Load agent defaults by name. Default search order matches the legacy
 * behavior: project-local `.pi/agents/`, then `$PI_CODING_AGENT_DIR/agents/`
 * (or `~/.pi/agent/agents/`), then bundled. If `searchDirs` is provided,
 * each directory is tried in order for `<dir>/<agentName>.md` and the bundled
 * / default paths are skipped — this is the escape hatch tests use to point
 * at deterministic agent fixtures.
 */
export function loadAgentDefaults(
  agentName: string,
  searchDirs?: string[],
): AgentDefaults | null {
  const paths: string[] = [];
  if (searchDirs && searchDirs.length > 0) {
    for (const d of searchDirs) {
      paths.push(join(d, `${agentName}.md`));
    }
  } else {
    const configDir = getAgentConfigDir();
    paths.push(
      join(process.cwd(), ".pi", "agents", `${agentName}.md`),
      join(configDir, "agents", `${agentName}.md`),
      join(getBundledAgentsDir(), `${agentName}.md`),
    );
  }

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefaultsFromContent(readFileSync(p, "utf8"));
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

export function resolveSubagentPaths(
  params: SubagentParamsType,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

export function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

export function resolveEffectiveSessionMode(
  params: SubagentParamsType,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

export function resolveLaunchBehavior(
  params: SubagentParamsType,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Build the internal artifact directory path for the current session.
 *   <sessionDir>/artifacts/<session-id>/
 */
export function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

/**
 * Strip a leading `<provider>/` prefix from a model string for Claude CLI.
 * "anthropic/claude-haiku-4-5" → "claude-haiku-4-5"
 * "claude-sonnet-4-6"          → "claude-sonnet-4-6" (no prefix)
 *
 * Rule: split on first `/`; if the left segment looks like a simple provider
 * identifier (letters/digits/dashes only), drop it. Otherwise keep as-is.
 */
function projectModelForClaude(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0) return model;
  const left = model.slice(0, slash);
  const right = model.slice(slash + 1);
  if (/^[a-zA-Z0-9-]+$/.test(left) && right.length > 0) return right;
  return model;
}

function safeFileName(raw: string, fallback: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || fallback
  );
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Minimal `ctx` shape required by resolveLaunchSpec. Real callers pass the
 * full `ExtensionContext["sessionManager"]` (which satisfies this shape); this
 * loose typing lets tests and the launchSubagent wrapper pass minimal stubs
 * without pulling in the whole ReadonlySessionManager surface.
 */
export interface LaunchSpecContext {
  sessionManager: {
    getSessionId(): string;
    getSessionDir(): string;
    getSessionFile?(): string | null;
  };
  cwd: string;
}

export function resolveLaunchSpec(
  params: SubagentParamsType,
  ctx: LaunchSpecContext,
  opts?: { agentSearchDirs?: string[] },
): ResolvedLaunchSpec {
  const id = Math.random().toString(16).slice(2, 10);
  const agentDefs = params.agent ? loadAgentDefaults(params.agent, opts?.agentSearchDirs) : null;

  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = params.thinking ?? agentDefs?.thinking;
  const effectiveCli = params.cli ?? agentDefs?.cli ?? "pi";
  const claudeModelArg = projectModelForClaude(effectiveModel);

  const sessionId = ctx.sessionManager.getSessionId();
  const sessionDirBase = ctx.sessionManager.getSessionDir();
  const artifactDir = getArtifactDir(sessionDirBase, sessionId);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(
    params,
    agentDefs,
  );
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Deterministic session-file path — eliminates launch-time races between
  // multiple parallel agents by giving each one a uuid-tagged jsonl file.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);
  const { sessionMode, seededSessionMode, inheritsConversationContext, taskDelivery } =
    launchBehavior;

  const denySet = resolveDenyTools(agentDefs);

  // Task-wrapping identity + modeHint + summaryInstruction (shared with pane path).
  const modeHint = agentDefs?.autoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";

  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = !!(systemPromptMode && identity);
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;
  // Claude-only task body: identity reaches Claude via --system-prompt /
  // --append-system-prompt, never via the task body. So omit `roleBlock`.
  const claudeTaskBody = inheritsConversationContext
    ? params.task
    : `${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

  const skillPrompts = (effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const configRootEnv: Record<string, string> = {};
  if (localAgentDir && existsSync(localAgentDir)) {
    configRootEnv.PI_CODING_AGENT_DIR = localAgentDir;
  } else if (process.env.PI_CODING_AGENT_DIR) {
    configRootEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
  }

  return {
    name: params.name,
    task: params.task,
    agent: params.agent,
    effectiveCli,

    effectiveModel,
    claudeModelArg,
    effectiveTools,
    effectiveSkills,
    effectiveThinking,
    skillPrompts,

    effectiveCwd,
    localAgentDir,
    effectiveAgentDir,
    configRootEnv,

    identity,
    identityInSystemPrompt,
    systemPromptMode,
    fullTask,
    claudeTaskBody,

    sessionMode,
    seededSessionMode,
    inheritsConversationContext,
    taskDelivery,
    subagentSessionFile,
    artifactDir,

    autoExit: agentDefs?.autoExit === true,
    denySet,
    resumeSessionId: params.resumeSessionId,
    focus: params.focus,

    agentDefs,
  };
}

// ── Artifact-write helpers (side-effectful) ────────────────────────────────

/**
 * Write the system-prompt artifact file used when `identityInSystemPrompt`
 * is true (agent frontmatter sets `system-prompt: append|replace`). Returns
 * the path the pane command should reference via `--append-system-prompt`
 * / `--system-prompt`. Returns `null` when not applicable.
 */
export function writeSystemPromptArtifact(
  spec: ResolvedLaunchSpec,
  namePrefix?: string,
): string | null {
  if (!spec.identityInSystemPrompt || !spec.identity) return null;
  const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const spSafeName = safeFileName(namePrefix ?? spec.name ?? "subagent", "subagent");
  const syspromptPath = join(
    spec.artifactDir,
    `context/${spSafeName}-sysprompt-${spTimestamp}.md`,
  );
  mkdirSync(dirname(syspromptPath), { recursive: true });
  writeFileSync(syspromptPath, spec.identity, "utf8");
  return syspromptPath;
}

/**
 * Write the task artifact consumed by pi via `@file` substitution when
 * `taskDelivery === "artifact"`. Returns the artifact path. For direct
 * delivery the caller uses `spec.fullTask` directly.
 */
export function writeTaskArtifact(spec: ResolvedLaunchSpec, namePrefix?: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName = safeFileName(namePrefix ?? spec.name, "subagent");
  const artifactName = `context/${safeName}-${timestamp}.md`;
  const artifactPath = join(spec.artifactDir, artifactName);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, spec.fullTask, "utf8");
  return artifactPath;
}
