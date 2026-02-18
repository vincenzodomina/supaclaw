import { downloadTextFromWorkspace, listWorkspaceObjects } from "./storage.ts";

export type SkillMetadata = {
  /** Skill slug/name (must match directory name). */
  slug: string;
  /** Human-meaningful description for routing. */
  description: string;
  /** Optional license string from frontmatter. */
  license?: string;
  /** Optional compatibility string from frontmatter. */
  compatibility?: string | string[];
  /** Optional allowlisted tools (experimental in the Agent Skills spec). */
  allowed_tools?: string[];
  /** Optional free-form metadata map. */
  metadata?: Record<string, string>;
  /** Where the skill came from (for debugging/UI). */
  source_type?: "workspace";
};

const SKILLS_PREFIX = ".agents/skills";
const SKILL_ENTRYPOINT = "SKILL.md";

// Spec: lowercase letters, numbers, and hyphens; no leading/trailing hyphen; no consecutive hyphens.
const SKILL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SKILLS_CACHE_TTL_MS = 60_000;
const MAX_TEXT_BYTES = 200_000; // safety limit for tool outputs

let skillsCache:
  | { fetchedAtMs: number; skills: SkillMetadata[] }
  | null = null;

function xmlEscape(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function countIndent(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 2;
    else break;
  }
  return n;
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function extractYamlFrontmatter(
  markdown: string,
): { yaml: string; body: string } | null {
  const text = markdown.replace(/^\uFEFF/, ""); // strip BOM if present
  if (!text.startsWith("---")) return null;

  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  if (lines.length < 3) return null;
  if (lines[0].trim() !== "---") return null;

  let endIx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIx = i;
      break;
    }
  }
  if (endIx === -1) return null;

  const yaml = lines.slice(1, endIx).join("\n");
  const body = lines.slice(endIx + 1).join("\n").trimStart();
  return { yaml, body };
}

/**
 * Minimal YAML parser for Agent Skills frontmatter.
 * Supports:
 * - root `key: value` (string)
 * - root `key:` + one-level indented map or list
 * - block scalars `|` / `>` (treated as newline-joined text)
 *
 * It intentionally does NOT implement full YAML.
 */
function parseSimpleYamlFrontmatter(yaml: string): Record<string, unknown> {
  const lines = yaml.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const out: Record<string, unknown> = {};

  const nextNonEmpty = (start: number): number | null => {
    for (let i = start; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t || t.startsWith("#")) continue;
      return i;
    }
    return null;
  };

  const readBlockText = (
    start: number,
    minIndent: number,
  ): { value: string; nextIndex: number } => {
    const buf: string[] = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      const t = line.trimEnd();
      if (!t.trim()) {
        buf.push("");
        i++;
        continue;
      }
      const ind = countIndent(line);
      if (ind < minIndent) break;
      buf.push(line.slice(Math.min(minIndent, line.length)));
      i++;
    }
    return { value: buf.join("\n").trimEnd(), nextIndex: i };
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const indent = countIndent(raw);
    if (indent !== 0) {
      // Ignore unexpected indentation at root.
      i++;
      continue;
    }

    const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }

    const key = m[1];
    const rest = (m[2] ?? "").trim();

    if (rest === "|" || rest === ">") {
      const nextIx = nextNonEmpty(i + 1);
      if (nextIx === null) {
        out[key] = "";
        i++;
        continue;
      }
      const blockIndent = countIndent(lines[nextIx]);
      if (blockIndent <= indent) {
        out[key] = "";
        i = nextIx;
        continue;
      }
      const block = readBlockText(nextIx, blockIndent);
      out[key] = block.value;
      i = block.nextIndex;
      continue;
    }

    if (rest) {
      out[key] = stripQuotes(rest);
      i++;
      continue;
    }

    // key:  (indented block)
    const startIx = nextNonEmpty(i + 1);
    if (startIx === null) {
      out[key] = "";
      i++;
      continue;
    }
    const blockIndent = countIndent(lines[startIx]);
    if (blockIndent <= indent) {
      out[key] = "";
      i = startIx;
      continue;
    }

    const firstLine = lines[startIx].trim();
    if (firstLine.startsWith("- ")) {
      // Parse list
      const items: string[] = [];
      let j = startIx;
      while (j < lines.length) {
        const line = lines[j];
        const t = line.trim();
        if (!t || t.startsWith("#")) {
          j++;
          continue;
        }
        const ind = countIndent(line);
        if (ind < blockIndent) break;
        if (ind !== blockIndent) {
          j++;
          continue;
        }
        if (t.startsWith("- ")) {
          items.push(stripQuotes(t.slice(2)));
        }
        j++;
      }
      out[key] = items;
      i = j;
      continue;
    }

    // Parse one-level map
    const obj: Record<string, string> = {};
    let j = startIx;
    while (j < lines.length) {
      const line = lines[j];
      const t = line.trim();
      if (!t || t.startsWith("#")) {
        j++;
        continue;
      }
      const ind = countIndent(line);
      if (ind < blockIndent) break;
      if (ind !== blockIndent) {
        j++;
        continue;
      }
      const mm = t.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!mm) {
        j++;
        continue;
      }
      const subKey = mm[1];
      const subRest = (mm[2] ?? "").trim();
      if (subRest === "|" || subRest === ">") {
        const k = nextNonEmpty(j + 1);
        if (k === null) {
          obj[subKey] = "";
          j++;
          continue;
        }
        const subIndent = countIndent(lines[k]);
        const block = readBlockText(k, subIndent);
        obj[subKey] = block.value;
        j = block.nextIndex;
        continue;
      }
      obj[subKey] = stripQuotes(subRest);
      j++;
    }
    out[key] = obj;
    i = j;
  }

  return out;
}

export function assertValidSkillSlug(input: string): string {
  const slug = String(input ?? "").trim();
  if (!slug) throw new Error("Skill name is required");
  if (slug.length > 64) throw new Error("Skill name is too long (max 64)");
  if (!SKILL_SLUG_RE.test(slug)) {
    throw new Error(
      "Invalid skill name (must be lowercase letters/numbers and hyphens)",
    );
  }
  return slug;
}

export function sanitizeSkillResourcePath(inputPath: string): string {
  const normalized = String(inputPath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");

  if (!normalized || normalized.includes("..")) {
    throw new Error("Invalid skill resource path");
  }

  const parts = normalized.split("/").filter(Boolean);
  // Keep file references one-level deep from SKILL.md (guidance from spec).
  if (parts.length > 2) {
    throw new Error(
      "Skill resource path is too deep (use root files or one-level paths like references/REFERENCE.md)",
    );
  }

  const ext = (parts[parts.length - 1] ?? "").split(".").pop()?.toLowerCase();
  const binaryExts = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "pdf",
    "zip",
    "tar",
    "gz",
    "bz2",
    "7z",
    "mp3",
    "mp4",
    "webm",
  ]);
  if (ext && binaryExts.has(ext)) {
    throw new Error("Only text-based skill resources can be read");
  }

  return parts.join("/");
}

function enforceMaxTextBytes(label: string, text: string): string {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes <= MAX_TEXT_BYTES) return text;
  throw new Error(`${label} is too large to return (${bytes} bytes)`);
}

export function getSkillsUsageInstructions(): string {
  return (
    "Load a skill to get detailed instructions for a specific task. " +
    "Skills provide specialized knowledge and step-by-step guidance. " +
    "Use this when a task matches an available skill's description. " +
    "Do not guess skill content; always load explicitly."
  );
}

export function renderAvailableSkillsXml(skills: ReadonlyArray<SkillMetadata>): string {
  if (!skills?.length) return "";

  const joinList = (value: unknown): string => {
    if (Array.isArray(value)) {
      return value.map((x) => String(x)).filter((x) => x.trim()).join(", ");
    }
    return String(value ?? "");
  };

  const lines: string[] = ["<available_skills>"];
  for (const skill of skills) {
    const slug = String(skill?.slug ?? "").trim();
    const description = String(skill?.description ?? "");
    const compatibility = skill?.compatibility;
    const allowedTools = skill?.allowed_tools;

    lines.push("<skill>");
    lines.push(`<name>${xmlEscape(slug)}</name>`);
    lines.push(`<description>${xmlEscape(description)}</description>`);
    lines.push(
      `<location>${xmlEscape(`${SKILLS_PREFIX}/${slug}/${SKILL_ENTRYPOINT}`)}</location>`,
    );
    if (compatibility && joinList(compatibility).trim()) {
      lines.push(`<compatibility>${xmlEscape(joinList(compatibility))}</compatibility>`);
    }
    if (allowedTools?.length) {
      lines.push(
        `<allowed-tools>${xmlEscape(joinList(allowedTools))}</allowed-tools>`,
      );
    }
    lines.push("</skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

export async function loadSkillFile(slug: string): Promise<string> {
  const safeSlug = assertValidSkillSlug(slug);
  const objectPath = `${SKILLS_PREFIX}/${safeSlug}/${SKILL_ENTRYPOINT}`;
  const content = await downloadTextFromWorkspace(objectPath);
  if (content === null) throw new Error(`Skill not found: ${safeSlug}`);
  return enforceMaxTextBytes(`Skill ${safeSlug}/${SKILL_ENTRYPOINT}`, content);
}

async function loadSkillMetadata(slug: string): Promise<SkillMetadata | null> {
  const safeSlug = assertValidSkillSlug(slug);
  const objectPath = `${SKILLS_PREFIX}/${safeSlug}/${SKILL_ENTRYPOINT}`;
  const raw = await downloadTextFromWorkspace(objectPath);
  if (raw === null) return null;

  const fm = extractYamlFrontmatter(raw);
  if (!fm) return null;

  const parsed = parseSimpleYamlFrontmatter(fm.yaml);
  const name = typeof parsed["name"] === "string"
    ? String(parsed["name"]).trim()
    : "";
  const description = typeof parsed["description"] === "string"
    ? String(parsed["description"]).trim()
    : "";

  // Validate required fields per spec (and enforce name matches directory).
  if (!name || !description) return null;
  if (name !== safeSlug) return null;

  const license = typeof parsed["license"] === "string"
    ? String(parsed["license"]).trim()
    : undefined;

  const compatibilityRaw = parsed["compatibility"];
  const compatibility = typeof compatibilityRaw === "string"
    ? compatibilityRaw.trim()
    : Array.isArray(compatibilityRaw)
    ? compatibilityRaw.map((x) => String(x)).filter((x) => x.trim())
    : undefined;

  const allowedRaw = (parsed["allowed-tools"] ?? parsed["allowed_tools"]);
  const allowed_tools = typeof allowedRaw === "string"
    ? allowedRaw.split(/\s+/).map((x) => x.trim()).filter(Boolean)
    : Array.isArray(allowedRaw)
    ? allowedRaw.map((x) => String(x)).filter((x) => x.trim())
    : undefined;

  const metadataRaw = parsed["metadata"];
  const metadata = (metadataRaw &&
      typeof metadataRaw === "object" &&
      !Array.isArray(metadataRaw))
    ? Object.fromEntries(
      Object.entries(metadataRaw as Record<string, unknown>)
        .map(([k, v]) => [String(k), String(v ?? "")] as const)
        .filter(([k, v]) => k.trim() && v.trim()),
    )
    : undefined;

  return {
    slug: safeSlug,
    description,
    license,
    compatibility,
    allowed_tools,
    metadata,
    source_type: "workspace",
  };
}

export async function initializeSkills(
  slugs?: ReadonlyArray<string>,
  options?: { forceRefresh?: boolean },
): Promise<SkillMetadata[]> {
  const now = Date.now();
  if (
    !options?.forceRefresh && skillsCache &&
    (now - skillsCache.fetchedAtMs) < SKILLS_CACHE_TTL_MS &&
    !slugs?.length
  ) {
    return skillsCache.skills;
  }

  const resolvedSlugs = slugs?.length
    ? slugs.map((s) => assertValidSkillSlug(s))
    : await (async () => {
      const { objects } = await listWorkspaceObjects(SKILLS_PREFIX);
      const candidates = objects.map((o) => String(o?.name ?? "").trim());
      const unique = Array.from(new Set(
        candidates.filter((name) =>
          name.length <= 64 && SKILL_SLUG_RE.test(name)
        ),
      ));
      unique.sort();
      return unique;
    })();

  // Load metadata for each slug (best-effort).
  const metas: SkillMetadata[] = [];
  const results = await Promise.all(
    resolvedSlugs.map(async (slug) => {
      try {
        return await loadSkillMetadata(slug);
      } catch {
        return null;
      }
    }),
  );
  for (const r of results) {
    if (r) metas.push(r);
  }

  if (!slugs?.length) {
    skillsCache = { fetchedAtMs: now, skills: metas };
  }

  return metas;
}

export async function buildSkillsInstructionsBlock(): Promise<string> {
  const skills = await initializeSkills().catch(() => []);
  if (!skills.length) return "";

  return `\n\n${getSkillsUsageInstructions()}\n\n${renderAvailableSkillsXml(skills)}`;
}

export async function readSkillResource(
  slug: string,
  resourcePath: string,
): Promise<string> {
  const safeSlug = assertValidSkillSlug(slug);
  const safePath = sanitizeSkillResourcePath(resourcePath);
  const objectPath = `${SKILLS_PREFIX}/${safeSlug}/${safePath}`;
  const content = await downloadTextFromWorkspace(objectPath);
  if (content === null) {
    throw new Error(`Skill resource not found: ${safeSlug}/${safePath}`);
  }
  return enforceMaxTextBytes(`Skill resource ${safeSlug}/${safePath}`, content);
}

