import { jsonSchema, tool } from "ai";
import {
  assertValidSkillSlug,
  initializeSkills,
  loadSkillFile,
  readSkillResource,
  sanitizeSkillResourcePath,
} from "../skills.ts";

export const skillsTool = tool({
  description: [
    "Discover and load Agent Skills from workspace storage.",
    "",
    "Actions:",
    "- list: returns available skill metadata (name/description)",
    "- load: loads full SKILL.md for a skill",
    "- read: reads a referenced file from within a skill folder",
    "",
    "Guidelines:",
    "- Use 'list' to see what's available.",
    "- 'load' a skill before using its instructions.",
    "- After loading, use 'read' for specific referenced resources (root files or one-level paths like references/REFERENCE.md).",
    "- Only text-based files can be read.",
  ].join("\n"),
  inputSchema: jsonSchema<
    { action: "list" | "load" | "read" | "sync"; name?: string; path?: string }
  >({
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "load", "read", "sync"],
        description:
          "Action to perform: 'list' returns available skills, 'load' returns full SKILL.md, 'read' returns a referenced file, 'sync' is not supported here.",
      },
      name: {
        type: "string",
        description:
          "The skill name/slug (required for load/read/sync actions).",
      },
      path: {
        type: "string",
        description:
          "Referenced file path within the skill (required for read action), e.g. 'references/REFERENCE.md'.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  }),
  execute: async ({ action, name, path }) => {
    try {
      if (action === "list") {
        const skills = await initializeSkills();
        return {
          type: "skill-list",
          title: "Available Skills",
          skills: skills.map((s) => ({
            name: s.slug,
            description: s.description,
            source_type: s.source_type ?? "workspace",
          })),
        };
      }

      if (action === "load") {
        const safeName = assertValidSkillSlug(name ?? "");
        const content = await loadSkillFile(safeName);
        return { type: "skill", title: safeName, content };
      }

      if (action === "read") {
        const safeName = assertValidSkillSlug(name ?? "");
        if (!path?.trim()) {
          return {
            error:
              "The 'path' parameter is required for 'read' action (e.g. references/REFERENCE.md).",
          };
        }
        const content = await readSkillResource(safeName, path);
        return {
          type: "skill-resource",
          title: `${safeName}/${sanitizeSkillResourcePath(path)}`,
          content,
        };
      }

      if (action === "sync") {
        return {
          error:
            "sync is not supported: workspace storage is the source of truth for skills.",
        };
      }

      return { error: `Unknown action: ${String(action)}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: `Skills tool error: ${msg}` };
    }
  },
});
