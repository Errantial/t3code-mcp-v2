#!/usr/bin/env node
// Explicit live tests: use only a dedicated disposable project.
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const projectId = process.argv[2];
if (!projectId)
  throw new Error(
    "Usage: node scripts/integration.mjs <scratch-project-id> [http-url]",
  );
const http = process.argv[3];
const client = new Client({ name: "v2-integration", version: "1" });
let transport;
if (http) {
  const token = fs
    .readFileSync(new URL("../.env", import.meta.url), "utf8")
    .match(/^MCP_HTTP_TOKEN=(.*)$/m)[1];
  transport = new StreamableHTTPClientTransport(new URL(http), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
} else
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    stderr: "inherit",
  });
await client.connect(transport);
const created = [];
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 360000,
  });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
}
async function wait(t) {
  return call("wait_for_turn", {
    threadId: t.threadId,
    runId: t.runId,
    timeoutSeconds: 120,
  });
}
function ok(label) {
  console.log("ok", label);
}
async function create(message, mode = "default") {
  const t = await call("create_thread", {
    projectId,
    title: "MCP v2 integration (disposable)",
    message,
    runtimeMode: "approval-required",
    interactionMode: mode,
  });
  created.push(t.threadId);
  assert.ok(t.runId);
  return t;
}
try {
  const list = await client.listTools();
  assert.equal(list.tools.length, 19);
  ok("19 tools");
  const status = await call("t3_status");
  assert.equal(status.authOk, true);
  assert.equal(status.readCompatible, true);
  assert.equal(status.commandChannelReady, true);
  ok("status/read/RPC readiness");
  assert.ok(
    (await call("list_projects")).projects.some(
      (p) => p.projectId === projectId,
    ),
  );
  const t = await create("Reply exactly MCP-FIRST. Do not use any tools.");
  assert.match((await wait(t)).reply?.text ?? "", /MCP-FIRST/);
  ok("create and run-specific reply");
  const sent = await call("send_message", {
    threadId: t.threadId,
    message: "Reply exactly MCP-SECOND. Do not use any tools.",
  });
  assert.match(
    (await wait({ ...sent, threadId: t.threadId })).reply?.text ?? "",
    /MCP-SECOND/,
  );
  assert.match((await wait(t)).reply?.text ?? "", /MCP-FIRST/);
  ok("follow-up and old-run correlation");
  const detail = await call("get_thread", { threadId: t.threadId });
  assert.ok(detail.messages.length >= 4);
  assert.equal(detail.attention, "done");
  assert.ok(
    (await call("thread_digest", { threadId: t.threadId })).spoken.includes(
      "MCP-SECOND",
    ),
  );
  assert.equal(typeof (await call("workspace_digest")).spoken, "string");
  assert.ok(Array.isArray((await call("pending_actions")).items));
  ok("history and digests");
  const change = call("wait_for_change", { timeoutSeconds: 15 });
  await call("archive_thread", { threadId: t.threadId });
  assert.ok((await change).changed > 0);
  assert.ok(
    (
      await call("list_threads", {
        projectId,
        includeArchived: true,
        limit: 100,
      })
    ).threads.some((r) => r.threadId === t.threadId && r.archived),
  );
  await call("unarchive_thread", { threadId: t.threadId });
  await call("set_thread_title", {
    threadId: t.threadId,
    title: "MCP-v2-search-fixture",
  });
  assert.ok(
    (
      await call("search_threads", { query: "MCP-v2-search-fixture" })
    ).threads.some((r) => r.threadId === t.threadId),
  );
  ok("change/archive/unarchive/search/rename");
  // archiving detached the old provider session: first verify automatic restart.
  const restart = await call("send_message", {
    threadId: t.threadId,
    message: "Reply exactly MCP-RESTARTED. No tools.",
  });
  assert.match(
    (await wait({ ...restart, threadId: t.threadId })).reply?.text ?? "",
    /MCP-RESTARTED/,
  );
  await call("stop_thread", { threadId: t.threadId });
  ok("session restart and stop");
  const slow = await create(
    "For this disposable integration test, run the harmless shell command sleep 30, then reply MCP-SLOW.",
  );
  const queued = await call("send_message", {
    threadId: slow.threadId,
    message: "Reply exactly MCP-QUEUED. Do not use tools.",
  });
  assert.ok(queued.runId);
  assert.notEqual(queued.runId, slow.runId);
  await call("interrupt_thread", {
    threadId: slow.threadId,
    runId: slow.runId,
  });
  assert.equal((await wait(slow)).outcome, "interrupted");
  const queuedWait = await wait({ ...queued, threadId: slow.threadId });
  assert.match(queuedWait.reply?.text ?? "", /MCP-QUEUED/);
  ok("busy queue and interrupt");
  const q = await create(
    "Use request_user_input now to ask exactly one multiple-choice question: choose red or blue. After receiving the answer, reply exactly MCP-ANSWER followed by the chosen color. Do not ask the question as plain chat. This is a disposable question-flow integration test.",
    "plan",
  );
  const question = await wait(q);
  assert.equal(question.outcome, "needs-you");
  const request = question.pendingRequests.find((r) => r.kind === "user-input");
  assert.ok(request);
  const questions = request.detail.questions;
  assert.ok(questions?.length);
  const answers = Object.fromEntries(
    questions.map((q) => [q.id, { answers: ["blue"] }]),
  );
  await call("respond_to_user_input", {
    threadId: q.threadId,
    requestId: request.requestId,
    answers,
  });
  const answer = await wait(q);
  assert.equal(answer.outcome, "completed");
  assert.match(answer.reply?.text ?? "", /blue/i);
  ok("question and answer");
  await assert.rejects(
    call("respond_to_user_input", {
      threadId: q.threadId,
      requestId: request.requestId,
      answers,
    }),
    /pending/,
  );
  ok("stale response rejected");
  // Escalated printf is intentionally harmless; both approval decisions are exercised.
  for (const decision of ["decline", "accept"]) {
    const a = await create(
      'This is an approval integration test. Use exec_command to run cmd "printf MCP-APPROVAL", sandbox_permissions "require_escalated", justification "May I print the harmless approval test marker?". Request the approval even though this command is harmless. Do not use another command if declined; just reply DECLINED. After execution reply APPROVAL-DONE.',
    );
    const approval = await wait(a);
    assert.equal(approval.outcome, "needs-you");
    const request = approval.pendingRequests.find((r) => r.kind === "approval");
    assert.ok(request);
    await call("respond_to_approval", {
      threadId: a.threadId,
      requestId: request.requestId,
      decision,
    });
    const result = await wait(a);
    assert.equal(result.outcome, "completed");
    ok(`approval ${decision}`);
  }
  console.log("INTEGRATION: ALL PASSED");
} finally {
  for (const threadId of created) {
    try {
      await call("archive_thread", { threadId });
    } catch (e) {
      console.error("cleanup", threadId, e.message);
    }
  }
  await client.close();
}
