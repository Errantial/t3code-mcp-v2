import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { T3Client } from "../client.js";
import { attentionOf, newId, nowIso, threadRequests } from "../model.js";
import type { ThreadShell } from "../model.js";
import {
  errorResult,
  jsonResult,
  messageRow,
  relTime,
  threadRow,
  truncate,
} from "../format.js";
import {
  MAX_MESSAGE_CHARS_CEILING,
  MAX_MESSAGE_CHARS_ENV,
  MESSAGE_DEFAULTS,
  resolveMaxChars,
} from "../message.js";
import {
  DEFAULT_SINCE_HOURS,
  filterThreads,
  pageFields,
  paginate,
} from "../query.js";

import { sleep } from "../wait.js";
import { optionalInstructionsPrefix } from "../instructions.js";

function needsHuman(t: ThreadShell): boolean {
  const a = attentionOf(t);
  return (
    a === "needs-approval" ||
    a === "needs-input" ||
    a === "plan-ready" ||
    a === "error"
  );
}

export function registerPhase2(server: McpServer, getClient: () => T3Client) {
  server.registerTool(
    "pending_actions",
    {
      title: "What needs me?",
      description:
        "Cross-thread inbox: every active/recent thread currently blocked on the human — pending " +
        "command/file approvals (with the exact request detail), unanswered agent questions, " +
        "actionable proposed plans, and errored sessions. Old done/idle/error threads are excluded " +
        "by default; pass includeInactive to include them. Includes the requestIds needed by " +
        "respond_to_approval / respond_to_user_input. Use nextCursor to page.",
      inputSchema: {
        includeInactive: z
          .boolean()
          .optional()
          .describe("Include old errored/blocked threads (default false)"),
        sinceHours: z
          .number()
          .min(1)
          .max(720)
          .optional()
          .describe(
            `Recency window for old error threads (default ${DEFAULT_SINCE_HOURS}h)`,
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max rows (default 15)"),
        cursor: z
          .string()
          .optional()
          .describe("Opaque nextCursor from a previous pending_actions call"),
      },
    },
    async (args) => {
      try {
        const client = getClient();
        const shell = await client.shell();
        const projectsById = new Map(shell.projects.map((p) => [p.id, p]));
        const blocked = filterThreads(shell.threads, {
          includeInactive: args.includeInactive,
          sinceHours: args.sinceHours,
        })
          .filter(needsHuman)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        const page = paginate(blocked, args.limit ?? 15, args.cursor);
        const items = await Promise.all(
          page.items.map(async (t) => {
            const attention = attentionOf(t);
            const item: Record<string, unknown> = {
              threadId: t.id,
              title: t.title ?? "(untitled)",
              project: projectsById.get(t.projectId)?.title ?? t.projectId,
              attention,
              updated: relTime(t.updatedAt),
            };
            if (attention === "needs-approval" || attention === "needs-input") {
              try {
                const detail = await client.detail(t.id);
                item.requests = threadRequests(detail);
              } catch {
                item.requests = "unavailable";
              }
            }
            if (attention === "error") {
              item.lastError =
                t.session?.lastError ?? t.latestTurn?.state ?? null;
            }
            return item;
          }),
        );
        return jsonResult({
          needsAttention: page.total,
          ...pageFields(page),
          items,
          ...(page.total === 0 ? { note: "Nothing is waiting on you." } : {}),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "respond_to_approval",
    {
      title: "Respond to a permission request",
      description:
        "Approve or decline a pending permission request (command execution, file read, file " +
        "change) on a thread. Get the requestId from pending_actions or get_thread. Decisions: " +
        "accept (once), acceptForSession (don't ask again this session), decline, cancel.",
      inputSchema: {
        threadId: z.string(),
        requestId: z
          .string()
          .describe("From pendingRequests in pending_actions/get_thread"),
        decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
      },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.approval.respond",
          commandId: newId(),
          threadId: args.threadId,
          requestId: args.requestId,
          decision: args.decision,
          createdAt: nowIso(),
        });
        return jsonResult({
          responded: true,
          decision: args.decision,
          sequence: result.sequence,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "respond_to_user_input",
    {
      title: "Answer an agent's question",
      description:
        "Answer a pending user-input request (an agent asked a question with options or free " +
        "text). Get the requestId and the question structure from pending_actions or get_thread; " +
        "answers is an object keyed by question id.",
      inputSchema: {
        threadId: z.string(),
        requestId: z.string(),
        answers: z
          .record(z.string(), z.unknown())
          .describe('Answers keyed by question id, e.g. {"q1": "option-a"}'),
      },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.user-input.respond",
          commandId: newId(),
          threadId: args.threadId,
          requestId: args.requestId,
          answers: args.answers,
          createdAt: nowIso(),
        });
        return jsonResult({ responded: true, sequence: result.sequence });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "create_thread",
    {
      title: "Start a new T3 thread",
      description:
        "Create a new agent thread in a project and send its first message, starting the agent. " +
        "The thread runs directly in the project workspace (worktree isolation is only available " +
        "from the T3 UI). Model defaults to the project's default, falling back to the project's " +
        "most recent thread's model. runtimeMode defaults to approval-required (safest); pass " +
        "full-access for autonomous work.",
      inputSchema: {
        projectId: z.string().describe("Project id (from list_projects)"),
        message: z
          .string()
          .min(1)
          .describe("First user message / task description"),
        title: z
          .string()
          .optional()
          .describe("Thread title (default: derived from message)"),
        provider: z
          .string()
          .optional()
          .describe(
            "Provider instance id, e.g. claude, codex, cursor, grok, opencode",
          ),
        model: z
          .string()
          .optional()
          .describe("Model name for the provider, e.g. gpt-5.4"),
        runtimeMode: z
          .enum([
            "approval-required",
            "auto-accept-edits",
            "auto",
            "full-access",
          ])
          .optional()
          .describe("Permission mode (default approval-required)"),
        interactionMode: z.enum(["default", "plan"]).optional(),
      },
    },
    async (args) => {
      try {
        const client = getClient();
        const shell = await client.shell();
        const project = shell.projects.find((p) => p.id === args.projectId);
        if (!project) {
          return errorResult(
            new Error(
              `No project with id ${args.projectId}. Use list_projects to find one.`,
            ),
          );
        }
        if (!!args.provider !== !!args.model)
          return errorResult(new Error("Pass provider and model together"));
        let modelSelection =
          args.provider && args.model
            ? { instanceId: args.provider, model: args.model }
            : (project.defaultModelSelection ?? null);
        if (!modelSelection) {
          const recent = shell.threads
            .filter((t) => t.projectId === project.id && t.modelSelection)
            .sort(
              (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
            )[0];
          modelSelection = recent?.modelSelection ?? null;
        }
        if (!modelSelection) {
          return errorResult(
            new Error(
              "No model available: project has no default and no prior threads. " +
                "Pass provider and model explicitly (e.g. provider=claude).",
            ),
          );
        }
        const threadId = newId();
        const runtimeMode = args.runtimeMode ?? "approval-required";
        const interactionMode = args.interactionMode ?? "default";
        const title =
          args.title ?? truncate(args.message.replace(/\s+/g, " "), 60).text;
        const result = await client.launch({
          commandId: newId(),
          threadId,
          projectId: project.id,
          title,
          modelSelection,
          runtimeMode,
          interactionMode,
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: newId(),
            text: args.message,
            attachments: [],
          },
        });
        return jsonResult({
          created: true,
          threadId,
          title,
          project: project.title,
          model: `${modelSelection.instanceId}/${modelSelection.model}`,
          runtimeMode,
          runId: result.runId,
          messageId: result.messageId,
          note: "Agent is starting. Use wait_for_turn to get the first reply.",
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "interrupt_thread",
    {
      title: "Interrupt a running turn",
      description:
        "Interrupt the agent's current turn on a thread (like pressing stop). The thread and " +
        "session survive; you can send a new message afterwards.",
      inputSchema: {
        threadId: z.string(),
        runId: z
          .string()
          .optional()
          .describe(
            "Specific run to interrupt; defaults to current active run",
          ),
      },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.turn.interrupt",
          runId: args.runId,
          commandId: newId(),
          threadId: args.threadId,
          createdAt: nowIso(),
        });
        return jsonResult({ interrupted: true, sequence: result.sequence });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "stop_thread",
    {
      title: "Stop a thread's agent session",
      description:
        "Shut down the provider process attached to a thread. The thread and its history remain; " +
        "a new session starts automatically on the next message.",
      inputSchema: { threadId: z.string() },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.session.stop",
          commandId: newId(),
          threadId: args.threadId,
          createdAt: nowIso(),
        });
        return jsonResult({ stopped: true, sequence: result.sequence });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "wait_for_turn",
    {
      title: "Wait for the agent's reply",
      description:
        "Block until the thread's current turn finishes OR the agent asks for approval/input, " +
        "then return the latest assistant message or the pending request. Use after send_message " +
        "or create_thread for a single round-trip. Times out (default 120s, max 300s) with the " +
        "current state. The reply row carries messageId, totalChars and truncated; use " +
        "get_message for the rest.",
      inputSchema: {
        threadId: z.string(),
        runId: z
          .string()
          .optional()
          .describe(
            "Run id returned by send_message/create_thread; otherwise targets latest run at call start",
          ),
        timeoutSeconds: z.number().int().min(5).max(300).optional(),
        maxChars: z
          .number()
          .int()
          .min(1)
          .max(MAX_MESSAGE_CHARS_CEILING)
          .optional()
          .describe(
            `Max characters of the reply (default ${MESSAGE_DEFAULTS.waitReply}, or ${MAX_MESSAGE_CHARS_ENV})`,
          ),
      },
    },
    async (args, extra) => {
      try {
        const client = getClient();
        const deadline = Date.now() + (args.timeoutSeconds ?? 120) * 1000;
        let targetRunId = args.runId;
        for (;;) {
          if (extra.signal.aborted) throw new Error("MCP request cancelled");
          const t = await client.detail(args.threadId);
          targetRunId ??= t.runs?.[0]?.id;
          if (!targetRunId)
            return jsonResult({
              outcome: "idle",
              note: "This thread has no runs.",
            });
          const run = t.runs?.find((r) => r.id === targetRunId);
          if (!run) throw new Error("Target run not found on this thread");
          const requests = threadRequests(t).filter((request) => {
            const item = t.activities.find(
              (a) => a.payload?.requestId === request.requestId,
            );
            return (request.runId ?? item?.turnId) === targetRunId;
          });
          if (requests.length)
            return jsonResult({
              outcome: "needs-you",
              runId: targetRunId,
              pendingRequests: requests,
            });
          if (
            [
              "completed",
              "failed",
              "interrupted",
              "cancelled",
              "rolled_back",
            ].includes(run.status)
          ) {
            let assistant = [...t.messages]
              .reverse()
              .find(
                (m) =>
                  m.role === "assistant" &&
                  m.turnId === targetRunId &&
                  !m.streaming,
              );
            if (!assistant && run.status === "completed")
              assistant = await client.runReply(args.threadId, targetRunId);
            return jsonResult({
              outcome:
                run.status === "failed"
                  ? "error"
                  : run.status === "completed"
                    ? "completed"
                    : "interrupted",
              runId: targetRunId,
              runStatus: run.status,
              sessionStatus: t.session?.status ?? "none",
              lastError: t.session?.lastError ?? null,
              reply: assistant
                ? messageRow(
                    assistant,
                    resolveMaxChars(MESSAGE_DEFAULTS.waitReply, args.maxChars),
                  )
                : null,
            });
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0)
            return jsonResult({
              outcome: "timeout",
              runId: targetRunId,
              runStatus: run.status,
              note: "Call wait_for_turn again with this runId.",
            });
          await sleep(Math.min(1500, remaining), extra.signal);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "archive_thread",
    {
      title: "Archive a thread",
      description:
        "Archive a thread (hides it from the active list; reversible).",
      inputSchema: { threadId: z.string() },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.archive",
          commandId: newId(),
          threadId: args.threadId,
        });
        return jsonResult({ archived: true, sequence: result.sequence });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "unarchive_thread",
    {
      title: "Unarchive a thread",
      description: "Bring an archived thread back to the active list.",
      inputSchema: { threadId: z.string() },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.unarchive",
          commandId: newId(),
          threadId: args.threadId,
        });
        return jsonResult({ unarchived: true, sequence: result.sequence });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "save_thread",
    {
      title: "Save a thread for later",
      description:
        "Shelve a thread: remove it from the active list and keep it in Saved. " +
        "Settling is separate; restoring returns it to its prior state.",
      inputSchema: { threadId: z.string() },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.save",
          commandId: newId(),
          threadId: args.threadId,
        });
        return jsonResult({ saved: true, sequence: result.sequence });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "unsave_thread",
    {
      title: "Restore a saved thread",
      description: "Bring a Saved thread back to the active/settled list it came from.",
      inputSchema: { threadId: z.string() },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.unsave",
          commandId: newId(),
          threadId: args.threadId,
        });
        return jsonResult({ restored: true, sequence: result.sequence });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "list_saved_threads",
    {
      title: "List saved threads",
      description:
        "List threads shelved with save_thread, newest saved first. Each row is " +
        "a normal thread summary; use unsave_thread to restore one.",
      inputSchema: {
        projectId: z.string().optional().describe("Only threads in this project"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max rows (default 25)"),
        cursor: z
          .string()
          .optional()
          .describe("Opaque nextCursor from a previous list_saved_threads call"),
      },
    },
    async (args) => {
      try {
        const shell = await getClient().shell(false);
        const projectsById = new Map(shell.projects.map((p) => [p.id, p]));
        const saved = shell.threads
          .filter((t) => t.savedAt != null)
          .filter((t) =>
            args.projectId ? t.projectId === args.projectId : true,
          )
          .sort(
            (a, b) =>
              Date.parse(b.savedAt ?? b.updatedAt) -
              Date.parse(a.savedAt ?? a.updatedAt),
          );
        const page = paginate(saved, args.limit ?? 25, args.cursor);
        return jsonResult({
          ...pageFields(page),
          threads: page.items.map((t) => threadRow(t, projectsById)),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "set_thread_title",
    {
      title: "Rename a thread",
      description:
        "Set a thread's title (useful for voice: 'call this one auth bug').",
      inputSchema: { threadId: z.string(), title: z.string().min(1) },
    },
    async (args) => {
      try {
        const result = await getClient().dispatch({
          type: "thread.meta.update",
          commandId: newId(),
          threadId: args.threadId,
          title: args.title,
        });
        return jsonResult({
          renamed: true,
          title: args.title,
          sequence: result.sequence,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
