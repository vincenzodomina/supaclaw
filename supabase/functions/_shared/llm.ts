import { getEnv, mustGetEnv } from './env.ts'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export async function generateAssistantReply(params: {
  messages: ChatMessage[]
}): Promise<string> {
  const openaiKey = getEnv('OPENAI_API_KEY')
  const anthropicKey = getEnv('ANTHROPIC_API_KEY')

  if (openaiKey) {
    const model = getEnv('OPENAI_MODEL') ?? 'gpt-4o-mini'
    return await openaiChatCompletion({ apiKey: openaiKey, model, messages: params.messages })
  }

  if (anthropicKey) {
    const model = getEnv('ANTHROPIC_MODEL') ?? 'claude-3-5-sonnet-latest'
    return await anthropicMessage({ apiKey: anthropicKey, model, messages: params.messages })
  }

  throw new Error('No LLM configured: set OPENAI_API_KEY or ANTHROPIC_API_KEY')
}

async function openaiChatCompletion(params: {
  apiKey: string
  model: string
  messages: ChatMessage[]
}): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      temperature: 0.2,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenAI chat.completions failed (${res.status}): ${body}`)
  }

  const json = await res.json()
  const text = json?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new Error('OpenAI returned empty response')
  return text.trim()
}

async function anthropicMessage(params: {
  apiKey: string
  model: string
  messages: ChatMessage[]
}): Promise<string> {
  // Convert to Anthropic format: system prompt separate + messages user/assistant only
  const system = params.messages.find((m) => m.role === 'system')?.content
  const msgs = params.messages.filter((m) => m.role !== 'system')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': params.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: 800,
      system,
      messages: msgs.map((m) => ({ role: m.role, content: m.content })),
      temperature: 0.2,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic messages failed (${res.status}): ${body}`)
  }

  const json = await res.json()
  const text = json?.content?.[0]?.text
  if (typeof text !== 'string' || !text.trim()) throw new Error('Anthropic returned empty response')
  return text.trim()
}

export function buildSystemPrompt(params: { soul?: string; memories?: string[] }) {
  const parts: string[] = []
  parts.push('You are SupaClaw, a cloud-native personal agent.')

  if (params.soul?.trim()) {
    parts.push('\n## SOUL\n' + params.soul.trim())
  }

  if (params.memories?.length) {
    parts.push('\n## MEMORY (retrieved)\n' + params.memories.map((m) => `- ${m}`).join('\n'))
  }

  parts.push('\n## Rules\n- Be concise.\n- If you are unsure, ask a clarifying question.\n')
  return parts.join('\n')
}

export function assertNoLLMSecretsInLogs() {
  // Placeholder: keep this file as the single place that touches LLM secrets.
  // If you add logging, avoid dumping request bodies with API keys.
  void mustGetEnv
}

