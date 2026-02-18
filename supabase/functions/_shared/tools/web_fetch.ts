import { jsonSchema, tool } from "ai";
import TurndownService from "turndown";
import { logger } from "../logger.ts";
import { uploadTextToWorkspace } from "../storage.ts";

const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB
const MAX_OUTPUT_LINES = 2000;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_REDIRECTS = 5;

type WebFetchArgs = {
  url: string;
  format?: "markdown" | "text" | "html";
  timeout_seconds?: number;
};

function redactUrlForLogs(input: URL): string {
  return `${input.origin}${input.pathname}`;
}

function parseHostPatterns(input: string | undefined): string[] {
  return (input ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function matchHost(host: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2).toLowerCase();
    const h = host.toLowerCase();
    return h === suffix || h.endsWith(`.${suffix}`);
  }
  return host.toLowerCase() === pattern.toLowerCase();
}

function isIpv4Literal(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function parseIpv4(host: string): number[] | null {
  if (!isIpv4Literal(host)) return null;
  const parts = host.split(".").map((x) => Number(x));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

function isPrivateIpv4(host: string): boolean {
  const ip = parseIpv4(host);
  if (!ip) return false;
  if (ip[0] === 10) return true;
  if (ip[0] === 127) return true;
  if (ip[0] === 0) return true;
  if (ip[0] === 169 && ip[1] === 254) return true;
  if (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) return true;
  if (ip[0] === 192 && ip[1] === 168) return true;
  if (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127) return true; // CGNAT
  return false;
}

function isLikelyLocalHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  if (h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true;
  if (h.endsWith(".internal")) return true;
  if (h === "metadata.google.internal") return true;
  return false;
}

function normalizeIpv6(host: string): string {
  const h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) return h.slice(1, -1);
  return h;
}

function isPrivateIpv6(host: string): boolean {
  const h = normalizeIpv6(host);
  if (!h.includes(":")) return false;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (h === "::" || h === "0:0:0:0:0:0:0:0") return true;
  if (h.startsWith("fe80:")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local (fc00::/7)

  const mapped = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : null;
  if (mapped && isPrivateIpv4(mapped)) return true;

  return false;
}

function validateTarget(url: URL): string | null {
  if (url.username || url.password) return "URL must not include username/password";
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "Only http(s) URLs are supported";
  }
  if (!url.hostname) return "URL is missing a hostname";
  if (isLikelyLocalHostname(url.hostname)) return "Blocked hostname";
  if (isPrivateIpv4(url.hostname)) return "Blocked private or local IP address";
  if (isPrivateIpv6(url.hostname)) return "Blocked private or local IP address";

  const deny = parseHostPatterns(Deno.env.get("WEB_FETCH_DENYLIST"));
  if (deny.some((p) => matchHost(url.hostname, p))) return "Blocked by denylist";

  const allow = parseHostPatterns(Deno.env.get("WEB_FETCH_ALLOWLIST"));
  if (allow.length > 0 && !allow.some((p) => matchHost(url.hostname, p))) {
    return "Blocked by allowlist";
  }

  return null;
}

function acceptHeader(format: WebFetchArgs["format"]): string {
  if (format === "text") {
    return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
  }
  if (format === "html") {
    return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
  }
  return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function htmlTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return normalizeWhitespace(decodeHtmlEntities(stripTags(m[1] ?? ""))) || null;
}

function resolveHref(href: string, base: URL): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function nodeName(node: unknown): string {
  const raw = (node as { nodeName?: unknown })?.nodeName;
  return typeof raw === "string" ? raw : "";
}

function nodeAttr(node: unknown, name: string): string {
  const fn = (node as { getAttribute?: unknown })?.getAttribute;
  if (typeof fn !== "function") return "";
  const value = (fn as (this: unknown, name: string) => unknown).call(node, name);
  return typeof value === "string" ? value : "";
}

function markdownToText(markdown: string): string {
  let text = markdown;
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, "");
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```[^\n]*\n?/g, "").replace(/```/g, ""),
  );
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  return normalizeWhitespace(text);
}

function htmlToMarkdown(html: string, base: URL): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });

  turndown.remove(["script", "style", "meta", "link", "noscript"]);

  turndown.addRule("absoluteLink", {
    filter: (node: unknown) =>
      nodeName(node).toLowerCase() === "a" && Boolean(nodeAttr(node, "href")),
    replacement: (content: string, node: unknown) => {
      const href = nodeAttr(node, "href").trim();
      const resolved = href ? resolveHref(href, base) : "";
      if (!resolved) return content;

      const label = content.trim();
      if (!label) return resolved;

      const escaped = resolved.replace(/([()])/g, "\\$1");
      const title = nodeAttr(node, "title").trim();
      const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
      return `[${label}](${escaped}${titlePart})`;
    },
  });

  turndown.addRule("absoluteImage", {
    filter: (node: unknown) =>
      nodeName(node).toLowerCase() === "img" && Boolean(nodeAttr(node, "src")),
    replacement: (_content: string, node: unknown) => {
      const src = nodeAttr(node, "src").trim();
      if (!src) return "";
      const resolved = resolveHref(src, base).replace(/([()])/g, "\\$1");

      const alt = nodeAttr(node, "alt");

      const title = nodeAttr(node, "title").trim();
      const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : "";

      return `![${alt}](${resolved}${titlePart})`;
    },
  });

  return turndown.turndown(html);
}

async function readBodyLimited(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; byteLength: number }> {
  const len = res.headers.get("content-length");
  if (len) {
    const n = Number(len);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(`Response too large (content-length ${n} > ${maxBytes})`);
    }
  }

  if (!res.body) return { bytes: new Uint8Array(), byteLength: 0 };

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new Error(`Response too large (exceeded ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: out, byteLength: total };
}

function truncateText(
  text: string,
  options: { maxBytes: number; maxLines: number },
): { content: string; truncated: boolean; removed: number; unit: "bytes" | "lines" } {
  const lines = text.split("\n");
  const enc = new TextEncoder();
  const totalBytes = enc.encode(text).byteLength;

  if (lines.length <= options.maxLines && totalBytes <= options.maxBytes) {
    return { content: text, truncated: false, removed: 0, unit: "bytes" };
  }

  const out: string[] = [];
  let bytes = 0;
  let i = 0;
  let hitBytes = false;

  for (i = 0; i < lines.length && i < options.maxLines; i++) {
    const line = lines[i] ?? "";
    const size = enc.encode(line).byteLength + (i > 0 ? 1 : 0);
    if (bytes + size > options.maxBytes) {
      hitBytes = true;
      break;
    }
    out.push(line);
    bytes += size;
  }

  const removed = hitBytes ? totalBytes - bytes : lines.length - out.length;
  const unit: "bytes" | "lines" = hitBytes ? "bytes" : "lines";
  return {
    content: out.join("\n"),
    truncated: true,
    removed,
    unit,
  };
}

async function fetchWithRedirects(params: {
  url: URL;
  init: RequestInit;
  maxRedirects: number;
}): Promise<{ response: Response; finalUrl: URL; redirects: number }> {
  let current = params.url;
  for (let i = 0; i <= params.maxRedirects; i++) {
    const err = validateTarget(current);
    if (err) throw new Error(`Blocked URL: ${err}`);

    const res = await fetch(current.toString(), { ...params.init, redirect: "manual" });
    if (
      (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 ||
        res.status === 308) && res.headers.has("location")
    ) {
      const loc = res.headers.get("location") ?? "";
      if (i >= params.maxRedirects) {
        throw new Error("Too many redirects");
      }
      current = new URL(loc, current);
      continue;
    }
    return { response: res, finalUrl: current, redirects: i };
  }
  throw new Error("Too many redirects");
}

export const webFetchTool = tool({
  description: [
    "Fetch content from a URL (read-only).",
    "",
    "Input:",
    "- url: fully qualified URL (http/https). http:// is upgraded to https:// by default.",
    '- format: "markdown" (default), "text", or "html".',
    "- timeout_seconds: optional, max 120 seconds.",
    "",
    "Safety:",
    "- Blocks localhost/private IPv4 ranges and common internal hostnames.",
    "- Optional env allow/deny lists:",
    '  - WEB_FETCH_ALLOWLIST="example.com,*.example.com" (if set, only these hosts are allowed)',
    '  - WEB_FETCH_DENYLIST="bad.com,*.bad.com" (always blocked)',
    "",
    "Large responses:",
    `- Max download: ${MAX_DOWNLOAD_BYTES} bytes.`,
    `- Tool output is truncated to ~${MAX_OUTPUT_BYTES} bytes / ${MAX_OUTPUT_LINES} lines; full output is saved to workspace storage under .agents/tool-output/web_fetch/ and the path is returned.`,
  ].join("\n"),
  inputSchema: jsonSchema<WebFetchArgs>({
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch." },
      format: {
        type: "string",
        enum: ["markdown", "text", "html"],
        description: 'Return format: "markdown" (default), "text", or "html".',
      },
      timeout_seconds: {
        type: "number",
        description: "Timeout in seconds (max 120).",
      },
    },
    required: ["url"],
    additionalProperties: false,
  }),
  execute: async ({ url, format, timeout_seconds }) => {
    const input = (url ?? "").trim();
    if (!input) return { error: "url is required" };

    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      return { error: "Invalid URL: must be fully qualified (e.g. https://example.com)" };
    }

    const upgradeHttp = Deno.env.get("WEB_FETCH_UPGRADE_HTTP") !== "false";
    const upgraded = upgradeHttp && parsed.protocol === "http:";
    if (upgraded) {
      parsed.protocol = "https:";
      if (parsed.port === "80") parsed.port = "";
    }

    const targetErr = validateTarget(parsed);
    if (targetErr) return { error: `Blocked URL: ${targetErr}` };

    const fmt = format ?? "markdown";
    const timeout = Math.min(
      Math.max(1, Math.floor(timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS)),
      MAX_TIMEOUT_SECONDS,
    );

    const headers: HeadersInit = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      Accept: acceptHeader(fmt),
      "Accept-Language": "en-US,en;q=0.9",
    };

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error("Timeout")), timeout * 1000);

    try {
      logger.debug("tool.web_fetch.start", {
        url: redactUrlForLogs(parsed),
        format: fmt,
        timeout_seconds: timeout,
      });

      const init: RequestInit = { method: "GET", headers, signal: abort.signal };
      const { response: initial, finalUrl, redirects } = await fetchWithRedirects({
        url: parsed,
        init,
        maxRedirects: MAX_REDIRECTS,
      });

      // Retry with honest UA if Cloudflare mitigation triggers (UA/TLS fingerprint mismatch).
      const response =
        initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
          ? await fetchWithRedirects({
            url: finalUrl,
            init: {
              ...init,
              headers: { ...headers, "User-Agent": "supaclaw" },
            },
            maxRedirects: 0,
          }).then((x) => x.response)
          : initial;

      if (!response.ok) {
        return {
          url: parsed.toString(),
          final_url: finalUrl.toString(),
          status: response.status,
          error: `Request failed with status ${response.status}`,
          redirects,
        };
      }

      const contentType = response.headers.get("content-type") ?? "";
      const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();

      const isTextLike =
        mime.startsWith("text/") ||
        mime === "application/json" ||
        mime.endsWith("+json") ||
        mime === "application/xml" ||
        mime.endsWith("+xml");

      if (!isTextLike) {
        return {
          url: parsed.toString(),
          final_url: finalUrl.toString(),
          status: response.status,
          content_type: contentType,
          error: `Unsupported content-type: ${contentType || "(missing)"}`,
          redirects,
        };
      }

      const { bytes, byteLength } = await readBodyLimited(response, MAX_DOWNLOAD_BYTES);
      const raw = new TextDecoder().decode(bytes);

      const title = mime.includes("html") ? (htmlTitle(raw) ?? null) : null;

      const fullContent = (() => {
        if (!mime.includes("html")) return raw;
        if (fmt === "html") return raw;
        const md = htmlToMarkdown(raw, finalUrl);
        if (fmt === "text") return markdownToText(md);
        return md;
      })();

      const truncated = truncateText(fullContent, {
        maxBytes: MAX_OUTPUT_BYTES,
        maxLines: MAX_OUTPUT_LINES,
      });

      let saved_path: string | null = null;
      if (truncated.truncated) {
        const ext = fmt === "html" ? "html" : fmt === "markdown" ? "md" : "txt";
        const path = `.agents/tool-output/web_fetch/${crypto.randomUUID()}.${ext}`;
        const mimeType = fmt === "html"
          ? "text/html; charset=utf-8"
          : fmt === "markdown"
          ? "text/markdown; charset=utf-8"
          : "text/plain; charset=utf-8";
        try {
          const uploaded = await uploadTextToWorkspace(path, fullContent, { mimeType });
          saved_path = uploaded.objectPath;
        } catch (e) {
          logger.warn("tool.web_fetch.save_failed", { error: e });
        }
      }

      const output = truncated.truncated
        ? `${truncated.content}\n\n...${truncated.removed} ${truncated.unit} truncated...\n\nFull output saved to: ${saved_path ?? "(save failed)"}`
        : truncated.content;

      logger.debug("tool.web_fetch.done", {
        url: redactUrlForLogs(parsed),
        final_url: redactUrlForLogs(finalUrl),
        status: response.status,
        content_type: contentType,
        bytes: byteLength,
        redirects,
        truncated: truncated.truncated,
        saved_path,
        upgraded_http: upgraded,
      });

      return {
        url: parsed.toString(),
        final_url: finalUrl.toString(),
        status: response.status,
        content_type: contentType,
        title,
        format: fmt,
        redirects,
        upgraded_http: upgraded,
        truncated: truncated.truncated,
        saved_path,
        bytes: byteLength,
        content: output,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn("tool.web_fetch.error", { error: e, message: msg });
      return { url: parsed.toString(), error: `web_fetch error: ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  },
});

