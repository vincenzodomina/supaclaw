import { mustGetEnv } from './helpers.ts'

const MAX_RETRIES = 5
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 8000

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.floor(seconds * 1000)
}

function getBackoffMs(attempt: number): number {
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1))
  // Add light jitter to avoid synchronized retries.
  const jitter = Math.floor(Math.random() * 250)
  return exponential + jitter
}

// deno-lint-ignore no-explicit-any
type ApiResult = Record<string, any> | null

async function telegramApi(method: string, body: Record<string, unknown>): Promise<ApiResult> {
  const token = mustGetEnv('TELEGRAM_BOT_TOKEN')
  const url = `https://api.telegram.org/bot${token}/${method}`
  const payload = JSON.stringify(body)

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
    } catch (error) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Telegram ${method} network failure after ${MAX_RETRIES} attempts: ${error instanceof Error ? error.message : String(error)}`)
      }
      await sleep(getBackoffMs(attempt))
      continue
    }

    if (res.ok) return await res.json().catch(() => null) as ApiResult

    const respBody = await res.text().catch(() => '')
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`Telegram ${method} failed (${res.status}) after ${attempt} attempts: ${respBody}`)
    }

    let retryAfterMs: number | null = parseRetryAfterMs(res.headers.get('retry-after'))
    if (res.status === 429 && respBody) {
      try {
        const parsed = JSON.parse(respBody) as { parameters?: { retry_after?: unknown } }
        const retryAfter = parsed?.parameters?.retry_after
        retryAfterMs = parseRetryAfterMs(
          retryAfter == null ? null : String(retryAfter),
        ) ?? retryAfterMs
      } catch {
        // Ignore malformed provider body and fall back to header/backoff.
      }
    }
    await sleep(retryAfterMs ?? getBackoffMs(attempt))
  }
  throw new Error(`Telegram ${method}: exhausted ${MAX_RETRIES} retries`)
}

/** Send a message and return the Telegram message_id (for later edits). */
export async function telegramSendMessage(params: { chatId: string; text: string }): Promise<string | undefined> {
  const chatId = params.chatId?.toString().trim()
  const text = params.text?.toString().trim()
  if (!chatId) throw new Error('telegramSendMessage requires non-empty chatId')
  if (!text) throw new Error('telegramSendMessage requires non-empty text')

  const data = await telegramApi('sendMessage', { chat_id: chatId, text })
  return data?.result?.message_id?.toString()
}

/** Edit an existing message in-place (used for tool-call status updates). */
export async function telegramEditMessageText(params: { chatId: string; messageId: string; text: string }): Promise<void> {
  const chatId = params.chatId?.toString().trim()
  const messageId = params.messageId?.toString().trim()
  const text = params.text?.toString().trim()
  if (!chatId || !messageId || !text) throw new Error('telegramEditMessageText requires non-empty chatId, messageId, and text')

  await telegramApi('editMessageText', { chat_id: chatId, message_id: Number(messageId), text })
}

