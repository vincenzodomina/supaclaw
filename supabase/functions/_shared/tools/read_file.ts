import { jsonSchema, tool } from "ai";
import { decodeUtf8, downloadFile } from "../storage.ts";

export const readFileTool = tool({
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
    const file = await downloadFile(path, { optional: true });
    const content = file ? decodeUtf8(file) : null;
    return { path, exists: file !== null, content };
  },
});
