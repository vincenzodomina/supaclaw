import { jsonSchema, tool } from "ai";
import { uploadFile } from "../storage.ts";

export const writeFileTool = tool({
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
    const result = await uploadFile(path, content, {
      mimeType: mime_type,
    });
    return { ok: true, path: result.objectPath };
  },
});
