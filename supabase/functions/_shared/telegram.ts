import { mustGetEnv } from './env.ts'

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

export async function telegramSendMessage(params: { chatId: string; text: string }) {
  const chatId = params.chatId?.toString().trim()
  const text = params.text?.toString().trim()
  if (!chatId) {
    throw new Error('telegramSendMessage requires non-empty chatId')
  }
  if (!text) {
    throw new Error('telegramSendMessage requires non-empty text')
  }

  const token = mustGetEnv('TELEGRAM_BOT_TOKEN')
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  const payload = JSON.stringify({
    chat_id: chatId,
    text,
  })

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
    } catch (error) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Provider sendMessage network failure after ${MAX_RETRIES} attempts: ${error instanceof Error ? error.message : String(error)}`)
      }
      await sleep(getBackoffMs(attempt))
      continue
    }

    if (res.ok) return

    const body = await res.text().catch(() => '')
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new Error(`Telegram sendMessage failed (${res.status}) after ${attempt} attempts: ${body}`)
    }

    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
    await sleep(retryAfterMs ?? getBackoffMs(attempt))
  }
}

