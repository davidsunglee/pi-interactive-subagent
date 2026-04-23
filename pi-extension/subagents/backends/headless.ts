import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  BackendWatchHooks,
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
  /**
   * Most recent partial snapshot emitted by the runner (pi/Claude path or an
   * injected test runner). Buffered so `watch()` can replay the latest partial
   * immediately to a late-bound `onUpdate`. The invariant: headless work
   * starts inside `launch()`, so partials may fire before `watch()` attaches —
   * we must not drop them.
   */
  latestPartial?: BackendResult;
  /**
   * `watch()` installs this once it attaches. `emitPartial()` calls it (if
   * present) with a fresh clone of the snapshot. Unset before attachment;
   * partials are still buffered via `latestPartial`.
   */
  onUpdate?: (p: BackendResult) => void;
}

// Module-private spawn reference that the unit test harness can swap out.
// Using a let-binding allows node:test to inject a fake spawn without
// rewriting `node:child_process` (which is frozen on ESM import).
let spawnImpl: typeof realSpawn = realSpawn;

function emitPartial(entry: HeadlessLaunch, snapshot: BackendResult): void {
  entry.latestPartial = { ...snapshot };
  entry.onUpdate?.({ ...entry.latestPartial });
}

export const __test__ = {
  setSpawn(fn: typeof realSpawn): void { spawnImpl = fn; },
  restoreSpawn(): void { spawnImpl = realSpawn; },
  /**
   * Build a headless Backend whose pi/Claude runners are replaced by the
   * injected `runner`. Used by unit tests to drive deterministic
   * emit/finish sequences without spawning real processes.
   *
   * The `emitPartial` passed to the runner closes over the launch entry
   * created inside `launch()`, so partials flow through the same buffer +
   * late-bound `onUpdate` path as production runners.
   */
  makeHeadlessBackendWithRunner(
    ctx: { sessionManager: ExtensionContext["sessionManager"]; cwd: string },
    runner: (args: {
      spec: BackendLaunchParams;
      startTime: number;
      abort: AbortSignal;
      emitPartial: (snapshot: BackendResult) => void;
    }) => Promise<BackendResult>,
  ): Backend {
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
        const name = params.name ?? "subagent";
        const entry: HeadlessLaunch = {
          id,
          name,
          startTime,
          promise: Promise.resolve<BackendResult>(null as any),
          abort,
        };
        entry.promise = runner({
          spec: params,
          startTime,
          abort: abort.signal,
          emitPartial: (snap) => emitPartial(entry, snap),
        });
        launches.set(id, entry);
        return { id, name, startTime };
      },
      async watch(
        handle: LaunchedHandle,
        watchSignal?: AbortSignal,
        onUpdate?: (partial: BackendResult) => void,
      ): Promise<BackendResult> {
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
          if (watchSignal) {
            if (watchSignal.aborted) entry.abort.abort();
            else watchSignal.addEventListener("abort", () => entry.abort.abort(), { once: true });
          }
          entry.onUpdate = onUpdate;
          if (entry.latestPartial && onUpdate) {
            onUpdate({ ...entry.latestPartial });
          }
          return await entry.promise;
        } finally {
          launches.delete(handle.id);
        }
      },
    };
  },
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

      const entry: HeadlessLaunch = {
        id,
        name: spec.name,
        startTime,
        promise: Promise.resolve<BackendResult>(null as any),
        abort,
      };
      const emit = (snap: BackendResult): void => emitPartial(entry, snap);
      entry.promise =
        spec.effectiveCli === "claude"
          ? runClaudeHeadless({ spec, startTime, abort: abort.signal, ctx, emitPartial: emit })
          : runPiHeadless({ spec, startTime, abort: abort.signal, ctx, emitPartial: emit });

      launches.set(id, entry);
      return {
        id,
        name: spec.name,
        startTime,
        // Pi children: session file is known at launch.
        // Claude children: session key is late-bound via onSessionKey hook.
        ...(spec.effectiveCli !== "claude" ? { sessionKey: spec.subagentSessionFile } : {}),
      };
    },

    async watch(
      handle: LaunchedHandle,
      signal?: AbortSignal,
      onUpdate?: (partial: BackendResult) => void,
      hooks?: BackendWatchHooks,
    ): Promise<BackendResult> {
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
      // Pi children: fire onSessionKey immediately (session file known at launch).
      // The sessionKey was stored on the LaunchedHandle so we can retrieve it here.
      if (handle.sessionKey) {
        try { hooks?.onSessionKey?.(handle.sessionKey); } catch { /* defensive */ }
      }
      try {
        if (signal) {
          if (signal.aborted) entry.abort.abort();
          else signal.addEventListener("abort", () => entry.abort.abort(), { once: true });
        }
        entry.onUpdate = onUpdate;
        if (entry.latestPartial && onUpdate) {
          onUpdate({ ...entry.latestPartial });
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
  emitPartial: (snapshot: BackendResult) => void;
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
  const { spec, startTime, abort, ctx, emitPartial: emit } = p;
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
        // Emit a partial snapshot on each message_end (not on every delta line,
        // which would spam). Reflects accumulated transcript + usage so far.
        emit({
          name: spec.name,
          finalMessage: getFinalOutput(transcript),
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: Date.now() - startTime,
          usage,
          transcript,
        });
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
      const sessionKey = spec.subagentSessionFile;

      // Check for .exit sidecar file written by subagent_done / caller_ping.
      // This sidecar may be present if the pi child exited via the headless path
      // (e.g. in tests or when running without a pane). The pane path uses
      // pollForExit which already consumes the sidecar; the headless path does
      // not, so we check here.
      let ping: { name: string; message: string } | undefined;
      try {
        const exitFile = `${spec.subagentSessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          if (data.type === "ping") {
            ping = { name: data.name, message: data.message };
          }
        }
      } catch { /* ignore malformed sidecar */ }

      if (wasAborted) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode: 1, elapsedMs, error: "aborted", sessionKey, usage, transcript });
        return;
      }
      if (exitCode !== 0) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode, elapsedMs,
                  error: stderr.trim() || `pi exited with code ${exitCode}`,
                  sessionKey, usage, transcript });
        return;
      }
      if (ping) {
        // Ping: subagent is blocked and requesting help. Resolve with ping info.
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode: 0, elapsedMs, sessionKey, ping, usage, transcript });
        return;
      }
      if (!terminalEvent) {
        resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                  exitCode: 1, elapsedMs,
                  error: "child exited without completion event", sessionKey, usage, transcript });
        return;
      }
      resolve({ name: spec.name, finalMessage: final, transcriptPath: archived,
                exitCode: 0, elapsedMs, sessionKey, usage, transcript });
    });
  });
}

async function runClaudeHeadless(p: RunParams): Promise<BackendResult> {
  const { spec, startTime, abort, ctx, emitPartial: emit } = p;
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
        // Terminal result event — emit a snapshot reflecting final usage and
        // final message. The `close` handler will still emit the ultimate
        // resolved BackendResult; this gives watchers a usage-complete partial
        // before archival.
        emit({
          name: spec.name,
          finalMessage: terminalResult.finalOutput ?? "",
          transcriptPath: null,
          exitCode: 0,
          elapsedMs: Date.now() - startTime,
          sessionId,
          usage,
          transcript,
        });
      } else {
        const msgs = parseClaudeStreamEvent(event);
        if (msgs) {
          let sawAssistant = false;
          for (const m of msgs) {
            transcript.push(m);
            if (m.role === "assistant") sawAssistant = true;
          }
          if (sawAssistant) {
            // Emit a partial on assistant events (not on every tool-result
            // fragment or user message, which would spam).
            emit({
              name: spec.name,
              finalMessage: getFinalOutput(transcript),
              transcriptPath: null,
              exitCode: 0,
              elapsedMs: Date.now() - startTime,
              sessionId,
              usage,
              transcript,
            });
          }
        }
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
                  error: "aborted", sessionId, sessionKey: sessionId, usage, transcript });
        return;
      }
      if (exitCode !== 0 || terminalResult?.error) {
        settle({ name: spec.name, finalMessage, transcriptPath,
                  exitCode: exitCode !== 0 ? exitCode : 1, elapsedMs,
                  error: terminalResult?.error
                    ?? (stderr.trim() || `claude exited with code ${exitCode}`),
                  sessionId, sessionKey: sessionId, usage, transcript });
        return;
      }
      if (!terminalResult) {
        settle({ name: spec.name, finalMessage, transcriptPath, exitCode: 1, elapsedMs,
                  error: "child exited without completion event",
                  sessionId, sessionKey: sessionId, usage, transcript });
        return;
      }
      settle({ name: spec.name, finalMessage, transcriptPath, exitCode: 0, elapsedMs,
                sessionId, sessionKey: sessionId, usage, transcript });
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
    // Include sessionKey for pi children so the caller can still route to the registry.
    ...(spec.effectiveCli !== "claude" ? { sessionKey: spec.subagentSessionFile } : {}),
    usage,
    transcript,
  };
}
