import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProjection,
  normalizeShell,
  requestsFromProjection,
  shellSchema,
} from "../dist/v2.js";
import { attentionOf } from "../dist/model.js";
import { T3Client } from "../dist/client.js";
import { T3Rpc } from "../dist/rpc.js";
import { registerPhase1 } from "../dist/tools/phase1.js";
import { registerPhase2 } from "../dist/tools/phase2.js";
import { registerPhase3 } from "../dist/tools/phase3.js";
import { sleep } from "../dist/wait.js";

const now = "2026-10-29T12:00:00.000Z";
const thread = {
  id: "t",
  projectId: "p",
  title: "fixture",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  runtimeMode: "approval-required",
  interactionMode: "default",
  modelSelection: {
    instanceId: "codex",
    model: "test",
    options: [{ id: "reasoningEffort", value: "low" }],
  },
};
const run = (id, status, ordinal = 1) => ({
  id,
  threadId: "t",
  ordinal,
  userMessageId: `m-${id}`,
  status,
  requestedAt: now,
  startedAt: now,
  completedAt: status === "completed" ? now : null,
});
const item = (id, type, runId = "r", extra = {}) => ({
  id,
  type,
  runId,
  ordinal: 1,
  updatedAt: now,
  startedAt: now,
  completedAt: now,
  ...extra,
});
const projection = (extra = {}) => ({
  thread,
  runs: [run("r", "completed")],
  providerSessions: [],
  nodes: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  visibleTurnItems: [],
  ...extra,
});
const visible = (item, position) => ({
  item,
  position,
  sourceThreadId: "t",
  sourceItemId: item.id,
});
function tools(client) {
  const handlers = new Map();
  const server = {
    registerTool(name, definition, handler) {
      handlers.set(name, handler);
    },
  };
  for (const register of [registerPhase1, registerPhase2, registerPhase3])
    register(server, () => client);
  return handlers;
}
const value = (result) => JSON.parse(result.content[0].text);
const extra = () => ({ signal: new AbortController().signal });

test("v2 schemas reject wrong protocol and preserve model options", () => {
  const raw = shellSchema.parse({
    schemaVersion: 2,
    snapshotSequence: 1,
    projects: [{ id: "p", title: "p", workspaceRoot: "/tmp" }],
    threads: [thread],
  });
  assert.deepEqual(
    raw.threads[0].modelSelection.options,
    thread.modelSelection.options,
  );
  assert.throws(() => shellSchema.parse({ ...raw, schemaVersion: 1 }));
});
test("all run states normalize attention", () => {
  for (const [status, expected] of Object.entries({
    preparing: "working",
    queued: "working",
    starting: "working",
    running: "working",
    waiting: "working",
    completed: "done",
    interrupted: "done",
    failed: "error",
    cancelled: "done",
    rolled_back: "done",
    idle: "idle",
  })) {
    assert.equal(
      attentionOf(
        normalizeShell({
          ...thread,
          status,
          latestRunId: status === "idle" ? null : "r",
        }),
      ),
      expected,
      status,
    );
  }
  assert.equal(
    attentionOf(
      normalizeShell({
        ...thread,
        status: "running",
        pendingRuntimeRequest: { id: "q", kind: "user_input" },
      }),
    ),
    "needs-input",
  );
  assert.equal(
    attentionOf(
      normalizeShell({
        ...thread,
        status: "waiting",
        pendingRuntimeRequest: { id: "q", kind: "permission" },
      }),
    ),
    "needs-approval",
  );
});
test("canonical visible timeline orders messages without duplication or reasoning leakage", () => {
  const p = projection({
    messages: [{ id: "duplicate", text: "must not render" }],
    visibleTurnItems: [
      visible(
        item("a", "assistant_message", "r", {
          messageId: "a",
          text: "answer",
          streaming: false,
        }),
        2,
      ),
      visible(
        item("u", "user_message", "r", { messageId: "u", text: "question" }),
        0,
      ),
      visible(item("internal", "reasoning", "r", { text: "hidden" }), 1),
    ],
  });
  const t = normalizeProjection(p);
  assert.deepEqual(
    t.messages.map((m) => m.text),
    ["question", "answer"],
  );
  assert.equal(t.messages[1].turnId, "r");
});
test("pending requests are authoritative even when their timeline item is absent", () => {
  const q = {
    id: "q",
    nodeId: "n",
    kind: "user_input",
    status: "pending",
    createdAt: now,
    responseCapability: { type: "not_resumable", reason: "offline" },
  };
  const p = projection({
    runtimeRequests: [q, { ...q, id: "old", status: "resolved" }],
  });
  const requests = requestsFromProjection(p);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].detail.detailUnavailable, true);
  assert.equal(requests[0].responseCapability.type, "not_resumable");
});
test("mutations use v2 commands and reject stale/wrong/non-resumable requests", async () => {
  const client = new T3Client("http://unused", "unused");
  const commands = [];
  client.command = async (command) => {
    commands.push(command);
    return { sequence: 1 };
  };
  const q = {
    id: "q",
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "live" },
  };
  client.projection = async () => projection({ runtimeRequests: [q] });
  await client.dispatch({
    type: "thread.user-input.respond",
    threadId: "t",
    requestId: "q",
    commandId: "c",
    answers: { q1: "yes" },
  });
  assert.equal(commands[0].type, "runtime-request.respond");
  await assert.rejects(
    client.dispatch({
      type: "thread.approval.respond",
      threadId: "t",
      requestId: "q",
    }),
    /kind/,
  );
  q.status = "resolved";
  await assert.rejects(
    client.dispatch({
      type: "thread.user-input.respond",
      threadId: "t",
      requestId: "q",
    }),
    /pending/,
  );
  q.status = "pending";
  q.responseCapability = { type: "not_resumable" };
  await assert.rejects(
    client.dispatch({
      type: "thread.user-input.respond",
      threadId: "t",
      requestId: "q",
    }),
    /resumed/,
  );
  await client.dispatch({
    type: "thread.meta.update",
    threadId: "t",
    title: "new",
    createdAt: now,
  });
  assert.equal(commands.at(-1).type, "thread.metadata.update");
  assert.equal("createdAt" in commands.at(-1), false);
});
test("message dispatch preserves modes and queues without escalating permission", async () => {
  const client = new T3Client("http://unused", "unused");
  const commands = [];
  client.command = async (c) => {
    commands.push(c);
    return { sequence: 2 };
  };
  client.thread = async () => ({ thread: normalizeProjection(projection()) });
  client.projection = async () =>
    projection({ runs: [{ ...run("new", "queued"), userMessageId: "m" }] });
  const result = await client.dispatch({
    type: "thread.turn.start",
    commandId: "c",
    threadId: "t",
    message: { messageId: "m", text: "hello", attachments: [] },
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, "message.dispatch");
  assert.deepEqual(commands[0].dispatchMode, { type: "queue_after_active" });
  assert.equal(commands[0].createdBy, "user");
  assert.equal(result.runId, "new");
});
test("all 19 tools register; waits use run identity rather than latest reply", async () => {
  const p = projection({
    runs: [run("new", "completed", 2), run("old", "completed", 1)],
    visibleTurnItems: [
      visible(
        item("a1", "assistant_message", "old", {
          messageId: "a1",
          text: "old reply",
        }),
        0,
      ),
      visible(
        item("a2", "assistant_message", "new", {
          messageId: "a2",
          text: "new reply",
        }),
        1,
      ),
    ],
  });
  const handlers = tools({
    thread: async () => ({ thread: normalizeProjection(p) }),
  });
  assert.equal(handlers.size, 19);
  const result = value(
    await handlers.get("wait_for_turn")(
      { threadId: "t", runId: "old", timeoutSeconds: 5 },
      extra(),
    ),
  );
  assert.equal(result.reply.text, "old reply");
  assert.equal(result.runId, "old");
});
test("wait returns pending request for its target run", async () => {
  const request = {
    id: "q",
    nodeId: "n",
    kind: "user_input",
    status: "pending",
    createdAt: now,
    responseCapability: { type: "live" },
  };
  const p = projection({
    runs: [run("r", "waiting")],
    runtimeRequests: [request],
    visibleTurnItems: [
      visible(
        item("question", "user_input_request", "r", {
          requestId: "q",
          questions: [{ id: "q1" }],
        }),
        0,
      ),
    ],
  });
  const handlers = tools({
    thread: async () => ({ thread: normalizeProjection(p) }),
  });
  assert.equal(
    value(await handlers.get("wait_for_turn")({ threadId: "t" }, extra()))
      .outcome,
    "needs-you",
  );
});
test("poll sleeps cancel promptly", async () => {
  const c = new AbortController();
  const pending = sleep(30000, c.signal);
  c.abort();
  await assert.rejects(pending, /cancelled/);
});

test("Effect RPC correlates concurrent requests, handles failure and reconnects without retrying writes", async () => {
  const Original = globalThis.WebSocket;
  const sockets = [];
  class Fake extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    constructor(url) {
      super();
      this.url = url;
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
    reply(request, value) {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            _tag: "Exit",
            requestId: request.id,
            exit: { _tag: "Success", value },
          }),
        }),
      );
    }
  }
  globalThis.WebSocket = Fake;
  const rpc = new T3Rpc("http://localhost:3773", async () => "private-ticket");
  try {
    const a = rpc.call("read", {}),
      b = rpc.call("write", { commandId: "stable" });
    await new Promise((r) => setImmediate(r));
    const s = sockets[0];
    assert.equal(s.sent.length, 2);
    assert.match(s.url.href, /orchestrationProtocol=2/);
    s.reply(s.sent[1], 2);
    s.reply(s.sent[0], 1);
    assert.deepEqual(await Promise.all([a, b]), [1, 2]);
    const lost = rpc.call("write", {});
    await new Promise((r) => setImmediate(r));
    s.close();
    await assert.rejects(lost, /outcome may be unknown/);
    assert.equal(sockets.length, 1);
    const next = rpc.call("read", {});
    await new Promise((r) => setImmediate(r));
    sockets[1].reply(sockets[1].sent[0], 3);
    assert.equal(await next, 3);
  } finally {
    rpc.close();
    globalThis.WebSocket = Original;
  }
});

test("HTTP reads use v2 headers and opaque history cursors without duplicating current messages", async () => {
  const original = globalThis.fetch;
  const calls = [];
  const p = projection({
    visibleTurnItems: [
      visible(
        item("new", "assistant_message", "r", {
          messageId: "new",
          text: "recent",
        }),
        2,
      ),
    ],
  });
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init]);
    const data = String(url).includes("/history?")
      ? {
          snapshotSequence: 1,
          items: [
            visible(
              item("old", "user_message", "old", {
                messageId: "old",
                text: "older",
              }),
              0,
            ),
          ],
          nextCursor: null,
          hasMoreHistory: false,
        }
      : String(url).includes("/bounded")
        ? {
            snapshotSequence: 2,
            projection: p,
            historyCursor: "opaque /?=cursor",
            hasMoreHistory: true,
          }
        : {
            schemaVersion: 2,
            snapshotSequence: 2,
            projects: [{ id: "p", title: "p", workspaceRoot: "/tmp" }],
            threads: [{ ...thread, status: "completed", latestRunId: "r" }],
            archivedThreads: [],
          };
    return Response.json(data);
  };
  try {
    const client = new T3Client("http://unused", "private-token");
    const recent = await client.thread("t");
    assert.equal(recent.page.beforeCursor, "opaque /?=cursor");
    assert.equal(recent.page.hasMore, true);
    const old = await client.thread("t", {
      beforeCursor: recent.page.beforeCursor,
    });
    assert.deepEqual(
      old.thread.messages.map((m) => m.text),
      ["older"],
    );
    assert.equal(old.page.hasMore, false);
    assert.ok(
      calls.every(
        ([, init]) => init.headers["x-t3-orchestration-protocol"] === "2",
      ),
    );
    assert.equal(
      new URL(
        calls.find(([url]) => url.includes("/history?"))[0],
      ).searchParams.get("cursor"),
      "opaque /?=cursor",
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("HTTP errors distinguish authentication, missing scope and protocol failure", async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, message] of [
      [401, /Authentication failed/],
      [403, /Insufficient token scope/],
      [400, /incompatible protocol/],
    ]) {
      globalThis.fetch = async () => new Response("", { status });
      await assert.rejects(
        new T3Client("http://unused", "unused").shell(),
        message,
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});
test("RPC rejects timeouts without automatically duplicating a command", async () => {
  const Original = globalThis.WebSocket;
  let sends = 0;
  class Fake extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor() {
      super();
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send() {
      sends++;
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = Fake;
  const rpc = new T3Rpc("http://unused", async () => "ticket");
  try {
    await assert.rejects(
      rpc.call("write", { commandId: "same" }, 10),
      /outcome may be unknown/,
    );
    assert.equal(sends, 1);
  } finally {
    rpc.close();
    globalThis.WebSocket = Original;
  }
});
