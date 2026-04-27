# Claude Pane Interactive Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude pane subagents support multi-turn interactive sessions by replacing the user-msg-count heuristic with an explicit `subagent_done` MCP tool call, so a Claude child can ask clarifying questions and remain alive until it explicitly signals completion.

**Architecture:** A bundled MCP server (`pi-subagent`) ships inside the existing plugin folder and exposes one tool, `subagent_done`, that writes the watcher's sentinel file via atomic rename. The Stop hook is slimmed to a single responsibility (surface the transcript path) and the user-msg-count completion heuristic is deleted. A new `claudeCompletionAddendum` field on `ResolvedLaunchSpec` carries the auto-exit-aware system-prompt instruction, which the pane Claude launch path folds into Claude's `--append-system-prompt` argument and combines with always-on injection of `mcp__pi-subagent__subagent_done` into the `--tools` allowlist.

**Tech Stack:** TypeScript (Node ESM), `@modelcontextprotocol/sdk` (new direct dep), bash (Stop hook), Node's built-in `node:test` runner, the existing `cmux`/`tmux` mux-pane backends.

---

## File Structure

**New files:**
- `pi-extension/subagents/plugin/.claude-plugin/plugin.json` — plugin manifest required for `--plugin-dir` to discover the `.mcp.json` server config.
- `pi-extension/subagents/plugin/.mcp.json` — declares the stdio MCP server `pi-subagent`, pointing at the compiled `mcp/server.js`.
- `pi-extension/subagents/plugin/mcp/server.ts` — MCP server source. Exposes one tool `subagent_done`; reads `$PI_CLAUDE_SENTINEL`; writes via atomic rename.
- `pi-extension/subagents/plugin/mcp/server.js` — compiled output (build artifact, committed so end users get a working plugin without running our build).
- `pi-extension/subagents/plugin/tsconfig.json` — separate TS config that compiles only the plugin MCP server (the root `tsconfig.json` excludes `plugin/**`).
- `test/plugin-mcp.test.ts` — MCP server unit tests (in-process — spawn the compiled server.js as a child via stdio).
- `test/plugin-stop-hook.test.ts` — Stop hook unit tests (invoke `on-stop.sh` directly with mocked stdin).
- `test/orchestration/pane-claude-completion-addendum.test.ts` — `buildClaudeCompletionAddendum` + `claudeCompletionAddendum` resolution unit tests.
- `test/orchestration/pane-claude-mcp-tool-injection.test.ts` — `buildClaudeCmdParts` MCP-tool-injection unit tests.
- `test/integration/pane-claude-interactive.test.ts` — pane integration tests for the multi-turn happy path, autonomous-with-MCP path, autonomous-without-MCP hang regression, cancellation, and manual `/exit`. Each test waits on observable assistant turns (via `waitForScreen`) instead of fixed sleeps and asserts the parent-facing terminal payload (`finalMessage`/`exitCode`/`transcriptPath`/`sessionId`).
- `test/integration/orchestration-claude-pane-serial.test.ts` — real `runSerial` + `makeDefaultDeps` coverage with `cli: claude, auto-exit: false`. Asserts the full `OrchestrationResult` payload shape (`state`, `transcriptPath`, `sessionId`, `sessionKey`, `finalMessage`, `exitCode`).
- `test/integration/orchestration-claude-pane-parallel.test.ts` — `runParallel` analogue with two interactive Claude tasks; asserts both children's payloads carry independent `sessionKey`s.
- `test/integration/orchestration-claude-pane-spec-designer-e2e.test.ts` — workflow-level smoke test dispatching through `runSerial` (not bare `launchSubagent`). Waits for question 1 in the pane, sends answer 1, waits for question 2, sends answer 2, then asserts the parent's `OrchestrationResult.finalMessage` matches `SPEC_WRITTEN: <path>`.

**Modified files:**
- `pi-extension/subagents/plugin/hooks/on-stop.sh` — slim down to the transcript-path surface only; remove user-msg-count signaling and the auto-exit env-var read; replace Python with one-line Node JSON parsing.
- `pi-extension/subagents/launch-spec.ts` — add `buildClaudeCompletionAddendum(autoExit: boolean): string` and a `claudeCompletionAddendum: string | null` field on `ResolvedLaunchSpec` (populated only on the Claude pane path).
- `pi-extension/subagents/index.ts` — Claude pane launch path:
  - Fold `spec.claudeCompletionAddendum` into the `identity` value passed to `buildClaudeCmdParts`, preserving ordering after `spec.identity`.
  - Always inject `mcp__pi-subagent__subagent_done` into the `--tools` list whenever the flag is emitted.
  - Upgrade the `watchSubagent` summary fallback chain so an empty sentinel file falls back to the archived transcript JSONL's last assistant message before pane screen-scrape.
  - (Conditional, Task 10 only — execute only if Task 9's plugin-auto-load smoke fails) Emit `--mcp-config <generated-path>` from `buildClaudeCmdParts` so the MCP server loads even when plugin-MCP auto-discovery is unreliable. The generated config has the same shape as `.mcp.json`.
- `package.json` — add `@modelcontextprotocol/sdk` as a direct dep; add `build:plugin` script (`tsc -p pi-extension/subagents/plugin`); chain it into the existing typecheck flow only as `npm run build:plugin`. Update `tsconfig.json` exclude to remain authoritative for the root project (no change needed) — the plugin compiles via its own tsconfig.
- `test/integration/claude-sentinel-roundtrip.test.ts` — adapt to the new completion contract: the existing single test instructs the model to "Reply with exactly: OK" but expects autonomous termination via the deleted user-msg-count path. Update to instruct the model to call `subagent_done` with the same payload, OR (cleaner) use an agent-frontmatter agent with `auto-exit: true` so the autonomous addendum is applied and the model is explicitly told to invoke the tool.

**Components that stay unchanged** (do not modify in this plan):
- `pollForExit` — unchanged.
- `BackendResult` shape, registry, `subagent_run_serial`, `subagent_run_parallel`.
- `backends/headless.ts`, `backends/claude-stream.ts` — out of scope.
- `subagent-done.ts`, `resolvePiToolsArg`, pi result extraction — out of scope.
- `pi-extension/subagents/index.ts` Pi CLI launch path (the `PI_SUBAGENT_AUTO_EXIT=1` line at index.ts:784 stays — its consumer `subagent-done.ts:93` is the pi child process, not the Claude path).

---

## Task 1: Add MCP SDK dependency and plugin tsconfig

**Files:**
- Modify: `package.json`
- Create: `pi-extension/subagents/plugin/tsconfig.json`

- [ ] **Step 1: Inspect current dep layout to confirm the SDK is not already transitively pinned**

Run: `npm ls @modelcontextprotocol/sdk`
Expected: `(empty)` — confirms the dep is missing and we need to add it directly.

- [ ] **Step 2: Add `@modelcontextprotocol/sdk` to `dependencies` in `package.json`**

Edit `package.json`. Add a `dependencies` block (currently the manifest only has `peerDependencies` and `devDependencies`). The MCP SDK is a runtime dep of the bundled plugin, not a peer:

```json
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
```

(Place this block between `peerDependencies` and `devDependencies` to keep the existing key order intact.)

- [ ] **Step 3: Add a `build:plugin` script**

Add to the `scripts` block in `package.json`:

```json
    "build:plugin": "tsc -p pi-extension/subagents/plugin",
```

Place it after `typecheck` so the script ordering reads typecheck → build:plugin.

- [ ] **Step 4: Create the plugin's tsconfig**

Write `pi-extension/subagents/plugin/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": ".",
    "rootDir": ".",
    "declaration": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "strict": false,
    "noImplicitAny": false,
    "types": ["node"]
  },
  "include": ["mcp/**/*.ts"]
}
```

- [ ] **Step 5: Install the new dep**

Run: `npm install`
Expected: `npm ls @modelcontextprotocol/sdk` now reports a concrete version under the package, no errors.

- [ ] **Step 6: Verify the (empty) plugin build runs without errors**

Run: `mkdir -p pi-extension/subagents/plugin/mcp && touch pi-extension/subagents/plugin/mcp/.gitkeep && npm run build:plugin`
Expected: exit 0 and no `.js` outputs (no `.ts` files yet). The script is now wired and ready for Task 2.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json pi-extension/subagents/plugin/tsconfig.json pi-extension/subagents/plugin/mcp/.gitkeep
git commit -m "chore(plugin): add @modelcontextprotocol/sdk dep and plugin tsconfig"
```

---

## Task 2: Build the `pi-subagent` MCP server (TDD)

**Files:**
- Create: `pi-extension/subagents/plugin/mcp/server.ts`
- Create: `test/plugin-mcp.test.ts`
- Modify: `package.json` (add `test:plugin` script)

The MCP server is a small stdio program. We test it by:
1. Building it (`npm run build:plugin`) into `mcp/server.js`.
2. Spawning it as a child process from the test, talking JSON-RPC over stdio with the standard `Client` from `@modelcontextprotocol/sdk`.

This avoids reimplementing the JSON-RPC transport in tests.

- [ ] **Step 1: Write the failing tests**

Write `test/plugin-mcp.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(HERE, "..", "pi-extension", "subagents", "plugin", "mcp", "server.js");
const SHOULD_SKIP = !existsSync(SERVER_JS);
if (SHOULD_SKIP) {
  console.log("⚠️  plugin-mcp tests skipped: server.js not built — run `npm run build:plugin` first");
}

async function withClient(
  envOverrides: Record<string, string | undefined>,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const env: Record<string, string> = { ...process.env } as any;
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_JS],
    env,
  });
  const client = new Client({ name: "pi-subagent-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try { await fn(client); } finally { await client.close(); }
}

describe("plugin-mcp pi-subagent server", { skip: SHOULD_SKIP }, () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), "pi-mcp-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it("advertises exactly one tool named subagent_done with documented schema", async () => {
    const sentinel = join(dir, "sentinel-handshake");
    await withClient({ PI_CLAUDE_SENTINEL: sentinel }, async (client) => {
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 1, "expected exactly one tool");
      const tool = tools.tools[0];
      assert.equal(tool.name, "subagent_done");
      assert.ok(tool.description && tool.description.length > 0, "tool must have a description");
      assert.equal(tool.inputSchema.type, "object");
      assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ["message"]);
    });
  });

  it("subagent_done with non-empty message writes that string to PI_CLAUDE_SENTINEL", async () => {
    const sentinel = join(dir, "sentinel-with-msg");
    await withClient({ PI_CLAUDE_SENTINEL: sentinel }, async (client) => {
      const out = await client.callTool({
        name: "subagent_done",
        arguments: { message: "task done: wrote SPEC.md" },
      });
      assert.equal(out.isError, undefined, `unexpected error: ${JSON.stringify(out)}`);
      assert.ok(existsSync(sentinel), "sentinel file must be written");
      assert.equal(readFileSync(sentinel, "utf-8"), "task done: wrote SPEC.md");
    });
  });

  it("subagent_done with omitted message writes empty body", async () => {
    const sentinel = join(dir, "sentinel-empty");
    await withClient({ PI_CLAUDE_SENTINEL: sentinel }, async (client) => {
      const out = await client.callTool({ name: "subagent_done", arguments: {} });
      assert.equal(out.isError, undefined);
      assert.ok(existsSync(sentinel));
      assert.equal(readFileSync(sentinel, "utf-8"), "");
    });
  });

  it("returns isError=true when PI_CLAUDE_SENTINEL is unset and writes nothing", async () => {
    const before = mkdtempSync(join(tmpdir(), "pi-mcp-unset-"));
    try {
      await withClient({ PI_CLAUDE_SENTINEL: undefined }, async (client) => {
        const out = await client.callTool({ name: "subagent_done", arguments: { message: "x" } });
        assert.equal(out.isError, true);
        const text = (out.content as any[])[0].text;
        assert.match(text, /PI_CLAUDE_SENTINEL is not set/);
      });
      // No file with that name should appear in the temp dir
      assert.equal(
        require("node:fs").readdirSync(before).length,
        0,
        "no sentinel file should be created when env var is unset",
      );
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("uses atomic-rename so the sentinel file never appears with partial content", async () => {
    // Drive 5 sequential invocations with different payloads. After each, the
    // file MUST exist with the exact payload written most recently — never an
    // intermediate ".tmp" filename, never a truncated body.
    const sentinel = join(dir, "sentinel-atomic");
    await withClient({ PI_CLAUDE_SENTINEL: sentinel }, async (client) => {
      const payloads = ["aaaaaaaa", "bbbbbbbbbb", "cccc", "ddddddddddddddddd", ""];
      for (const p of payloads) {
        const out = await client.callTool({ name: "subagent_done", arguments: { message: p } });
        assert.equal(out.isError, undefined);
        assert.ok(existsSync(sentinel));
        assert.equal(readFileSync(sentinel, "utf-8"), p);
      }
      // No leftover .tmp file
      assert.equal(existsSync(sentinel + ".tmp"), false, "atomic-rename must clean up .tmp file");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (server.js does not exist yet)**

Run: `node --test test/plugin-mcp.test.ts`
Expected: PASS the skip — the suite reports "skipped: server.js not built". This is the canonical failing-state for TDD here: until we write and build the server, every assertion in the suite is gated. After the next step, we'll un-gate by running the build.

- [ ] **Step 3: Add the `test:plugin` npm script**

Edit `package.json`:

```json
    "test:plugin": "node --test test/plugin-mcp.test.ts",
```

Place it after `test:integration:slow`.

- [ ] **Step 4: Write the MCP server**

Write `pi-extension/subagents/plugin/mcp/server.ts`:

```ts
#!/usr/bin/env node
/**
 * pi-subagent MCP server.
 *
 * Auto-loaded by the bundled plugin when Claude is launched with `--plugin-dir`.
 * Exposes a single tool, `subagent_done`, that the model invokes when its task
 * is complete. The tool writes the watcher's sentinel file via atomic rename.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";

const TOOL_NAME = "subagent_done";
const TOOL_DESCRIPTION =
  "Call this when your task is complete. Your final assistant message before " +
  "this call should summarize what you accomplished — that summary is returned " +
  "to the parent agent. The session will end after this call.";

const server = new Server(
  { name: "pi-subagent", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description:
              "Optional final summary returned to the parent. Defaults to the " +
              "last assistant message if omitted.",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== TOOL_NAME) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
    };
  }
  const sentinel = process.env.PI_CLAUDE_SENTINEL;
  if (!sentinel) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: "PI_CLAUDE_SENTINEL is not set — subagent_done is only valid in pi-spawned Claude sessions.",
      }],
    };
  }
  const args = (req.params.arguments ?? {}) as { message?: string };
  const body = typeof args.message === "string" ? args.message : "";
  try {
    const tmp = sentinel + ".tmp";
    writeFileSync(tmp, body);
    renameSync(tmp, sentinel);
  } catch (err: any) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `Failed to write sentinel ${sentinel}: ${err?.message ?? String(err)}`,
      }],
    };
  }
  return {
    content: [{
      type: "text",
      text: "Session ending. Parent will receive your summary.",
    }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 5: Build the plugin**

Run: `npm run build:plugin`
Expected: exit 0, and `pi-extension/subagents/plugin/mcp/server.js` now exists.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:plugin`
Expected: 5 tests pass (one per `it` block).

- [ ] **Step 7: Commit**

```bash
git add pi-extension/subagents/plugin/mcp/server.ts pi-extension/subagents/plugin/mcp/server.js test/plugin-mcp.test.ts package.json
git commit -m "feat(plugin): add pi-subagent MCP server with subagent_done tool"
```

---

## Task 3: Plugin manifests (`.claude-plugin/plugin.json` + `.mcp.json`)

**Files:**
- Create: `pi-extension/subagents/plugin/.claude-plugin/plugin.json`
- Create: `pi-extension/subagents/plugin/.mcp.json`

These two files are config-only — there is no unit test to "fail." We add them, then verify both with a JSON-validity check and a structural assertion in the existing claude-sentinel-roundtrip integration test (Task 9 will exercise them end-to-end).

- [ ] **Step 1: Write a structural test for the manifests**

Add to `test/plugin-mcp.test.ts` (after the existing `describe` block):

```ts
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

describe("plugin manifests", () => {
  const PLUGIN_ROOT = join(
    dirname(fileURLToPath(import.meta.url)),
    "..", "pi-extension", "subagents", "plugin",
  );

  it(".claude-plugin/plugin.json exists and parses with required keys", () => {
    const path = join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");
    assert.ok(existsSync(path), `${path} must exist`);
    const j = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(typeof j.name, "string");
    assert.ok(j.name.length > 0);
  });

  it(".mcp.json declares exactly one server named pi-subagent invoking node mcp/server.js", () => {
    const path = join(PLUGIN_ROOT, ".mcp.json");
    assert.ok(existsSync(path), `${path} must exist`);
    const j = JSON.parse(readFileSync(path, "utf-8"));
    assert.ok(j.mcpServers, ".mcp.json must have mcpServers");
    const names = Object.keys(j.mcpServers);
    assert.deepEqual(names, ["pi-subagent"]);
    const srv = j.mcpServers["pi-subagent"];
    assert.equal(srv.command, "node");
    assert.ok(Array.isArray(srv.args));
    const argStr = srv.args.join(" ");
    assert.match(argStr, /mcp\/server\.js/);
  });
});
```

(The existing `import` block at the top of `test/plugin-mcp.test.ts` already covers `existsSync`, `readFileSync`, `join`, `dirname`, and `fileURLToPath` — drop the duplicate import lines if they collide.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:plugin`
Expected: FAIL — both new tests report missing files.

- [ ] **Step 3: Write `.claude-plugin/plugin.json`**

Create `pi-extension/subagents/plugin/.claude-plugin/plugin.json`:

```json
{
  "name": "pi-subagent",
  "version": "1.0.0",
  "description": "Bundled plugin for pi-spawned Claude pane subagents — provides the Stop hook for transcript surfacing and the subagent_done MCP tool for explicit completion signaling."
}
```

- [ ] **Step 4: Write `.mcp.json`**

Create `pi-extension/subagents/plugin/.mcp.json`:

```json
{
  "mcpServers": {
    "pi-subagent": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/server.js"]
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` is Claude's plugin-config substitution variable, the same one already used by `hooks/hooks.json` (`${CLAUDE_PLUGIN_ROOT}/hooks/on-stop.sh`). It resolves to the directory passed via `--plugin-dir` at runtime.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:plugin`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add pi-extension/subagents/plugin/.claude-plugin/plugin.json pi-extension/subagents/plugin/.mcp.json test/plugin-mcp.test.ts
git commit -m "feat(plugin): add plugin manifest and .mcp.json for pi-subagent"
```

---

## Task 4: Slim the Stop hook (TDD)

**Files:**
- Modify: `pi-extension/subagents/plugin/hooks/on-stop.sh`
- Create: `test/plugin-stop-hook.test.ts`

The hook's sole remaining responsibility is to write the transcript path to `${PI_CLAUDE_SENTINEL}.transcript`. The user-msg-count completion signaling and the auto-exit env-var read are removed. Python is replaced with one-line Node JSON parsing (Node is already a hard plugin dependency now that the MCP server lives there).

- [ ] **Step 1: Write the failing tests**

Write `test/plugin-stop-hook.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "pi-extension", "subagents", "plugin", "hooks", "on-stop.sh");

function runHook(input: string, env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string> = { ...process.env } as any;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return spawnSync("bash", [HOOK], {
    input,
    env: merged,
    encoding: "utf-8",
  });
}

describe("plugin Stop hook", () => {
  let dir: string;
  before(() => { dir = mkdtempSync(join(tmpdir(), "pi-hook-")); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it("exits 0 and writes nothing when PI_CLAUDE_SENTINEL is unset", () => {
    const transcriptPath = join(dir, "fixt-no-env.jsonl");
    writeFileSync(transcriptPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    const sentinel = join(dir, "sentinel-no-env");
    const result = runHook(
      JSON.stringify({ transcript_path: transcriptPath, stop_hook_active: false }),
      { PI_CLAUDE_SENTINEL: undefined },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel), false);
    assert.equal(existsSync(sentinel + ".transcript"), false);
  });

  it("exits 0 immediately and writes nothing when stop_hook_active=true", () => {
    const transcriptPath = join(dir, "fixt-loop.jsonl");
    writeFileSync(transcriptPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    const sentinel = join(dir, "sentinel-loop");
    const result = runHook(
      JSON.stringify({ transcript_path: transcriptPath, stop_hook_active: true }),
      { PI_CLAUDE_SENTINEL: sentinel },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel + ".transcript"), false);
  });

  it("writes the transcript path to ${PI_CLAUDE_SENTINEL}.transcript on a valid input", () => {
    const transcriptPath = join(dir, "fixt-valid.jsonl");
    writeFileSync(transcriptPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    const sentinel = join(dir, "sentinel-valid");
    const result = runHook(
      JSON.stringify({ transcript_path: transcriptPath, stop_hook_active: false }),
      { PI_CLAUDE_SENTINEL: sentinel },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel + ".transcript"), true);
    assert.equal(readFileSync(sentinel + ".transcript", "utf-8").trim(), transcriptPath);
  });

  it("exits 0 and writes nothing when transcript_path is missing or nonexistent", () => {
    const sentinel = join(dir, "sentinel-no-transcript");
    const result = runHook(
      JSON.stringify({ stop_hook_active: false }),
      { PI_CLAUDE_SENTINEL: sentinel },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel + ".transcript"), false);
  });

  it("REGRESSION: a transcript with user_msg_count==1 must NOT cause the sentinel file to appear", () => {
    // This pins the original-bug fix. The deleted heuristic used to write the
    // sentinel file whenever exactly one human-content user message was in the
    // transcript — interpreting "no follow-ups yet" as "task done." Any
    // resurrection of that branch will fail this assertion.
    const transcriptPath = join(dir, "fixt-1user.jsonl");
    writeFileSync(
      transcriptPath,
      '{"type":"user","message":{"role":"user","content":"first turn"}}\n' +
        '{"type":"assistant","message":{"role":"assistant","content":"asking a clarifying question?"}}\n',
    );
    const sentinel = join(dir, "sentinel-1user");
    const result = runHook(
      JSON.stringify({
        transcript_path: transcriptPath,
        stop_hook_active: false,
        last_assistant_message: "asking a clarifying question?",
      }),
      { PI_CLAUDE_SENTINEL: sentinel },
    );
    assert.equal(result.status, 0);
    assert.equal(existsSync(sentinel), false,
      "sentinel must NOT appear after a single-user-turn transcript — that was the original bug");
    // The transcript pointer is still allowed (and expected) to be written.
    assert.equal(existsSync(sentinel + ".transcript"), true);
  });
});
```

- [ ] **Step 2: Append the new test file to the `test` script**

Edit `package.json`:

```json
    "test": "node --test test/test.ts test/system-prompt-mode.test.ts test/plugin-mcp.test.ts test/plugin-stop-hook.test.ts test/orchestration/*.test.ts",
```

(Insert `test/plugin-mcp.test.ts test/plugin-stop-hook.test.ts` after `test/system-prompt-mode.test.ts`.)

- [ ] **Step 3: Run the tests to verify the regression test fails**

Run: `npm test`
Expected: FAIL — the regression test (`user_msg_count==1`) fails because the current hook writes the sentinel for that case.

- [ ] **Step 4: Replace the Stop hook with the slim version**

Overwrite `pi-extension/subagents/plugin/hooks/on-stop.sh`:

```sh
#!/usr/bin/env bash
# Stop hook for pi-spawned Claude sessions.
# Sole responsibility: surface the transcript path to the watcher so it can
# archive the JSONL and resolve the Claude session id early. Completion
# signaling lives in the bundled MCP `subagent_done` tool.

set -euo pipefail

input=$(cat)

# Loop guard
stop_hook_active=$(printf '%s' "$input" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).stop_hook_active||false)))')
[ "$stop_hook_active" = "true" ] && exit 0

# Only act for pi-spawned sessions
[ -z "${PI_CLAUDE_SENTINEL:-}" ] && exit 0

# Surface the transcript path
transcript_path=$(printf '%s' "$input" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).transcript_path||""))')
[ -n "$transcript_path" ] && [ -f "$transcript_path" ] && \
  printf '%s\n' "$transcript_path" > "${PI_CLAUDE_SENTINEL}.transcript"

exit 0
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all 5 hook tests pass; the rest of the suite stays green.

- [ ] **Step 6: Commit**

```bash
git add pi-extension/subagents/plugin/hooks/on-stop.sh test/plugin-stop-hook.test.ts package.json
git commit -m "refactor(plugin): slim Stop hook to transcript surfacing only"
```

---

## Task 5: `buildClaudeCompletionAddendum` + `claudeCompletionAddendum` field on `ResolvedLaunchSpec`

**Files:**
- Modify: `pi-extension/subagents/launch-spec.ts`
- Create: `test/orchestration/pane-claude-completion-addendum.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `test/orchestration/pane-claude-completion-addendum.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeCompletionAddendum,
  resolveLaunchSpec,
} from "../../pi-extension/subagents/launch-spec.ts";

const baseCtx = {
  sessionManager: {
    getSessionFile: () => "/tmp/parent.jsonl",
    getSessionId: () => "sess-test",
    getSessionDir: () => "/tmp",
  } as any,
  cwd: "/tmp",
};

describe("buildClaudeCompletionAddendum", () => {
  it("returns the autonomous form for autoExit=true", () => {
    const text = buildClaudeCompletionAddendum(true);
    assert.match(text, /one-shot subagent/);
    assert.match(text, /without asking the user questions/);
    assert.match(text, /call `subagent_done`/);
  });

  it("returns the interactive form for autoExit=false", () => {
    const text = buildClaudeCompletionAddendum(false);
    assert.match(text, /interactive subagent/);
    assert.match(text, /ask clarifying questions/);
    assert.match(text, /call `subagent_done`/);
  });
});

describe("resolveLaunchSpec.claudeCompletionAddendum", () => {
  it("is populated with the autoExit=false form for cli=claude when no agent or auto-exit:false agent", () => {
    const spec = resolveLaunchSpec(
      { name: "C", task: "do", cli: "claude" },
      baseCtx,
    );
    assert.ok(spec.claudeCompletionAddendum, "addendum must be populated for Claude pane path");
    assert.match(spec.claudeCompletionAddendum!, /interactive subagent/);
  });

  it("is populated with the autoExit=true form when agent declares auto-exit:true", () => {
    const spec = resolveLaunchSpec(
      { name: "C", task: "do", agent: "test-echo" }, // test-echo declares auto-exit: true
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    // test-echo also declares cli: pi by default — assert against the
    // autoExit value rather than the cli, then re-resolve with cli forced.
    const claudeSpec = resolveLaunchSpec(
      { name: "C", task: "do", agent: "test-echo", cli: "claude" },
      baseCtx,
      { agentSearchDirs: ["test/integration/agents"] },
    );
    assert.equal(claudeSpec.autoExit, true);
    assert.ok(claudeSpec.claudeCompletionAddendum);
    assert.match(claudeSpec.claudeCompletionAddendum!, /one-shot subagent/);
    void spec;
  });

  it("is null when effectiveCli is not 'claude'", () => {
    const spec = resolveLaunchSpec({ name: "P", task: "do", cli: "pi" }, baseCtx);
    assert.equal(spec.claudeCompletionAddendum, null);
  });

  it("is null when no cli is specified (defaults to pi)", () => {
    const spec = resolveLaunchSpec({ name: "P", task: "do" }, baseCtx);
    assert.equal(spec.effectiveCli, "pi");
    assert.equal(spec.claudeCompletionAddendum, null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/orchestration/pane-claude-completion-addendum.test.ts`
Expected: FAIL — `buildClaudeCompletionAddendum` is not exported and `claudeCompletionAddendum` is not a field on `ResolvedLaunchSpec`.

- [ ] **Step 3: Add `buildClaudeCompletionAddendum`**

Edit `pi-extension/subagents/launch-spec.ts`. Add after the `safeFileName` helper and before the `// ── Main entry point ──` banner:

```ts
/**
 * Build the Claude pane completion-instruction addendum that reaches Claude
 * via `--append-system-prompt`. The text varies on `autoExit` to set
 * expectations about user interaction. Both forms end with the same explicit
 * `subagent_done` instruction — that tool is the unified completion path on
 * the Claude pane backend (see docs/superpowers/specs/2026-04-26-claude-pane-interactive-subagents-design.md).
 */
export function buildClaudeCompletionAddendum(autoExit: boolean): string {
  if (autoExit) {
    return (
      "You are a one-shot subagent. Complete your task autonomously without " +
      "asking the user questions. When finished, your FINAL assistant message " +
      "should summarize what you accomplished, then call `subagent_done` to " +
      "end the session."
    );
  }
  return (
    "You are an interactive subagent. The user can type into this pane at any " +
    "time — feel free to ask clarifying questions as many times as needed. " +
    "When the task is complete, your FINAL assistant message should summarize " +
    "what you accomplished, then call `subagent_done` to end the session."
  );
}
```

- [ ] **Step 4: Add the field to `ResolvedLaunchSpec` and populate it**

In the same file, edit the `ResolvedLaunchSpec` interface to add the field (right after `autoExit: boolean;`):

```ts
  /**
   * Claude-only system-prompt addendum that ends with a `subagent_done`
   * instruction. Populated only on the Claude pane path (`effectiveCli ===
   * "claude"`); null on every other path. The pane launch site folds this
   * into the `identity` value passed to `buildClaudeCmdParts`.
   */
  claudeCompletionAddendum: string | null;
```

Then in the `resolveLaunchSpec` body, populate it inside the returned object literal. Add right after `autoExit: agentDefs?.autoExit === true,`:

```ts
    claudeCompletionAddendum:
      effectiveCli === "claude"
        ? buildClaudeCompletionAddendum(agentDefs?.autoExit === true)
        : null,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/orchestration/pane-claude-completion-addendum.test.ts`
Expected: PASS — all four assertions green.

- [ ] **Step 6: Run the full unit suite to verify no regression**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add pi-extension/subagents/launch-spec.ts test/orchestration/pane-claude-completion-addendum.test.ts
git commit -m "feat(launch-spec): add buildClaudeCompletionAddendum and claudeCompletionAddendum field"
```

---

## Task 6: Inject `mcp__pi-subagent__subagent_done` into Claude `--tools` (TDD)

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Create: `test/orchestration/pane-claude-mcp-tool-injection.test.ts`

This task implements the spec's "buildClaudeCmdParts always injects `mcp__pi-subagent__subagent_done` into the `--tools` allowlist whenever the flag is emitted" rule. When `effectiveTools` is unset (no `--tools` flag), Claude's default allowlist already permits MCP tools, so injection is unnecessary.

- [ ] **Step 1: Write the failing tests**

Write `test/orchestration/pane-claude-mcp-tool-injection.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCmdParts } from "../../pi-extension/subagents/index.ts";

const MCP_TOOL = "mcp__pi-subagent__subagent_done";

function getToolsArg(parts: string[]): string | null {
  const idx = parts.indexOf("--tools");
  if (idx < 0 || idx + 1 >= parts.length) return null;
  // shellEscape wraps args in single quotes; strip them for asserting on the list
  return parts[idx + 1].replace(/^'|'$/g, "");
}

describe("buildClaudeCmdParts injects subagent_done MCP tool into --tools", () => {
  it("includes mcp__pi-subagent__subagent_done alongside mapped builtins when --tools is emitted", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/sentinel-1",
      pluginDir: "/tmp/plugin",
      model: "sonnet",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      effectiveTools: "read, bash",
      task: "do",
    });
    const arg = getToolsArg(parts);
    assert.ok(arg, "--tools must be emitted when effectiveTools is set");
    const tools = new Set(arg!.split(","));
    assert.ok(tools.has("Read"), "expected mapped Read");
    assert.ok(tools.has("Bash"), "expected mapped Bash");
    assert.ok(tools.has(MCP_TOOL), `expected ${MCP_TOOL} to be injected`);
  });

  it("omits --tools entirely when effectiveTools is unset (Claude's default permits MCP tools)", () => {
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/sentinel-2",
      pluginDir: "/tmp/plugin",
      model: "sonnet",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do",
    });
    assert.equal(parts.includes("--tools"), false);
  });

  it("emits --tools with only the MCP tool when no builtins map (e.g. effectiveTools='unknown')", () => {
    // Today, an effectiveTools list with zero recognized builtins yields no
    // --tools flag. Spec change: lifecycle MCP tool MUST still be allowlisted
    // so the model can call subagent_done — emit --tools with just the MCP tool.
    const parts = buildClaudeCmdParts({
      sentinelFile: "/tmp/sentinel-3",
      pluginDir: "/tmp/plugin",
      model: "sonnet",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      effectiveTools: "unmapped-tool-name",
      task: "do",
    });
    const arg = getToolsArg(parts);
    assert.ok(arg, "--tools must still be emitted when an MCP tool needs allowlisting");
    assert.equal(arg, MCP_TOOL);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/orchestration/pane-claude-mcp-tool-injection.test.ts`
Expected: FAIL — neither injection nor MCP-only emission is implemented today.

- [ ] **Step 3: Modify `buildClaudeCmdParts`**

Edit `pi-extension/subagents/index.ts`. Locate the `--tools` block (lines ~562–574) and replace with:

```ts
  // The MCP tool `mcp__pi-subagent__subagent_done` is the unified completion
  // signal on the Claude pane backend. Whenever we emit a restrictive --tools
  // list, the MCP tool MUST be present alongside any mapped builtins so the
  // model can actually call it (symmetric to how resolvePiToolsArg always
  // reserves caller_ping,subagent_done on the pi path).
  const MCP_LIFECYCLE_TOOL = "mcp__pi-subagent__subagent_done";
  if (input.effectiveTools) {
    const claudeTools = new Set<string>();
    for (const tool of input.effectiveTools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)) {
      const mapped = PI_TO_CLAUDE_TOOLS[tool.toLowerCase()];
      if (mapped) claudeTools.add(mapped);
    }
    claudeTools.add(MCP_LIFECYCLE_TOOL);
    parts.push("--tools", shellEscape([...claudeTools].join(",")));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/orchestration/pane-claude-mcp-tool-injection.test.ts`
Expected: PASS — all three assertions green.

- [ ] **Step 5: Re-run the existing pane-claude-tool-restriction test to verify it still holds**

Run: `node --test test/integration/pane-claude-tool-restriction.test.ts`
Expected: PASS (it tests with `effectiveTools: "read"`; the addition of the MCP tool to the allowlist does not affect the test's assertion — Bash is still excluded — but verify the test still skips correctly when `claude` is not on PATH).

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add pi-extension/subagents/index.ts test/orchestration/pane-claude-mcp-tool-injection.test.ts
git commit -m "feat(claude-pane): always inject subagent_done MCP tool into --tools"
```

---

## Task 7: Fold `claudeCompletionAddendum` into Claude pane launch identity (TDD)

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Modify: `test/orchestration/pane-claude-completion-addendum.test.ts` (extend with launch-path assertions)

The Claude pane launch path currently passes `spec.identity` directly to `buildClaudeCmdParts.identity`. New behavior: combine `spec.identity` with `spec.claudeCompletionAddendum` so the addendum reaches Claude via `--append-system-prompt` even when `spec.identity` is null/empty.

Fold rule per spec:
- If `spec.identity` is non-empty: addendum is appended after a blank-line separator.
- If `spec.identity` is null/empty: addendum becomes the sole system-prompt content (the flag is still emitted).

- [ ] **Step 1: Add the failing launch-path tests**

Append to `test/orchestration/pane-claude-completion-addendum.test.ts`:

```ts
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchSubagent } from "../../pi-extension/subagents/index.ts";

async function captureClaudeLaunchScript(
  subagentParams: Record<string, unknown>,
): Promise<string> {
  const sessionDir = mkdtempSync(join(tmpdir(), "pane-addendum-"));
  const ctxCwd = mkdtempSync(join(tmpdir(), "pane-addendum-ctx-"));
  try {
    await launchSubagent(
      { cli: "claude", ...subagentParams } as any,
      {
        sessionManager: {
          getSessionFile: () => join(sessionDir, "parent.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => sessionDir,
        },
        cwd: ctxCwd,
      } as any,
      { surface: "pi-test-fake-surface" },
    ).catch(() => { /* mux dispatch fails harmlessly under fake surface */ });
    const scriptsRoot = join(sessionDir, "artifacts");
    const found: string[] = [];
    const walk = (d: string) => {
      let names: string[] = [];
      try { names = readdirSync(d); } catch { return; }
      for (const n of names) {
        const p = join(d, n);
        try {
          if (statSync(p).isDirectory()) walk(p);
          else if (n.endsWith(".sh")) found.push(p);
        } catch {}
      }
    };
    walk(scriptsRoot);
    assert.equal(found.length, 1, `expected one launch script, got ${found.join(", ")}`);
    return readFileSync(found[0], "utf-8");
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(ctxCwd, { recursive: true, force: true });
  }
}

describe("Claude pane launch folds claudeCompletionAddendum into the system prompt", () => {
  it("emits --append-system-prompt with the addendum when identity is null", async () => {
    const script = await captureClaudeLaunchScript({ name: "no-id", task: "hi" });
    const m = script.match(/--append-system-prompt '([^']+)'/);
    assert.ok(m, `expected --append-system-prompt in launch script:\n${script}`);
    assert.match(m![1], /interactive subagent/);
    assert.match(m![1], /call `subagent_done`/);
  });

  it("emits --append-system-prompt with identity then a blank-line separator then the addendum", async () => {
    const script = await captureClaudeLaunchScript({
      name: "with-id",
      task: "hi",
      systemPrompt: "You are Sherlock Holmes.",
    });
    const m = script.match(/--append-system-prompt '([^']+)'/);
    assert.ok(m, `expected --append-system-prompt in launch script:\n${script}`);
    const value = m![1];
    assert.match(value, /^You are Sherlock Holmes\./);
    assert.match(value, /interactive subagent/);
    // The identity must come BEFORE the addendum and there must be a blank-line separator.
    const idIdx = value.indexOf("You are Sherlock Holmes.");
    const addIdx = value.indexOf("interactive subagent");
    assert.ok(idIdx >= 0 && addIdx > idIdx);
    const between = value.slice(idIdx + "You are Sherlock Holmes.".length, addIdx);
    assert.match(between, /\n\s*\n/, "must have a blank-line separator between identity and addendum");
  });

  it("uses the autoExit=true wording when the agent declares auto-exit:true", async () => {
    const script = await captureClaudeLaunchScript({
      name: "auto",
      task: "hi",
      agent: "test-echo", // declares auto-exit: true in test/integration/agents/test-echo.md
    });
    const m = script.match(/--append-system-prompt '([^']+)'/);
    assert.ok(m);
    assert.match(m![1], /one-shot subagent/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/orchestration/pane-claude-completion-addendum.test.ts`
Expected: FAIL — the addendum is not yet folded into the launch identity.

- [ ] **Step 3: Modify the Claude pane launch path**

Edit `pi-extension/subagents/index.ts`. Locate the Claude branch in `launchSubagent` (around line 666) and modify the `buildClaudeCmdParts` call to fold the addendum into `identity`:

Replace the existing `identity: spec.identity,` line with:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/orchestration/pane-claude-completion-addendum.test.ts`
Expected: PASS — all assertions green.

- [ ] **Step 5: Re-run the full unit suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pi-extension/subagents/index.ts test/orchestration/pane-claude-completion-addendum.test.ts
git commit -m "feat(claude-pane): fold completion addendum into --append-system-prompt"
```

---

## Task 8: Watcher fallback — read transcript JSONL last assistant message (TDD)

**Files:**
- Modify: `pi-extension/subagents/index.ts`
- Create: `test/orchestration/pane-claude-transcript-fallback.test.ts`

When the sentinel file is empty (model called `subagent_done` with omitted/empty `message`), today's fallback chain skips straight to a screen-scrape of the pane. Spec adds a new step: extract the last assistant message from the archived transcript JSONL first.

Fallback chain after this task:
1. Sentinel file content (if non-empty).
2. **NEW:** last assistant message from the archived transcript JSONL.
3. Pane screen scrape.
4. Generic exit-code fallback string.

- [ ] **Step 1: Write the failing test**

Write `test/orchestration/pane-claude-transcript-fallback.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractLastAssistantMessage } from "../../pi-extension/subagents/index.ts";

describe("extractLastAssistantMessage", () => {
  it("returns the most recent assistant message text from a JSONL transcript", () => {
    const jsonl = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "first turn" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "more" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "final summary" } }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      }),
    ].join("\n");
    assert.equal(extractLastAssistantMessage(jsonl), "final summary");
  });

  it("handles assistant content as an array of text blocks", () => {
    const jsonl = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
      },
    });
    assert.equal(extractLastAssistantMessage(jsonl), "part one part two");
  });

  it("returns empty string when no assistant messages are present", () => {
    const jsonl = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });
    assert.equal(extractLastAssistantMessage(jsonl), "");
  });

  it("returns empty string for malformed input without throwing", () => {
    assert.equal(extractLastAssistantMessage("not json\n{also bad"), "");
    assert.equal(extractLastAssistantMessage(""), "");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/orchestration/pane-claude-transcript-fallback.test.ts`
Expected: FAIL — `extractLastAssistantMessage` is not exported.

- [ ] **Step 3: Add `extractLastAssistantMessage` to `index.ts`**

Edit `pi-extension/subagents/index.ts`. Add the helper near `copyClaudeSession` (around line 865):

```ts
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
      if (typeof content === "string") {
        last = content;
      } else if (Array.isArray(content)) {
        last = content
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("");
      }
    } catch { /* skip malformed line */ }
  }
  return last;
}
```

- [ ] **Step 4: Run the helper tests to verify they pass**

Run: `node --test test/orchestration/pane-claude-transcript-fallback.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the helper into `watchSubagent`'s fallback chain**

Edit `pi-extension/subagents/index.ts`. Locate the Claude summary-extraction block (lines ~948–967):

```ts
      let summary = "";

      if (running.sentinelFile) {
        try {
          summary = readFileSync(running.sentinelFile, "utf-8").trim();
        } catch {}
      }

      if (!summary) {
        summary = readScreen(surface, 200)
          .replace(/__SUBAGENT_DONE_\d+__/, "")
          .trimEnd();
      }
```

The transcript archival happens later in the function. To use the transcript JSONL in the fallback chain, hoist `copyClaudeSession` before the summary block. Replace the relevant section (the existing block that reads `summary`, then the block at lines ~969–981 that does archive + cleanup) with:

```ts
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
```

- [ ] **Step 6: Run the full unit suite to verify no regression**

Run: `npm test`
Expected: PASS — including any sentinel-roundtrip / transcript-discovery tests that exercise this code path.

- [ ] **Step 7: Commit**

```bash
git add pi-extension/subagents/index.ts test/orchestration/pane-claude-transcript-fallback.test.ts
git commit -m "feat(claude-pane): prefer transcript JSONL over screen scrape in summary fallback"
```

---

## Task 9: Adapt the existing claude-sentinel-roundtrip integration test

**Files:**
- Modify: `test/integration/claude-sentinel-roundtrip.test.ts`
- Create: `test/integration/agents/test-claude-autoexit.md`

The current single test launches a Claude subagent with `cli: "claude"` and no agent (so `auto-exit` defaults to false), instructing the model to "Reply with exactly: OK". Under the old design that worked because the user-msg-count==1 heuristic terminated the session after the first turn. Under the new design we must use the autonomous-with-MCP path: the model must call `subagent_done`. Use an `auto-exit: true` agent so the autonomous addendum is applied.

- [ ] **Step 1: Add a test agent fixture**

Write `test/integration/agents/test-claude-autoexit.md`:

```markdown
---
auto-exit: true
cli: claude
---

Echo agent for autoexit Claude pane integration tests. Complete autonomously, then call subagent_done.
```

- [ ] **Step 2: Update the test to use the new agent**

Edit `test/integration/claude-sentinel-roundtrip.test.ts`. Replace the `launchSubagent` call:

```ts
      const running = await launchSubagent(
        {
          name: "ClaudeRoundtrip",
          task: "Reply OK and call subagent_done with message='OK'.",
          agent: "test-claude-autoexit",
        },
        ctx,
      );
```

The `agent` field activates the `auto-exit: true` autonomous addendum, so the model receives an explicit instruction to call `subagent_done`. The assertion `result.summary && result.summary.trim().length > 0` continues to hold — under the new path it picks up the `subagent_done` message via the sentinel file (preferred) or the transcript-JSONL fallback.

- [ ] **Step 3: Build the plugin and run the test**

Run: `npm run build:plugin && npm run test:integration -- --test-name-pattern=claude-sentinel-roundtrip`
Expected: PASS (skipped if `claude` CLI is not on PATH or no mux backend is available — the existing skip gate is preserved).

- [ ] **Step 4: Plugin auto-load decision checkpoint**

This is the first live exercise of plugin-MCP auto-discovery. Confirm the model could actually invoke `mcp__pi-subagent__subagent_done` before continuing.

If `claude` is on PATH locally:
- Run: `npm run build:plugin && npm run test:integration -- --test-name-pattern=claude-sentinel-roundtrip`
- After the test, inspect `${env.dir}` (the test prints its tmpdir) — the archived transcript (`*.jsonl`) should contain a `tool_use` block with `name: "subagent_done"` and the sentinel file should contain the test's payload (`OK`).

Decide:
- **Auto-load worked** (sentinel populated, transcript shows the tool call): SKIP Task 10. Continue with Task 11.
- **Auto-load failed** (model hangs / aborts; transcript shows no `subagent_done` call; pane logs an "unknown tool" error): PROCEED to Task 10 to add the `--mcp-config` fallback before continuing.

If `claude` is not on PATH locally, the smoke test skips. In that case, defer the decision to the first CI run with Claude available; until then, assume auto-load works and proceed past Task 10.

- [ ] **Step 5: Commit**

```bash
git add test/integration/claude-sentinel-roundtrip.test.ts test/integration/agents/test-claude-autoexit.md
git commit -m "test(integration): adapt claude-sentinel-roundtrip to subagent_done MCP completion"
```

---

## Task 10 (CONDITIONAL): `--mcp-config` fallback when plugin auto-load is unreliable

**Execute only if Task 9 Step 4 detected plugin-MCP auto-load failure. Otherwise skip to Task 11.**

**Files:**
- Modify: `pi-extension/subagents/index.ts` (extend `buildClaudeCmdParts` and the Claude pane launch path)
- Create: `test/orchestration/pane-claude-mcp-config-fallback.test.ts`

The fallback writes a generated MCP config inside the session's artifact directory and emits `--mcp-config <path>` from `buildClaudeCmdParts`. The generated config is byte-for-byte equivalent to the bundled `.mcp.json`, except `${CLAUDE_PLUGIN_ROOT}` is resolved to the absolute plugin directory at write time so it does not depend on Claude's plugin-config substitution.

- [ ] **Step 1: Write the failing test**

Write `test/orchestration/pane-claude-mcp-config-fallback.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeCmdParts } from "../../pi-extension/subagents/index.ts";

describe("buildClaudeCmdParts emits --mcp-config when mcpConfigPath is set", () => {
  const dir = mkdtempSync(join(tmpdir(), "pane-mcp-cfg-"));
  it("includes --mcp-config <path> alongside --plugin-dir", () => {
    const cfgPath = join(dir, "mcp.json");
    const parts = buildClaudeCmdParts({
      sentinelFile: join(dir, "sentinel"),
      pluginDir: "/abs/plugin",
      mcpConfigPath: cfgPath,
      model: "sonnet",
      identity: undefined,
      systemPromptMode: undefined,
      resumeSessionId: undefined,
      effectiveThinking: undefined,
      task: "do",
    });
    const idx = parts.indexOf("--mcp-config");
    assert.ok(idx > 0, `--mcp-config must be emitted; parts=${parts.join(" ")}`);
    // shellEscape wraps the path in single quotes; strip them
    assert.equal(parts[idx + 1].replace(/^'|'$/g, ""), cfgPath);
  });
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/orchestration/pane-claude-mcp-config-fallback.test.ts`
Expected: FAIL — `mcpConfigPath` is not yet a recognized input.

- [ ] **Step 3: Extend `buildClaudeCmdParts`**

Edit `pi-extension/subagents/index.ts`. Add `mcpConfigPath?: string` to the `ClaudeCmdInputs` interface, and in `buildClaudeCmdParts`, after the existing `--plugin-dir` push, add:

```ts
  if (input.mcpConfigPath) {
    parts.push("--mcp-config", shellEscape(input.mcpConfigPath));
  }
```

- [ ] **Step 4: Wire generated-config writing into the Claude pane launch path**

In `launchSubagent`'s Claude branch, before constructing `cmdParts`, write the generated config alongside the launch script:

```ts
      // Plugin auto-load fallback: write a resolved MCP config inside the
      // session artifact dir and pass it explicitly. Without this, Claude
      // versions where plugin-MCP discovery is unreliable would fail to load
      // the pi-subagent server and `subagent_done` would be unavailable.
      const mcpConfigPath = join(artifactDir, `mcp-config-${name}.json`);
      writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            "pi-subagent": {
              command: "node",
              args: [join(pluginDir, "mcp", "server.js")],
            },
          },
        }, null, 2),
      );
```

Then pass `mcpConfigPath` into `buildClaudeCmdParts({ ..., mcpConfigPath })`.

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `node --test test/orchestration/pane-claude-mcp-config-fallback.test.ts`
Expected: PASS.

- [ ] **Step 6: Re-run the Task 9 integration smoke**

Run: `npm run build:plugin && npm run test:integration -- --test-name-pattern=claude-sentinel-roundtrip`
Expected: PASS — sentinel populated, transcript shows the `subagent_done` tool call. The fallback config makes the MCP server load even when plugin-MCP auto-discovery is broken.

- [ ] **Step 7: Commit**

```bash
git add pi-extension/subagents/index.ts test/orchestration/pane-claude-mcp-config-fallback.test.ts
git commit -m "feat(claude-pane): add --mcp-config fallback for unreliable plugin auto-load"
```

---

## Task 11: New pane integration tests (multi-turn + edge cases)

**Files:**
- Create: `test/integration/pane-claude-interactive.test.ts`
- Create: `test/integration/agents/test-claude-interactive.md`

These exercise the full path: pane creation → Claude launch → MCP tool call → watcher return. Gated by `CLAUDE_AVAILABLE && backends.length > 0` like the existing claude-sentinel-roundtrip.

- [ ] **Step 1: Add the interactive agent fixture**

Write `test/integration/agents/test-claude-interactive.md`:

```markdown
---
auto-exit: false
cli: claude
---

Interactive echo agent for pane integration tests. Stays alive across user turns until subagent_done is called.
```

- [ ] **Step 2: Write the failing tests**

Write `test/integration/pane-claude-interactive.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAvailableBackends, setBackend, restoreBackend,
  createTestEnv, cleanupTestEnv, sendCommand, sleep, waitForScreen,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";
import { launchSubagent, watchSubagent } from "../../pi-extension/subagents/index.ts";

const CLAUDE_AVAILABLE = (() => {
  try { execSync("which claude", { stdio: "pipe" }); return true; }
  catch { return false; }
})();
const PLUGIN_DIR = join(
  new URL("../../pi-extension/subagents/plugin", import.meta.url).pathname,
);
const PLUGIN_BUILT = existsSync(join(PLUGIN_DIR, "mcp", "server.js"));
const backends = getAvailableBackends();
const SHOULD_SKIP = !CLAUDE_AVAILABLE || !PLUGIN_BUILT || backends.length === 0;
if (SHOULD_SKIP) {
  console.log(`⚠️  pane-claude-interactive skipped: CLAUDE=${CLAUDE_AVAILABLE} PLUGIN_BUILT=${PLUGIN_BUILT} BACKENDS=${backends.length}`);
}

for (const backend of backends) {
  describe(`pane-claude-interactive [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 2 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    before(() => { prevMux = setBackend(backend); env = createTestEnv(backend); });
    after(() => { cleanupTestEnv(env); restoreBackend(prevMux); });

    function ctx() {
      return {
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "test-session",
          getSessionDir: () => env.dir,
        },
        cwd: env.dir,
      };
    }

    it("interactive: pane stays alive until model calls subagent_done", async () => {
      const running = await launchSubagent(
        {
          name: "interactive",
          agent: "test-claude-interactive",
          task:
            "Ask exactly one clarifying question that ends with the marker " +
            "'CLARIFY?' on its own line. After the user replies, call " +
            "subagent_done with message='all done'.",
        },
        ctx(),
      );
      env.surfaces.push(running.surface);

      // Wait for the first assistant turn to be observable in the pane (the
      // model must have asked its clarifying question). Anchored to the
      // explicit CLARIFY? marker so we don't depend on timing.
      await waitForScreen(running.surface, /CLARIFY\?/, 30_000);

      // Now — having seen a real first assistant turn — assert the sentinel
      // file is still absent. This pins the regression: the deleted
      // user_msg_count heuristic would have written it right after the first
      // assistant turn, so observing the turn first is what makes the
      // assertion meaningful.
      assert.equal(
        existsSync(running.sentinelFile!),
        false,
        "sentinel must not exist after the first assistant turn — the user_msg_count heuristic regressed",
      );

      // Send a turn-2 reply into the pane so the model can complete its task.
      sendCommand(running.surface, "yes please proceed");

      const result = await watchSubagent(running, new AbortController().signal);
      assert.equal(result.exitCode, 0, `exit code: ${result.exitCode}; summary: ${result.summary}`);
      assert.match(result.summary, /all done/, `expected 'all done' in summary, got: ${result.summary}`);
      assert.ok(result.transcriptPath, "transcriptPath must be populated");
      assert.equal(typeof (result as any).claudeSessionId, "string");
      assert.ok((result as any).claudeSessionId.length > 0, "claudeSessionId must be populated");
    });

    it("autonomous-with-MCP: agent that auto-exits completes via the same MCP path", async () => {
      const running = await launchSubagent(
        {
          name: "autonomous",
          agent: "test-claude-autoexit",
          task: "Reply with exactly: AUTO. Then call subagent_done with message='AUTO'.",
        },
        ctx(),
      );
      env.surfaces.push(running.surface);
      const result = await watchSubagent(running, new AbortController().signal);
      assert.equal(result.exitCode, 0);
      assert.match(result.summary, /AUTO/);
      assert.ok(result.transcriptPath, "transcriptPath must be populated");
      assert.equal(typeof (result as any).claudeSessionId, "string");
      assert.ok((result as any).claudeSessionId.length > 0);
    });

    it("autonomous-without-MCP regression: hangs until aborted (model forgot to call tool)", async () => {
      const running = await launchSubagent(
        {
          name: "no-mcp",
          agent: "test-claude-autoexit",
          // Explicit instruction NOT to call the tool — pins the documented
          // "model forgot ⇒ hang" behavior. We rely on the abort path to
          // unblock.
          task: "Reply with: STUCK. Do NOT call any tools, including subagent_done.",
        },
        ctx(),
      );
      env.surfaces.push(running.surface);
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 10_000).unref?.();
      const result = await watchSubagent(running, ctrl.signal);
      assert.equal(result.error, "cancelled");
      assert.equal(result.exitCode, 1);
    });

    it("cancellation mid-question: pane closes cleanly and BackendResult reflects abort", async () => {
      const running = await launchSubagent(
        {
          name: "cancel-mid",
          agent: "test-claude-interactive",
          task: "Ask many clarifying questions. Wait for the user between each. Never call subagent_done.",
        },
        ctx(),
      );
      env.surfaces.push(running.surface);
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 6_000).unref?.();
      const result = await watchSubagent(running, ctrl.signal);
      assert.equal(result.error, "cancelled");
    });

    it("user closes pane manually: watcher returns via __SUBAGENT_DONE__ marker", async () => {
      const running = await launchSubagent(
        {
          name: "user-exit",
          agent: "test-claude-interactive",
          task:
            "Greet the user with the marker 'READY' on its own line, then wait. " +
            "Do not call subagent_done.",
        },
        ctx(),
      );
      env.surfaces.push(running.surface);
      // Wait for the first assistant turn to be observable, then send /exit.
      // This is what makes "user closes during a live session" deterministic
      // — without it, /exit could land before Claude even started.
      void waitForScreen(running.surface, /READY/, 30_000).then(
        () => sendCommand(running.surface, "/exit"),
      );
      const result = await watchSubagent(running, new AbortController().signal);
      // Summary should be non-empty: either the transcript fallback picked
      // up the assistant's greeting, or the generic exit-code fallback fired.
      assert.ok(result.summary && result.summary.length > 0, "summary must be non-empty");
    });
  });
}
```

- [ ] **Step 3: Build the plugin and run the new test**

Run: `npm run build:plugin && node --test test/integration/pane-claude-interactive.test.ts`
Expected: tests pass when `claude` is on PATH and a mux backend is present, otherwise the suite reports skipped. If running locally without Claude, manually inspect that the skip gate fires.

- [ ] **Step 4: Commit**

```bash
git add test/integration/pane-claude-interactive.test.ts test/integration/agents/test-claude-interactive.md
git commit -m "test(integration): cover interactive Claude pane multi-turn and edge cases"
```

---

## Task 12: Real `runSerial` / `runParallel` orchestration coverage with `cli: claude`

**Files:**
- Create: `test/integration/orchestration-claude-pane-serial.test.ts`
- Create: `test/integration/orchestration-claude-pane-parallel.test.ts`

These tests exercise the full parent-facing path: `runSerial` / `runParallel` with `makeDefaultDeps(ctx)` (which selects the pane backend) dispatching `cli: claude, auto-exit: false` tasks. They pin the public `OrchestrationResult` payload — the same payload `subagent_run_serial` / `subagent_run_parallel` MCP handlers return to the parent — including `state`, `transcriptPath`, `sessionId`, and `sessionKey`.

Gated by `CLAUDE_AVAILABLE && PLUGIN_BUILT && backends.length > 0`, identical to the gate in Task 11.

- [ ] **Step 1: Write the failing serial test**

Write `test/integration/orchestration-claude-pane-serial.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getAvailableBackends, setBackend, restoreBackend,
  createTestEnv, cleanupTestEnv, sendCommand, waitForScreen,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";
import { runSerial } from "../../pi-extension/orchestration/run-serial.ts";
import { makeDefaultDeps } from "../../pi-extension/orchestration/default-deps.ts";

const CLAUDE_AVAILABLE = (() => {
  try { execSync("which claude", { stdio: "pipe" }); return true; }
  catch { return false; }
})();
const PLUGIN_BUILT = existsSync(
  join(new URL("../../pi-extension/subagents/plugin", import.meta.url).pathname, "mcp", "server.js"),
);
const backends = getAvailableBackends();
const SHOULD_SKIP = !CLAUDE_AVAILABLE || !PLUGIN_BUILT || backends.length === 0;
if (SHOULD_SKIP) {
  console.log(`⚠️  orchestration-claude-pane-serial skipped: CLAUDE=${CLAUDE_AVAILABLE} PLUGIN_BUILT=${PLUGIN_BUILT} BACKENDS=${backends.length}`);
}

for (const backend of backends) {
  describe(`orchestration-claude-pane-serial [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 3 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    before(() => { prevMux = setBackend(backend); env = createTestEnv(backend); });
    after(() => { cleanupTestEnv(env); restoreBackend(prevMux); });

    it("runSerial with cli=claude, auto-exit=false: parent-facing payload is fully populated", async () => {
      const deps = makeDefaultDeps({
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => env.dir,
        } as any,
        cwd: env.dir,
      });

      // Drive the multi-turn flow concurrently with runSerial: poll every 1s
      // for the assistant's clarifying-question marker, send a reply when we
      // see it, then let runSerial resolve when the model calls subagent_done.
      const driver = (async () => {
        // The pane handle isn't returned to us through runSerial; instead we
        // discover the Claude surface by inspecting env.surfaces (createTestEnv
        // tracks them). The pane-backend launches via cmux/tmux with a stable
        // surface naming pattern — wait for one to appear, then drive it.
        const findSurface = async (timeoutMs: number) => {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            if (env.surfaces.length > 0) return env.surfaces[env.surfaces.length - 1];
            await new Promise((r) => setTimeout(r, 250));
          }
          throw new Error("no Claude surface appeared within timeout");
        };
        const surface = await findSurface(20_000);
        await waitForScreen(surface, /CLARIFY\?/, 30_000);
        sendCommand(surface, "yes proceed");
      })();

      const out = await runSerial(
        [{
          agent: "test-claude-interactive",
          task:
            "Ask exactly one clarifying question that ends with the marker " +
            "'CLARIFY?' on its own line. After the user replies, call " +
            "subagent_done with message='SERIAL_DONE'.",
          cli: "claude",
        }],
        {},
        deps,
      );
      await driver.catch(() => { /* surface may have been torn down before driver finished */ });

      assert.equal(out.results.length, 1, "exactly one task result");
      assert.equal(out.isError, false);
      const r = out.results[0];

      // Parent-facing payload assertions (acceptance criteria from the spec).
      assert.equal(r.state, "completed", `state must be 'completed', got: ${r.state}`);
      assert.equal(r.exitCode, 0, `exitCode must be 0, got: ${r.exitCode}; finalMessage: ${r.finalMessage}`);
      assert.match(r.finalMessage, /SERIAL_DONE/, `finalMessage must contain SERIAL_DONE, got: ${r.finalMessage}`);
      assert.ok(r.transcriptPath, "transcriptPath must be populated");
      assert.ok(existsSync(r.transcriptPath!), `archived transcript must exist: ${r.transcriptPath}`);
      assert.equal(typeof r.sessionId, "string");
      assert.ok(r.sessionId!.length > 0, "sessionId must be populated for Claude-backed children");
      assert.equal(typeof r.sessionKey, "string");
      assert.ok(r.sessionKey!.length > 0, "sessionKey must be populated");
    });
  });
}
```

- [ ] **Step 2: Run the serial test to verify it fails (until the rest of the plan is implemented)**

Run: `npm run build:plugin && node --test test/integration/orchestration-claude-pane-serial.test.ts`
Expected: skipped if Claude is not on PATH; otherwise passes once Tasks 1–11 land. If you run this in isolation before Tasks 1–11, the test launches but the model has no `subagent_done` and the pane hangs — failing as expected for a TDD red.

- [ ] **Step 3: Write the failing parallel test**

Write `test/integration/orchestration-claude-pane-parallel.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getAvailableBackends, setBackend, restoreBackend,
  createTestEnv, cleanupTestEnv, sendCommand, waitForScreen,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";
import { runParallel } from "../../pi-extension/orchestration/run-parallel.ts";
import { makeDefaultDeps } from "../../pi-extension/orchestration/default-deps.ts";

const CLAUDE_AVAILABLE = (() => {
  try { execSync("which claude", { stdio: "pipe" }); return true; }
  catch { return false; }
})();
const PLUGIN_BUILT = existsSync(
  join(new URL("../../pi-extension/subagents/plugin", import.meta.url).pathname, "mcp", "server.js"),
);
const backends = getAvailableBackends();
const SHOULD_SKIP = !CLAUDE_AVAILABLE || !PLUGIN_BUILT || backends.length === 0;
if (SHOULD_SKIP) {
  console.log(`⚠️  orchestration-claude-pane-parallel skipped: CLAUDE=${CLAUDE_AVAILABLE} PLUGIN_BUILT=${PLUGIN_BUILT} BACKENDS=${backends.length}`);
}

for (const backend of backends) {
  describe(`orchestration-claude-pane-parallel [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 3 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    before(() => { prevMux = setBackend(backend); env = createTestEnv(backend); });
    after(() => { cleanupTestEnv(env); restoreBackend(prevMux); });

    it("runParallel with two cli=claude tasks: each child gets its own sessionKey + payload", async () => {
      const deps = makeDefaultDeps({
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => env.dir,
        } as any,
        cwd: env.dir,
      });

      // Drive both surfaces concurrently. Each pane will print 'CLARIFY-<name>?'
      // so we can disambiguate; we feed each its expected reply.
      const driveSurfaces = async () => {
        const seen = new Set<string>();
        const start = Date.now();
        while (seen.size < 2 && Date.now() - start < 60_000) {
          for (const surface of env.surfaces) {
            if (seen.has(surface)) continue;
            try {
              const screen = (await import("./harness.ts")).readScreen(surface, 200);
              const m = screen.match(/CLARIFY-(alpha|beta)\?/);
              if (m) {
                sendCommand(surface, `proceed-${m[1]}`);
                seen.add(surface);
              }
            } catch { /* surface may be transient */ }
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      };
      const driver = driveSurfaces();

      const out = await runParallel(
        [
          {
            name: "alpha", agent: "test-claude-interactive", cli: "claude",
            task:
              "Ask exactly one clarifying question that ends with the marker " +
              "'CLARIFY-alpha?' on its own line. After the user replies, call " +
              "subagent_done with message='PARA_ALPHA'.",
          },
          {
            name: "beta", agent: "test-claude-interactive", cli: "claude",
            task:
              "Ask exactly one clarifying question that ends with the marker " +
              "'CLARIFY-beta?' on its own line. After the user replies, call " +
              "subagent_done with message='PARA_BETA'.",
          },
        ],
        {},
        deps,
      );
      await driver.catch(() => {});

      assert.equal(out.results.length, 2);
      assert.equal(out.isError, false);
      const byName = Object.fromEntries(out.results.map((r) => [r.name, r]));
      for (const name of ["alpha", "beta"] as const) {
        const r = byName[name];
        assert.ok(r, `result for ${name} must exist`);
        assert.equal(r.state, "completed", `${name} state must be 'completed', got: ${r.state}`);
        assert.equal(r.exitCode, 0);
        assert.match(r.finalMessage, name === "alpha" ? /PARA_ALPHA/ : /PARA_BETA/);
        assert.ok(r.transcriptPath && existsSync(r.transcriptPath));
        assert.ok(typeof r.sessionId === "string" && r.sessionId.length > 0);
        assert.ok(typeof r.sessionKey === "string" && r.sessionKey.length > 0);
      }
      // sessionKey uniqueness — two children must not share a key.
      assert.notEqual(byName["alpha"].sessionKey, byName["beta"].sessionKey);
    });
  });
}
```

- [ ] **Step 4: Run the parallel test**

Run: `npm run build:plugin && node --test test/integration/orchestration-claude-pane-parallel.test.ts`
Expected: skipped without Claude; passes with Claude + a mux backend.

- [ ] **Step 5: Run the full unit suite as a regression check**

Run: `npm test`
Expected: PASS — the existing `test/orchestration/run-serial.test.ts` and `run-parallel.test.ts` (which use `fakeDeps`) keep passing as a pi-path regression guard.

- [ ] **Step 6: Commit**

```bash
git add test/integration/orchestration-claude-pane-serial.test.ts test/integration/orchestration-claude-pane-parallel.test.ts
git commit -m "test(integration): cover subagent_run_serial/parallel with cli=claude through orchestration"
```

---

## Task 13: Spec-designer-style end-to-end through the orchestration layer

**Files:**
- Create: `test/integration/orchestration-claude-pane-spec-designer-e2e.test.ts`
- Create: `test/integration/agents/test-claude-spec-designer.md`

The target workflow is `define-spec` dispatching `spec-designer` via `subagent_run_serial`. This test mirrors that path: a parent calls `runSerial` with a single `cli: claude, auto-exit: false` task, the model asks two clarifying questions, the test waits for each question (observable marker) before sending the corresponding answer, the model writes a SPEC.md, then calls `subagent_done` with a `SPEC_WRITTEN: <path>` summary. Asserts the parent's `OrchestrationResult` carries that summary in `finalMessage` plus a populated `state`/`transcriptPath`/`sessionId`/`sessionKey`.

- [ ] **Step 1: Add the spec-designer-style agent fixture**

Write `test/integration/agents/test-claude-spec-designer.md`:

```markdown
---
auto-exit: false
cli: claude
tools: read, write, edit
---

Spec-designer-style agent for end-to-end pane integration. Asks two clarifying questions, then writes a SPEC.md to the working directory and calls subagent_done with a `SPEC_WRITTEN: <abs path>` summary.
```

- [ ] **Step 2: Write the failing test**

Write `test/integration/orchestration-claude-pane-spec-designer-e2e.test.ts`:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAvailableBackends, setBackend, restoreBackend,
  createTestEnv, cleanupTestEnv, sendCommand, waitForScreen,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";
import { runSerial } from "../../pi-extension/orchestration/run-serial.ts";
import { makeDefaultDeps } from "../../pi-extension/orchestration/default-deps.ts";

const CLAUDE_AVAILABLE = (() => {
  try { execSync("which claude", { stdio: "pipe" }); return true; }
  catch { return false; }
})();
const PLUGIN_BUILT = existsSync(
  join(new URL("../../pi-extension/subagents/plugin", import.meta.url).pathname, "mcp", "server.js"),
);
const backends = getAvailableBackends();
const SHOULD_SKIP = !CLAUDE_AVAILABLE || !PLUGIN_BUILT || backends.length === 0;
if (SHOULD_SKIP) {
  console.log(`⚠️  orchestration-claude-pane-spec-designer-e2e skipped: CLAUDE=${CLAUDE_AVAILABLE} PLUGIN_BUILT=${PLUGIN_BUILT} BACKENDS=${backends.length}`);
}

for (const backend of backends) {
  describe(`orchestration-claude-pane-spec-designer-e2e [${backend}]`, { skip: SHOULD_SKIP, timeout: PI_TIMEOUT * 4 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;
    before(() => { prevMux = setBackend(backend); env = createTestEnv(backend); });
    after(() => { cleanupTestEnv(env); restoreBackend(prevMux); });

    it("dispatches through runSerial; observes Q1 then Q2; parent payload carries SPEC_WRITTEN", async () => {
      const SPEC_PATH = join(env.dir, "SPEC.md");
      const deps = makeDefaultDeps({
        sessionManager: {
          getSessionFile: () => join(env.dir, "session.jsonl"),
          getSessionId: () => "parent",
          getSessionDir: () => env.dir,
        } as any,
        cwd: env.dir,
      });

      const driver = (async () => {
        // Wait until the pane backend has launched the surface.
        const start = Date.now();
        while (env.surfaces.length === 0) {
          if (Date.now() - start > 20_000) throw new Error("no Claude surface appeared");
          await new Promise((r) => setTimeout(r, 250));
        }
        const surface = env.surfaces[env.surfaces.length - 1];

        // Wait for Q1 marker, then send answer 1.
        await waitForScreen(surface, /Q1\?/, 30_000);
        sendCommand(surface, "Use TypeScript and ES modules.");

        // Wait for Q2 marker, then send answer 2.
        await waitForScreen(surface, /Q2\?/, 30_000);
        sendCommand(surface, "Print 'hello world' to stdout.");
      })();

      const out = await runSerial(
        [{
          agent: "test-claude-spec-designer", cli: "claude",
          task:
            "Help me draft a SPEC.md for a hello-world Node script. Ask exactly " +
            "two clarifying questions: end the first one with the marker 'Q1?' " +
            "on its own line, end the second with 'Q2?' on its own line. After " +
            `both answers, write SPEC.md to ${SPEC_PATH}, then call ` +
            "subagent_done with message=`SPEC_WRITTEN: ${SPEC_PATH}`.",
        }],
        {},
        deps,
      );
      await driver.catch(() => {});

      assert.equal(out.results.length, 1);
      assert.equal(out.isError, false);
      const r = out.results[0];

      // Parent-facing payload assertions (acceptance criteria).
      assert.equal(r.state, "completed", `state must be 'completed', got: ${r.state}`);
      assert.equal(r.exitCode, 0, `exit ${r.exitCode}; finalMessage: ${r.finalMessage}`);
      assert.match(r.finalMessage, /SPEC_WRITTEN:/);
      assert.ok(r.transcriptPath && existsSync(r.transcriptPath), "archived transcript must exist");
      assert.ok(typeof r.sessionId === "string" && r.sessionId.length > 0);
      assert.ok(typeof r.sessionKey === "string" && r.sessionKey.length > 0);

      // Side-effect: the SPEC.md the model wrote must exist with non-empty content.
      assert.ok(existsSync(SPEC_PATH), "SPEC.md must have been written");
      assert.ok(readFileSync(SPEC_PATH, "utf-8").length > 0, "SPEC.md must be non-empty");
    });
  });
}
```

- [ ] **Step 3: Build and run**

Run: `npm run build:plugin && node --test test/integration/orchestration-claude-pane-spec-designer-e2e.test.ts`
Expected: PASS when Claude + a mux backend are available; skips otherwise.

- [ ] **Step 4: Commit**

```bash
git add test/integration/orchestration-claude-pane-spec-designer-e2e.test.ts test/integration/agents/test-claude-spec-designer.md
git commit -m "test(integration): spec-designer-style e2e through subagent_run_serial"
```

---

## Task 14: Final verification

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 2: Run the full unit suite**

Run: `npm test`
Expected: PASS — including the new `plugin-mcp`, `plugin-stop-hook`, `pane-claude-completion-addendum`, `pane-claude-mcp-tool-injection`, and `pane-claude-transcript-fallback` test files.

- [ ] **Step 3: Run the integration suite (expect skips on CI without claude)**

Run: `npm run test:integration`
Expected: passes locally where `claude` and a mux backend are available; gracefully skips otherwise.

- [ ] **Step 4: Manual exploratory check**

If `claude` is on PATH locally, run a one-liner sanity check via the new pane test:

Run: `npm run build:plugin && node --test test/integration/pane-claude-interactive.test.ts`
Expected: green for the interactive happy path; the autonomous-without-MCP regression test runs to its 10s abort.

- [ ] **Step 5: Source-TODO closure (optional, requires user approval)**

The source TODO at `.pi/todos/fca9feda.md` is outside the feature surface defined by the spec. Closing it is a repo-housekeeping step, not part of this plan's contract. **Skip this step unless the user explicitly asks for it.** If approved, run `git rm .pi/todos/fca9feda.md` and commit with `chore(todos): close interactive-claude-pane TODO (fca9feda)`.

---

## Self-Review Checklist (run before declaring done)

The following spec sections have explicit task coverage:

| Spec section | Task(s) |
|---|---|
| MCP server (`subagent_done` tool, atomic rename, env-var error) | Task 2 |
| Plugin manifests (`.claude-plugin/plugin.json` + `.mcp.json`) | Task 3 |
| Slim Stop hook (no user-msg-count, Node JSON parse, transcript-only) | Task 4 |
| `buildClaudeCompletionAddendum` + `claudeCompletionAddendum` field | Task 5 |
| `--tools` always includes `mcp__pi-subagent__subagent_done` | Task 6 |
| Identity-fold in Claude pane launch path | Task 7 |
| Watcher fallback chain upgrade (transcript JSONL before screen scrape) | Task 8 |
| Adapt existing claude-sentinel-roundtrip test + plugin-auto-load decision checkpoint | Task 9 |
| `--mcp-config` fallback (conditional on Task 9 outcome) | Task 10 |
| Pane integration tests (multi-turn, autonomous, hang, cancel, /exit) — observable turns + payload assertions | Task 11 |
| Real `subagent_run_serial` / `subagent_run_parallel` orchestration with `cli: claude` | Task 12 |
| Spec-designer e2e through `runSerial` (observable turns, parent-payload assertions) | Task 13 |
| Final typecheck / suite | Task 14 |

Items deliberately not addressed (per spec non-goals):
- Headless Claude backend changes (out of scope).
- `caller_ping` for Claude pane sessions (deferred to phase-2.5).
- Removing the vestigial `SubagentParams.interactive` field.
- Removing `PI_SUBAGENT_AUTO_EXIT` from the Pi launch path (its consumer `subagent-done.ts` still reads it on the pi child process). The spec line about removing it from "the Claude env" already holds today: the pane Claude branch in `index.ts:666–727` does not set this env var.
- Hard timeouts for "model forgot to call `subagent_done`" — design defers to abort + manual `/exit`.

Type / signature consistency to confirm before merge:
- `buildClaudeCompletionAddendum(autoExit: boolean): string` — same name in spec, plan, code.
- `claudeCompletionAddendum: string | null` — same field name across `ResolvedLaunchSpec`, tests, and the launch path.
- `extractLastAssistantMessage(jsonl: string): string` — exported from `index.ts`; used by the watcher fallback.
- MCP tool name string `mcp__pi-subagent__subagent_done` — appears identically in `buildClaudeCmdParts`, the tool injection test, and the spec.
- `mcpConfigPath?: string` (added in Task 10 only) — recognized by `ClaudeCmdInputs`, written by the Claude pane launch path, and asserted in `pane-claude-mcp-config-fallback.test.ts`.

Acceptance-criteria payload assertions (from spec "Acceptance criteria"):
- `finalMessage`, `exitCode`, `state`, `transcriptPath`, `sessionId`, `sessionKey` — all asserted in Task 12 (`runSerial` / `runParallel` integration tests) and Task 13 (`runSerial` spec-designer e2e).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-26-claude-pane-interactive-subagents-v2.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
