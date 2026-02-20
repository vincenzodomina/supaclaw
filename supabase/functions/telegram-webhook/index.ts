import { createServiceClient } from '../_shared/supabase.ts'
import { mustGetEnv, timingSafeEqual, jsonResponse, textResponse } from '../_shared/helpers.ts'
import { telegramSendChatAction } from '../_shared/telegram.ts'

type TelegramUpdate = {
  update_id: number | string
  message?: TelegramMessage
  edited_message?: TelegramMessage
}

type TelegramMessage = {
  message_id: number | string
  from?: { id: number | string }
  chat: { id: number | string; type: string }
  text?: string
  // Attachments (we don't process them yet, but we persist raw update)
  document?: unknown
  photo?: unknown
}

function verifyTelegramSecret(req: Request) {
  const expected = mustGetEnv('TELEGRAM_WEBHOOK_SECRET')
  const actual = req.headers.get('x-telegram-bot-api-secret-token') ?? ''
  return timingSafeEqual(expected, actual)
}

function isAllowedUser(message: TelegramMessage): boolean {
  const allowedId = mustGetEnv('TELEGRAM_ALLOWED_USER_ID').trim()
  if (!allowedId) throw new Error('TELEGRAM_ALLOWED_USER_ID must be a non-empty Telegram user id')
  return String(message.from?.id ?? '') === allowedId
}

function getTextContent(message: TelegramMessage): string | undefined {
  if (typeof message.text === 'string' && message.text.trim()) return message.text
  // Future: attachment handling
  return undefined
}

async function kickAgentWorkerNow() {
  const workerSecret = Deno.env.get('WORKER_SECRET')?.trim()
  if (!workerSecret) return
  const baseUrl = (Deno.env.get('SUPABASE_URL') ?? '').trim().replace(/\/+$/, '')
  if (!baseUrl) return
  const url = `${baseUrl}/functions/v1/agent-worker`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 1500)
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': workerSecret,
      },
      body: '{}',
      signal: ctrl.signal,
    })
  } catch {
    // Best effort: cron remains the durable backstop.
  } finally {
    clearTimeout(timer)
  }
}

const supabase = createServiceClient()

Deno.serve(async (req) => {
  if (req.method !== 'POST') return textResponse('method not allowed', { status: 405 })
  if (!verifyTelegramSecret(req)) return textResponse('forbidden', { status: 403 })

  let update: TelegramUpdate
  try {
    update = (await req.json()) as TelegramUpdate
  } catch {
    return textResponse('invalid json', { status: 400 })
  }
  const message = update.message ?? update.edited_message
  if (!message) return textResponse('ok')

  // Security: ignore all non-allowed senders (especially in groups)
  if (!isAllowedUser(message)) return textResponse('ok')

  const content = getTextContent(message)
  if (!content) return textResponse('ok')

  const chatId = String(message.chat.id)
  const updateId = String(update.update_id)
  const messageId = String(message.message_id)
  const fromUserId = message.from?.id == null ? null : String(message.from.id)

  // 1) Upsert session
  const { data: sessionRows, error: sErr } = await supabase
    .from('sessions')
    .upsert(
      {
        channel: 'telegram',
        channel_chat_id: chatId,
        // naive title: first message snippet (can be overwritten later)
        title: content.slice(0, 80),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'channel,channel_chat_id' },
    )
    .select('id')

  if (sErr) return jsonResponse({ error: sErr.message }, { status: 500 })
  const sessionId = sessionRows?.[0]?.id as string | undefined
  if (!sessionId) return jsonResponse({ error: 'failed to upsert session' }, { status: 500 })

  // 2) Insert inbound message (idempotent on provider_update_id)
  const { error: mErr } = await supabase.from('messages').insert({
    session_id: sessionId,
    role: 'user',
    type: 'text',
    content,
    provider: 'telegram',
    provider_update_id: updateId,
    telegram_message_id: messageId,
    telegram_chat_id: chatId,
    telegram_from_user_id: fromUserId,
  })

  // If we hit a unique violation (duplicate update), we can safely continue.
  if (mErr && mErr.code !== '23505') return jsonResponse({ error: mErr.message }, { status: 500 })

  // 3) Enqueue job (idempotent via dedupe_key)
  const dedupeKey = `telegram:process_message:${updateId}`
  const { error: jErr } = await supabase.rpc('enqueue_job', {
    p_dedupe_key: dedupeKey,
    p_type: 'process_message',
    p_payload: { session_id: sessionId, provider_update_id: updateId, telegram_chat_id: chatId },
    p_run_at: new Date().toISOString(),
    p_max_attempts: 10,
  })
  if (jErr) return jsonResponse({ error: jErr.message }, { status: 500 })

  await telegramSendChatAction({ chatId, action: 'typing' }).catch(() => {})
  await kickAgentWorkerNow()

  return textResponse('ok')
})

