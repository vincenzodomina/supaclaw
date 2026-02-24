import * as jose from "@panva/jose";
import rawConfig from "./config.json" with { type: "json" };

// Single source of truth: infer keys/types directly from config.json.
export type AppConfig = typeof rawConfig;
export type AppConfigKey = keyof AppConfig;

/** Tiny typed proxy over flat dotted-key config entries. */
export const appConfig = new Proxy(rawConfig as AppConfig, {
  get(target, prop) {
    if (typeof prop !== "string") return undefined;
    return target[prop as AppConfigKey];
  },
});

export function getConfig<K extends AppConfigKey>(key: K): AppConfig[K];
export function getConfig<T = unknown>(
  key: string,
): T | undefined;
export function getConfig(key: string) {
  return (rawConfig as Record<string, unknown>)[key];
}

export function getConfigNumber(key: string): number | undefined {
  const value = getConfig(key);
  return typeof value === "number" ? value : undefined;
}

export function getConfigString(key: string): string | undefined {
  const value = getConfig(key);
  return typeof value === "string" ? value : undefined;
}

export function getConfigBoolean(key: string): boolean | undefined {
  const value = getConfig(key);
  return typeof value === "boolean" ? value : undefined;
}

export function mustGetEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const SUPABASE_URL = mustGetEnv("SUPABASE_URL");
const SUPABASE_JWT_ISSUER = Deno.env.get("SB_JWT_ISSUER") ??
  `${SUPABASE_URL}/auth/v1`;
const SUPABASE_JWT_KEYS = jose.createRemoteJWKSet(
  new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
);

export type VerifiedJwt = jose.JWTPayload & {
  role?: string;
  email?: string;
};

export function getBearerToken(req: Request): string {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) throw new Error("Missing authorization header");

  const [bearer, token] = authHeader.split(" ");
  if (bearer !== "Bearer" || !token) {
    throw new Error("Authorization header must be in format 'Bearer <token>'");
  }

  return token;
}

export async function verifySupabaseJwt(token: string): Promise<VerifiedJwt> {
  const { payload } = await jose.jwtVerify(token, SUPABASE_JWT_KEYS, {
    issuer: SUPABASE_JWT_ISSUER,
  });
  return payload as VerifiedJwt;
}

/** Constant-time string comparison to prevent timing side-channel attacks. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

const URL_RE = /^https?:\/\//;

function truncVal(v: unknown, max: number): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    if (URL_RE.test(v)) {
      try {
        const u = new URL(v);
        const short = u.hostname + u.pathname;
        return short.length <= max ? short : short.slice(0, max - 1) + "…";
      } catch { /* fall through */ }
    }
    return v.length <= max ? v : v.slice(0, max - 1) + "…";
  }
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.length === 0 ? "[]" : `[${v.length} items]`;
  const s = JSON.stringify(v);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Produce a compact, human-readable summary of an unknown tool
 * input/output for display in Telegram.  Parses JSON strings, walks
 * objects showing `key: value` pairs with long values / URLs shortened,
 * and caps total length.
 */
export function summarize(
  raw: unknown,
  maxVal = 60,
  maxTotal = 300,
): string {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch { /* keep as string */ }
  }
  if (parsed === null || parsed === undefined) return "";
  if (typeof parsed !== "object") return truncVal(parsed, maxTotal);

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return "[]";
    const first = summarize(parsed[0], maxVal, maxVal);
    return parsed.length === 1 ? first : `${first} +${parsed.length - 1} more`;
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  let result = "";
  let used = 0;
  for (const [k, v] of entries) {
    const part = `${k}: ${truncVal(v, maxVal)}`;
    const next = used === 0 ? part : `${result}, ${part}`;
    if (next.length > maxTotal && used > 0) {
      return `${result} +${entries.length - used} more`;
    }
    result = next;
    used++;
  }
  return result.length > maxTotal
    ? result.slice(0, maxTotal - 1) + "…"
    : result;
}

export function jsonResponse(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function textResponse(text: string, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/plain; charset=utf-8");
  }
  return new Response(text, { ...init, headers });
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.ceil(bytes / 1024)}KB`;
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.floor(seconds * 1000);
}

export function getBackoffMs(
  attempt: number,
  maxBackoffMs = 8000,
  baseBackoffMs = 500,
): number {
  const exponential = Math.min(
    maxBackoffMs,
    baseBackoffMs * 2 ** (attempt - 1),
  );
  // Add light jitter to avoid synchronized retries.
  const jitter = Math.floor(Math.random() * 250);
  return exponential + jitter;
}
