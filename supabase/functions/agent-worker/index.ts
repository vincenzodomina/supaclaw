import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

import { createServiceClient } from '../_shared/supabase.ts'
import { mustGetEnv } from '../_shared/env.ts'
import { jsonResponse, textResponse } from '../_shared/http.ts'
import { telegramSendMessage } from '../_shared/telegram.ts'
import { buildSystemPrompt, generateAssistantReply, type ChatMessage } from '../_shared/llm.ts'
import { downloadTextFromWorkspace } from '../_shared/storage.ts'
import { embedText } from '../_shared/embeddings.ts'

type JobRow = {
  id: number
  type: string
  payload: Record<string, unknown>
}

const supabase = createServiceClient()

function isAuthorized(req: Request) {
  const expected = mustGetEnv('WORKER_SECRET')
  const actual = req.headers.get('x-worker-secret')
  return actual === expected
}

async function claimJobs(workerId: string, maxJobs = 3): Promise<JobRow[]> {
  const { data, error } = await supabase.rpc('claim_jobs', {
    p_locked_by: workerId,
    p_max_jobs: maxJobs,
    p_lock_timeout_seconds: 300,
  })
  if (error) throw new Error(`claim_jobs failed: ${error.message}`)
  return (data ?? []) as JobRow[]
}

async function jobSucceed(jobId: number) {
  const { error } = await supabase.rpc('job_succeed', { p_job_id: jobId })
  if (error) throw new Error(`job_succeed failed: ${error.message}`)
}

async function jobFail(jobId: number, errorMessage: string, retryInSeconds = 60) {
  const { error } = await supabase.rpc('job_fail', {
    p_job_id: jobId,
    p_error: errorMessage,
    p_retry_in_seconds: retryInSeconds,
  })
  if (error) throw new Error(`job_fail failed: ${error.message}`)
}

async function processProcessMessage(job: JobRow) {
  const sessionId = job.payload.session_id as string | undefined
  const updateId = job.payload.provider_update_id as number | undefined
  const telegramChatId = job.payload.telegram_chat_id as number | undefined

  if (!sessionId || !updateId || !telegramChatId) throw new Error('Invalid process_message payload')

  // Fetch the inbound message content
  const { data: inbound, error: iErr } = await supabase
    .from('messages')
    .select('id, content, created_at')
    .eq('session_id', sessionId)
    .eq('provider_update_id', updateId)
    .eq('role', 'user')
    .maybeSingle()
  if (iErr) throw new Error(`Failed to load inbound message: ${iErr.message}`)
  if (!inbound) {
    // Nothing to do (could be a duplicate update we ignored)
    return
  }

  // Idempotency + retry-safe delivery:
  // - If an assistant row already exists and was delivered, do nothing.
  // - If it exists but wasn't delivered yet, deliver now and mark sent.
  const { data: existingReply, error: rErr } = await supabase
    .from('messages')
    .select('id, content, telegram_chat_id, telegram_sent_at')
    .eq('reply_to_message_id', inbound.id)
    .eq('role', 'assistant')
    .maybeSingle()
  if (rErr) throw new Error(`Failed to check existing replies: ${rErr.message}`)
  if (existingReply) {
    if (existingReply.telegram_sent_at) return

    const existingChatId =
      typeof existingReply.telegram_chat_id === 'number' ? existingReply.telegram_chat_id : telegramChatId
    await telegramSendMessage({ chatId: existingChatId, text: existingReply.content })

    const { error: deliveredErr } = await supabase
      .from('messages')
      .update({ telegram_sent_at: new Date().toISOString() })
      .eq('id', existingReply.id)
    if (deliveredErr) throw new Error(`Failed to mark assistant message as delivered: ${deliveredErr.message}`)
    return
  }

  const soul = await downloadTextFromWorkspace('.agents/SOUL.md').catch(() => null)

  // Memory retrieval in one query (pinned facts + summaries), then split by type.
  // We fetch a slightly larger candidate pool to preserve quality after filtering.
  const queryEmbedding = await embedText(inbound.content)
  const { data: memoryCandidates, error: memErr } = await supabase.rpc('hybrid_search_memories', {
    query_text: inbound.content,
    query_embedding: queryEmbedding,
    match_count: 30,
    filter_type: ['pinned_fact', 'summary'],
    filter_session_id: null,
  })
  if (memErr) throw new Error(`hybrid_search_memories failed: ${memErr.message}`)

  const pinnedFacts: any[] = []
  const summaries: any[] = []
  for (const memory of memoryCandidates ?? []) {
    if (memory.type === 'pinned_fact' && pinnedFacts.length < 5) {
      pinnedFacts.push(memory)
      continue
    }
    if (memory.type === 'summary' && memory.session_id === sessionId && summaries.length < 5) {
      summaries.push(memory)
    }
    if (pinnedFacts.length >= 5 && summaries.length >= 5) break
  }

  const memoryStrings = [...(pinnedFacts ?? []), ...(summaries ?? [])].map((m: any) => `[${m.type}] ${m.content}`) as string[]

  const system = buildSystemPrompt({ soul: soul ?? undefined, memories: memoryStrings })

  // Build short chat context (last N messages).
  // Query newest first for index efficiency, then reverse for chronological model input.
  const { data: recent, error: recentErr } = await supabase
    .from('messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(20)
  if (recentErr) throw new Error(`Failed to load recent messages: ${recentErr.message}`)

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...((recent ?? []).reverse()).map((m: any) => ({ role: m.role, content: m.content })),
  ]

  const reply = await generateAssistantReply({ messages })

  // Persist assistant message before delivery; retries will deliver pending messages.
  const { data: savedReply, error: saveErr } = await supabase
    .from('messages')
    .insert({
      session_id: sessionId,
      reply_to_message_id: inbound.id,
      role: 'assistant',
      content: reply,
      provider: 'telegram',
      telegram_chat_id: telegramChatId,
      telegram_sent_at: null,
      raw: {},
    })
    .select('id')
    .single()
  if (saveErr) throw new Error(`Failed to persist assistant message: ${saveErr.message}`)

  await telegramSendMessage({ chatId: telegramChatId, text: reply })

  const { error: deliveredErr } = await supabase
    .from('messages')
    .update({ telegram_sent_at: new Date().toISOString() })
    .eq('id', savedReply.id)
  if (deliveredErr) throw new Error(`Failed to mark assistant message as delivered: ${deliveredErr.message}`)
}

async function processTrigger(job: JobRow) {
  // Trigger jobs are intentionally accepted as no-op for now.
  // This keeps trigger-webhook usable without creating retry noise.
  void job
}

type EmbedConfig = {
  table: 'memories' | 'messages' | 'files'
  idKey: 'memory_id' | 'message_id' | 'file_id'
}

const EMBED_CONFIG: Partial<Record<JobRow['type'], EmbedConfig>> = {
  embed_memory: { table: 'memories', idKey: 'memory_id' },
  embed_message: { table: 'messages', idKey: 'message_id' },
  embed_file: { table: 'files', idKey: 'file_id' },
}

async function processEmbed(job: JobRow, config: EmbedConfig) {
  const id = job.payload[config.idKey]
  if (!id) throw new Error(`Invalid ${job.type} payload`)

  const { data: row, error: loadErr } = await supabase
    .from(config.table)
    .select('id, content')
    .eq('id', id)
    .maybeSingle()
  if (loadErr) throw new Error(`Failed to load ${job.type}: ${loadErr.message}`)
  if (!row) return

  const embedding = await embedText(row.content)

  const { error: updateErr } = await supabase
    .from(config.table)
    .update({
      embedding,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (updateErr) throw new Error(`Failed to update ${job.type} embedding: ${updateErr.message}`)
}

async function processJob(job: JobRow) {
  if (job.type === 'process_message') return await processProcessMessage(job)
  const embedConfig = EMBED_CONFIG[job.type]
  if (embedConfig) return await processEmbed(job, embedConfig)
  if (job.type === 'trigger') return await processTrigger(job)
  throw new Error(`Unknown job type: ${job.type}`)
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return textResponse('method not allowed', { status: 405 })
  if (!isAuthorized(req)) return textResponse('forbidden', { status: 403 })

  const workerId = crypto.randomUUID()

  try {
    const jobs = await claimJobs(workerId, 3)
    if (jobs.length === 0) return jsonResponse({ results: [] })

    const results: Array<{ jobId: number; ok: boolean; error?: string }> = []

    for (const job of jobs) {
      try {
        await processJob(job)
        await jobSucceed(job.id)
        results.push({ jobId: job.id, ok: true })
      } catch (e) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e)
        await jobFail(job.id, msg, 60)
        results.push({ jobId: job.id, ok: false, error: msg })
      }
    }

    return jsonResponse({ results })
  } catch (e) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e)
    return jsonResponse({ error: msg }, { status: 500 })
  }
})

