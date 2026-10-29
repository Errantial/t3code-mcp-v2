#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeClient, type T3Client } from "./client.js";
import { loadHttpToken } from "./config.js";
import { registerPhase1 } from "./tools/phase1.js";
import { registerPhase2 } from "./tools/phase2.js";
import { registerPhase3 } from "./tools/phase3.js";
import { startHttp } from "./http.js";

const VERSION = "0.3.0";

let client: T3Client | undefined;
const getClient = () => (client ??= makeClient());

export function createServer(): McpServer {
  const server = new McpServer({ name: "t3code-mcp", version: VERSION });
  // Lazy so the MCP server starts (and t3_status can explain) even when T3 is down.
  registerPhase1(server, getClient);
  registerPhase2(server, getClient);
  registerPhase3(server, getClient);
  return server;
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `t3code-mcp ${VERSION} — MCP server for a running T3 Code instance

Usage:
  t3code-mcp                    stdio transport (for claude mcp add etc.)
  t3code-mcp --http [--port N] [--host H]
                                streamable HTTP transport for remote clients;
                                requires MCP_HTTP_TOKEN (bearer auth).
Env:
  T3_TOKEN        bearer token for the T3 server (required)
  T3_ORIGIN       override T3 server origin (default: ~/.t3/userdata/server-runtime.json)
  MCP_HTTP_TOKEN  bearer token clients must present in --http mode`,
    );
    return;
  }
  if (args.includes("--http")) {
    const token = loadHttpToken();
    if (!token) {
      console.error(
        "--http requires MCP_HTTP_TOKEN to be set (bearer auth for clients).",
      );
      process.exit(1);
    }
    const port = Number(argValue(args, "--port") ?? 3774);
    const host = argValue(args, "--host") ?? "127.0.0.1";
    startHttp({ makeServer: createServer, port, host, token });
    return;
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`t3code-mcp ${VERSION} ready on stdio`);
}

main().catch((e) => {
  console.error("t3code-mcp fatal:", e);
  process.exit(1);
});
