import type { IncomingMessage, ServerResponse } from 'node:http'
import { invalidAccessToken, verifyMcpToken } from '../server/auth.js'
import { createMcpStore, type BoardRpc } from '../server/store.js'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createTaskboardHandler, MCP_MAX_BODY_BYTES } from '../server/mcp.js'
import { mcpConfig } from '../server/config.js'

export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  res.setHeader('Cache-Control', 'no-store')
  const fail = (status: number, error: string) => { res.setHeader('Content-Type', 'application/json'); res.writeHead(status).end(JSON.stringify({ error })) }
  let config: ReturnType<typeof mcpConfig>
  try { config = mcpConfig(); if (config.secret.length < 32) throw new Error('Missing signing key') } catch { fail(503, 'MCP is not configured'); return }
  const origin = req.headers.origin
  const allowedOrigins = [config.origin, 'https://claude.ai', ...(process.env.TASKBOARD_MCP_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean)]
  if (origin && (typeof origin !== 'string' || !allowedOrigins.includes(origin))) { fail(403, 'Origin is not allowed'); return }
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin') }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, MCP-Session-Id, Last-Event-ID')
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Retry-After, MCP-Protocol-Version, MCP-Session-Id')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
  const challenge = (invalidToken = false) => {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${config.origin}/api/oauth-protected-resource", scope="openid"${invalidToken ? ', error="invalid_token"' : ''}`)
    fail(401, 'A valid OAuth authorization is required')
  }
  const header = req.headers.authorization
  if (typeof header !== 'string' || header.length > 16000 || !/^Bearer [^\s]+$/i.test(header)) { challenge(Boolean(header)); return }
  const token = header.slice(7)
  let client: BoardRpc
  let caller: { userId: string; clientId: string }
  try {
    const claims = await verifyMcpToken(token, config.supabaseUrl, config.resource)
    if (!claims) { challenge(true); return }
    client = createMcpStore(config.databaseUrl, claims)
    // 签名验证后在数据库原子核对撤销与调用额度；不依赖单个 serverless 实例的内存计数。
    const access = await client.rpc('consume_mcp_request_budget')
    if (access.error) {
      if (access.error.code === '42501' || access.error.code === 'PGRST301') challenge(true)
      else fail(503, 'Board authorization check is temporarily unavailable')
      return
    }
    const budget = access.data as { allowed?: unknown; retryAfterSeconds?: unknown } | null
    if (typeof budget?.allowed !== 'boolean') { fail(503, 'Invalid authorization budget response'); return }
    if (!budget.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.min(60, Math.ceil(Number(budget.retryAfterSeconds) || 60)))))
      fail(429, 'MCP request limit reached; retry after the indicated delay')
      return
    }
    caller = { userId: claims.sub, clientId: claims.client_id }
  } catch (error) {
    if (invalidAccessToken(error)) challenge(true)
    else fail(503, 'Authorization service is temporarily unavailable')
    return
  }
  // SDK 对原始流设大小上限；Vercel 已解析的 body 仍需在交给 SDK 前单独检查。
  if (Number(req.headers['content-length']) > MCP_MAX_BODY_BYTES || (req.body !== undefined && Buffer.byteLength(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) > MCP_MAX_BODY_BYTES)) { fail(413, 'Request too large'); return }
  const handler = createTaskboardHandler(client, caller, config.secret)
  res.on('close', () => { void handler.close().catch(() => {}) })
  try { await toNodeHandler(handler, { maxRequestBodySize: MCP_MAX_BODY_BYTES })(req, res, req.body) }
  catch { if (!res.headersSent) fail(500, 'MCP request failed'); else if (!res.writableEnded) res.end() }
}
