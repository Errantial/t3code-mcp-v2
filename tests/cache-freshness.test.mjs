import test from "node:test";
import assert from "node:assert/strict";
import { ThreadIndex } from "../dist/shell-cache.js";
import { T3Rpc } from "../dist/rpc.js";

const now = "2026-11-02T12:00:00.000Z";
const rawThread = (id) => ({
  id,
  projectId: "p",
  title: id,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  status: "completed",
  latestRunId: "r",
  latestRunCompletedAt: now,
  activeProviderThreadId: null,
  modelSelection: { instanceId: "opencode", model: "test" },
});
const rawShell = (ids, snapshotSequence = 10) => ({
  schemaVersion: 2,
  snapshotSequence,
  projects: [{ id: "p", title: "p", workspaceRoot: "/tmp" }],
  threads: ids.map(rawThread),
  archivedThreads: [],
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("live-but-silent stream still reloads once the snapshot exceeds maxAge", async () => {
  let loads = 0;
  let onItems;
  const ids = ["t1"];
  const index = new ThreadIndex(
    {
      loadActive: async () => {
        loads++;
        return rawShell([...ids]);
      },
      loadArchived: async () => rawShell([], 1),
      subscribe: async (_seq, callback) => {
        onItems = callback;
        return new Promise(() => {});
      },
    },
    60_000,
    { maxAgeMs: 40, watchdogMs: 0 },
  );
  try {
    assert.equal((await index.snapshot()).threads.length, 1);
    onItems([{ kind: "synchronized", sequence: 11 }]);
    assert.equal(index.stats().liveUpdates, true);
    // Stream goes quiet (stalled); T3 gains a thread the stream never reports.
    ids.push("t2");
    assert.equal((await index.snapshot()).threads.length, 1, "within maxAge: cached");
    assert.equal(loads, 1);
    await sleep(60);
    const after = await index.snapshot();
    assert.deepEqual(after.threads.map((t) => t.id).sort(), ["t1", "t2"]);
    assert.equal(loads, 2);
  } finally {
    index.close();
  }
});

test("watchdog restarts a silent subscription, aborts the old one, ignores its late items", async () => {
  const subscriptions = [];
  const index = new ThreadIndex(
    {
      loadActive: async () => rawShell(["t1"]),
      loadArchived: async () => rawShell([], 1),
      subscribe: async (afterSequence, callback, signal) => {
        subscriptions.push({ afterSequence, callback, signal });
        return new Promise(() => {});
      },
    },
    60_000,
    { maxAgeMs: 0, watchdogMs: 30 },
  );
  try {
    await index.snapshot();
    assert.equal(subscriptions.length, 1);
    await sleep(50);
    await index.snapshot(); // a read also runs the watchdog check
    assert.equal(subscriptions.length, 2);
    assert.equal(subscriptions[0].signal.aborted, true);
    assert.equal(subscriptions[1].signal.aborted, false);
    assert.equal(index.stats().streamRestarts, 1);
    // Late chunk from the abandoned stream must not mutate the index.
    subscriptions[0].callback([
      { kind: "thread.updated", sequence: 99, location: "active", thread: rawThread("ghost") },
    ]);
    assert.equal((await index.snapshot()).threads.some((t) => t.id === "ghost"), false);
    // The new stream keeps working, and activity keeps the watchdog quiet.
    subscriptions[1].callback([
      { kind: "thread.updated", sequence: 12, location: "active", thread: rawThread("t9") },
    ]);
    assert.equal((await index.snapshot()).threads.some((t) => t.id === "t9"), true);
    assert.equal(subscriptions.length, 2);
  } finally {
    index.close();
  }
});

test("watchdog timer fires without any reads", async () => {
  let subs = 0;
  const index = new ThreadIndex(
    {
      loadActive: async () => rawShell(["t1"]),
      loadArchived: async () => rawShell([], 1),
      subscribe: async () => {
        subs++;
        return new Promise(() => {});
      },
    },
    60_000,
    { maxAgeMs: 0, watchdogMs: 20 },
  );
  try {
    await index.snapshot();
    await sleep(120);
    assert.ok(subs >= 2, `expected a timer-driven restart, got ${subs}`);
  } finally {
    index.close();
  }
});

test("refreshUntil reloads until a just-launched thread is listed", async () => {
  let loads = 0;
  const index = new ThreadIndex(
    {
      loadActive: async () => {
        loads++;
        // First two loads race the projection and miss the new thread.
        return rawShell(loads <= 2 ? ["t1"] : ["t1", "new"]);
      },
      loadArchived: async () => rawShell([], 1),
      subscribe: async () => new Promise(() => {}),
    },
    60_000,
    { watchdogMs: 0 },
  );
  try {
    await index.snapshot();
    assert.equal(await index.refreshUntil("new", 4, 5), true);
    assert.equal(loads, 3);
    assert.ok((await index.snapshot()).threads.some((t) => t.id === "new"));
    assert.equal(await index.refreshUntil("never", 2, 1), false);
  } finally {
    index.close();
  }
});

test("aborting an RPC stream sends an Effect Interrupt frame", async () => {
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
    const abort = new AbortController();
    const done = rpc.stream("orchestration.subscribeShell", {}, () => {}, abort.signal);
    await new Promise((resolve) => setImmediate(resolve));
    const request = sockets[0].sent[0];
    abort.abort();
    await assert.rejects(done, /cancelled/);
    assert.deepEqual(sockets[0].sent[1], {
      _tag: "Interrupt",
      requestId: request.id,
      interruptors: [],
    });
  } finally {
    rpc.close();
    globalThis.WebSocket = Original;
  }
});
