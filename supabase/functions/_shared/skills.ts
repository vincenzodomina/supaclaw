import {
  downloadTextFromWorkspace,
  listWorkspaceObjects,
  uploadFileToWorkspace,
  writeWorkspaceText,
} from "./storage.ts";

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
  const lines = yaml.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split(
    "\n",
  );
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

export function renderAvailableSkillsXml(
  skills: ReadonlyArray<SkillMetadata>,
): string {
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
      `<location>${
        xmlEscape(`${SKILLS_PREFIX}/${slug}/${SKILL_ENTRYPOINT}`)
      }</location>`,
    );
    if (compatibility && joinList(compatibility).trim()) {
      lines.push(
        `<compatibility>${xmlEscape(joinList(compatibility))}</compatibility>`,
      );
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

  const allowedRaw = parsed["allowed-tools"] ?? parsed["allowed_tools"];
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
      const unique = Array.from(
        new Set(
          candidates.filter((name) =>
            name.length <= 64 && SKILL_SLUG_RE.test(name)
          ),
        ),
      );
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

  return `\n\n${getSkillsUsageInstructions()}\n\n${
    renderAvailableSkillsXml(skills)
  }`;
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

export function parseSkillEntrypoint(markdown: string): SkillMetadata {
  const fm = extractYamlFrontmatter(markdown);
  if (!fm) {
    throw new Error(
      "Invalid SKILL.md: missing YAML frontmatter. Expected a leading `---` block with at least `name` and `description`.",
    );
  }

  const parsed = parseSimpleYamlFrontmatter(fm.yaml);
  const name = typeof parsed["name"] === "string"
    ? String(parsed["name"]).trim()
    : "";
  const description = typeof parsed["description"] === "string"
    ? String(parsed["description"]).trim()
    : "";

  if (!name) {
    throw new Error(
      "Invalid SKILL.md: frontmatter is missing required field `name`.",
    );
  }
  if (!description) {
    throw new Error(
      "Invalid SKILL.md: frontmatter is missing required field `description`.",
    );
  }

  const slug = assertValidSkillSlug(name);

  const license = typeof parsed["license"] === "string"
    ? String(parsed["license"]).trim()
    : undefined;

  const compatibilityRaw = parsed["compatibility"];
  const compatibility = typeof compatibilityRaw === "string"
    ? compatibilityRaw.trim()
    : Array.isArray(compatibilityRaw)
    ? compatibilityRaw.map((x) => String(x)).filter((x) => x.trim())
    : undefined;

  const allowedRaw = parsed["allowed-tools"] ?? parsed["allowed_tools"];
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
    slug,
    description,
    license,
    compatibility,
    allowed_tools,
    metadata,
    source_type: "workspace",
  };
}

export function invalidateSkillsCache() {
  skillsCache = null;
}

type InstallOk = {
  ok: true;
  type: "skill-install";
  name: string;
  written_paths: string[];
  source: "content" | "url";
  url?: string;
  warnings?: string[];
};

type InstallErr = {
  ok: false;
  error: string;
  message: string;
  step?: string;
  details?: Record<string, unknown>;
};

type InstallResult = InstallOk | InstallErr;

type Result<T> = { ok: true; value: T } | InstallErr;

export function installError(
  error: string,
  message: string,
  step?: string,
  details?: Record<string, unknown>,
): InstallErr {
  return { ok: false, error, message, step, details };
}

function decodeUrlSegment(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function stripGitSuffix(repo: string): string {
  return repo.toLowerCase().endsWith(".git") ? repo.slice(0, -4) : repo;
}

function encodeGitHubPath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function fetchTextLimited(
  res: Response,
  maxChars = 2_000,
): Promise<string> {
  const text = await res.text().catch(() => "");
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + "…";
}

async function githubFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const token = (Deno.env.get("GITHUB_TOKEN") ?? "").trim();
  const headers = new Headers(init?.headers);
  headers.set("User-Agent", "SupaClaw (skills installer)");
  headers.set("Accept", headers.get("Accept") || "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return await fetch(url, { ...init, headers });
}

async function githubRefExists(
  owner: string,
  repo: string,
  ref: string,
): Promise<boolean | InstallErr> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${
    encodeURIComponent(repo)
  }/commits/${encodeURIComponent(ref)}`;
  let res: Response;
  try {
    res = await githubFetch(url, { method: "GET" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return installError(
      "github_fetch_failed",
      `Failed to call GitHub API while resolving the ref. ${msg}`,
      "resolve_ref",
      { owner, repo, ref },
    );
  }
  if (res.status === 404) return false;
  if (res.ok) return true;
  const detail = await fetchTextLimited(res);
  return installError(
    "github_ref_check_failed",
    `GitHub ref check failed (${res.status}). ${
      detail ? `Detail: ${detail}` : ""
    }`.trim(),
    "resolve_ref",
    { owner, repo, ref, status: res.status },
  );
}

async function resolveGitHubRefAndPath(params: {
  owner: string;
  repo: string;
  rest: string[];
}): Promise<Result<{ ref: string; path: string }>> {
  const rest = params.rest.filter((s) => s.trim());
  if (!rest.length) {
    return installError(
      "invalid_github_url",
      "GitHub URL is missing the ref segment (branch/tag/sha).",
      "parse_url",
      { owner: params.owner, repo: params.repo },
    );
  }

  const maxRefSegments = Math.min(rest.length, 10);
  for (let n = maxRefSegments; n >= 1; n--) {
    const candidate = rest.slice(0, n).join("/");
    const exists = await githubRefExists(params.owner, params.repo, candidate);
    if (typeof exists !== "boolean") return exists;
    if (exists) {
      return {
        ok: true,
        value: { ref: candidate, path: rest.slice(n).join("/") },
      };
    }
  }

  return installError(
    "github_ref_not_found",
    "Could not resolve the GitHub ref from this URL. If your branch name contains slashes, try using a URL that points to a specific commit SHA, or a raw.githubusercontent.com URL.",
    "resolve_ref",
    { owner: params.owner, repo: params.repo, rest: params.rest },
  );
}

type GitHubUrlTarget = {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
  mode: "dir" | "file";
  original_url: string;
};

async function parseGitHubUrl(raw: string): Promise<Result<GitHubUrlTarget>> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return installError(
      "invalid_url",
      "Invalid URL: must be fully qualified (e.g. https://github.com/owner/repo/tree/main/skill).",
      "parse_url",
      { url: raw },
    );
  }

  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean).map(decodeUrlSegment);

  if (host === "github.com" || host === "www.github.com") {
    if (parts.length < 2) {
      return installError(
        "invalid_github_url",
        "Invalid GitHub URL: expected https://github.com/<owner>/<repo>/...",
        "parse_url",
        { url: raw },
      );
    }
    const owner = parts[0] ?? "";
    const repo = stripGitSuffix(parts[1] ?? "");
    const op = parts[2] ?? "";

    if (!op) {
      return {
        ok: true,
        value: {
          owner,
          repo,
          ref: undefined,
          path: "",
          mode: "dir",
          original_url: raw,
        },
      };
    }

    if (op !== "tree" && op !== "blob" && op !== "raw") {
      return installError(
        "unsupported_github_url",
        "Unsupported GitHub URL. Use a repo URL, a /tree/<ref>/<path> folder URL, or a /blob/<ref>/<path>/SKILL.md URL.",
        "parse_url",
        { url: raw },
      );
    }

    const resolved = await resolveGitHubRefAndPath({
      owner,
      repo,
      rest: parts.slice(3),
    });
    if (!resolved.ok) return resolved;

    const mode: "dir" | "file" = op === "tree" ? "dir" : "file";
    return {
      ok: true,
      value: {
        owner,
        repo,
        ref: resolved.value.ref,
        path: resolved.value.path,
        mode,
        original_url: raw,
      },
    };
  }

  if (host === "raw.githubusercontent.com") {
    if (parts.length < 4) {
      return installError(
        "invalid_github_url",
        "Invalid raw.githubusercontent.com URL. Expected https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>/SKILL.md",
        "parse_url",
        { url: raw },
      );
    }
    const owner = parts[0] ?? "";
    const repo = stripGitSuffix(parts[1] ?? "");
    const ref = parts[2] ?? "";
    const path = parts.slice(3).join("/");
    return {
      ok: true,
      value: { owner, repo, ref, path, mode: "file", original_url: raw },
    };
  }

  return installError(
    "unsupported_url",
    "Only GitHub URLs are supported for skills install (github.com or raw.githubusercontent.com).",
    "parse_url",
    { url: raw, host: url.hostname },
  );
}

async function githubGetContents(params: {
  owner: string;
  repo: string;
  ref?: string;
  path: string;
}): Promise<Result<unknown>> {
  const base = `https://api.github.com/repos/${
    encodeURIComponent(params.owner)
  }/${encodeURIComponent(params.repo)}/contents`;
  const url = new URL(
    params.path ? `${base}/${encodeGitHubPath(params.path)}` : base,
  );
  if (params.ref) url.searchParams.set("ref", params.ref);

  let res: Response;
  try {
    res = await githubFetch(url.toString(), { method: "GET" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return installError(
      "github_fetch_failed",
      `Failed to call GitHub API. ${msg}`,
      "list_contents",
      {
        owner: params.owner,
        repo: params.repo,
        ref: params.ref,
        path: params.path,
      },
    );
  }
  if (res.status === 404) {
    return installError(
      "github_not_found",
      "GitHub path not found (404). Double-check the ref and path in the URL.",
      "list_contents",
      {
        owner: params.owner,
        repo: params.repo,
        ref: params.ref,
        path: params.path,
      },
    );
  }
  if (!res.ok) {
    const detail = await fetchTextLimited(res);
    return installError(
      "github_api_failed",
      `GitHub API request failed (${res.status}). ${
        detail ? `Detail: ${detail}` : ""
      }`.trim(),
      "list_contents",
      {
        owner: params.owner,
        repo: params.repo,
        ref: params.ref,
        path: params.path,
        status: res.status,
      },
    );
  }

  try {
    return { ok: true, value: await res.json() };
  } catch {
    const detail = await fetchTextLimited(res);
    return installError(
      "github_api_invalid_json",
      `GitHub API returned non-JSON content. ${
        detail ? `Detail: ${detail}` : ""
      }`.trim(),
      "list_contents",
      {
        owner: params.owner,
        repo: params.repo,
        ref: params.ref,
        path: params.path,
      },
    );
  }
}

type GitHubContentItem = {
  type?: string;
  path?: string;
  name?: string;
  size?: number;
  download_url?: string | null;
  url?: string;
};

async function githubListFilesRec(params: {
  owner: string;
  repo: string;
  ref?: string;
  root: string;
}): Promise<
  Result<{ files: GitHubContentItem[]; warnings: string[] }>
> {
  const stack: string[] = [params.root];
  const seen = new Set<string>();
  const files: GitHubContentItem[] = [];
  const warnings: string[] = [];

  while (stack.length) {
    const dir = stack.pop() ?? "";
    const key = dir || ".";
    if (seen.has(key)) continue;
    seen.add(key);

    const data = await githubGetContents({
      owner: params.owner,
      repo: params.repo,
      ref: params.ref,
      path: dir,
    });
    if (!data.ok) return data;

    if (Array.isArray(data.value)) {
      for (const entry of data.value) {
        const item = entry as GitHubContentItem;
        const t = String(item.type ?? "");
        const p = String(item.path ?? "");
        if (t === "dir") {
          if (p) stack.push(p);
          continue;
        }
        if (t === "file") {
          files.push(item);
          continue;
        }
        if (t) {
          warnings.push(
            `Skipped unsupported GitHub entry type: ${t}${p ? ` (${p})` : ""}`,
          );
        }
      }
      continue;
    }

    const obj = data.value as GitHubContentItem;
    const t = String(obj?.type ?? "");
    if (t === "dir") {
      stack.push(String(obj.path ?? dir));
      continue;
    }
    if (t === "file") {
      files.push(obj);
      continue;
    }
    return installError(
      "github_unexpected_response",
      "GitHub API returned an unexpected response shape when listing contents.",
      "list_contents",
      { owner: params.owner, repo: params.repo, ref: params.ref, path: dir },
    );
  }

  return { ok: true, value: { files, warnings } };
}

async function githubDownloadBytes(
  item: GitHubContentItem,
): Promise<Result<Uint8Array>> {
  const maxFileBytes = 5 * 1024 * 1024; // 5MB per file safety limit
  if (
    typeof item.size === "number" && Number.isFinite(item.size) &&
    item.size > maxFileBytes
  ) {
    return installError(
      "github_file_too_large",
      `GitHub file is too large to install (${item.size} bytes > ${maxFileBytes}).`,
      "download_file",
      { path: item.path, size: item.size, max_bytes: maxFileBytes },
    );
  }

  const downloadUrl = (item.download_url ?? "").trim();
  const apiUrl = item.url ? String(item.url).trim() : "";
  const candidates = [
    ...(downloadUrl
      ? [{ url: downloadUrl, accept: "application/octet-stream" }]
      : []),
    ...(apiUrl && apiUrl !== downloadUrl
      ? [{ url: apiUrl, accept: "application/vnd.github.raw" }]
      : []),
  ];
  if (!candidates.length) {
    return installError(
      "github_missing_download_url",
      "GitHub API did not provide a download URL for a file entry.",
      "download_file",
      { path: item.path },
    );
  }

  let last: { url: string; status: number; detail: string } | null = null;
  for (const candidate of candidates) {
    let res: Response;
    try {
      res = await githubFetch(candidate.url, {
        method: "GET",
        headers: { Accept: candidate.accept },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      last = { url: candidate.url, status: 0, detail: msg };
      continue;
    }
    if (!res.ok) {
      last = {
        url: candidate.url,
        status: res.status,
        detail: await fetchTextLimited(res),
      };
      continue;
    }

    let buf: ArrayBuffer;
    try {
      buf = await res.arrayBuffer();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      last = { url: candidate.url, status: res.status, detail: msg };
      continue;
    }
    if (buf.byteLength > maxFileBytes) {
      return installError(
        "github_file_too_large",
        `GitHub file exceeded size limit after download (${buf.byteLength} bytes > ${maxFileBytes}).`,
        "download_file",
        { path: item.path, bytes: buf.byteLength, max_bytes: maxFileBytes },
      );
    }
    return { ok: true, value: new Uint8Array(buf) };
  }

  return installError(
    "github_download_failed",
    `Failed to download GitHub file. Last attempt (${
      last?.status ?? "unknown"
    }): ${last?.detail ?? ""}`
      .trim(),
    "download_file",
    {
      path: item.path,
      tried: candidates.map((c) => c.url),
      last_status: last?.status,
      last_url: last?.url,
    },
  );
}

function relFromRoot(fullPath: string, root: string): string | InstallErr {
  const full = String(fullPath ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
  const base = String(root ?? "").replaceAll("\\", "/").replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!full) {
    return installError(
      "invalid_path",
      "Missing file path from GitHub API.",
      "write_files",
    );
  }
  if (full.includes("..")) {
    return installError(
      "invalid_path",
      "Blocked GitHub path containing '..'.",
      "write_files",
      { path: fullPath },
    );
  }
  if (!base) return full;
  if (full === base) return "";
  if (!full.startsWith(base + "/")) {
    return installError(
      "invalid_path",
      "GitHub file path is outside the requested skill folder.",
      "write_files",
      { path: full, root: base },
    );
  }
  return full.slice(base.length + 1);
}

export async function installSkillFromContent(params: {
  content: string;
  overwrite?: boolean;
}): Promise<InstallResult> {
  const content = params.content ?? "";
  if (!content.trim()) {
    return installError(
      "invalid_content",
      "content must be a non-empty string containing a SKILL.md file.",
      "validate_input",
    );
  }

  let meta: { slug: string };
  try {
    meta = parseSkillEntrypoint(content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return installError("invalid_skill_md", msg, "parse_skill_md");
  }

  const slug = meta.slug;
  const dest = `.agents/skills/${slug}/SKILL.md`;
  const exists = await downloadTextFromWorkspace(dest, { optional: true });
  if (exists !== null && params.overwrite !== true) {
    return installError(
      "skill_exists",
      `Skill already exists: ${slug}. Re-run with overwrite=true to replace it.`,
      "check_exists",
      { name: slug, path: dest },
    );
  }

  try {
    const written = await writeWorkspaceText(dest, content, {
      mimeType: "text/markdown; charset=utf-8",
    });
    invalidateSkillsCache();
    return {
      ok: true,
      type: "skill-install",
      name: slug,
      written_paths: [written.objectPath],
      source: "content",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return installError(
      "workspace_write_failed",
      `Failed to write SKILL.md into workspace storage. ${msg}`,
      "write_files",
      { path: dest, name: slug },
    );
  }
}

export async function installSkillFromUrl(params: {
  url: string;
  overwrite?: boolean;
}): Promise<InstallResult> {
  const raw = (params.url ?? "").trim();
  if (!raw) {
    return installError(
      "invalid_url",
      "url must be a non-empty string.",
      "validate_input",
    );
  }

  const parsed = await parseGitHubUrl(raw);
  if (!parsed.ok) return parsed;
  const target = parsed.value;

  const isSkillMd = target.mode === "file";
  const skillMdPath = (() => {
    if (!isSkillMd) return "";
    const p = (target.path ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
    return p;
  })();

  if (isSkillMd && !skillMdPath.toLowerCase().endsWith("skill.md")) {
    return installError(
      "invalid_github_url",
      "GitHub URL must point to SKILL.md (or use a folder URL that contains SKILL.md).",
      "parse_url",
      { url: target.original_url, path: skillMdPath },
    );
  }

  const root = (() => {
    const p = (target.path ?? "").replaceAll("\\", "/").replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (target.mode === "dir") return p;
    return p.split("/").slice(0, -1).join("/");
  })();

  const expectedSkill = root ? `${root}/SKILL.md` : "SKILL.md";
  const skillData = await githubGetContents({
    owner: target.owner,
    repo: target.repo,
    ref: target.ref,
    path: expectedSkill,
  });
  if (!skillData.ok) return skillData;

  const skillItem = skillData.value as GitHubContentItem;
  if (!skillItem || String(skillItem.type ?? "") !== "file") {
    return installError(
      "skill_md_not_found",
      "SKILL.md was not found at the provided GitHub folder URL. Point the URL to the skill folder that directly contains SKILL.md, or directly to SKILL.md.",
      "locate_skill",
      { url: target.original_url, expected: expectedSkill },
    );
  }

  const skillBytes = await githubDownloadBytes(skillItem);
  if (!skillBytes.ok) return skillBytes;

  let skillMd: string;
  try {
    skillMd = new TextDecoder("utf-8", { fatal: true }).decode(
      skillBytes.value,
    );
  } catch {
    return installError(
      "invalid_skill_md",
      "SKILL.md could not be decoded as UTF-8 text.",
      "parse_skill_md",
      { url: target.original_url, path: expectedSkill },
    );
  }

  let meta: { slug: string };
  try {
    meta = parseSkillEntrypoint(skillMd);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return installError("invalid_skill_md", msg, "parse_skill_md", {
      url: target.original_url,
      path: expectedSkill,
    });
  }

  const slug = meta.slug;
  const destRoot = `.agents/skills/${slug}`;
  const destSkill = `${destRoot}/SKILL.md`;
  const exists = await downloadTextFromWorkspace(destSkill, { optional: true });
  if (exists !== null && params.overwrite !== true) {
    return installError(
      "skill_exists",
      `Skill already exists: ${slug}. Re-run with overwrite=true to replace it.`,
      "check_exists",
      { name: slug, path: destSkill },
    );
  }

  const listed = await githubListFilesRec({
    owner: target.owner,
    repo: target.repo,
    ref: target.ref,
    root,
  });
  if (!listed.ok) return listed;
  const files = listed.value.files;
  const listedWarnings = listed.value.warnings;

  const maxFiles = 200;
  if (files.length > maxFiles) {
    return installError(
      "skill_too_large",
      `Skill folder contains too many files to install (${files.length} > ${maxFiles}).`,
      "list_contents",
      {
        url: target.original_url,
        files: files.length,
        max_files: maxFiles,
        root,
      },
    );
  }

  const written_paths: string[] = [];
  const warnings: string[] = [...listedWarnings];

  const entries: Array<GitHubContentItem & { path: string }> = files
    .map((f: GitHubContentItem) => ({ ...f, path: String(f.path ?? "") }))
    .filter((f: GitHubContentItem & { path: string }) => f.path);

  entries.sort(
    (
      a: GitHubContentItem & { path: string },
      b: GitHubContentItem & { path: string },
    ) => {
      const ar = relFromRoot(a.path, root);
      const br = relFromRoot(b.path, root);
      const aSkill = typeof ar === "string" && ar.toLowerCase() === "skill.md";
      const bSkill = typeof br === "string" && br.toLowerCase() === "skill.md";
      if (aSkill === bSkill) return a.path.localeCompare(b.path);
      return aSkill ? 1 : -1; // write SKILL.md last
    },
  );

  const maxTotalBytes = 25 * 1024 * 1024; // 25MB safety limit across all files
  let totalBytes = 0;

  for (const item of entries) {
    const rel = relFromRoot(item.path ?? "", root);
    if (typeof rel === "object") return rel;
    if (!rel) continue;

    const out = `${destRoot}/${rel}`;
    const downloaded = await githubDownloadBytes(item);
    if (!downloaded.ok) return downloaded;

    totalBytes += downloaded.value.byteLength;
    if (totalBytes > maxTotalBytes) {
      return installError(
        "skill_too_large",
        `Skill folder is too large to install (exceeded ${maxTotalBytes} bytes).`,
        "download_file",
        {
          url: target.original_url,
          name: slug,
          max_bytes: maxTotalBytes,
          total_bytes: totalBytes,
        },
      );
    }

    const decoded = (() => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(
          downloaded.value,
        );
      } catch {
        return null;
      }
    })();

    try {
      if (decoded !== null) {
        const mimeType = rel.toLowerCase().endsWith(".md")
          ? "text/markdown; charset=utf-8"
          : "text/plain; charset=utf-8";
        const written = await writeWorkspaceText(out, decoded, { mimeType });
        written_paths.push(written.objectPath);
      } else {
        const uploaded = await uploadFileToWorkspace(out, downloaded.value, {
          defaultMimeType: "application/octet-stream",
        });
        written_paths.push(uploaded.objectPath);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return installError(
        "workspace_write_failed",
        `Failed to write skill file to workspace storage. ${msg}`,
        "write_files",
        {
          name: slug,
          path: out,
          source_path: item.path,
          url: target.original_url,
        },
      );
    }
  }

  invalidateSkillsCache();
  return {
    ok: true,
    type: "skill-install",
    name: slug,
    written_paths,
    source: "url",
    url: target.original_url,
    ...(warnings.length ? { warnings } : {}),
  };
}
