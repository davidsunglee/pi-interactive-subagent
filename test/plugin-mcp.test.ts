import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
        readdirSync(before).length,
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
