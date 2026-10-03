import type { IncomingMessage, ServerResponse } from 'node:http'
import { createClient } from '@supabase/supabase-js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createTaskboardServer } from '../server/mcp.js'
import { mcpConfig } from '../server/config.js'

export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  res.setHeader('Cache-Control', 'no-store')
  const fail = (status: number, error: string) => { res.setHeader('Content-Type', 'application/json'); res.writeHead(status).end(JSON.stringify({ error })) }
  let config: ReturnType<typeof mcpConfig>
  try { config = mcpConfig(); if (config.secret.length < 32) throw new Error('Missing signing key') } catch { fail(503, 'MCP is not configured'); return }
  const origin = req.headers.origin
  const allowedOrigins = [config.origin, 'https://claude.ai', ...(process.env.TASKBOARD_MCP_ORIGINS || '').split(',').filter(Boolean)]
  if (origin && (typeof origin !== 'string' || !allowedOrigins.includes(origin))) { fail(403, 'Origin is not allowed'); return }
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin') }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
  const challenge = () => {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${config.origin}/api/oauth-protected-resource", scope="openid"`)
    fail(401, 'A valid OAuth authorization is required')
  }
  const header = req.headers.authorization
  if (typeof header !== 'string' || header.length > 16000 || !/^Bearer [^\s]+$/i.test(header)) { challenge(); return }
  const token = header.slice(7)
  const client = createClient(config.supabaseUrl, config.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { headers: { Authorization: header } } })
  let caller: { userId: string; clientId: string }
  try {
    const { data, error } = await client.auth.getClaims(token)
    const claims = data?.claims
    const audiences = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud]
    if (error || !claims || claims.iss !== `${config.supabaseUrl}/auth/v1` || claims.role !== 'authenticated' || typeof claims.sub !== 'string' || typeof claims.client_id !== 'string' || !claims.client_id || !audiences.includes(config.resource)) { challenge(); return }
    // 初始化、查询和变更都验证授权未撤销，不能只验证尚未过期的 JWT 签名。
    const access = await client.rpc('get_private_board')
    if (access.error) {
      if (access.error.code === '42501' || access.error.code === 'PGRST301') challenge()
      else fail(503, 'Board authorization check is temporarily unavailable')
      return
    }
    caller = { userId: claims.sub, clientId: claims.client_id }
  } catch { fail(503, 'Authorization service is temporarily unavailable'); return }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); fail(405, 'Use stateless Streamable HTTP POST'); return }
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) { fail(415, 'Expected application/json'); return }
  let body = req.body
  try {
    if (Number(req.headers['content-length']) > 2_000_000) { fail(413, 'Request too large'); return }
    if (body === undefined) {
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (size > 2_000_000) { fail(413, 'Request too large'); return }
        chunks.push(bytes)
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } else {
      if (Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body)) > 2_000_000) { fail(413, 'Request too large'); return }
      if (typeof body === 'string') body = JSON.parse(body)
    }
  } catch { fail(400, 'Invalid JSON request'); return }
  const server = createTaskboardServer(client, caller, config.secret)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => { void server.close().catch(() => {}) })
  try { await server.connect(transport); await transport.handleRequest(req, res, body) }
  catch { if (!res.headersSent) fail(500, 'MCP request failed'); else if (!res.writableEnded) res.end() }
}
