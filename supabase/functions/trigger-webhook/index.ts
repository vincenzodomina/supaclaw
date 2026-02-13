import { createServiceClient } from '../_shared/supabase.ts'
import { mustGetEnv } from '../_shared/env.ts'
import { jsonResponse, textResponse } from '../_shared/http.ts'

const supabase = createServiceClient()
const ALLOWED_JOB_TYPES = new Set(['trigger', 'process_message', 'embed_memory', 'embed_message', 'embed_file'])

function isAuthorized(req: Request) {
  const expected = mustGetEnv('TRIGGER_WEBHOOK_SECRET')
  const actual = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  return actual === expected
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return textResponse('method not allowed', { status: 405 })
  if (!isAuthorized(req)) return textResponse('forbidden', { status: 403 })

  const body = await req.json().catch(() => ({}))
  const type = typeof body?.type === 'string' ? body.type : 'trigger'
  if (!ALLOWED_JOB_TYPES.has(type)) {
    return jsonResponse({ ok: false, error: `unsupported job type: ${type}` }, { status: 400 })
  }
  const dedupeKey =
    typeof body?.dedupe_key === 'string' && body.dedupe_key.trim()
      ? body.dedupe_key
      : `trigger:${crypto.randomUUID()}`

  const payload = typeof body?.payload === 'object' && body.payload ? body.payload : body

  const { data, error } = await supabase.rpc('enqueue_job', {
    p_dedupe_key: dedupeKey,
    p_type: type,
    p_payload: payload,
    p_run_at: new Date().toISOString(),
    p_max_attempts: 5,
  })

  if (error) return jsonResponse({ ok: false, error: error.message }, { status: 500 })
  return jsonResponse({ ok: true, job_id: data })
})

