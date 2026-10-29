import { z } from "zod";
import { discoverOrigin, loadToken, ConfigError } from "./config.js";
import type { ShellSnapshot, ThreadDetailSnapshot } from "./model.js";
import { canonicalThreadId, isProviderScopedThreadId } from "./model.js";
import { T3Rpc } from "./rpc.js";
import {
  boundedSchema,
  historySchema,
  normalizeItems,
  normalizeProjection,
  normalizeShell,
  projectionSchema,
  shellSchema,
} from "./v2.js";

export class T3Error extends Error {}
export interface EnvironmentInfo {
  environmentId: string;
  label: string;
  serverVersion: string;
  platform?: Record<string, unknown>;
}
export interface DispatchResult {
  sequence: number;
  runId?: string;
  messageId?: string;
}

export class T3Client {
  readonly rpc: T3Rpc;
  constructor(
    readonly origin: string,
    private readonly token: string,
  ) {
    this.rpc = new T3Rpc(origin, async () => {
      const result = z
        .object({ ticket: z.string() })
        .parse(
          await this.req("/api/auth/websocket-ticket", { method: "POST" }),
        );
      return result.ticket;
    });
  }
  private async req(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.origin}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          "x-t3-orchestration-protocol": "2",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch {
      if (init.signal?.aborted) throw new T3Error("MCP request cancelled");
      throw new T3Error(
        `T3 is unreachable at ${this.origin}. Check that T3 Code is running.`,
      );
    }
    if (!response.ok) {
      const category =
        response.status === 401
          ? "Authentication failed"
          : response.status === 403
            ? "Insufficient token scope"
            : response.status === 404
              ? "Resource or API not found"
              : response.status === 400 || response.status === 426
                ? "Invalid request or incompatible protocol"
                : "Server error";
      throw new T3Error(
        `${category}: ${path} returned HTTP ${response.status}. ${(await response.text()).slice(0, 1000)}`,
      );
    }
    return await response.json();
  }
  async authState() {
    return z
      .object({
        authenticated: z.boolean(),
        scopes: z.array(z.string()).optional(),
        permissions: z.array(z.string()).optional(),
      })
      .parse(await this.req("/api/auth/session"));
  }
  async commandReady() {
    await this.rpc.call("orchestration.getArchivedShellSnapshot", {});
    return true;
  }
  async probe(): Promise<EnvironmentInfo> {
    const response = await fetch(`${this.origin}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok)
      throw new T3Error(`T3 liveness probe returned HTTP ${response.status}`);
    return (await response.json()) as EnvironmentInfo;
  }
  async shell(
    includeArchived = false,
    signal?: AbortSignal,
  ): Promise<ShellSnapshot> {
    const raw = shellSchema.parse(
      await this.req("/api/orchestration/shell", { signal }),
    );
    let archived = raw.archivedThreads ?? [];
    if (includeArchived) {
      const archive = shellSchema.parse(
        await this.rpc.call("orchestration.getArchivedShellSnapshot", {}),
      );
      archived = archive.threads;
    }
    const all = new Map(
      [...raw.threads, ...archived].map((t) => [t.id, normalizeShell(t)]),
    );
    return {
      snapshotSequence: raw.snapshotSequence,
      projects: raw.projects,
      threads: [...all.values()],
      updatedAt: new Date().toISOString(),
    };
  }
  async projection(threadId: string) {
    return projectionSchema.parse(
      await this.rpc.call("orchestration.getThreadProjection", { threadId }),
    );
  }
  /** Resolve provider-scoped ids to the canonical T3 app-thread id. */
  async resolveThreadId(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const shell = await this.shell(false, signal);
    return canonicalThreadId(shell.threads, threadId);
  }
  async thread(
    threadId: string,
    opts: {
      turnLimit?: number;
      beforeCursor?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<ThreadDetailSnapshot> {
    // Read the shell first so provider session/thread ids passed by an older
    // caller can be resolved to the canonical app-thread id before any request.
    const shell = await this.shell(false, opts.signal);
    const resolvedId = canonicalThreadId(shell.threads, threadId);
    const path = `/api/orchestration/threads/${encodeURIComponent(resolvedId)}`;
    const raw = boundedSchema.parse(
      await this.req(`${path}/bounded`, { signal: opts.signal }),
    );
    // Shell state carries authoritative attention summaries not present on appThread.
    const thread = normalizeProjection(
      raw.projection,
      shell.threads.find((t) => t.id === resolvedId),
    );
    // Identity is the T3 app thread, even if a provider-scoped alias was used
    // or the projection echoed a provider thread id after a switch.
    thread.id = resolvedId;
    thread.session = thread.session
      ? { ...thread.session, threadId: resolvedId }
      : { threadId: resolvedId, status: "idle" };
    let cursor = raw.historyCursor;
    let hasMore = raw.hasMoreHistory;
    let sequence = raw.snapshotSequence;
    if (opts.beforeCursor) {
      const history = historySchema.parse(
        await this.req(
          `${path}/history?${new URLSearchParams({ cursor: opts.beforeCursor, view: "conversation" })}`,
          { signal: opts.signal },
        ),
      );
      Object.assign(
        thread,
        normalizeItems(
          history.items
            .sort((a, b) => a.position - b.position)
            .map((v) => v.item),
        ),
      );
      cursor = history.nextCursor;
      hasMore = history.hasMoreHistory;
      sequence = history.snapshotSequence;
    }
    // Keep the server's opaque cursor intact: trimming within a server page would
    // skip unreturned items on the next call. turnLimit is a best-effort hint in v2.
    return {
      snapshotSequence: sequence,
      thread,
      page: {
        beforeCursor: cursor,
        hasMore,
        turnLimitApplied: false,
        payloadBudgetExceeded: raw.payloadBudgetExceeded ?? false,
      },
    };
  }
  async runReply(threadId: string, runId: string) {
    const p = await this.projection(threadId);
    return normalizeProjection(p)
      .messages.slice()
      .reverse()
      .find(
        (m) => m.role === "assistant" && m.turnId === runId && !m.streaming,
      );
  }
  async command(command: Record<string, unknown>): Promise<DispatchResult> {
    return z
      .object({ sequence: z.number() })
      .parse(await this.rpc.call("orchestration.dispatchCommand", command));
  }
  async dispatch(old: Record<string, unknown>): Promise<DispatchResult> {
    const { createdAt: _createdAt, ...input } = old;
    let command = input;
    if (
      typeof command.threadId === "string" &&
      isProviderScopedThreadId(command.threadId)
    ) {
      const resolved = await this.resolveThreadId(command.threadId);
      if (resolved !== command.threadId)
        command = { ...command, threadId: resolved };
    }
    if (command.type === "thread.meta.update")
      command.type = "thread.metadata.update";
    if (command.type === "thread.turn.start") {
      const detail = await this.thread(String(command.threadId));
      const t = detail.thread;
      for (const [field, type] of [
        ["runtimeMode", "thread.runtime-mode.set"],
        ["interactionMode", "thread.interaction-mode.set"],
      ] as const) {
        if (command[field] !== undefined && command[field] !== t[field])
          await this.command({
            type,
            commandId: crypto.randomUUID(),
            threadId: t.id,
            [field]: command[field],
          });
      }
      const message = command.message as {
        messageId: string;
        text: string;
        attachments: unknown[];
      };
      // queue_after_active also starts immediately when idle, avoiding a read/write race.
      const result = await this.command({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "mcp",
        commandId: command.commandId,
        threadId: t.id,
        messageId: message.messageId,
        text: message.text,
        attachments: message.attachments,
        dispatchMode: { type: "queue_after_active" },
      });
      const p = await this.projection(t.id);
      return {
        ...result,
        messageId: message.messageId,
        runId: p.runs.find((r) => r.userMessageId === message.messageId)?.id,
      };
    }
    if (command.type === "thread.turn.interrupt") {
      const t = (await this.thread(String(command.threadId))).thread;
      const runId = command.runId ?? t.session?.activeTurnId;
      if (!runId) throw new T3Error("No active run to interrupt");
      return this.command({
        type: "run.interrupt",
        commandId: command.commandId,
        threadId: t.id,
        runId,
      });
    }
    if (command.type === "thread.session.stop") {
      const p = await this.projection(String(command.threadId));
      const live = p.providerSessions.filter((s) =>
        ["starting", "ready", "running", "waiting"].includes(String(s.status)),
      );
      if (!live.length) throw new T3Error("No live provider session to stop");
      let result: DispatchResult = { sequence: 0 };
      for (const session of live)
        result = await this.command({
          type: "provider-session.detach",
          commandId: crypto.randomUUID(),
          threadId: command.threadId,
          providerSessionId: session.id,
          reason: "Stopped through MCP stop_thread",
        });
      return result;
    }
    if (
      command.type === "thread.approval.respond" ||
      command.type === "thread.user-input.respond"
    ) {
      const p = await this.projection(String(command.threadId));
      const request = p.runtimeRequests.find((r) => r.id === command.requestId);
      if (!request || request.status !== "pending")
        throw new T3Error("Request is missing or no longer pending");
      const input = command.type === "thread.user-input.respond";
      if ((request.kind === "user_input") !== input)
        throw new T3Error("Request kind does not match this response tool");
      if (
        request.responseCapability.type !== "live" &&
        !(input && request.responseCapability.type === "message")
      )
        throw new T3Error(
          "Request cannot be resumed: " +
            String(
              request.responseCapability.reason ??
                request.responseCapability.type,
            ),
        );
      const item = [
        ...p.turnItems,
        ...p.visibleTurnItems.map((v) => v.item),
      ].find((i) => i.requestId === request.id);
      if (
        !input &&
        Array.isArray(item?.options) &&
        item.options.length &&
        !item.options.some(
          (o: unknown) =>
            typeof o === "object" &&
            o !== null &&
            "decision" in o &&
            o.decision === command.decision,
        )
      )
        throw new T3Error("Decision is not supported by this approval request");
      return this.command({ ...command, type: "runtime-request.respond" });
    }
    return this.command(command);
  }
  async launch(input: Record<string, unknown>) {
    const raw = z
      .object({
        threadId: z.string(),
        projection: projectionSchema,
        resumed: z.boolean(),
      })
      .parse(
        await this.rpc.call(
          "orchestration.launchThread",
          { creationSource: "mcp", ...input },
          60_000,
        ),
      );
    const run = raw.projection.runs
      .slice()
      .sort((a, b) => b.ordinal - a.ordinal)[0];
    return {
      threadId: raw.threadId,
      runId: run?.id,
      messageId: run?.userMessageId,
    };
  }
  close() {
    this.rpc.close();
  }
}
export function makeClient(): T3Client {
  return new T3Client(discoverOrigin(), loadToken());
}
export { ConfigError };
