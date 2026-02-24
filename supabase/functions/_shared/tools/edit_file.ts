import { jsonSchema, tool } from "ai";
import {
  downloadTextFromWorkspace,
  uploadFile,
} from "../storage.ts";

export const editFileTool = tool({
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

    const result = await uploadFile(path, next);
    return { ok: true, path: result.objectPath, replacements };
  },
});
