import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { T3Client } from "../client.js";
import type { InstructionFile, InstructionSnapshot } from "../instructions.js";
import { attachmentIdsForThread } from "../instructions.js";
import { errorResult, jsonResult } from "../format.js";

const scopeSchema = z.enum(["global", "project"]);
const kindSchema = z.enum(["sync", "optional"]);
const providerSchema = z.enum(["codex", "claude", "opencode", "cursor", "custom"]);
const targetSchema = z.object({
  provider: providerSchema,
  scope: scopeSchema,
  projectId: z.string().optional(),
  workspaceRoot: z
    .string()
    .optional()
    .describe("Project workspace root; required for project-scoped targets"),
  path: z.string().optional().describe("Absolute path or one relative to the T3 home"),
  filename: z.string().optional(),
});

function summary(snapshot: InstructionSnapshot, file: InstructionFile) {
  const sync = snapshot.syncs.find((candidate) => candidate.fileId === file.id) ?? null;
  return {
    id: file.id,
    title: file.title,
    kind: file.kind,
    scope: file.scope,
    projectId: file.projectId ?? null,
    filename: file.filename ?? null,
    revision: file.revision,
    updatedAt: file.updatedAt,
    chars: file.content.length,
    sync: sync === null ? null : { id: sync.id, targets: sync.targets },
    targets: snapshot.targets[file.id] ?? [],
  };
}

export function registerInstructions(server: McpServer, getClient: () => T3Client) {
  server.registerTool(
    "list_instruction_files",
    {
      title: "List instruction files",
      description:
        "List global/project instruction files (AGENTS.md, CLAUDE.md and provider " +
        "equivalents) managed by T3, with sync targets and drift status.",
      inputSchema: {
        kind: kindSchema.optional(),
        scope: scopeSchema.optional(),
        projectId: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const snapshot = await getClient().instructions();
        const files = snapshot.files
          .filter((file) => (args.kind ? file.kind === args.kind : true))
          .filter((file) => (args.scope ? file.scope === args.scope : true))
          .filter((file) =>
            args.projectId ? file.projectId === args.projectId : true,
          )
          .map((file) => summary(snapshot, file));
        return jsonResult({ files });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_instruction_file",
    {
      title: "Read an instruction file",
      description: "Read one managed instruction file, including its content and revision.",
      inputSchema: { id: z.string() },
    },
    async (args) => {
      try {
        const snapshot = await getClient().instructions();
        const file = snapshot.files.find((candidate) => candidate.id === args.id);
        if (!file) return errorResult(new Error(`No instruction file ${args.id}`));
        return jsonResult(file);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "put_instruction_file",
    {
      title: "Create or update an instruction file",
      description:
        "Create or update a managed instruction file. Updates require the revision you " +
        "read unless expectedRevision is omitted. Sync groups are rewritten immediately.",
      inputSchema: {
        id: z.string().optional(),
        kind: kindSchema.optional().describe("Default sync"),
        scope: scopeSchema.optional().describe("Default global"),
        projectId: z.string().optional(),
        title: z.string().min(1),
        filename: z.string().optional(),
        content: z.string(),
        expectedRevision: z.number().int().min(0).optional(),
        updatedBy: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const result = await getClient().putInstruction(args);
        return jsonResult(result);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "list_instruction_syncs",
    {
      title: "List instruction sync groups",
      description:
        "List the assignments that materialize one managed file into provider paths " +
        "(global or project), including target drift.",
      inputSchema: { fileId: z.string().optional() },
    },
    async (args) => {
      try {
        const snapshot = await getClient().instructions();
        const syncs = snapshot.syncs
          .filter((sync) => (args.fileId ? sync.fileId === args.fileId : true))
          .map((sync) => ({
            ...sync,
            targets: sync.targets.map((target, index) => ({
              ...target,
              status: (snapshot.targets[sync.fileId] ?? [])[index] ?? null,
            })),
          }));
        return jsonResult({ syncs });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "set_instruction_sync",
    {
      title: "Set an instruction sync group",
      description:
        "Assign one managed instruction file to one or more provider paths. T3 writes " +
        "generated copies; manual edits to targets are reported as drift and overwritten " +
        "on the next sync.",
      inputSchema: {
        id: z.string().optional(),
        fileId: z.string(),
        targets: z.array(targetSchema).min(1),
      },
    },
    async (args) => {
      try {
        const result = await getClient().setInstructionSync(args);
        return jsonResult(result);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "remove_instruction_sync",
    {
      title: "Remove an instruction sync group",
      description: "Stop materializing a file into provider paths. The managed file remains.",
      inputSchema: { id: z.string() },
    },
    async (args) => {
      try {
        return jsonResult(await getClient().removeInstructionSync(args.id));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "list_optional_instruction_files",
    {
      title: "List optional instruction files",
      description:
        "List the role/context library used to attach extra .md files to individual " +
        "threads. Attachments are injected into the next message as <t3_optional_instructions>.",
      inputSchema: {
        scope: scopeSchema.optional(),
        projectId: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const snapshot = await getClient().instructions();
        const files = snapshot.files
          .filter((file) => file.kind === "optional")
          .filter((file) => (args.scope ? file.scope === args.scope : true))
          .filter((file) =>
            args.projectId ? file.projectId === args.projectId : true,
          )
          .map((file) => summary(snapshot, file));
        return jsonResult({ files });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "attach_optional_instructions",
    {
      title: "Attach optional instruction files",
      description:
        "Attach role/context files to a thread. They are injected into every later " +
        "send_message for that thread until detached.",
      inputSchema: {
        threadId: z.string(),
        fileIds: z.array(z.string()).min(1),
      },
    },
    async (args) => {
      try {
        const client = getClient();
        const snapshot = await client.instructions();
        const current = attachmentIdsForThread(snapshot, args.threadId);
        const next = [...new Set([...current, ...args.fileIds])];
        return jsonResult(
          await client.setThreadAttachments(args.threadId, next),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "detach_optional_instructions",
    {
      title: "Detach optional instruction files",
      description:
        "Remove some or all optional files from a thread. The change applies to later " +
        "messages; earlier turns keep what they already received.",
      inputSchema: {
        threadId: z.string(),
        fileIds: z.array(z.string()).optional().describe("Omit to detach all"),
      },
    },
    async (args) => {
      try {
        const client = getClient();
        const snapshot = await client.instructions();
        const current = attachmentIdsForThread(snapshot, args.threadId);
        const remove = new Set(args.fileIds ?? current);
        const next = current.filter((id) => !remove.has(id));
        return jsonResult(
          await client.setThreadAttachments(args.threadId, next),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
