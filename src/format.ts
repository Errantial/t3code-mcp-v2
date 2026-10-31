import type { Project, ThreadShell, Message, Activity } from "./model.js";
import { attentionOf } from "./model.js";
import { MESSAGE_DEFAULTS, resolveMaxChars } from "./message.js";

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}…`, truncated: true };
}

/** "3m ago", "2h ago", "4d ago" — voice-friendly recency. */
export function relTime(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Compact list row for a thread. Identity is always the T3 app-thread id. */
export function threadRow(t: ThreadShell, projectsById: Map<string, Project>) {
  const model = t.modelSelection ? `${t.modelSelection.instanceId}/${t.modelSelection.model}` : null;
  const provider = t.modelSelection?.instanceId ?? t.session?.providerInstanceId ?? null;
  return {
    threadId: t.id,
    rootThreadId: t.lineage?.rootThreadId ?? t.id,
    title: t.title ?? "(untitled)",
    project: projectsById.get(t.projectId)?.title ?? t.projectId,
    attention: attentionOf(t),
    sessionStatus: t.session?.status ?? "none",
    latestTurn: t.latestTurn?.state ?? null,
    provider,
    model,
    branch: t.branch ?? null,
    worktree: t.worktreePath ? true : false,
    archived: t.archivedAt ? true : false,
    savedAt: t.savedAt ?? null,
    updated: relTime(t.updatedAt),
    updatedAt: t.updatedAt,
    ...(t.planProgress
      ? {
          planProgress: `${t.planProgress.completedSteps}/${t.planProgress.totalSteps}${
            t.planProgress.step ? ` (${t.planProgress.step})` : ""
          }`,
        }
      : {}),
  };
}

/**
 * Compact message row. Always carries the id and full length so a caller can
 * fetch the rest with `get_message` when `truncated` is true.
 */
export function messageRow(m: Message, maxChars?: number) {
  const full = m.text ?? "";
  const { text, truncated } = truncate(
    full,
    resolveMaxChars(MESSAGE_DEFAULTS.threadRow, maxChars),
  );
  return {
    messageId: m.id,
    role: m.role,
    text,
    truncated,
    totalChars: full.length,
    ...(m.streaming ? { streaming: true } : {}),
    at: m.createdAt,
    ago: relTime(m.createdAt),
  };
}

/** Group tool/task activity into a compact per-kind count plus recent summaries. */
export function activityOverview(activities: Activity[], recentCount = 10) {
  const counts: Record<string, number> = {};
  for (const a of activities) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  const recent = activities.slice(-recentCount).map((a) => ({
    kind: a.kind,
    summary: truncate(a.summary ?? "", 200).text,
    ago: relTime(a.createdAt),
  }));
  return { counts, recent };
}

/** Strip markdown/code so text reads well over TTS. */
export function stripForVoice(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*?|__|~~/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Standard MCP text result with compact JSON. */
export function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}

export function errorResult(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}
