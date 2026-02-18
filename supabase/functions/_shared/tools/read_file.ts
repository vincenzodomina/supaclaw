import { jsonSchema, tool } from "ai";
import { downloadTextFromWorkspace } from "../storage.ts";

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
    const content = await downloadTextFromWorkspace(path, { optional: true });
    return { path, exists: content !== null, content };
  },
});
