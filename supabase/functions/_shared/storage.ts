import { createServiceClient } from './supabase.ts'

const supabase = createServiceClient()

function sanitizeObjectPath(objectPath: string): string {
  const normalizedPath = objectPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
  if (!normalizedPath || normalizedPath.includes('..')) {
    throw new Error('Invalid storage path')
  }
  return normalizedPath
}

export async function downloadTextFromWorkspace(objectPath: string): Promise<string | null> {
  const bucket = Deno.env.get('WORKSPACE_BUCKET') ?? 'workspace'
  const safePath = sanitizeObjectPath(objectPath)
  const { data, error } = await supabase.storage.from(bucket).download(safePath)
  if (error) {
    // Not found is common for optional files
    if (error.message?.toLowerCase().includes('not found')) return null
    throw new Error(`Storage download failed: ${error.message}`)
  }
  return await data.text()
}

