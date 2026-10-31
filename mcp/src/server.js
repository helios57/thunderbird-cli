#!/usr/bin/env node

/**
 * thunderbird-cli MCP server
 *
 * Exposes Thunderbird email management as MCP tools for Claude Desktop and
 * other MCP-compatible clients. Communicates with the local bridge daemon
 * (default: 127.0.0.1:7700) which forwards to the Thunderbird WebExtension.
 *
 * Usage:
 *   tb-mcp                                # uses defaults
 *   TB_BRIDGE_HOST=host.docker.internal tb-mcp
 *
 * Add to Claude Desktop config (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "thunderbird": { "command": "tb-mcp" }
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createRequire } from "module";

import { api } from "./client.js";
import { tools } from "./tools.js";

const { version } = createRequire(import.meta.url)("../package.json");

// ─── Server setup ──────────────────────────────────────────────────

const server = new Server(
  {
    name: "thunderbird-cli",
    version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ─── Handlers ──────────────────────────────────────────────────────

// MCP tool annotations: let clients tell reading from changing. Hints only — the bridge
// policy (TB_BRIDGE_POLICY) is what actually enforces limits.
const ANNOTATIONS = {
  email_stats: { readOnlyHint: true },
  email_search: { readOnlyHint: true },
  email_recent: { readOnlyHint: true },
  email_identities: { readOnlyHint: true },
  email_list: { readOnlyHint: true },
  email_read: { readOnlyHint: true },
  email_thread: { readOnlyHint: true },
  email_attachments: { readOnlyHint: true },
  email_folders: { readOnlyHint: true },
  email_compose: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  email_reply: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  email_forward: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  email_mark: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  email_archive: { readOnlyHint: false, destructiveHint: true },
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations: annotations || ANNOTATIONS[name],
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = tools.find((t) => t.name === name);

  if (!tool) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }

  try {
    const result = await tool.handler(args || {}, api);
    // Compact JSON: indentation is ~25–40% of the characters in a message list and carries
    // nothing for a model.
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      ...(result && typeof result === "object" && "error" in result && Object.keys(result).length <= 2
        ? { isError: true }
        : {}),
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: err.message || String(err),
            code: err.code || "UNKNOWN",
          }),
        },
      ],
      isError: true,
    };
  }
});

// ─── Start ─────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr — stdout is reserved for MCP JSON-RPC protocol
  console.error(
    `[tb-mcp] thunderbird-cli MCP server running on stdio (${tools.length} tools)`
  );
}

main().catch((err) => {
  console.error("[tb-mcp] Fatal:", err);
  process.exit(1);
});
