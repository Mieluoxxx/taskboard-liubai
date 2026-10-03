import pg from 'pg'
import type { GatewayClaims } from './auth.js'

export type RpcReply = { data: unknown; error: { code: string; message: string } | null }
export type BoardRpc = { rpc: (method: string, args?: Record<string, unknown>) => PromiseLike<RpcReply> }
let pool: pg.Pool | undefined

/** 数据库凭据与 MCP Bearer 独立；专用角色只能执行受限分派函数，不能读表或永久清除。 */
export function createMcpStore(databaseUrl: string, claims: GatewayClaims): BoardRpc {
  if (!databaseUrl) throw new Error('Database gateway is not configured')
  if (!pool) {
    const url = new URL(databaseUrl)
    if (!/^liubai_mcp_gateway(?:\.[a-z0-9]+)?$/.test(url.username)) throw new Error('Use the restricted MCP database role')
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || (url.searchParams.has('sslmode') && url.searchParams.get('sslmode') !== 'verify-full')) throw new Error('Verified PostgreSQL TLS is required')
    const ca = process.env.TASKBOARD_DATABASE_CA?.replaceAll('\\n', '\n')
    pool = new pg.Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) }, max: 1, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, allowExitOnIdle: true })
    pool.on('error', () => { console.warn('[taskboard] idle database connection closed') })
  }
  const connection = pool
  // 只传递最少的、已经验证的主体上下文，不保存或转发原访问令牌。
  const context = JSON.stringify(claims)
  return {
    async rpc(method, args = {}) {
      try {
        // 无命名 prepared statement，适配 Supabase transaction pooler。
        const result = await connection.query<{ data: unknown }>('select public.mcp_dispatch($1::jsonb, $2::text, $3::jsonb) as data', [context, method, JSON.stringify(args)])
        return { data: result.rows[0]?.data ?? null, error: null }
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'DB_UNAVAILABLE'
        const safe = ['PT409', '42501', '22023'].includes(code)
        if (!safe) console.warn('[taskboard] database request failed', /^[A-Z0-9_]+$/.test(code) ? code : 'DB_UNAVAILABLE')
        return { data: null, error: { code, message: safe && error instanceof Error ? error.message : 'Database request failed' } }
      }
    },
  }
}
