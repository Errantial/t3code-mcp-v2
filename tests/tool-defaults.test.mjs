import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShell } from "../dist/v2.js";
import { registerPhase1 } from "../dist/tools/phase1.js";
import { registerPhase2 } from "../dist/tools/phase2.js";
import { registerPhase3 } from "../dist/tools/phase3.js";

const now = Date.now();
const ago = (hours) => new Date(now - hours * 3_600_000).toISOString();
const base = {
  projectId: "p",
  createdAt: ago(100),
  runtimeMode: "approval-required",
  interactionMode: "default",
  modelSelection: { instanceId: "codex", model: "test" },
};
const rawThread = (id, options = {}) =>
  normalizeShell({
    ...base,
    id,
    title: options.title ?? `needle ${id}`,
    updatedAt: ago(options.updatedHours ?? 0),
    archivedAt: options.archivedHours === undefined ? null : ago(options.archivedHours),
    status: options.status ?? "completed",
    latestRunId: options.status === "idle" ? null : "r",
    latestRunCompletedAt: ago(options.updatedHours ?? 0),
    ...(options.pending
      ? { pendingRuntimeRequest: { id: options.pending, kind: "permission" } }
      : {}),
  });

const history = {
  recentDone: rawThread("recent-done", { status: "completed", updatedHours: 1 }),
  recentError: rawThread("recent-error", { status: "failed", updatedHours: 2 }),
  recentApproval: rawThread("recent-approval", {
    status: "waiting",
    updatedHours: 3,
    pending: "q1",
  }),
  oldWorking: rawThread("old-working", { status: "running", updatedHours: 100 }),
  oldDone: rawThread("old-done", { status: "completed", updatedHours: 100 }),
  oldError: rawThread("old-error", { status: "failed", updatedHours: 100 }),
  archivedRecent: rawThread("archived-recent", {
    status: "completed",
    updatedHours: 1,
    archivedHours: 1,
  }),
};
const all = Object.values(history);

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

function fakeClient() {
  const shellCalls = [];
  return {
    shellCalls,
    shell: async (includeArchived = false) => {
      shellCalls.push(includeArchived);
      return {
        snapshotSequence: 1,
        projects: [{ id: "p", title: "p", workspaceRoot: "/tmp" }],
        threads: all,
        updatedAt: ago(0),
      };
    },
    thread: async (threadId) => ({
      thread: {
        ...all.find((t) => t.id === threadId),
        pendingRequests: [],
        activities: [],
      },
    }),
    detail: async (threadId) => ({
      ...all.find((t) => t.id === threadId),
      pendingRequests: [],
      activities: [],
    }),
  };
}

test("list_threads defaults to active/recent non-archived and paginates", async () => {
  const client = fakeClient();
  const handlers = tools(client);
  const first = value(await handlers.get("list_threads")({ limit: 2 }));
  assert.deepEqual(
    first.threads.map((t) => t.threadId),
    ["recent-done", "recent-error"],
  );
  assert.equal(first.shown, 2);
  assert.equal(first.matchedOf, 4);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = value(
    await handlers.get("list_threads")({ limit: 2, cursor: first.nextCursor }),
  );
  assert.deepEqual(
    second.threads.map((t) => t.threadId),
    ["recent-approval", "old-working"],
  );
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(client.shellCalls, [false, false]);

  const allOld = value(
    await handlers.get("list_threads")({ includeInactive: true, limit: 50 }),
  );
  assert.equal(allOld.matchedOf, 6);
  const withArchived = value(
    await handlers.get("list_threads")({
      includeInactive: true,
      includeArchived: true,
      limit: 50,
    }),
  );
  assert.equal(withArchived.matchedOf, 7);
  assert.deepEqual(client.shellCalls, [false, false, false, true]);
});

test("search_threads defaults to active/recent non-archived and paginates", async () => {
  const client = fakeClient();
  const handlers = tools(client);
  const first = value(
    await handlers.get("search_threads")({ query: "needle", limit: 2 }),
  );
  assert.equal(first.matches, 4);
  assert.equal(first.threads.length, 2);
  assert.equal(first.hasMore, true);
  const second = value(
    await handlers.get("search_threads")({
      query: "needle",
      limit: 2,
      cursor: first.nextCursor,
    }),
  );
  assert.equal(second.threads.length, 2);
  assert.equal(second.hasMore, false);
  const allOld = value(
    await handlers.get("search_threads")({
      query: "needle",
      includeInactive: true,
      limit: 10,
    }),
  );
  assert.equal(allOld.matches, 6);
  const withArchived = value(
    await handlers.get("search_threads")({
      query: "needle",
      includeInactive: true,
      includeArchived: true,
      limit: 10,
    }),
  );
  assert.equal(withArchived.matches, 7);
  assert.deepEqual(client.shellCalls, [false, false, false, true]);
});

test("pending_actions excludes old errors unless asked", async () => {
  const client = fakeClient();
  const handlers = tools(client);
  const recent = value(await handlers.get("pending_actions")({}));
  assert.deepEqual(
    recent.items.map((i) => i.threadId),
    ["recent-error", "recent-approval"],
  );
  assert.equal(recent.needsAttention, 2);
  assert.deepEqual(
    value(await handlers.get("pending_actions")({ includeInactive: true })).items.map(
      (i) => i.threadId,
    ),
    ["recent-error", "recent-approval", "old-error"],
  );
});

test("workspace_digest excludes old done/error threads by default", async () => {
  const client = fakeClient();
  const handlers = tools(client);
  const recent = value(await handlers.get("workspace_digest")({}));
  assert.deepEqual(
    recent.threads.map((t) => t.threadId),
    ["recent-approval", "recent-error", "old-working", "recent-done"],
  );
  assert.equal(recent.matchedOf, 4);
  assert.doesNotMatch(recent.spoken, /old-error|old-done/);
  assert.equal(
    value(await handlers.get("workspace_digest")({ includeInactive: true }))
      .matchedOf,
    6,
  );
});
