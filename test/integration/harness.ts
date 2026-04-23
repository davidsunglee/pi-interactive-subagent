/**
 * Integration test harness for pi-interactive-subagents.
 *
 * Provides utilities to:
 * - Detect available mux backends (cmux, tmux)
 * - Create isolated test environments with test agent definitions
 * - Start real pi sessions in mux surfaces
 * - Poll for file creation and screen output
 * - Clean up surfaces and temp files after tests
 */
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  getMuxBackend,
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
  type MuxBackend,
} from "../../pi-extension/subagents/cmux.ts";

// Re-export mux primitives for tests
export {
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
};
export type { MuxBackend };

// ── Paths ──

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");

// ── Configuration ──

/** Model used for integration tests. Override with PI_TEST_MODEL env var. */
export const TEST_MODEL = process.env.PI_TEST_MODEL ?? "anthropic/claude-haiku-4-5";

/** Per-test timeout in ms. Override with PI_TEST_TIMEOUT env var. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

/**
 * Per-event wait budget for async orchestration steer-back notifications
 * (BLOCKED / ORCHESTRATION_COMPLETE). Tighter than PI_TIMEOUT because these
 * events should fire quickly once the child process is live — a single event
 * timing out on this budget is a real signal, not a sluggish CI signal.
 * Override with PI_BLOCK_WAIT_MS env var.
 */
export const BLOCK_WAIT_MS = Number(process.env.PI_BLOCK_WAIT_MS ?? "90000");

/**
 * Slow-lane opt-in flag. Real-backend orchestration tests (those that spawn
 * actual pi children or mux surfaces over multi-minute wall times) check this
 * and self-skip unless PI_RUN_SLOW=1 is set. The `npm run test:integration`
 * script leaves this unset so the default integration gate stays snappy;
 * `npm run test:integration:slow` sets it to run the heavy suites explicitly.
 */
export const SLOW_LANE_OPT_IN = process.env.PI_RUN_SLOW === "1";

// ── Backend detection ──

/**
 * Detect which mux backends are actually available in the current environment.
 * Temporarily sets PI_SUBAGENT_MUX to probe each backend.
 */
export function getAvailableBackends(): MuxBackend[] {
  const backends: MuxBackend[] = [];
  const orig = process.env.PI_SUBAGENT_MUX;

  for (const backend of ["cmux", "tmux"] as MuxBackend[]) {
    process.env.PI_SUBAGENT_MUX = backend;
    try {
      if (getMuxBackend() === backend) backends.push(backend);
    } catch {}
  }

  if (orig === undefined) delete process.env.PI_SUBAGENT_MUX;
  else process.env.PI_SUBAGENT_MUX = orig;

  return backends;
}

export function setBackend(backend: MuxBackend): string | undefined {
  const prev = process.env.PI_SUBAGENT_MUX;
  process.env.PI_SUBAGENT_MUX = backend;
  return prev;
}

export function restoreBackend(prev: string | undefined): void {
  if (prev === undefined) delete process.env.PI_SUBAGENT_MUX;
  else process.env.PI_SUBAGENT_MUX = prev;
}

// ── Test environment ──

export interface TestEnv {
  /** Temp directory serving as the test project root */
  dir: string;
  /** Active mux backend for this test run */
  backend: MuxBackend;
  /** Surfaces created during the test (cleaned up automatically) */
  surfaces: string[];
  /** Temp files to clean up */
  tempFiles: string[];
}

/**
 * Create an isolated test environment with test agent definitions.
 * The temp dir has `.pi/agents/` containing copies of all test agents.
 */
export function createTestEnv(backend: MuxBackend): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-integ-"));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });

  // Copy test agent definitions into the project-local agents dir
  if (existsSync(TEST_AGENTS_SRC)) {
    for (const file of readdirSync(TEST_AGENTS_SRC)) {
      if (file.endsWith(".md")) {
        cpSync(join(TEST_AGENTS_SRC, file), join(agentsDir, file));
      }
    }
  }

  return { dir, backend, surfaces: [], tempFiles: [] };
}

/**
 * Seed `<dir>/.pi/agents/` with the test agent definitions (`test-echo`,
 * `test-ping`). Used by headless integration tests that don't go through
 * `createTestEnv()` (which is mux-coupled).
 */
export function copyTestAgents(dir: string): void {
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  if (!existsSync(TEST_AGENTS_SRC)) return;
  for (const file of readdirSync(TEST_AGENTS_SRC)) {
    if (file.endsWith(".md")) {
      cpSync(join(TEST_AGENTS_SRC, file), join(agentsDir, file));
    }
  }
}

/**
 * Clean up all resources created during the test.
 */
export function cleanupTestEnv(env: TestEnv): void {
  for (const surface of env.surfaces) {
    try {
      closeSurface(surface);
    } catch {}
  }
  for (const file of env.tempFiles) {
    try {
      unlinkSync(file);
    } catch {}
  }
  try {
    rmSync(env.dir, { recursive: true, force: true });
  } catch {}
}

/**
 * Create a surface and register it for automatic cleanup.
 */
export function createTrackedSurface(env: TestEnv, name: string): string {
  const surface = createSurface(name);
  env.surfaces.push(surface);
  return surface;
}

/**
 * Remove a surface from tracking (after manual close).
 */
export function untrackSurface(env: TestEnv, surface: string): void {
  env.surfaces = env.surfaces.filter((s) => s !== surface);
}

// ── Pi session management ──

/**
 * Start a pi session in a mux surface with the subagents extension loaded.
 * Returns immediately — the pi process runs asynchronously in the surface.
 *
 * The command ends with a sentinel so we can detect when pi exits:
 *   `pi ...; echo '__TEST_DONE_'$?'__'`
 */
export function startPi(
  surface: string,
  testDir: string,
  task: string,
  opts?: { model?: string; extraArgs?: string },
): void {
  const model = opts?.model ?? TEST_MODEL;
  const extra = opts?.extraArgs ?? "";

  const cmd = [
    `cd ${shellEscape(testDir)} &&`,
    `pi`,
    `--model ${shellEscape(model)}`,
    extra,
    shellEscape(task),
  ]
    .filter(Boolean)
    .join(" ");

  sendLongCommand(surface, `${cmd}; echo '__TEST_DONE_'$?'__'`, {
    scriptPath: join(testDir, `test-launch-${Date.now()}.sh`),
  });
}

// ── Polling helpers ──

/**
 * Poll until a regex pattern appears in the surface's screen output.
 * Throws on timeout with the last screen contents for debugging.
 */
export async function waitForScreen(
  surface: string,
  pattern: RegExp,
  timeout: number = PI_TIMEOUT,
  lines: number = 200,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const screen = await readScreenAsync(surface, lines);
      if (pattern.test(screen)) return screen;
    } catch {}
    await sleep(2000);
  }

  let finalScreen = "";
  try {
    finalScreen = readScreen(surface, lines);
  } catch {}
  throw new Error(
    `Timeout (${timeout}ms) waiting for pattern ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`,
  );
}

/**
 * Poll until a file exists and optionally matches a content pattern.
 * Returns the file content on success.
 */
export async function waitForFile(
  path: string,
  timeout: number = PI_TIMEOUT,
  contentPattern?: RegExp,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (!contentPattern || contentPattern.test(content)) return content;
    }
    await sleep(2000);
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for file: ${path}` +
      (contentPattern ? ` matching ${contentPattern}` : ""),
  );
}

/**
 * Wait for the pi process in a surface to exit (sentinel detection).
 * Returns the exit code.
 */
export async function waitForPiExit(
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<number> {
  const screen = await waitForScreen(surface, /__TEST_DONE_(\d+)__/, timeout);
  const match = screen.match(/__TEST_DONE_(\d+)__/);
  return match ? parseInt(match[1], 10) : -1;
}

// ── Utilities ──

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Register a temp file for cleanup.
 */
export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path);
}

// ── Shared helpers for async/block integration tests ──

export type SentMessage = { message: any; opts?: any };

/**
 * Poll `sentMessages` for a message with `customType === customType`. Returns
 * the matched record or null on timeout. Kept intentionally side-effect-free
 * so callers can dump diagnostics and perform their own cleanup when null.
 */
export async function waitForSentMessage(
  sentMessages: SentMessage[],
  customType: string,
  timeoutMs: number,
): Promise<SentMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = sentMessages.find((m) => m.message?.customType === customType);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/**
 * Format a compact summary of sentMessages for diagnostics on wait-for-message
 * timeouts. Capped at 20 rows so assertion failure output stays readable.
 */
export function summarizeSentMessages(
  sentMessages: SentMessage[],
  limit: number = 20,
): string {
  if (sentMessages.length === 0) return "(no messages sent)";
  const rows = sentMessages.slice(-limit).map((m, i) => {
    const idx = sentMessages.length - Math.min(limit, sentMessages.length) + i;
    const kind = m.message?.customType ?? m.message?.role ?? "<no-customType>";
    const oid = m.message?.details?.orchestrationId;
    const tIdx = m.message?.details?.taskIndex;
    const extras: string[] = [];
    if (oid) extras.push(`oid=${oid}`);
    if (tIdx !== undefined) extras.push(`taskIndex=${tIdx}`);
    if (m.opts?.deliverAs) extras.push(`deliverAs=${m.opts.deliverAs}`);
    return `  [${idx}] ${kind}${extras.length ? " " + extras.join(" ") : ""}`;
  });
  return `${sentMessages.length} total; last ${rows.length}:\n${rows.join("\n")}`;
}

/**
 * Best-effort cancel for a dispatched orchestration. Intended for finally
 * blocks so a wait-for-message timeout doesn't leave live children stranded
 * across tests. Swallows errors; safe to call with an unknown id.
 */
export async function tryCancelOrchestration(
  cancelTool: { execute: (...args: any[]) => Promise<any> } | undefined,
  orchestrationId: string | undefined,
  ctx: any,
): Promise<void> {
  if (!cancelTool || !orchestrationId) return;
  try {
    await cancelTool.execute(
      "teardown-cancel",
      { orchestrationId },
      new AbortController().signal,
      () => {},
      ctx,
    );
  } catch {}
}
