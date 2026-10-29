#!/usr/bin/env node
// Read-only live verification. Tokens and thread contents are never printed.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadHttpToken } from "../dist/config.js";
const url = new URL(process.argv[2] ?? "http://127.0.0.1:3774/");
const token = loadHttpToken();
if (!token) throw new Error("No MCP_HTTP_TOKEN: configure the server first");
for (const headers of [{}, { Authorization: "Bearer invalid-verification-token" }]) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  assert.equal(r.status, 401, "Unauthenticated/invalid-token request must return 401");
  await r.body?.cancel();
}
const client = new Client({ name: "v2-read-only-verification", version: "1" });
try {
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  assert.equal(client.getServerVersion()?.version, "0.2.0", "Expected the supplied v2 bridge build");
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 19);
  async function call(name, args = {}) {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name} failed: ${r.content?.[0]?.text}`);
    return JSON.parse(r.content[0].text);
  }
  const status = await call("t3_status");
  for (const key of ["running", "authOk", "readCompatible", "commandChannelReady", "canOperate"]) assert.equal(status[key], true, `t3_status.${key}`);
  assert.equal(status.orchestrationProtocol, 2);
  await call("list_projects");
  const threads = await call("list_threads", { limit: 1 });
  if (threads.threads.length) await call("get_thread", { threadId: threads.threads[0].threadId });
  console.log(JSON.stringify({ verified: true, endpoint: url.href, mcpVersion: client.getServerVersion()?.version, t3Version: status.serverVersion, tools: tools.tools.length, protocol: 2, authChecks: "passed", liveReads: "passed" }, null, 2));
} finally { await client.close(); }
