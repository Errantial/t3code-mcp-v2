import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Streamable-HTTP transport for remote (voice) clients, stateless mode:
 * each POST gets a fresh server+transport pair. Requires a bearer token.
 */
export function startHttp(opts: {
  makeServer: () => McpServer;
  port: number;
  host: string;
  token: string;
}) {
  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${opts.token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
          id: null,
        }),
      );
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Stateless server: POST only" },
          id: null,
        }),
      );
      return;
    }
    try {
      const body = await readBody(req);
      const server = opts.makeServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: `Internal error: ${(e as Error).message}` },
            id: null,
          }),
        );
      }
    }
  });
  httpServer.listen(opts.port, opts.host, () => {
    console.error(`t3code-mcp listening on http://${opts.host}:${opts.port}/ (streamable HTTP)`);
  });
  return httpServer;
}
