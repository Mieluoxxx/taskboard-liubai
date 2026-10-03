import type { IncomingMessage, ServerResponse } from 'node:http'
import { mcpConfig } from '../server/config.js'

export default function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); res.writeHead(405).end(); return }
  try {
    const config = mcpConfig()
    res.end(JSON.stringify({ resource: config.resource, authorization_servers: [`${config.supabaseUrl}/auth/v1`], bearer_methods_supported: ['header'], scopes_supported: ['openid'], resource_name: 'Liubai Taskboard' }))
  } catch { res.writeHead(503).end(JSON.stringify({ error: 'MCP is not configured' })) }
}
