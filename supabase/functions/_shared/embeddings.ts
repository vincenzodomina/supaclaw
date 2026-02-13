import { Supabase } from '@supabase/functions-js/edge-runtime.d.ts'

export const EMBEDDING_DIMENSIONS = 384

const session = new Supabase.ai.Session('gte-small')

export async function embedText(input: string): Promise<number[]> {
  const embedding = await session.run(input, { mean_pool: true, normalize: true })
  // Supabase returns Float32Array-like; ensure plain array for JSON/pgvector
  return Array.from(embedding as unknown as number[])
}

