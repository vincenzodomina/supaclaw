export function mustGetEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export function parseIntEnv(name: string): number | undefined {
  const raw = Deno.env.get(name);
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number`);
  return n;
}

