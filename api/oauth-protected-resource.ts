import type { IncomingMessage, ServerResponse } from 'node:http'
import { mcpConfig } from '../server/config.js'

export default function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  // 发现文档只含公共配置，必须可被浏览器客户端跨域读取，不携带 Cookie。
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD, OPTIONS'); res.writeHead(405).end(); return }
  try {
    const config = mcpConfig()
    res.end(JSON.stringify({ resource: config.resource, authorization_servers: [`${config.supabaseUrl}/auth/v1`], bearer_methods_supported: ['header'], scopes_supported: ['openid'], resource_name: 'Liubai Taskboard' }))
  } catch { res.writeHead(503).end(JSON.stringify({ error: 'MCP is not configured' })) }
}
