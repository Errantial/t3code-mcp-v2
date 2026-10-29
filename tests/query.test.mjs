import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeCursor,
  encodeCursor,
  filterThreads,
  pageFields,
  paginate,
} from "../dist/query.js";
import { normalizeShell } from "../dist/v2.js";

const now = Date.now();
const ago = (hours) => new Date(now - hours * 3_600_000).toISOString();
const base = {
  projectId: "p",
  createdAt: ago(100),
  updatedAt: ago(0),
  archivedAt: null,
  runtimeMode: "approval-required",
  interactionMode: "default",
  modelSelection: { instanceId: "codex", model: "test" },
};
const thread = (id, options = {}) =>
  normalizeShell({
    ...base,
    id,
    title: options.title ?? id,
    status: options.status ?? "completed",
    latestRunId: options.status === "idle" ? null : "r",
    latestRunCompletedAt: options.completedAt ?? ago(0),
    updatedAt: options.updatedAt ?? ago(0),
    archivedAt: options.archivedAt ?? null,
  });

test("thread windows default to active or recent non-archived threads", () => {
  const threads = [
    thread("working-old", { status: "running", updatedAt: ago(100) }),
    thread("done-recent", { status: "completed", updatedAt: ago(0.5) }),
    thread("done-old", { status: "completed", updatedAt: ago(100) }),
    thread("error-old", { status: "failed", updatedAt: ago(100) }),
    thread("error-recent", { status: "failed", updatedAt: ago(2) }),
    thread("archived-recent", {
      status: "completed",
      updatedAt: ago(1),
      archivedAt: ago(1),
    }),
  ];
  assert.deepEqual(
    filterThreads(threads).map((t) => t.id),
    ["working-old", "done-recent", "error-recent"],
  );
  assert.deepEqual(
    filterThreads(threads, { includeInactive: true }).map((t) => t.id),
    [
      "working-old",
      "done-recent",
      "done-old",
      "error-old",
      "error-recent",
    ],
  );
  assert.deepEqual(
    filterThreads(threads, {
      includeInactive: true,
      includeArchived: true,
    }).map((t) => t.id),
    [
      "working-old",
      "done-recent",
      "done-old",
      "error-old",
      "error-recent",
      "archived-recent",
    ],
  );
  assert.deepEqual(
    filterThreads(threads, { sinceHours: 1 }).map((t) => t.id),
    ["working-old", "done-recent"],
  );
});

test("offset cursors paginate stably and reject malformed values", () => {
  const values = Array.from({ length: 25 }, (_, index) => index);
  const first = paginate(values, 10);
  assert.deepEqual(first.items, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(first.total, 25);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, encodeCursor(10));
  const second = paginate(values, 10, first.nextCursor);
  assert.deepEqual(second.items, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(second.offset, 10);
  const third = paginate(values, 10, second.nextCursor);
  assert.deepEqual(third.items, [20, 21, 22, 23, 24]);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, null);
  assert.equal(decodeCursor(first.nextCursor), 10);
  assert.throws(() => decodeCursor("not-a-cursor"), /Invalid cursor/);
  assert.throws(() => paginate(values, 10, encodeCursor(99)), /Invalid cursor/);
  assert.deepEqual(pageFields(first), {
    shown: 10,
    matchedOf: 25,
    offset: 0,
    limit: 10,
    hasMore: true,
    nextCursor: first.nextCursor,
  });
});
