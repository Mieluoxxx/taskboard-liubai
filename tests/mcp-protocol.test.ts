import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import pg from 'pg'
import type { BoardRpc } from '../server/store'
import { createTaskboardHandler } from '../server/mcp'
import { emptySnapshot } from '../src/domain'
import mcpHandler from '../api/mcp'
import metadataHandler from '../api/oauth-protected-resource'

const VERSION = '2026-07-28'
const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
const board = { revision: 0, snapshot: emptySnapshot('UTC') }
function fixture() {
  const calls: string[] = []
  const client: BoardRpc = { rpc: async (name: string) => {
    calls.push(name)
    if (name === 'get_private_board') return { data: [board], error: null }
    if (name === 'record_board_failure') return { data: null, error: null }
    throw new Error(`Unexpected RPC: ${name}`)
  } }
  return { handler: createTaskboardHandler(client, { userId: 'owner', clientId: 'client' }, 'x'.repeat(64)), calls }
}
function message(method: string, params: Record<string, unknown> = {}, version = VERSION) {
  return { jsonrpc: '2.0' as const, id: 1, method, params: { ...params, _meta: { [META_VERSION]: version, [META_CAPABILITIES]: {} } } }
}
function headers(method: string, name?: string, version = VERSION) {
  const result = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': version, 'Mcp-Method': method })
  if (name) result.set('Mcp-Name', name)
  return result
}
async function result(response: Response) {
  const text = await response.text()
  const json = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split(/\r?\n/).filter((line) => line.startsWith('data: ')).at(-1)?.slice(6)
    : text
  return { status: response.status, headers: response.headers, data: json ? JSON.parse(json) : undefined }
}

test('2026-07-28 wire contract: discovery, metadata, headers, result types, errors and tool schemas', async () => {
  const { handler, calls } = fixture()
  const post = async (body: ReturnType<typeof message>, changes: Record<string, string | undefined> = {}) => {
    const { name } = body.params as Record<string, unknown>
    const h = headers(body.method, typeof name === 'string' ? name : undefined, body.params._meta[META_VERSION])
    for (const [name, value] of Object.entries(changes)) value === undefined ? h.delete(name) : h.set(name, value)
    return result(await handler.fetch(new Request('https://example.test/mcp', { method: 'POST', headers: h, body: JSON.stringify(body) })))
  }
  try {
    // clientInfo 是 SHOULD，不是 MUST；没有它也必须能在无 initialize 的情况下直接调用。
    const discovery = await post(message('server/discover'))
    assert.equal(discovery.status, 200)
    assert.equal(discovery.data.result.resultType, 'complete')
    assert(discovery.data.result.supportedVersions.includes(VERSION))
    assert(discovery.data.result.capabilities.tools)
    assert.equal(discovery.data.result._meta['io.modelcontextprotocol/serverInfo'].name, 'liubai-taskboard')
    assert.equal(discovery.headers.get('mcp-session-id'), null)
    const first = await post(message('tools/list'))
    const second = await post(message('tools/list'))
    assert.deepEqual(first.data.result.tools, second.data.result.tools)
    assert.deepEqual(first.data.result.tools.map((tool: { name: string }) => tool.name), ['board_read', 'tasks_list', 'board_apply', 'trash_list', 'audit_list'])
    assert(first.data.result.tools.every((tool: { inputSchema: { type: string } }) => tool.inputSchema.type === 'object'))
    const read = await post(message('tools/call', { name: 'board_read', arguments: {} }))
    assert.equal(read.data.result.resultType, 'complete')
    assert.equal(read.data.result.structuredContent.revision, 0)
    assert.deepEqual(JSON.parse(read.data.result.content[0].text), read.data.result.structuredContent)
    const encoded = await post(message('tools/call', { name: 'board_read', arguments: {} }), { 'Mcp-Name': `=?base64?${Buffer.from('board_read').toString('base64')}?=` })
    assert.equal(encoded.status, 200)
    assert.equal(encoded.data.result.isError, undefined)
    const callCount = calls.length
    for (const changes of [{ 'Mcp-Method': undefined }, { 'MCP-Protocol-Version': undefined }, { 'Mcp-Method': 'tools/call' }, { 'MCP-Protocol-Version': '2025-11-25' }]) {
      const bad = await post(message('tools/list'), changes)
      assert.equal(bad.status, 400); assert.equal(bad.data.error.code, -32020)
    }
    for (const name of [undefined, 'tasks_list', '=?base64?!!!?=']) {
      const bad = await post(message('tools/call', { name: 'board_read', arguments: {} }), { 'Mcp-Name': name })
      assert.equal(bad.status, 400); assert.equal(bad.data.error.code, -32020)
    }
    const missingMeta = message('tools/list')
    delete (missingMeta.params as Record<string, unknown>)._meta
    const missing = await result(await handler.fetch(new Request('https://example.test/mcp', { method: 'POST', headers: headers('tools/list'), body: JSON.stringify(missingMeta) })))
    assert.equal(missing.status, 400); assert.equal(missing.data.error.code, -32602)
    const noCapabilities = message('tools/list')
    delete (noCapabilities.params._meta as Record<string, unknown>)[META_CAPABILITIES]
    const badCapabilities = await post(noCapabilities)
    assert.equal(badCapabilities.status, 400); assert.equal(badCapabilities.data.error.code, -32602)
    const unknown = await post(message('tools/list', {}, '2099-01-01'))
    assert.equal(unknown.status, 400); assert.equal(unknown.data.error.code, -32022)
    assert.deepEqual(unknown.data.error.data.requested, '2099-01-01')
    assert(unknown.data.error.data.supported.includes(VERSION))
    const method = await post(message('unsupported/method'))
    assert.equal(method.status, 404); assert.equal(method.data.error.code, -32601)
    assert.equal(calls.length, callCount, 'malformed protocol messages must not execute business RPCs')
    const invalidInput = await post(message('tools/call', { name: 'tasks_list', arguments: { limit: 0 } }))
    assert.equal(invalidInput.status, 200)
    assert.equal(invalidInput.data.result.resultType, 'complete')
    assert.equal(invalidInput.data.result.isError, true)
    const malformed = await result(await handler.fetch(new Request('https://example.test/mcp', { method: 'POST', headers: headers('tools/list'), body: '{' })))
    assert.equal(malformed.status, 400); assert.equal(malformed.data.error.code, -32700)
  } finally { await handler.close() }
})

test('legacy 2025-11-25 clients still initialize, list tools and receive a notification acknowledgement', async () => {
  const { handler } = fixture()
  const send = (body: unknown) => handler.fetch(new Request('https://example.test/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify(body) })).then(result)
  try {
    const init = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-client', version: '1' } } })
    assert.equal(init.status, 200); assert.equal(init.data.result.protocolVersion, '2025-11-25')
    assert.equal(init.headers.get('mcp-session-id'), null)
    const notification = await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(notification.status, 202); assert.equal(notification.data, undefined)
    const tools = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    assert.equal(tools.status, 200); assert.equal(tools.data.result.tools.length, 5)
    const read = await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'board_read', arguments: {} } })
    assert.equal(read.status, 200); assert.equal(read.data.result.structuredContent.revision, 0)
  } finally { await handler.close() }
})

test('Node HTTP boundary: signed JWT, Vercel parsed bodies, modern CORS, OAuth challenges and shared rate budget', async (t) => {
  const before = { ...process.env }
  const baseUrl = 'https://mcp-compliance.supabase.co'
  const resource = 'https://taskboard.test/api/mcp'
  Object.assign(process.env, { TASKBOARD_MCP_URL: resource, TASKBOARD_MCP_SECRET: 'x'.repeat(64), SUPABASE_URL: baseUrl, SUPABASE_PUBLISHABLE_KEY: 'test-public-key', TASKBOARD_DATABASE_URL: 'postgresql://liubai_mcp_gateway:test@localhost/test' })
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'protocol-test', alg: 'ES256', use: 'sig' }
  const issuedTokens: string[] = []
  const jwt = (audience: string, expires = Math.floor(Date.now() / 1000) + 300) => {
    const head = Buffer.from(JSON.stringify({ alg: 'ES256', kid: jwk.kid })).toString('base64url')
    const claims = Buffer.from(JSON.stringify({ iss: `${baseUrl}/auth/v1`, sub: 'owner', role: 'authenticated', client_id: 'client', session_id: 'session', aud: ['authenticated', audience], exp: expires })).toString('base64url')
    const payload = `${head}.${claims}`
    const token = `${payload}.${sign('sha256', Buffer.from(payload), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
    issuedTokens.push(token)
    return token
  }
  let limited = false
  let revoked = false
  const fetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (new URL(url).hostname === '127.0.0.1') return fetch(input, init)
    if (url.endsWith('/.well-known/jwks.json')) {
      assert.equal(new Headers(init?.headers).get('authorization'), null, 'public JWKS fetch must not receive the MCP token')
      return Response.json({ keys: [jwk] })
    }
    throw new Error(`Unexpected upstream HTTP path: ${new URL(url).pathname}`)
  })
  t.mock.method(pg.Pool.prototype, 'query', async (...args: unknown[]) => {
    assert.equal(args[0], 'select public.mcp_dispatch($1::jsonb, $2::text, $3::jsonb) as data')
    const values = args[1] as string[]
    for (const token of issuedTokens) assert(!JSON.stringify(values).includes(token), 'do not forward MCP bearer tokens to the database')
    const claims = JSON.parse(values[0])
    assert.equal(claims.sub, 'owner'); assert.equal(claims.client_id, 'client')
    assert.deepEqual(claims.aud, [resource])
    assert.equal(values[1], 'consume_mcp_request_budget')
    if (revoked) throw Object.assign(new Error('Access revoked'), { code: '42501' })
    return { rows: [{ data: { allowed: !limited, retryAfterSeconds: 7 } }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] }
  })
  const server = createServer(async (req: IncomingMessage & { body?: unknown }, res) => {
    if (req.url === '/metadata') { metadataHandler(req, res); return }
    if (req.url === '/parsed') {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      req.body = JSON.parse(Buffer.concat(chunks).toString())
    }
    await mcpHandler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const origin = 'https://claude.ai'
    const preflight = await fetch(local, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Headers': 'authorization,mcp-protocol-version,mcp-method,mcp-name' } })
    assert.equal(preflight.status, 204)
    for (const name of ['mcp-method', 'mcp-name', 'mcp-protocol-version']) assert(preflight.headers.get('access-control-allow-headers')?.toLowerCase().includes(name))
    const anonymous = await fetch(local, { method: 'POST', headers: { Origin: origin } })
    assert.equal(anonymous.status, 401)
    assert(anonymous.headers.get('access-control-expose-headers')?.toLowerCase().includes('www-authenticate'))
    assert.match(anonymous.headers.get('www-authenticate')!, /resource_metadata=/)
    const metadata = await fetch(`${local}/metadata`, { headers: { Origin: origin } })
    assert.equal(metadata.headers.get('access-control-allow-origin'), '*')
    assert.equal((await metadata.json()).resource, resource)
    const h = headers('server/discover'); h.set('Authorization', `Bearer ${jwt(resource)}`)
    const body = JSON.stringify(message('server/discover'))
    const success = await fetch(`${local}/parsed`, { method: 'POST', headers: h, body }).then(result)
    assert.equal(success.status, 200); assert(success.data.result.supportedVersions.includes(VERSION))
    for (const token of [jwt('https://other-resource.test'), jwt(resource, 1), 'not-a-jwt']) {
      const rejected = await fetch(local, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      assert.equal(rejected.status, 401)
      assert.match(rejected.headers.get('www-authenticate')!, /error="invalid_token"/)
    }
    limited = true
    const denied = await fetch(local, { method: 'POST', headers: h, body })
    assert.equal(denied.status, 429); assert.equal(denied.headers.get('retry-after'), '7')
    limited = false; revoked = true
    assert.equal((await fetch(local, { method: 'POST', headers: h, body })).status, 401)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    t.mock.restoreAll()
    for (const name of ['TASKBOARD_MCP_URL', 'TASKBOARD_MCP_SECRET', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'TASKBOARD_DATABASE_URL']) {
      if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]
    }
  }
})
