import test from "node:test";
import assert from "node:assert/strict";
import { ThreadIndex } from "../dist/shell-cache.js";
import { T3Client } from "../dist/client.js";
import { T3Rpc } from "../dist/rpc.js";

const now = "2026-10-29T12:00:00.000Z";
const rawThread = (id, options = {}) => ({
  id,
  projectId: "p",
  title: options.title ?? id,
  createdAt: now,
  updatedAt: options.updatedAt ?? now,
  archivedAt: options.archivedAt ?? null,
  runtimeMode: "approval-required",
  interactionMode: "default",
  status: options.status ?? "completed",
  latestRunId: options.status === "idle" ? null : "r",
  latestRunCompletedAt: now,
  activeProviderThreadId: options.activeProviderThreadId ?? null,
  modelSelection: { instanceId: "codex", model: "test" },
});
const rawShell = (threads, snapshotSequence = 10) => ({
  schemaVersion: 2,
  snapshotSequence,
  projects: [{ id: "p", title: "p", workspaceRoot: "/tmp" }],
  threads,
  archivedThreads: [],
});

test("thread index loads once, applies stream deltas, and keeps archived opt-in", async () => {
  let activeLoads = 0;
  let archivedLoads = 0;
  let onItems;
  const index = new ThreadIndex(
    {
      loadActive: async () => {
        activeLoads++;
        return rawShell([rawThread("t1"), rawThread("t2")]);
      },
      loadArchived: async () => {
        archivedLoads++;
        return rawShell([rawThread("a1", { archivedAt: now })], 11);
      },
      subscribe: async (_afterSequence, callback) => {
        onItems = callback;
        return new Promise(() => {});
      },
    },
    60_000,
  );

  const first = await index.snapshot();
  const second = await index.snapshot();
  assert.deepEqual(
    first.threads.map((t) => t.id),
    ["t1", "t2"],
  );
  assert.deepEqual(
    second.threads.map((t) => t.id),
    ["t1", "t2"],
  );
  assert.equal(activeLoads, 1);
  assert.equal(archivedLoads, 0);

  onItems([
    {
      kind: "thread.updated",
      sequence: 11,
      location: "active",
      thread: rawThread("t1", { title: "renamed" }),
    },
  ]);
  const updated = await index.snapshot();
  assert.equal(updated.threads.find((t) => t.id === "t1").title, "renamed");
  assert.equal(activeLoads, 1);

  // T3 sends a delta snapshot (often empty) after an afterSequence subscribe;
  // it must merge with the seeded index rather than wipe it.
  onItems([
    {
      kind: "snapshot",
      snapshot: rawShell([], 12),
    },
  ]);
  assert.equal((await index.snapshot()).threads.length, 2);

  const withArchived = await index.snapshot(true);
  assert.equal(archivedLoads, 1);
  assert.deepEqual(
    withArchived.threads.map((t) => t.id),
    ["t1", "t2", "a1"],
  );

  onItems([
    {
      kind: "thread.updated",
      sequence: 12,
      location: "archive",
      thread: rawThread("t2", { archivedAt: now }),
    },
    { kind: "thread.removed", sequence: 13, threadId: "t1" },
  ]);
  const after = await index.snapshot(true);
  assert.deepEqual(
    after.threads.map((t) => t.id),
    ["a1", "t2"],
  );
  assert.equal(index.stats().liveUpdates, true);
});

test("thread index resolves provider-thread aliases without a second load", async () => {
  const index = new ThreadIndex(
    {
      loadActive: async () =>
        rawShell([
          rawThread("t", { activeProviderThreadId: "provider-thread:pt-1" }),
        ]),
      loadArchived: async () => rawShell([], 1),
      subscribe: async () => new Promise(() => {}),
    },
    60_000,
  );
  assert.equal(await index.resolveId("provider-thread:pt-1"), "t");
  assert.equal(await index.resolveId("unknown"), "unknown");
  assert.equal((await index.snapshot()).threads.length, 1);
});

test("single-thread reads do not fetch the shell; list reads are cached", async () => {
  const original = globalThis.fetch;
  let shellFetches = 0;
  let boundedFetches = 0;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/bounded")) {
      boundedFetches++;
      return Response.json({
        snapshotSequence: 1,
        projection: {
          thread: rawThread("t"),
          runs: [
            {
              id: "r",
              threadId: "t",
              ordinal: 1,
              userMessageId: "m",
              status: "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
            },
          ],
          providerSessions: [],
          providerThreads: [],
          nodes: [],
          runtimeRequests: [],
          messages: [],
          plans: [],
          turnItems: [],
          visibleTurnItems: [],
        },
        historyCursor: null,
        hasMoreHistory: false,
      });
    }
    if (value.includes("/api/orchestration/shell")) {
      shellFetches++;
      return Response.json({
        ...rawShell([rawThread("t")], 1),
        archivedThreads: [],
      });
    }
    throw new Error(`unexpected fetch ${value}`);
  };
  try {
    const client = new T3Client("http://unused", "token");
    client.rpc.stream = async () => new Promise(() => {});
    await client.thread("t");
    assert.equal(shellFetches, 0);
    assert.equal(boundedFetches, 1);
    await client.shell();
    await client.shell();
    assert.equal(shellFetches, 1);
    assert.equal(client.index.stats().activeThreads, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("Effect RPC delivers shell stream chunks and resolves on Exit", async () => {
  const Original = globalThis.WebSocket;
  const sockets = [];
  class Fake extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    constructor() {
      super();
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
  }
  globalThis.WebSocket = Fake;
  const rpc = new T3Rpc("http://unused", async () => "ticket");
  try {
    const chunks = [];
    const done = rpc.stream("orchestration.subscribeShell", {}, (values) =>
      chunks.push(...values),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const socket = sockets[0];
    assert.equal(socket.sent[0].tag, "orchestration.subscribeShell");
    const fire = (frame) =>
      socket.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(frame) }),
      );
    fire({
      _tag: "Chunk",
      requestId: socket.sent[0].id,
      values: [{ kind: "synchronized" }],
    });
    fire({
      _tag: "Chunk",
      requestId: socket.sent[0].id,
      values: [{ kind: "thread.updated", sequence: 2 }],
    });
    fire({
      _tag: "Exit",
      requestId: socket.sent[0].id,
      exit: { _tag: "Success", value: null },
    });
    await done;
    assert.deepEqual(
      chunks.map((chunk) => chunk.kind),
      ["synchronized", "thread.updated"],
    );
  } finally {
    rpc.close();
    globalThis.WebSocket = Original;
  }
});
