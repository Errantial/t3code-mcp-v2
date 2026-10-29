import type { Attention, ThreadShell } from "./model.js";
import { attentionOf } from "./model.js";

/** Attention states that always count as active regardless of age. */
export const ACTIVE_ATTENTION: readonly Attention[] = [
  "needs-approval",
  "needs-input",
  "plan-ready",
  "working",
];

export const DEFAULT_SINCE_HOURS = 72;

export interface ThreadWindow {
  includeArchived?: boolean;
  /** Include old done/idle/error threads instead of only recent ones. */
  includeInactive?: boolean;
  sinceHours?: number;
  now?: number;
}

/**
 * Active-or-recent, non-archived by default. Archived threads and old
 * done/idle/error threads are explicit opt-ins.
 */
export function filterThreads(
  threads: ThreadShell[],
  options: ThreadWindow = {},
): ThreadShell[] {
  const sinceHours = options.sinceHours ?? DEFAULT_SINCE_HOURS;
  const cutoff = (options.now ?? Date.now()) - sinceHours * 3_600_000;
  return threads.filter((thread) => {
    if (!options.includeArchived && thread.archivedAt) return false;
    if (options.includeInactive) return true;
    if (ACTIVE_ATTENTION.includes(attentionOf(thread))) return true;
    return Date.parse(thread.updatedAt) >= cutoff;
  });
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
}

/** Opaque offset cursor. Cursors are intentionally small and versioned. */
export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset }), "utf8").toString(
    "base64url",
  );
}

export function decodeCursor(cursor: string): number {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid cursor");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { v?: unknown }).v !== 1 ||
    !Number.isInteger((value as { offset?: unknown }).offset) ||
    ((value as { offset: number }).offset as number) < 0
  )
    throw new Error("Invalid cursor");
  return (value as { offset: number }).offset;
}

export function paginate<T>(
  items: T[],
  limit: number,
  cursor?: string,
): Page<T> {
  const offset = cursor ? decodeCursor(cursor) : 0;
  if (offset > items.length) throw new Error("Invalid cursor");
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    total: items.length,
    offset,
    limit,
    hasMore: nextOffset < items.length,
    nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null,
  };
}

export function pageFields<T>(page: Page<T>) {
  return {
    shown: page.items.length,
    matchedOf: page.total,
    offset: page.offset,
    limit: page.limit,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}
