import { jsonSchema, tool } from "ai";
import { Bash, defineCommand, type CommandName } from "just-bash";
import { getConfigBoolean, getConfigNumber, getConfigString } from "../helpers.ts";
import { logger } from "../logger.ts";
import {
  decodeUtf8,
  downloadFile,
  listWorkspaceObjects,
  sanitizeObjectPath,
  sanitizeObjectPrefix,
  uploadFile,
} from "../storage.ts";

const DEFAULT_COMMANDS: CommandName[] = [
  "echo",
  "cat",
  "printf",
  "ls",
  "mkdir",
  "rmdir",
  "touch",
  "rm",
  "cp",
  "mv",
  "pwd",
  "readlink",
  "head",
  "tail",
  "wc",
  "stat",
  "grep",
  "fgrep",
  "egrep",
  "rg",
  "sed",
  "awk",
  "sort",
  "uniq",
  "comm",
  "cut",
  "paste",
  "tr",
  "rev",
  "nl",
  "fold",
  "expand",
  "unexpand",
  "strings",
  "split",
  "column",
  "join",
  "tee",
  "find",
  "basename",
  "dirname",
  "tree",
  "du",
  "env",
  "printenv",
  "alias",
  "unalias",
  "history",
  "xargs",
  "true",
  "false",
  "clear",
  "bash",
  "sh",
  "jq",
  "base64",
  "diff",
  "date",
  "sleep",
  "timeout",
  "seq",
  "expr",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "file",
  "html-to-markdown",
  "help",
  "which",
  "tac",
  "hostname",
  "od",
  "gzip",
  "gunzip",
  "zcat",
  "tar",
  "yq",
  "xan",
  "time",
  "whoami",
] as const;

const DEFAULT_EXECUTION_LIMITS = {
  maxCallDepth: 80,
  maxCommandCount: 15_000,
  maxLoopIterations: 20_000,
  maxAwkIterations: 20_000,
  maxSedIterations: 20_000,
  maxJqIterations: 20_000,
  maxGlobOperations: 200_000,
  maxStringLength: 10 * 1024 * 1024,
  maxArrayElements: 150_000,
  maxHeredocSize: 2 * 1024 * 1024,
  maxSubstitutionDepth: 50,
} as const;

const MAX_SCRIPT_BYTES = 80_000;
const MAX_IMPORT_FILES = 3_000;
const MAX_EXPORT_FILES = 2_000;

const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024; // 50KB
const DEFAULT_MAX_OUTPUT_LINES = 2_000;
const MAX_OUTPUT_SAVE_BYTES = 2 * 1024 * 1024; // 2MB

const SHELL_TTL_MS = 20 * 60_000; // 20 minutes best-effort in-memory persistence
const TOOL_OUTPUT_PREFIX = ".agents/tool-output/bash";

type BashAction = "exec" | "reset" | "info";

type BashArgs = {
  action?: BashAction;
  shell_id?: string;
  /**
   * Script to execute. When shell_id is provided, the filesystem persists between calls (best-effort).
   */
  script?: string;
  /**
   * Working directory within the virtual /workspace mount. Defaults to ".".
   */
  cwd?: string;
  stdin?: string;
  raw_script?: boolean;

  /**
   * Import workspace files (workspace-root-relative paths) into /workspace/**.
   * For large sets, prefer import_prefixes (recursive).
   */
  imports?: string[];
  /**
   * Import all files under these workspace prefixes (recursive).
   * Example: ["repo"] imports repo/**; [""] or ["."] imports the full workspace.
   */
  import_prefixes?: string[];

  /**
   * Export (write back) these files from /workspace/** into the workspace bucket.
   */
  exports?: string[];
  /**
   * Export (write back) all files under these /workspace prefixes (recursive).
   */
  export_prefixes?: string[];

  /**
   * Enable network commands (curl) with allow-listed URL prefixes.
   * When enabled, allow list is read from env BASH_NET_ALLOWLIST.
   */
  network?: "off" | "on";

  max_output_bytes?: number;
  max_output_lines?: number;
};

type ShellState = {
  id: string;
  sessionId: string;
  bash: Bash;
  env: Record<string, string>;
  cwd: string;
  createdAtMs: number;
  lastUsedMs: number;
  networkEnabled: boolean;
};

const shells = new Map<string, ShellState>();

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function clampInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeId(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length > 80) throw new Error("shell_id is too long (max 80 chars)");
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    throw new Error("shell_id contains unsupported characters");
  }
  return trimmed;
}

function normalizeWorkspacePath(input: string): string {
  return sanitizeObjectPath(input);
}

function normalizeWorkspacePrefix(input: string): string {
  return sanitizeObjectPrefix(input);
}

function joinPrefix(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name;
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function cleanupExpiredShells(nowMs = Date.now()) {
  for (const [key, shell] of shells) {
    if ((nowMs - shell.lastUsedMs) > SHELL_TTL_MS) {
      shells.delete(key);
    }
  }
}

async function collectFilesRecursive(prefix: string, maxFiles: number): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [prefix];
  const seen = new Set<string>();
  const pageSize = 1_000;

  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) continue;
    const safePrefix = normalizeWorkspacePrefix(next);
    if (seen.has(safePrefix)) continue;
    seen.add(safePrefix);

    for (let offset = 0; offset < 100_000; offset += pageSize) {
      const { objects } = await listWorkspaceObjects(safePrefix, {
        limit: pageSize,
        offset,
      });
      for (const obj of objects) {
        const name = String(obj?.name ?? "").trim();
        if (!name) continue;
        const path = joinPrefix(safePrefix, name);

        if (obj?.id) {
          out.push(path);
          if (out.length >= maxFiles) return out;
          continue;
        }

        // Likely a folder (storage "directory") — recurse.
        queue.push(path);
      }
      if (objects.length < pageSize) break;
      if (out.length >= maxFiles) return out;
    }
  }

  return out;
}

function toVirtualPath(workspacePath: string): string {
  const safe = normalizeWorkspacePath(workspacePath);
  return `/workspace/${safe}`;
}

function toVirtualCwd(workspacePrefix: string | undefined): string {
  const prefix = normalizeWorkspacePrefix(workspacePrefix ?? "");
  return prefix ? `/workspace/${prefix}` : "/workspace";
}

function resolveAllowlistedNetwork() {
  const allow = parseCsv(getConfigString("tools.bash.network.allowlist"));
  const methods = parseCsv(getConfigString("tools.bash.network.methods"));
  const dangerouslyAllowFullInternetAccess = getConfigBoolean(
    "tools.bash.network.dangerously_allow_full_internet_access",
  ) === true;

  if (dangerouslyAllowFullInternetAccess) {
    return { dangerouslyAllowFullInternetAccess: true as const };
  }

  if (allow.length === 0) return null;

  return {
    allowedUrlPrefixes: allow,
    allowedMethods: (methods.length > 0 ? methods : ["GET", "HEAD"]) as string[],
    maxRedirects: clampInt(
      getConfigNumber("tools.bash.network.max_redirects"),
      10,
      0,
      50,
    ),
    timeoutMs: clampInt(
      getConfigNumber("tools.bash.network.timeout_ms"),
      25_000,
      1_000,
      120_000,
    ),
    maxResponseSize: clampInt(
      getConfigNumber("tools.bash.network.max_response_bytes"),
      5 * 1024 * 1024,
      0,
      20 * 1024 * 1024,
    ),
  };
}

function shellKey(sessionId: string, id: string) {
  return `${sessionId}:${id}`;
}

function safeHeaderLine(line: string): { name: string; value: string } | null {
  const ix = line.indexOf(":");
  if (ix <= 0) return null;
  const name = line.slice(0, ix).trim();
  const value = line.slice(ix + 1).trim();
  if (!name) return null;
  return { name, value };
}

function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
}

const curlCommand = defineCommand("curl", async (args, ctx) => {
  if (args.includes("--help") || args.includes("-h")) {
    return {
      stdout:
        "curl (sandboxed)\n\nSupported options: -X, -H, -d/--data, -o, -i, -I, -L, -s, -S, --max-time\n",
      stderr: "",
      exitCode: 0,
    };
  }

  if (!ctx.fetch) {
    return {
      stdout: "",
      stderr:
        "curl: network is disabled (set tools.bash.network.allowlist in config.json and call bash with network=on)\n",
      exitCode: 7,
    };
  }

  let method = "GET";
  let data: string | undefined;
  const headers: Record<string, string> = Object.create(null);
  let outFile: string | undefined;
  let includeHeaders = false;
  let headOnly = false;
  let followRedirects = true;
  let silent = false;
  let showError = false;
  let timeoutMs: number | undefined;
  let url: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-X" || a === "--request") {
      method = String(args[i + 1] ?? "").toUpperCase();
      i++;
      continue;
    }
    if (a === "-H" || a === "--header") {
      const line = String(args[i + 1] ?? "");
      i++;
      const parsed = safeHeaderLine(line);
      if (!parsed) {
        return { stdout: "", stderr: `curl: invalid header: ${line}\n`, exitCode: 2 };
      }
      headers[parsed.name] = parsed.value;
      continue;
    }
    if (a === "-d" || a === "--data" || a === "--data-raw") {
      data = String(args[i + 1] ?? "");
      i++;
      if (method === "GET") method = "POST";
      continue;
    }
    if (a === "-o" || a === "--output") {
      outFile = String(args[i + 1] ?? "");
      i++;
      continue;
    }
    if (a === "-i" || a === "--include") {
      includeHeaders = true;
      continue;
    }
    if (a === "-I" || a === "--head") {
      headOnly = true;
      method = "HEAD";
      continue;
    }
    if (a === "-L" || a === "--location") {
      followRedirects = true;
      continue;
    }
    if (a === "--max-time") {
      const seconds = Number(args[i + 1]);
      i++;
      if (Number.isFinite(seconds) && seconds > 0) {
        timeoutMs = Math.floor(seconds * 1000);
      }
      continue;
    }
    if (a === "-s" || a === "--silent") {
      silent = true;
      continue;
    }
    if (a === "-S" || a === "--show-error") {
      showError = true;
      continue;
    }

    if (typeof a === "string" && !a.startsWith("-")) {
      url = a;
    }
  }

  if (!url) {
    return { stdout: "", stderr: "curl: no URL specified\n", exitCode: 2 };
  }

  const normalizedUrl = url.match(/^https?:\/\//) ? url : `https://${url}`;

  try {
    const res = await ctx.fetch(normalizedUrl, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: data,
      followRedirects,
      timeoutMs,
    });

    const head = `HTTP/1.1 ${res.status} ${res.statusText}\r\n${formatHeaders(res.headers)}\r\n\r\n`;
    const body = headOnly ? "" : res.body;
    const content = includeHeaders ? `${head}${body}` : body;

    if (outFile && outFile.trim()) {
      const filePath = ctx.fs.resolvePath(ctx.cwd, outFile.trim());
      await ctx.fs.writeFile(filePath, body);
      return { stdout: silent ? "" : "", stderr: "", exitCode: 0 };
    }

    return { stdout: silent ? "" : content, stderr: "", exitCode: 0 };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const stderr = !silent || showError ? `curl: ${message}\n` : "";
    return { stdout: "", stderr, exitCode: 7 };
  }
});

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

async function createShell(params: {
  sessionId: string;
  id: string;
  networkEnabled: boolean;
  imports?: string[];
  importPrefixes?: string[];
  cwd?: string;
}) {
  const filePaths = new Set<string>();

  const imports = Array.isArray(params.imports) ? params.imports : [];
  for (const p of imports) {
    if (!p?.trim()) continue;
    filePaths.add(normalizeWorkspacePath(p));
    if (filePaths.size >= MAX_IMPORT_FILES) break;
  }

  const prefixes = Array.isArray(params.importPrefixes) ? params.importPrefixes : [];
  for (const raw of prefixes) {
    const prefix = normalizeWorkspacePrefix(raw);
    const files = await collectFilesRecursive(prefix, MAX_IMPORT_FILES);
    for (const f of files) {
      filePaths.add(f);
      if (filePaths.size >= MAX_IMPORT_FILES) break;
    }
    if (filePaths.size >= MAX_IMPORT_FILES) break;
  }

  const initialFiles: Record<string, string | (() => Promise<string>)> = {};
  for (const p of filePaths) {
    const vpath = toVirtualPath(p);
    const workspacePath = p;
    initialFiles[vpath] = async () => {
      const file = await downloadFile(workspacePath, { optional: true });
      if (file === null) {
        throw new Error(`Workspace file not found: ${workspacePath}`);
      }
      return decodeUtf8(file);
    };
  }

  const networkConfig = params.networkEnabled ? resolveAllowlistedNetwork() : null;
  if (params.networkEnabled && !networkConfig) {
    throw new Error(
      "network=on requested but tools.bash.network.allowlist is empty in config.json.",
    );
  }

  const bash = new Bash({
    files: initialFiles,
    cwd: toVirtualCwd(params.cwd),
    commands: [...DEFAULT_COMMANDS],
    executionLimits: { ...DEFAULT_EXECUTION_LIMITS },
    ...(networkConfig ? { network: networkConfig as unknown as Record<string, unknown> } : {}),
    customCommands: [curlCommand],
  });

  const now = Date.now();
  const state: ShellState = {
    id: params.id,
    sessionId: params.sessionId,
    bash,
    env: { PWD: toVirtualCwd(params.cwd) },
    cwd: toVirtualCwd(params.cwd),
    createdAtMs: now,
    lastUsedMs: now,
    networkEnabled: Boolean(networkConfig),
  };
  return state;
}

async function exportFromShell(params: {
  bash: Bash;
  files?: string[];
  prefixes?: string[];
}): Promise<{ exported: string[]; skipped: string[] }> {
  const exported: string[] = [];
  const skipped: string[] = [];

  const wants = new Set<string>();
  const files = Array.isArray(params.files) ? params.files : [];
  for (const f of files) {
    if (!f?.trim()) continue;
    wants.add(normalizeWorkspacePath(f));
  }

  const prefixes = Array.isArray(params.prefixes) ? params.prefixes : [];
  if (prefixes.length > 0) {
    const all = params.bash.fs.getAllPaths();
    for (const raw of prefixes) {
      const prefix = normalizeWorkspacePrefix(raw);
      const vprefix = prefix ? `/workspace/${prefix}/` : "/workspace/";
      for (const p of all) {
        if (typeof p !== "string") continue;
        if (!p.startsWith(vprefix)) continue;
        if (p.endsWith("/")) continue;
        if (p === "/workspace") continue;
        if (p === "/workspace/") continue;
        const rel = p.slice("/workspace/".length);
        if (!rel.trim()) continue;
        wants.add(normalizeWorkspacePath(rel));
        if (wants.size >= MAX_EXPORT_FILES) break;
      }
      if (wants.size >= MAX_EXPORT_FILES) break;
    }
  }

  const list = Array.from(wants);
  list.sort();

  for (const w of list.slice(0, MAX_EXPORT_FILES)) {
    try {
      const vpath = toVirtualPath(w);
      const content = await params.bash.fs.readFile(vpath);
      if (typeof content !== "string") {
        skipped.push(w);
        continue;
      }
      await uploadFile(w, content, { mimeType: "text/plain; charset=utf-8" });
      exported.push(w);
    } catch {
      skipped.push(w);
    }
  }

  return { exported, skipped };
}

export function createBashTool(sessionId: string) {
  return tool({
    description: [
      "Run bash scripts in a sandboxed virtual shell (powered by just-bash).",
      "",
      "Filesystem:",
      "- Workspace files are mounted under /workspace/ (virtual).",
      "- Provide imports/import_prefixes to make workspace files available inside the shell.",
      "- Writes inside the shell do NOT automatically persist to Supabase Storage.",
      "- To persist results, provide exports/export_prefixes to write files back to the workspace bucket.",
      "",
      "Sessions:",
      "- Provide shell_id to reuse the same in-memory shell across multiple calls (best-effort; expires after ~20m).",
      "- action=reset deletes the in-memory shell session.",
      "",
      "Network:",
      "- network=on enables sandboxed curl using allow-listed URL prefixes from tools.bash.network.allowlist in config.json.",
      "- This does NOT provide OS-level CLIs (git, npm, ffmpeg, etc.). It's a simulated shell with built-in commands.",
      "",
      "Output:",
      `- Output is truncated to ~${DEFAULT_MAX_OUTPUT_BYTES} bytes / ${DEFAULT_MAX_OUTPUT_LINES} lines; full output may be saved under ${TOOL_OUTPUT_PREFIX}/.`,
    ].join("\n"),
    inputSchema: jsonSchema<BashArgs>({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["exec", "reset", "info"],
          description: "exec (default), reset, or info.",
        },
        shell_id: {
          type: "string",
          description:
            "Optional shell id for a persistent in-memory session (best-effort).",
        },
        script: { type: "string", description: "Bash script to execute." },
        cwd: {
          type: "string",
          description: "Workspace-relative cwd inside the shell (default '.').",
        },
        stdin: { type: "string", description: "Optional stdin to pass to the script." },
        raw_script: {
          type: "boolean",
          description:
            "If true, don't normalize multi-line script indentation (useful for heredocs).",
        },
        imports: {
          type: "array",
          items: { type: "string" },
          description: "Workspace-relative file paths to import into /workspace/**.",
        },
        import_prefixes: {
          type: "array",
          items: { type: "string" },
          description: "Workspace-relative prefixes to import recursively (e.g. 'repo').",
        },
        exports: {
          type: "array",
          items: { type: "string" },
          description: "Workspace-relative file paths to export back to Storage.",
        },
        export_prefixes: {
          type: "array",
          items: { type: "string" },
          description: "Workspace-relative prefixes to export recursively back to Storage.",
        },
        network: {
          type: "string",
          enum: ["off", "on"],
          description: "Enable allow-listed network (curl) inside the shell.",
        },
        max_output_bytes: {
          type: "number",
          description: "Override output truncation byte limit (max 200KB).",
        },
        max_output_lines: {
          type: "number",
          description: "Override output truncation line limit (max 5000).",
        },
      },
      additionalProperties: false,
    }),
    execute: async (args: BashArgs) => {
      cleanupExpiredShells();

      const action = args.action ?? "exec";
      const requestedId = normalizeId(args.shell_id);

      if (action === "info") {
        const now = Date.now();
        const active = Array.from(shells.values())
          .filter((s) => s.sessionId === sessionId)
          .map((s) => ({
            shell_id: s.id,
            created_ms_ago: now - s.createdAtMs,
            last_used_ms_ago: now - s.lastUsedMs,
            cwd: s.cwd,
            network: s.networkEnabled ? "on" : "off",
          }))
          .sort((a, b) => a.last_used_ms_ago - b.last_used_ms_ago);
        return { session_id: sessionId, count: active.length, shells: active };
      }

      if (action === "reset") {
        if (!requestedId) return { error: "shell_id is required for action=reset" };
        const existed = shells.delete(shellKey(sessionId, requestedId));
        return { ok: true, shell_id: requestedId, deleted: existed };
      }

      if (action !== "exec") {
        return { error: `Unknown action: ${String(action)}` };
      }

      const id = requestedId ?? crypto.randomUUID();
      const key = requestedId ? shellKey(sessionId, id) : null;

      const script = (args.script ?? "").trim();
      if (!script) return { error: "script is required" };
      if (byteLength(script) > MAX_SCRIPT_BYTES) {
        return { error: `script is too large (max ${MAX_SCRIPT_BYTES} bytes)` };
      }

      const networkRequested = args.network === "on";

      let shell = key ? shells.get(key) ?? null : null;
      if (!shell) {
        shell = await createShell({
          sessionId,
          id,
          networkEnabled: networkRequested,
          imports: args.imports,
          importPrefixes: args.import_prefixes,
          cwd: args.cwd,
        });
        if (key) shells.set(key, shell);
      } else if (networkRequested && !shell.networkEnabled) {
        // Network mode is immutable for a shell instance (safer + simpler).
        return {
          error:
            "shell exists with network=off. Call action=reset and re-create with network=on.",
          shell_id: key ? id : null,
        };
      }

      shell.lastUsedMs = Date.now();

      const execCwd = toVirtualCwd(args.cwd ?? shell.cwd.replace(/^\/workspace\/?/, ""));
      const maxBytes = clampInt(args.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES, 1, 200_000);
      const maxLines = clampInt(args.max_output_lines, DEFAULT_MAX_OUTPUT_LINES, 1, 5_000);

      try {
        const result = await shell.bash.exec(script, {
          cwd: execCwd,
          env: shell.env,
          stdin: args.stdin,
          rawScript: args.raw_script,
        });

        // Persist shell env + cwd for session-like behavior across calls.
        if (result?.env && typeof result.env === "object") {
          shell.env = result.env as Record<string, string>;
          const nextPwd = typeof result.env.PWD === "string" ? result.env.PWD : null;
          if (nextPwd && nextPwd.startsWith("/workspace")) shell.cwd = nextPwd;
        }

        const stdout = typeof result.stdout === "string" ? result.stdout : "";
        const stderr = typeof result.stderr === "string" ? result.stderr : "";
        const full = [stdout, stderr].filter(Boolean).join(
          stdout && stderr ? "\n" : "",
        );
        const truncated = truncateText(full, { maxBytes, maxLines });

        let saved_path: string | null = null;
        if (truncated.truncated && byteLength(full) <= MAX_OUTPUT_SAVE_BYTES) {
          const path = `${TOOL_OUTPUT_PREFIX}/${crypto.randomUUID()}.log`;
          try {
            const uploaded = await uploadFile(path, full, {
              mimeType: "text/plain; charset=utf-8",
            });
            saved_path = uploaded.objectPath;
          } catch {
            saved_path = null;
          }
        }

        const { exported, skipped } = await exportFromShell({
          bash: shell.bash,
          files: args.exports,
          prefixes: args.export_prefixes,
        });

        return {
          ok: true,
          action: "exec",
          shell_id: key ? id : null,
          cwd: shell.cwd,
          network: shell.networkEnabled ? "on" : "off",
          exit_code: result.exitCode,
          truncated: truncated.truncated,
          saved_path,
          exported,
          skipped,
          output: truncated.truncated
            ? `${truncated.content}\n\n...${truncated.removed} ${truncated.unit} truncated...\n\nFull output saved to: ${
              saved_path ?? "(save skipped/failed)"
            }`
            : truncated.content,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logger.warn("tool.bash.exec_failed", {
          sessionId,
          shellId: id,
          message,
        });
        return { ok: false, shell_id: key ? id : null, error: `bash error: ${message}` };
      }
    },
  });
}

