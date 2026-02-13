export function mustGetEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function getEnv(name: string): string | undefined {
  return Deno.env.get(name) ?? undefined;
}

export function parseIntEnv(name: string): number | undefined {
  const raw = getEnv(name);
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number`);
  return n;
}

