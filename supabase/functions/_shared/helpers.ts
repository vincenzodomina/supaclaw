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
