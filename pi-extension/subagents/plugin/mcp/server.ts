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
import { renameSync, writeFileSync } from "node:fs";

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
