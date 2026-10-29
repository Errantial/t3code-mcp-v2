import { z } from "zod";
import type {
  Activity,
  Message,
  PendingRequest,
  ThreadDetail,
  ThreadShell,
} from "./model.js";

const base = z.object({ id: z.string() }).passthrough();
export const runSchema = base.extend({
  threadId: z.string(),
  ordinal: z.number(),
  userMessageId: z.string(),
  status: z.string(),
  requestedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type Run = z.infer<typeof runSchema>;
export const requestSchema = base.extend({
  nodeId: z.string(),
  kind: z.string(),
  status: z.string(),
  createdAt: z.string(),
  responseCapability: z.object({ type: z.string() }).passthrough(),
});
export const itemSchema = base.extend({
  type: z.string(),
  runId: z.string().nullable(),
  ordinal: z.number(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type Item = z.infer<typeof itemSchema>;
const visibleSchema = z
  .object({
    position: z.number(),
    sourceThreadId: z.string(),
    sourceItemId: z.string(),
    item: itemSchema,
  })
  .passthrough();
export const threadSchema = base.extend({
  projectId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  runtimeMode: z.string(),
  interactionMode: z.string(),
  providerInstanceId: z.string().optional(),
  providerInstanceHistory: z.array(z.string()).optional(),
  activeProviderThreadId: z.string().nullable().optional(),
  lineage: z
    .object({
      parentThreadId: z.string().nullable(),
      relationshipToParent: z.string().nullable(),
      rootThreadId: z.string(),
    })
    .passthrough()
    .nullable()
    .optional(),
  modelSelection: z
    .object({
      instanceId: z.string(),
      model: z.string(),
      options: z
        .union([
          z.record(z.unknown()),
          z.array(
            z
              .object({
                id: z.string(),
                value: z.union([z.string(), z.boolean()]),
              })
              .passthrough(),
          ),
        ])
        .optional(),
    })
    .passthrough(),
});
export const providerThreadSchema = base.extend({
  providerInstanceId: z.string().optional(),
  providerSessionId: z.string().nullable().optional(),
  appThreadId: z.string().nullable().optional(),
  status: z.string().optional(),
  updatedAt: z.string().optional(),
});
export const shellSchema = z.object({
  schemaVersion: z.literal(2),
  snapshotSequence: z.number(),
  projects: z.array(
    base.extend({ title: z.string(), workspaceRoot: z.string() }),
  ),
  threads: z.array(threadSchema),
  archivedThreads: z.array(threadSchema).optional(),
});
export type RawShellSnapshot = z.infer<typeof shellSchema>;
export type RawThreadShell = z.infer<typeof threadSchema>;
export const projectionSchema = z
  .object({
    thread: threadSchema,
    runs: z.array(runSchema),
    providerSessions: z.array(base),
    providerThreads: z.array(providerThreadSchema).default([]),
    nodes: z.array(base).default([]),
    runtimeRequests: z.array(requestSchema),
    messages: z.array(base),
    plans: z.array(base),
    turnItems: z.array(itemSchema).default([]),
    visibleTurnItems: z.array(visibleSchema),
  })
  .passthrough();
export type Projection = z.infer<typeof projectionSchema>;
export const boundedSchema = z.object({
  snapshotSequence: z.number(),
  projection: projectionSchema,
  historyCursor: z.string().nullable(),
  hasMoreHistory: z.boolean(),
  payloadBudgetExceeded: z.boolean().optional(),
});
export const historySchema = z.object({
  snapshotSequence: z.number(),
  items: z.array(visibleSchema),
  nextCursor: z.string().nullable(),
  hasMoreHistory: z.boolean(),
});

const state = (
  status: string,
): "running" | "completed" | "interrupted" | "error" =>
  ["failed"].includes(status)
    ? "error"
    : ["interrupted", "cancelled", "rolled_back"].includes(status)
      ? "interrupted"
      : status === "completed"
        ? "completed"
        : "running";

const ACTIVE_RUN_STATUSES: readonly string[] = [
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
];

/** T3 serializes some absent provider ids as the literal string "null". */
function optionalId(value: unknown): string | null {
  return typeof value === "string" && value && value !== "null" ? value : null;
}

export function normalizeShell(raw: z.infer<typeof threadSchema>): ThreadShell {
  const status = String(raw.activityRunStatus ?? raw.status ?? "idle");
  const pending = raw.pendingRuntimeRequest as
    { id: string; kind: string } | null | undefined;
  const latestId = raw.latestRunId as string | null | undefined;
  const providerInstanceId = (raw.providerInstanceId ??
    raw.modelSelection?.instanceId) as string | undefined;
  const activeProviderThreadId = optionalId(raw.activeProviderThreadId);
  return {
    ...raw,
    branch: raw.branch as string | null,
    worktreePath: raw.worktreePath as string | null,
    providerInstanceId,
    activeProviderThreadId,
    latestTurn: latestId
      ? {
          turnId: latestId,
          state: state(String(raw.status)),
          requestedAt: raw.latestRunRequestedAt as string,
          startedAt: raw.latestRunStartedAt as string,
          completedAt: raw.latestRunCompletedAt as string,
        }
      : null,
    session: {
      threadId: raw.id,
      status: ["preparing", "starting"].includes(status)
        ? "starting"
        : ["running", "waiting", "queued"].includes(status)
          ? "running"
          : status === "failed"
            ? "error"
            : "idle",
      providerInstanceId,
      providerName: providerInstanceId,
      providerThreadId: activeProviderThreadId,
      activeTurnId: raw.activeRunId as string | null,
      lastError: raw.lastError,
    },
    hasPendingApprovals: !!pending && pending.kind !== "user_input",
    hasPendingUserInput: pending?.kind === "user_input",
    hasActionableProposedPlan: raw.hasActionableProposedPlan === true,
    pendingRequestIds: pending ? [pending.id] : [],
    backgroundLiveness:
      Array.isArray(raw.pendingBackgroundTasks) &&
      raw.pendingBackgroundTasks.length
        ? "monitoring"
        : null,
  };
}

export function normalizeItems(items: Item[]): {
  messages: Message[];
  activities: Activity[];
} {
  const messages: Message[] = [],
    activities: Activity[] = [];
  for (const item of items) {
    const createdAt = item.startedAt ?? item.updatedAt;
    if (item.type === "user_message" || item.type === "assistant_message") {
      messages.push({
        id: String(item.messageId ?? item.id),
        role: item.type === "user_message" ? "user" : "assistant",
        text: String(item.text ?? ""),
        turnId: item.runId,
        streaming: item.streaming === true,
        createdAt,
        updatedAt: item.updatedAt,
      });
    } else {
      activities.push({
        id: item.id,
        tone: item.status === "failed" ? "error" : "tool",
        kind:
          item.type === "proposed_plan" ? "plan.proposed" : `tool.${item.type}`,
        summary: String(item.title ?? item.input ?? item.prompt ?? item.type),
        payload: item,
        turnId: item.runId,
        createdAt,
      });
    }
  }
  return { messages, activities };
}

export function requestsFromProjection(p: Projection): PendingRequest[] {
  const items = new Map(
    [...p.turnItems, ...p.visibleTurnItems.map((v) => v.item)]
      .filter((i) => typeof i.requestId === "string")
      .map((i) => [i.requestId, i]),
  );
  return p.runtimeRequests
    .filter(
      (r) =>
        r.status === "pending" &&
        [
          "user_input",
          "command",
          "file-read",
          "file-change",
          "mcp-elicitation",
          "permission",
        ].includes(r.kind),
    )
    .map((r) => {
      const item = items.get(r.id);
      return {
        requestId: r.id,
        kind: r.kind === "user_input" ? "user-input" : "approval",
        requestKind: r.kind,
        summary: item
          ? String(item.prompt ?? item.title ?? item.reason ?? r.kind)
          : r.kind,
        detail: item ?? { kind: r.kind, detailUnavailable: true },
        responseCapability: r.responseCapability,
        runId:
          item?.runId ??
          (p.nodes.find((n) => n.id === r.nodeId)?.runId as
            string | null | undefined),
        createdAt: r.createdAt,
      };
    });
}

export function normalizeProjection(
  p: Projection,
  shell?: ThreadShell,
): ThreadDetail {
  const runs = [...p.runs].sort((a, b) => b.ordinal - a.ordinal);
  const latest = runs[0];
  const active = runs.find((r) =>
    ["preparing", "starting", "running", "waiting"].includes(r.status),
  );
  const pending = requestsFromProjection(p);
  const items = p.visibleTurnItems
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((v) => v.item);
  const content = normalizeItems(items);
  // Provider threads/sessions are provider-scoped plumbing. They may be shared
  // across app threads and are never thread identity. Bind the current provider
  // thread to this app thread so a switch cannot leak another thread's status.
  const providerInstanceId = (p.thread.providerInstanceId ??
    p.thread.modelSelection.instanceId) as string;
  const activeProviderThreadId = optionalId(p.thread.activeProviderThreadId);
  const providerThreads = p.providerThreads ?? [];
  const boundProviderThread =
    providerThreads.find((pt) => pt.id === activeProviderThreadId) ??
    providerThreads.find((pt) => pt.appThreadId === p.thread.id);
  const providerSessionId =
    optionalId(boundProviderThread?.providerSessionId) ??
    optionalId(
      p.providerSessions
        .filter(
          (s) =>
            !s.providerInstanceId ||
            s.providerInstanceId === providerInstanceId,
        )
        .slice()
        .sort((a, b) =>
          String(a.updatedAt).localeCompare(String(b.updatedAt)),
        )
        .at(-1)?.id,
    );
  const providerSession =
    p.providerSessions.find((s) => s.id === providerSessionId) ??
    p.providerSessions
      .filter(
        (s) =>
          !s.providerInstanceId ||
          s.providerInstanceId === providerInstanceId,
      )
      .slice()
      .sort((a, b) =>
        String(a.updatedAt).localeCompare(String(b.updatedAt)),
      )
      .at(-1);
  const latestIsTerminal =
    !!latest && !ACTIVE_RUN_STATUSES.includes(latest.status);
  const sessionStatus = active
    ? ["preparing", "starting"].includes(active.status)
      ? "starting"
      : "running"
    : latest?.status === "failed"
      ? "error"
      : // The shell entry is per app thread; a provider session's status is
        // per provider instance and may describe a different thread entirely.
        (shell?.session?.status ??
        (latestIsTerminal
          ? "idle"
          : providerSession
            ? String(providerSession.status)
            : "idle"));
  return {
    ...normalizeShell(p.thread),
    ...shell,
    ...p.thread,
    // Identity is the T3 app thread, never a provider thread/session echo.
    id: shell?.id ?? p.thread.id,
    branch: p.thread.branch as string | null,
    worktreePath: p.thread.worktreePath as string | null,
    ...content,
    runs,
    pendingRequests: pending,
    latestTurn: latest
      ? {
          turnId: latest.id,
          state: state(latest.status),
          requestedAt: latest.requestedAt,
          startedAt: latest.startedAt,
          completedAt: latest.completedAt,
        }
      : null,
    session: {
      threadId: shell?.id ?? p.thread.id,
      status: sessionStatus as import("./model.js").Session["status"],
      activeTurnId: active?.id ?? null,
      providerInstanceId,
      providerName: providerInstanceId,
      providerThreadId: activeProviderThreadId ?? boundProviderThread?.id ?? null,
      providerSessionId,
      lastError:
        shell?.session?.lastError ??
        (latest?.status === "failed" ? providerSession?.lastError : undefined),
    },
    hasPendingApprovals: pending.some((r) => r.kind === "approval"),
    hasPendingUserInput: pending.some((r) => r.kind === "user-input"),
    pendingRequestIds: pending.map((r) => r.requestId),
  };
}
