import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LineBuffer } from "./line-buffer.ts";
import {
  resolveLaunchSpec,
  writeSystemPromptArtifact,
  writeTaskArtifact,
  type ResolvedLaunchSpec,
} from "../launch-spec.ts";
import { seedSubagentSessionFile } from "../session.ts";
import { buildClaudeHeadlessArgs, parseClaudeStreamEvent, parseClaudeResult } from "./claude-stream.ts";
import { warnClaudeSkillsDropped } from "../index.ts";
import type {
  Backend,
  BackendLaunchParams,
  BackendResult,
  LaunchedHandle,
  TranscriptContent,
  TranscriptMessage,
  UsageStats,
} from "./types.ts";

interface HeadlessLaunch {
  id: string;
  name: string;
  startTime: number;
  promise: Promise<BackendResult>;
  abort: AbortController;
}

// Module-private spawn reference that the unit test harness can swap out.
// Using a let-binding allows node:test to inject a fake spawn without
// rewriting `node:child_process` (which is frozen on ESM import).
let spawnImpl: typeof realSpawn = realSpawn;

export const __test__ = {
  setSpawn(fn: typeof realSpawn): void { spawnImpl = fn; },
  restoreSpawn(): void { spawnImpl = realSpawn; },
};

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function getFinalOutput(transcript: TranscriptMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const msg = transcript[i];
    if (msg.role === "assistant") {
      for (const part of msg.content ?? []) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export function makeHeadlessBackend(ctx: {
  sessionManager: ExtensionContext["sessionManager"];
  cwd: string;
}): Backend {
  const launches = new Map<string, HeadlessLaunch>();

  return {
    async launch(
      params: BackendLaunchParams,
      _defaultFocus: boolean,
      signal?: AbortSignal,
    ): Promise<LaunchedHandle> {
      const id = Math.random().toString(16).slice(2, 10);
      const startTime = Date.now();
      const abort = new AbortController();
      if (signal) {
        if (signal.aborted) abort.abort();
        else signal.addEventListener("abort", () => abort.abort(), { once: true });
      }

      const spec = resolveLaunchSpec(
        {
          name: params.name ?? "subagent",
          task: params.task,
          agent: params.agent,
          model: params.model,
          thinking: params.thinking,
          systemPrompt: params.systemPrompt,
          skills: params.skills,
          tools: params.tools,
          cwd: params.cwd,
          fork: params.fork,
          resumeSessionId: params.resumeSessionId,
          cli: params.cli,
          focus: params.focus,
        },
        ctx,
      );

      const promise: Promise<BackendResult> =
        spec.effectiveCli === "claude"
          ? runClaudeHeadless({ spec, startTime, abort: abort.signal, ctx })
          : runPiHeadless({ spec, startTime, abort: abort.signal, ctx });

      launches.set(id, { id, name: spec.name, startTime, promise, abort });
      return { id, name: spec.name, startTime };
    },

    async watch(handle: LaunchedHandle, signal?: AbortSignal): Promise<BackendResult> {
      const entry = launches.get(handle.id);
      if (!entry) {
        return {
          name: handle.name,
          finalMessage: "",
          transcriptPath: null,
          exitCode: 1,
          elapsedMs: 0,
          error: `no launch entry for ${handle.id}`,
        };
      }
      try {
        if (signal) {
          if (signal.aborted) entry.abort.abort();
          else signal.addEventListener("abort", () => entry.abort.abort(), { once: true });
        }
        return await entry.promise;
      } finally {
        launches.delete(handle.id);
      }
    },
  };
}

interface RunParams {
  spec: ResolvedLaunchSpec;
  startTime: number;
  abort: AbortSignal;
  ctx: { sessionManager: ExtensionContext["sessionManager"]; cwd: string };
}

function makeAbortHandler(proc: ChildProcess, isExited: () => boolean): () => void {
  return () => {
    try { proc.kill("SIGTERM"); } catch {}
    // unref so the 5s escalation timer does not hold the event loop open
    // after the child has already exited normally (review-I1).
    setTimeout(() => {
      if (!isExited()) {
        try { proc.kill("SIGKILL"); } catch {}
      }
    }, 5000).unref();
  };
}

type PiStreamMessage = {
  role: "user" | "assistant" | "toolResult";
  content: unknown;  // normalized to TranscriptContent[] by projectPiMessageToTranscript
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

async function runPiHeadless(p: RunParams): Promise<BackendResult> {
  const { spec, startTime, abort, ctx } = p;
  const transcript: TranscriptMessage[] = [];
  const usage = emptyUsage();
  let stderr = "";
  let terminalEvent = false;

  if (spec.seededSessionMode) {
    seedSubagentSessionFile({
      mode: spec.seededSessionMode,
      parentSessionFile: ctx.sessionManager.getSessionFile()!,
      childSessionFile: spec.subagentSessionFile,
      childCwd: spec.effectiveCwd ?? ctx.cwd,
    });
  }

  const systemPromptFlag: string[] = [];
  if (spec.identityInSystemPrompt && spec.identity) {
    const flag = spec.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const artifactPath = writeSystemPromptArtifact(spec);
    if (artifactPath) systemPromptFlag.push(flag, artifactPath);
  }

  const subagentDonePath = join(
    dirname(new URL(import.meta.url).pathname),
    "..",
    "subagent-done.ts",
  );

  // pi's non-interactive JSON stream is `--mode json --print` in the installed
  // CLI surface (no `--output-format` flag). `--print` / `-p` makes pi
  // non-interactive; `--mode json` emits one JSON event per line on stdout.
  const args: string[] = [
    "--session", spec.subagentSessionFile,
    "-e", subagentDonePath,
    "--mode", "json",
    "--print",
  ];
  if (spec.effectiveModel) {
    const model = spec.effectiveThinking
      ? `${spec.effectiveModel}:${spec.effectiveThinking}`
      : spec.effectiveModel;
    args.push("--model", model);
  }
  args.push(...systemPromptFlag);
  if (spec.effectiveTools) {
    const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    const builtins = spec.effectiveTools
      .split(",").map((t) => t.trim()).filter((t) => BUILTIN_TOOLS.has(t));
    if (builtins.length > 0) args.push("--tools", builtins.join(","));
  }

  let taskArg: string;
  if (spec.taskDelivery === "direct") {
    taskArg = spec.fullTask;
  } else {
    taskArg = `@${writeTaskArtifact(spec)}`;
  }
  const positional: string[] = [];
  if (spec.taskDelivery === "artifact" && spec.skillPrompts.length > 0) {
    positional.push("");
  }
  positional.push(...spec.skillPrompts, taskArg);
  args.push(...positional);

  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    PI_SUBAGENT_NAME: spec.name,
    PI_SUBAGENT_SESSION: spec.subagentSessionFile,
    ...spec.configRootEnv,
  };
  if (spec.agent) childEnv.PI_SUBAGENT_AGENT = spec.agent;
  if (spec.autoExit) childEnv.PI_SUBAGENT_AUTO_EXIT = "1";
  if (spec.denySet.size > 0) childEnv.PI_DENY_TOOLS = [...spec.denySet].join(",");

  if (abort.aborted) return makeAbortedResult(spec, startTime, transcript, usage);

  return new Promise<BackendResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawnImpl("pi", args, {
        cwd: spec.effectiveCwd ?? ctx.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      });
    } catch (err: any) {
      resolve({
        name: spec.name,
        finalMessage: "",
        transcriptPath: null,
        exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err?.message ?? String(err),
      });
      return;
    }

    const lb = new LineBuffer();
    let wasAborted = false;
    let exited = false;          // ← set ONLY by close/exit; drives SIGKILL escalation
    proc.on("exit", () => { exited = true; });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "message_end" && event.message) {
        const msg = event.message as PiStreamMessage;
        transcript.push(projectPiMessageToTranscript(msg));
        if (msg.role === "assistant") {
          usage.turns++;
          const u: any = (msg as any).usage;
          if (u) {
            usage.input += u.input ?? 0;
            usage.output += u.output ?? 0;
            usage.cacheRead += u.cacheRead ?? 0;
            usage.cacheWrite += u.cacheWrite ?? 0;
            usage.cost += u.cost?.total ?? 0;
            usage.contextTokens = u.totalTokens ?? usage.contextTokens;
          }
          const stop = (msg as any).stopReason;
          if (stop === "endTurn" || stop === "stop" || stop === "error") terminalEvent = true;
        }
      } else if (event.type === "tool_result_end" && event.message) {
        transcript.push(projectPiMessageToTranscript(event.message as PiStreamMessage));
      }
    };

    proc.stdout!.on("data", (data: Buffer) => {
      for (const line of lb.push(data.toString())) processLine(line);
    });
    proc.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });

    const onAbort = () => {
      wasAborted = true;
      makeAbortHandler(proc, () => exited)();
    };
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      resolve({
        name: spec.name,
        finalMessage: "",
        transcriptPath: null,
        exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err.code === "ENOENT"
          ? "pi CLI not found on PATH"
          : err.message || String(err),
      });
    });

    proc.on("close", (code) => {
      exited = true;
      for (const line of lb.flush()) processLine(line);
      const elapsedMs = Date.now() - startTime;
      const archived = existsSync(spec.subagentSessionFile) ? spec.subagentSessionFile : null;
      const exitCode = code ?? 0;
      const final = getFinalOutput(transcript);

      if (wasAborted) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode: 1, elapsedMs, error: "aborted", usage, transcript });
        return;
      }
      if (exitCode !== 0) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode, elapsedMs,
                  error: stderr.trim() || `pi exited with code ${exitCode}`,
                  usage, transcript });
        return;
      }
      if (!terminalEvent) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode: 1, elapsedMs,
                  error: "child exited without completion event", usage, transcript });
        return;
      }
      resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                exitCode: 0, elapsedMs, usage, transcript });
    });
  });
}

async function runClaudeHeadless(p: RunParams): Promise<BackendResult> {
  const { spec, startTime, abort, ctx } = p;
  const transcript: TranscriptMessage[] = [];
  let usage: UsageStats = emptyUsage();
  let stderr = "";
  let terminalResult: ReturnType<typeof parseClaudeResult> | null = null;
  let sessionId: string | undefined;

  warnClaudeSkillsDropped(spec.name, spec.effectiveSkills);

  // Claude always uses direct task delivery — the Claude CLI prompt argument does
  // not support @file substitution, so spec.taskDelivery is ignored on this path.
  const taskText = spec.claudeTaskBody;

  const args = buildClaudeHeadlessArgs(spec, taskText);

  if (abort.aborted) return makeAbortedResult(spec, startTime, transcript, usage);

  return new Promise<BackendResult>((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawnImpl("claude", args, {
        cwd: spec.effectiveCwd ?? ctx.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...spec.configRootEnv },
      });
    } catch (err: any) {
      resolve({
        name: spec.name, finalMessage: "", transcriptPath: null, exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err?.message ?? String(err),
      });
      return;
    }

    const lb = new LineBuffer();
    let wasAborted = false;
    let exited = false;
    // review I3: guard against double-resolve if both `error` and `close` fire.
    let settled = false;
    const settle = (r: BackendResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    proc.on("exit", () => { exited = true; });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "system" && event.subtype === "init"
          && typeof event.session_id === "string") {
        sessionId = event.session_id;
      }
      if (event.type === "result") {
        terminalResult = parseClaudeResult(event);
        usage = terminalResult.usage;
      } else {
        const msgs = parseClaudeStreamEvent(event);
        if (msgs) for (const m of msgs) transcript.push(m);
      }
    };

    proc.stdout!.on("data", (data: Buffer) => {
      for (const line of lb.push(data.toString())) processLine(line);
    });
    proc.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });

    const onAbort = () => {
      wasAborted = true;
      makeAbortHandler(proc, () => exited)();
    };
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      settle({
        name: spec.name, finalMessage: "", transcriptPath: null, exitCode: 1,
        elapsedMs: Date.now() - startTime,
        error: err.code === "ENOENT"
          ? "claude CLI not found on PATH"
          : err.message || String(err),
      });
    });

    proc.on("close", async (code) => {
      if (settled) return;
      exited = true;
      for (const line of lb.flush()) processLine(line);
      const elapsedMs = Date.now() - startTime;
      const exitCode = code ?? 0;
      const finalMessage = terminalResult?.finalOutput ?? "";
      // review I1: warn if the stream ended without a system/init session_id
      // on an otherwise-clean exit — likely means Claude's stream format changed.
      if (!sessionId && exitCode === 0) {
        process.stderr.write(
          `[pi-interactive-subagent] ${spec.name}: no system/init event seen — ` +
            `transcriptPath will be null (Claude stream format may have changed)\n`,
        );
      }
      // review I2: archival may throw (EACCES, ENOSPC, race vs. session file
      // deletion). Fall through to transcriptPath=null with a warning rather
      // than letting the async close-handler reject unhandled.
      let transcriptPath: string | null = null;
      if (sessionId) {
        try {
          transcriptPath = await archiveClaudeTranscript(sessionId);
        } catch (e: any) {
          process.stderr.write(
            `[pi-interactive-subagent] transcript archive failed: ${e?.message ?? e}\n`,
          );
        }
      }

      if (wasAborted) {
        settle({ name: spec.name, finalMessage, transcriptPath, exitCode: 1, elapsedMs,
                  error: "aborted", sessionId, usage, transcript });
        return;
      }
      if (exitCode !== 0 || terminalResult?.error) {
        settle({ name: spec.name, finalMessage, transcriptPath,
                  exitCode: exitCode !== 0 ? exitCode : 1, elapsedMs,
                  error: terminalResult?.error
                    ?? (stderr.trim() || `claude exited with code ${exitCode}`),
                  sessionId, usage, transcript });
        return;
      }
      if (!terminalResult) {
        settle({ name: spec.name, finalMessage, transcriptPath, exitCode: 1, elapsedMs,
                  error: "child exited without completion event",
                  sessionId, usage, transcript });
        return;
      }
      settle({ name: spec.name, finalMessage, transcriptPath, exitCode: 0, elapsedMs,
                sessionId, usage, transcript });
    });
  });
}

async function archiveClaudeTranscript(sessionId: string): Promise<string | null> {
  const sourceFile = await findClaudeSessionFile(sessionId, 2000);
  if (!sourceFile) {
    process.stderr.write(
      `[pi-interactive-subagent] Claude session file ${sessionId}.jsonl not found ` +
        `under ~/.claude/projects/*/ after 2s; transcriptPath will be null.\n`,
    );
    return null;
  }
  const destDir = join(homedir(), ".pi", "agent", "sessions", "claude-code");
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, `${sessionId}.jsonl`);
  copyFileSync(sourceFile, dest);
  return dest;
}

export async function findClaudeSessionFile(
  sessionId: string,
  timeoutMs: number,
): Promise<string | null> {
  const projectsRoot = join(homedir(), ".claude", "projects");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(projectsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
    }
    for (const slug of dirs) {
      const candidate = join(projectsRoot, slug, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

function makeAbortedResult(
  spec: ResolvedLaunchSpec,
  startTime: number,
  transcript: TranscriptMessage[],
  usage: UsageStats,
): BackendResult {
  return {
    name: spec.name,
    finalMessage: "",
    transcriptPath: null,
    exitCode: 1,
    elapsedMs: Date.now() - startTime,
    error: "aborted",
    usage,
    transcript,
  };
}
