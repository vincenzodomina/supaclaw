import * as jose from '@panva/jose'
import { mustGetEnv } from './env.ts'

const SUPABASE_URL = mustGetEnv('SUPABASE_URL')
const SUPABASE_JWT_ISSUER = Deno.env.get('SB_JWT_ISSUER') ?? `${SUPABASE_URL}/auth/v1`
const SUPABASE_JWT_KEYS = jose.createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`))

export type VerifiedJwt = jose.JWTPayload & {
  role?: string
  email?: string
}

export function getBearerToken(req: Request): string {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) throw new Error('Missing authorization header')

  const [bearer, token] = authHeader.split(' ')
  if (bearer !== 'Bearer' || !token) {
    throw new Error("Authorization header must be in format 'Bearer <token>'")
  }

  return token
}

export async function verifySupabaseJwt(token: string): Promise<VerifiedJwt> {
  const { payload } = await jose.jwtVerify(token, SUPABASE_JWT_KEYS, {
    issuer: SUPABASE_JWT_ISSUER,
  })
  return payload as VerifiedJwt
}

