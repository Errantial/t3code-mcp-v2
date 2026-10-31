export type InstructionScope = "global" | "project";
export type InstructionKind = "sync" | "optional";
export type InstructionProvider =
  | "codex"
  | "claude"
  | "opencode"
  | "cursor"
  | "custom";

export interface InstructionFile {
  id: string;
  kind: InstructionKind;
  scope: InstructionScope;
  projectId?: string;
  title: string;
  filename?: string;
  content: string;
  revision: number;
  updatedAt: string;
  updatedBy?: string;
}

export interface InstructionSyncTarget {
  provider: InstructionProvider;
  scope: InstructionScope;
  projectId?: string;
  workspaceRoot?: string;
  path?: string;
  filename?: string;
}

export interface InstructionSync {
  id: string;
  fileId: string;
  targets: ReadonlyArray<InstructionSyncTarget>;
  updatedAt: string;
}

export interface InstructionTargetStatus {
  path: string;
  exists: boolean;
  drift: boolean;
  lastWrittenHash: string;
}

export interface InstructionSnapshot {
  version: 1;
  files: InstructionFile[];
  syncs: InstructionSync[];
  threadAttachments: Record<string, string[]>;
  targets: Record<string, InstructionTargetStatus[]>;
}

export interface InstructionPutInput {
  id?: string;
  kind?: InstructionKind;
  scope?: InstructionScope;
  projectId?: string;
  title: string;
  filename?: string;
  content: string;
  expectedRevision?: number;
  updatedBy?: string;
}

const MAX_OPTIONAL_CHARS = 64 * 1024;

/** Prefix a user message with the optional files attached to the thread. */
export function optionalInstructionsPrefix(
  snapshot: InstructionSnapshot,
  fileIds: ReadonlyArray<string>,
  text: string,
): string {
  if (fileIds.length === 0) return text;
  const byId = new Map(snapshot.files.map((file) => [file.id, file]));
  const selected = fileIds
    .map((id) => byId.get(id))
    .filter((file): file is InstructionFile => file !== undefined);
  if (selected.length === 0) return text;
  const body = selected
    .map(
      (file) =>
        `<file id="${file.id}" title="${escapeXml(file.title)}">\n${file.content.trim()}\n</file>`,
    )
    .join("\n\n");
  if (body.length > MAX_OPTIONAL_CHARS) {
    throw new Error(
      `Optional instructions are ${body.length} chars; the limit is ${MAX_OPTIONAL_CHARS}.`,
    );
  }
  return [
    "<t3_optional_instructions>",
    body,
    "</t3_optional_instructions>",
    "",
    "<user_request>",
    text,
    "</user_request>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function attachmentIdsForThread(
  snapshot: InstructionSnapshot,
  threadId: string,
): ReadonlyArray<string> {
  return snapshot.threadAttachments[threadId] ?? [];
}
