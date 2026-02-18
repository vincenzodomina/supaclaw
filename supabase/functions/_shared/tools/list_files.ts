import { jsonSchema, tool } from "ai";
import { listWorkspaceObjects } from "../storage.ts";

function joinPrefix(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

export const listFilesTool = tool({
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
});
