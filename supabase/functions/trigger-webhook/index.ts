import { createServiceClient } from "../_shared/supabase.ts";
import {
  getBearerToken,
  jsonResponse,
  mustGetEnv,
  textResponse,
  type VerifiedJwt,
  verifySupabaseJwt,
} from "../_shared/helpers.ts";

const supabase = createServiceClient();
const ALLOWED_JOB_TYPES = new Set([
  "trigger",
  "process_message",
  "embed_memory",
  "embed_message",
  "embed_file",
  "run_task",
]);

type AuthContext =
  | { authType: "secret" }
  | { authType: "jwt"; claims: VerifiedJwt };

async function authorize(req: Request): Promise<AuthContext> {
  const token = getBearerToken(req);

  // Backwards compatible path for server-to-server callers.
  if (token === mustGetEnv("TRIGGER_WEBHOOK_SECRET")) {
    return { authType: "secret" };
  }

  const claims = await verifySupabaseJwt(token);
  if (!claims.sub) throw new Error("Invalid JWT: missing subject claim");

  // Keep this endpoint restricted to authenticated/app-level callers.
  const role = typeof claims.role === "string" ? claims.role : null;
  if (!role || (role !== "authenticated" && role !== "service_role")) {
    throw new Error("Invalid JWT role for this endpoint");
  }

  return { authType: "jwt", claims };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return textResponse("method not allowed", { status: 405 });
  }

  let auth: AuthContext;
  try {
    auth = await authorize(req);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Invalid authorization";
    return jsonResponse({ ok: false, error: message }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const type = typeof body?.type === "string" ? body.type : "trigger";
  if (!ALLOWED_JOB_TYPES.has(type)) {
    return jsonResponse({ ok: false, error: `unsupported job type: ${type}` }, {
      status: 400,
    });
  }
  const dedupeKey =
    typeof body?.dedupe_key === "string" && body.dedupe_key.trim()
      ? body.dedupe_key
      : `trigger:${crypto.randomUUID()}`;

  const payload = typeof body?.payload === "object" && body.payload
    ? body.payload
    : body;
  const enrichedPayload = auth.authType === "jwt"
    ? {
      ...payload,
      auth_user_id: auth.claims.sub,
      auth_user_role: auth.claims.role ?? null,
      auth_user_email: auth.claims.email ?? null,
    }
    : payload;

  const { data, error } = await supabase.rpc("enqueue_job", {
    p_dedupe_key: dedupeKey,
    p_type: type,
    p_payload: enrichedPayload,
    p_run_at: new Date().toISOString(),
    p_max_attempts: 5,
  });

  if (error) {
    return jsonResponse({ ok: false, error: error.message }, { status: 500 });
  }
  return jsonResponse({ ok: true, job_id: data });
});
