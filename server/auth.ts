import { createRemoteJWKSet, errors, jwtVerify } from 'jose'

export type GatewayClaims = { sub: string; client_id: string; session_id: string; iss: string; aud: string[]; exp: number; role: 'authenticated' }
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

/** 只获取公开 JWKS，本地验证入站令牌；不将 Bearer 发送给用户信息或数据 API。 */
export async function verifyMcpToken(token: string, supabaseUrl: string, resource: string): Promise<GatewayClaims | null> {
  const issuer = `${supabaseUrl}/auth/v1`
  let keys = keySets.get(issuer)
  if (!keys) { keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)); keySets.set(issuer, keys) }
  const { payload } = await jwtVerify(token, keys, { issuer, audience: resource, algorithms: ['ES256', 'RS256'], requiredClaims: ['sub', 'exp', 'client_id', 'session_id'] })
  if (payload.role !== 'authenticated' || !payload.sub || typeof payload.client_id !== 'string' || !payload.client_id || typeof payload.session_id !== 'string' || !payload.session_id || typeof payload.exp !== 'number') return null
  return { sub: payload.sub, client_id: payload.client_id, session_id: payload.session_id, iss: issuer, aud: [resource], exp: payload.exp, role: 'authenticated' }
}

export function invalidAccessToken(error: unknown): boolean {
  return error instanceof errors.JOSEError && !['ERR_JOSE_GENERIC', 'ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JWK_INVALID', 'ERR_JWKS_MULTIPLE_MATCHING_KEYS'].includes(error.code)
}
