import { jsonSchema, tool } from "ai";
import {
  downloadTextFromWorkspace,
  listWorkspaceObjects,
  writeWorkspaceText,
} from "./storage.ts";

function joinPrefix(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

export const workspaceTools = {
  read_file: tool({
    description:
      'Read a UTF-8 text file from the workspace storage. Path is workspace-root-relative (no leading slash), e.g. ".agents/SOUL.md".',
    inputSchema: jsonSchema<{ path: string }>({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-root-relative file path.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    }),
    execute: async ({ path }) => {
      const content = await downloadTextFromWorkspace(path, { optional: true });
      return { path, exists: content !== null, content };
    },
  }),

  write_file: tool({
    description:
      "Write (create or overwrite) a UTF-8 text file into the workspace storage at the given path (workspace-root-relative).",
    inputSchema: jsonSchema<
      { path: string; content: string; mime_type?: string }
    >({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-root-relative file path.",
        },
        content: {
          type: "string",
          description: "Full file contents to write.",
        },
        mime_type: {
          type: "string",
          description: "Optional MIME type for storage + file record.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    }),
    execute: async ({ path, content, mime_type }) => {
      const result = await writeWorkspaceText(path, content, {
        mimeType: mime_type,
      });
      return { ok: true, path: result.objectPath };
    },
  }),

  list_files: tool({
    description:
      'List files/folders under a workspace directory prefix (non-recursive). Use path "." or empty to list the workspace root.',
    inputSchema: jsonSchema<{ path?: string }>({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-root-relative directory prefix to list.",
        },
      },
      additionalProperties: false,
    }),
    execute: async ({ path }) => {
      const { prefix, objects } = await listWorkspaceObjects(path || "");
      const paths = objects.map((o) => joinPrefix(prefix, o.name));
      return { path: prefix, paths };
    },
  }),

  edit_file: tool({
    description:
      "Edit a UTF-8 text file in the workspace by applying one or more exact text replacements, then write it back.",
    inputSchema: jsonSchema<{
      path: string;
      edits: Array<
        { old_text: string; new_text: string; replace_all?: boolean }
      >;
    }>({
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-root-relative file path.",
        },
        edits: {
          type: "array",
          description: "Edits to apply in order.",
          items: {
            type: "object",
            properties: {
              old_text: {
                type: "string",
                description: "Exact text to replace.",
              },
              new_text: { type: "string", description: "Replacement text." },
              replace_all: {
                type: "boolean",
                description: "Replace all occurrences (default false).",
              },
            },
            required: ["old_text", "new_text"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    }),
    execute: async ({ path, edits }) => {
      const current = await downloadTextFromWorkspace(path, { optional: true });
      if (current === null) throw new Error(`File not found: ${path}`);

      let next = current;
      const replacements: number[] = [];

      for (const edit of edits) {
        if (!edit.old_text) {
          throw new Error("edit_file: old_text must be a non-empty string");
        }

        if (edit.replace_all) {
          const parts = next.split(edit.old_text);
          replacements.push(parts.length - 1);
          next = parts.join(edit.new_text);
          continue;
        }

        const ix = next.indexOf(edit.old_text);
        replacements.push(ix === -1 ? 0 : 1);
        if (ix !== -1) {
          next = next.replace(edit.old_text, edit.new_text);
        }
      }

      const result = await writeWorkspaceText(path, next);
      return { ok: true, path: result.objectPath, replacements };
    },
  }),
};
