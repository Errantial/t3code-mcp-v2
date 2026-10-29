import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { T3Client } from "../client.js";
import { attentionOf, providerOf, threadRequests } from "../model.js";
import type { Attention, ThreadShell } from "../model.js";
import {
  errorResult,
  jsonResult,
  relTime,
  stripForVoice,
  threadRow,
  truncate,
} from "../format.js";
import { filterThreads, paginate, pageFields } from "../query.js";

import { sleep } from "../wait.js";

function speakAttention(a: Attention): string {
  switch (a) {
    case "needs-approval":
      return "waiting for your approval";
    case "needs-input":
      return "waiting for an answer from you";
    case "plan-ready":
      return "ready with a plan for you to review";
    case "working":
      return "still working";
    case "error":
      return "hit an error";
    case "done":
      return "finished";
    case "idle":
      return "idle";
  }
}

export function registerPhase3(server: McpServer, getClient: () => T3Client) {
  server.registerTool(
    "thread_digest",
    {
      title: "Speakable thread digest",
      description:
        "A TTS-friendly plain-language digest of one thread: what it's doing, what the agent " +
        "last said (markdown/code stripped), and anything it's waiting on. Designed to be read " +
        "aloud by a voice assistant.",
      inputSchema: {
        threadId: z.string(),
        maxReplyChars: z
          .number()
          .int()
          .min(100)
          .max(4000)
          .optional()
          .describe("Default 800"),
      },
    },
    async (args) => {
      try {
        const t = await getClient().detail(args.threadId);
        const attention = attentionOf(t);
        const pending = threadRequests(t);
        const messages = t.messages ?? [];
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        const lastAssistant = [...messages]
          .reverse()
          .find((m) => m.role === "assistant");
        const toolCount = (t.activities ?? []).filter((a) =>
          a.kind.startsWith("tool."),
        ).length;

        const parts: string[] = [];
        parts.push(
          `Thread "${t.title ?? "untitled"}" is ${speakAttention(attention)}.`,
        );
        if (lastUser) {
          parts.push(
            `Your last message, ${relTime(lastUser.createdAt) ?? "earlier"}: ${
              truncate(stripForVoice(lastUser.text), 200).text
            }`,
          );
        }
        if (toolCount > 0)
          parts.push(`The agent has run ${toolCount} tool actions recently.`);
        if (lastAssistant) {
          parts.push(
            `Latest reply, ${relTime(lastAssistant.createdAt) ?? "earlier"}: ${
              truncate(
                stripForVoice(lastAssistant.text),
                args.maxReplyChars ?? 800,
              ).text
            }`,
          );
        }
        for (const p of pending) {
          parts.push(
            p.kind === "approval"
              ? `It is asking permission for a ${p.requestKind ?? "action"}: ${
                  truncate(
                    stripForVoice(
                      String(p.summary ?? JSON.stringify(p.detail)),
                    ),
                    200,
                  ).text
                }`
              : `It has a question for you: ${
                  truncate(
                    stripForVoice(
                      String(p.summary ?? JSON.stringify(p.detail)),
                    ),
                    300,
                  ).text
                }`,
          );
        }
        if (t.session?.lastError) {
          parts.push(
            `Session error: ${truncate(String(t.session.lastError), 200).text}`,
          );
        }
        return jsonResult({
          spoken: parts.join(" "),
          attention,
          pendingRequests: pending,
          threadId: t.id,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "workspace_digest",
    {
      title: "Speakable workspace briefing",
      description:
        "One-line-per-thread briefing across all projects — the 'what are my agents doing' " +
        "answer. Covers threads needing attention first, then working, then recently finished. " +
        "Old done/idle/error threads are excluded by default. TTS-friendly 'spoken' field plus " +
        "structured rows. Use nextCursor to page.",
      inputSchema: {
        sinceHours: z
          .number()
          .min(1)
          .max(720)
          .optional()
          .describe(
            "Include finished/idle threads updated within this window (default 24h)",
          ),
        includeInactive: z
          .boolean()
          .optional()
          .describe("Include old done/idle/error threads (default false)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max rows (default 20)"),
        cursor: z
          .string()
          .optional()
          .describe("Opaque nextCursor from a previous workspace_digest call"),
      },
    },
    async (args) => {
      try {
        const shell = await getClient().shell();
        const projectsById = new Map(shell.projects.map((p) => [p.id, p]));
        const order: Attention[] = [
          "needs-approval",
          "needs-input",
          "plan-ready",
          "error",
          "working",
          "done",
          "idle",
        ];
        const interesting = filterThreads(shell.threads, {
          includeInactive: args.includeInactive,
          sinceHours: args.sinceHours ?? 24,
        }).sort(
          (a, b) =>
            order.indexOf(attentionOf(a)) - order.indexOf(attentionOf(b)) ||
            Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
        );
        const page = paginate(interesting, args.limit ?? 20, args.cursor);
        const rows = page.items.map((t: ThreadShell) => {
          const project =
            projectsById.get(t.projectId)?.title ?? "unknown project";
          return (
            `"${t.title ?? "untitled"}" in ${project} is ${speakAttention(attentionOf(t))}` +
            ` (updated ${relTime(t.updatedAt) ?? "recently"}).`
          );
        });
        const needing = interesting.filter((t) =>
          ["needs-approval", "needs-input", "plan-ready", "error"].includes(
            attentionOf(t),
          ),
        ).length;
        const working = interesting.filter(
          (t) => attentionOf(t) === "working",
        ).length;
        const spoken =
          page.total === 0
            ? "All quiet — no active agent threads right now."
            : `You have ${working} thread${working === 1 ? "" : "s"} working and ${needing} ` +
              `waiting on you. ${rows.join(" ")}`;
        return jsonResult({
          spoken,
          ...pageFields(page),
          threads: page.items.map((t) => threadRow(t, projectsById)),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "search_threads",
    {
      title: "Search threads",
      description:
        "Find threads by words from the title, project name, or branch (case-insensitive " +
        "substring match on each word). Defaults to active or recent non-archived threads; " +
        "archived and old threads are opt-in. Use nextCursor to page.",
      inputSchema: {
        query: z.string().min(1),
        includeArchived: z
          .boolean()
          .optional()
          .describe("Search archived threads too (default false)"),
        includeInactive: z
          .boolean()
          .optional()
          .describe("Include old done/idle/error threads (default false)"),
        sinceHours: z
          .number()
          .min(1)
          .max(720)
          .optional()
          .describe("Recency window for done/idle/error threads (default 72h)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Default 10"),
        cursor: z
          .string()
          .optional()
          .describe("Opaque nextCursor from a previous search_threads call"),
      },
    },
    async (args) => {
      try {
        const shell = await getClient().shell(args.includeArchived ?? false);
        const projectsById = new Map(shell.projects.map((p) => [p.id, p]));
        const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = filterThreads(shell.threads, {
          includeArchived: args.includeArchived,
          includeInactive: args.includeInactive,
          sinceHours: args.sinceHours,
        })
          .map((t) => {
            const hay = [
              t.title ?? "",
              projectsById.get(t.projectId)?.title ?? "",
              t.branch ?? "",
            ]
              .join(" ")
              .toLowerCase();
            const hits = words.filter((w) => hay.includes(w)).length;
            return { t, hits };
          })
          .filter(
            (m) =>
              m.hits === words.length ||
              (words.length > 2 && m.hits >= words.length - 1),
          )
          .sort(
            (a, b) =>
              b.hits - a.hits ||
              Date.parse(b.t.updatedAt) - Date.parse(a.t.updatedAt),
          )
          .map((m) => m.t);
        const page = paginate(matches, args.limit ?? 10, args.cursor);
        return jsonResult({
          matches: page.total,
          ...pageFields(page),
          threads: page.items.map((t) => threadRow(t, projectsById)),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "wait_for_change",
    {
      title: "Wait for anything to change",
      description:
        "Long-poll the workspace until any thread changes attention state (a turn finishes, an " +
        "approval appears, an error occurs) or the timeout passes. Returns the changed threads " +
        "with old and new state. Lets a voice loop stay silent until something actually happens.",
      inputSchema: {
        timeoutSeconds: z
          .number()
          .int()
          .min(5)
          .max(300)
          .optional()
          .describe("Default 60"),
      },
    },
    async (args, extra) => {
      try {
        const client = getClient();
        const baseline = await client.shell(false, extra.signal);
        const provider = (t: ThreadShell) => providerOf(t);
        const model = (t: ThreadShell) => t.modelSelection?.model ?? null;
        const fingerprint = (t: ThreadShell) =>
          JSON.stringify([
            attentionOf(t),
            t.pendingRequestIds ?? [],
            t.archivedAt ?? null,
            provider(t),
            model(t),
          ]);
        const aliases = (t: ThreadShell) =>
          [t.activeProviderThreadId, t.session?.providerThreadId].filter(
            (id): id is string => !!id,
          );
        const before = new Map(
          baseline.threads.map((t) => [
            t.id,
            {
              state: attentionOf(t),
              fingerprint: fingerprint(t),
              provider: provider(t),
              model: model(t),
            },
          ]),
        );
        // Provider session/thread ids are aliases of the app thread, not new
        // threads. Remember which canonical thread owns each alias.
        const aliasOwner = new Map<string, string>();
        for (const t of baseline.threads)
          for (const alias of aliases(t)) aliasOwner.set(alias, t.id);
        const deadline = Date.now() + (args.timeoutSeconds ?? 60) * 1000;
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0)
            return jsonResult({
              changed: 0,
              note: "No changes before timeout.",
            });
          await sleep(Math.min(2500, remaining), extra.signal);
          const shell = await client.shell(false, extra.signal);
          const projectsById = new Map(shell.projects.map((p) => [p.id, p]));
          const changes: Array<Record<string, unknown>> = [];
          const seen = new Set<string>();
          for (const t of shell.threads) {
            const directOwner = before.has(t.id) ? t.id : undefined;
            const aliasOwnerId = aliases(t)
              .map((alias) => aliasOwner.get(alias))
              .find((id): id is string => !!id);
            const owner = directOwner ?? aliasOwnerId;
            if (!owner) {
              changes.push({
                ...threadRow(t, projectsById),
                change: `new thread (${attentionOf(t)})`,
                changeType: "new",
              });
              continue;
            }
            if (seen.has(owner)) continue;
            seen.add(owner);
            const previous = before.get(owner)!;
            if (previous.fingerprint === fingerprint(t)) continue;
            const parts: string[] = [];
            if (previous.state !== attentionOf(t))
              parts.push(`${previous.state} → ${attentionOf(t)}`);
            if (previous.provider !== provider(t))
              parts.push(
                `provider ${previous.provider ?? "none"} → ${provider(t) ?? "none"}`,
              );
            if (previous.model !== model(t))
              parts.push(
                `model ${previous.model ?? "none"} → ${model(t) ?? "none"}`,
              );
            changes.push({
              ...threadRow(t, projectsById),
              threadId: owner,
              change: parts.join(", ") || "updated",
              changeType: owner === t.id ? "updated" : "provider-switch",
            });
          }
          for (const [id, previous] of before)
            if (!seen.has(id))
              changes.push({
                threadId: id,
                change: `removed from active snapshot (${previous.state})`,
                changeType: "removed",
              });
          if (changes.length)
            return jsonResult({ changed: changes.length, changes });
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
