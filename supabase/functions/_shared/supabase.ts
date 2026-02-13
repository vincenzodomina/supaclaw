import { createClient } from 'npm:@supabase/supabase-js@2'
import { mustGetEnv } from './env.ts'

export function createServiceClient() {
  const url = mustGetEnv('SUPABASE_URL')
  const key = mustGetEnv('SUPABASE_SERVICE_ROLE_KEY')

  return createClient(url, key, {
    auth: { persistSession: false },
    global: {
      headers: {
        // Useful for tracing in Postgres logs
        'X-Client-Info': 'supaclaw-edge',
      },
    },
  })
}

