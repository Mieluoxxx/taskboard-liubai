export function mcpConfig() {
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
  const resource = process.env.TASKBOARD_MCP_URL || ''
  const secret = process.env.TASKBOARD_MCP_SECRET || ''
  const url = new URL(resource)
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('MCP requires HTTPS')
  if (url.username || url.password || url.search || url.hash || !supabaseUrl.startsWith('https://')) throw new Error('Invalid MCP configuration')
  return { supabaseUrl, resource: url.href, secret, origin: url.origin, databaseUrl: process.env.TASKBOARD_DATABASE_URL || '' }
}
