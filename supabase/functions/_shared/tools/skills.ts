import { jsonSchema, tool } from "ai";
import {
  assertValidSkillSlug,
  initializeSkills,
  installError,
  installSkillFromContent,
  installSkillFromUrl,
  loadSkillFile,
  readSkillResource,
  sanitizeSkillResourcePath,
} from "../skills.ts";

export const skillsTool = tool({
  description: [
    "Discover, load, read, and install Agent Skills from workspace storage.",
    "",
    "Actions:",
    "- list: returns available skill metadata (name/description)",
    "- load: loads full SKILL.md for a skill",
    "- read: reads a referenced file from within a skill folder",
    "- install: install a new skill from SKILL.md content or a GitHub URL",
    "",
    "Guidelines:",
    "- Use 'list' to see what's available.",
    "- 'load' a skill before using its instructions.",
    "- After loading, use 'read' for specific referenced resources (root files or one-level paths like references/REFERENCE.md).",
    "- Only text-based files can be read.",
    "",
    "Install:",
    "- Provide exactly one of these inputs:",
    `  - { "action": "install", "content": "<SKILL.md content>" }`,
    `  - { "action": "install", "url": "https://github.com/<owner>/<repo>/tree/<ref>/<skill-folder>" }`,
    "- GitHub URLs may point to a skill folder containing SKILL.md, or directly to SKILL.md (blob/raw/raw.githubusercontent.com).",
    "- The installer writes the skill to: .agents/skills/<name>/... (name comes from SKILL.md frontmatter).",
    "- Pass overwrite=true to replace an existing skill.",
    "- Optional: set GITHUB_TOKEN for private repos and higher GitHub API rate limits.",
    "- On failure, returns a structured error: { ok:false, error, message, step, details } so you can retry with a corrected input.",
  ].join("\n"),
  inputSchema: jsonSchema<
    {
      action: "list" | "load" | "read" | "sync" | "install";
      name?: string;
      path?: string;
      content?: string;
      url?: string;
      overwrite?: boolean;
    }
  >({
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "load", "read", "sync", "install"],
        description:
          "Action to perform: 'list' returns available skills, 'load' returns full SKILL.md, 'read' returns a referenced file, 'install' installs a new skill, 'sync' is not supported here.",
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
      content: {
        type: "string",
        description:
          "SKILL.md contents (required for install when installing from content).",
      },
      url: {
        type: "string",
        description:
          "GitHub URL to a skill folder or SKILL.md (required for install when installing from url).",
      },
      overwrite: {
        type: "boolean",
        description:
          "When action=install, set true to overwrite an existing installed skill.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  }),
  execute: async ({ action, name, path, content, url, overwrite }) => {
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

      if (action === "install") {
        const hasContent = typeof content === "string" &&
          content.trim().length > 0;
        const hasUrl = typeof url === "string" && url.trim().length > 0;
        if ((hasContent ? 1 : 0) + (hasUrl ? 1 : 0) !== 1) {
          return installError(
            "invalid_install_input",
            "For action=install, provide exactly one of: content or url.",
            "validate_input",
            { has_content: hasContent, has_url: hasUrl },
          );
        }
        if (hasContent) {
          return await installSkillFromContent({
            content: content ?? "",
            overwrite,
          });
        }
        return await installSkillFromUrl({ url: url ?? "", overwrite });
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
