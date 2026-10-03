import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { PGlite } from '@electric-sql/pglite'
import { addTask, createTask, deleteCycle, deleteTask, emptySnapshot, updateTask } from '../src/domain'
import { applyActions, mergeAgentChanges, restoreTrash, type TrashEntry } from '../src/agent-operations'
import { issueReadTicket, readTicket } from '../server/mcp'
import mcpHandler from '../api/mcp'

const owner = '00000000-0000-0000-0000-000000000001'
const other = '00000000-0000-0000-0000-000000000002'
const session = '00000000-0000-0000-0000-000000000011'
const oauthSession = '00000000-0000-0000-0000-000000000012'
const clientId = '00000000-0000-0000-0000-000000000021'
const resource = 'https://taskboard-liubai.vercel.app/api/mcp'
const now = '2026-01-15T12:00:00.000Z'
function sample() {
  return applyActions(emptySnapshot('UTC'), [
    { op: 'create_project', name: 'Project', startDate: '2026-01-01', endDate: '2026-12-31', ref: 'project' },
    { op: 'create_task', domain: 'daily', title: 'Parent', dateKey: '2026-01-15', cycleId: '$project', ref: 'parent' },
    { op: 'create_task', domain: 'daily', title: 'Child', parentId: '$parent', ref: 'child' },
    { op: 'create_focus', title: 'Focus', dateKey: '2026-01-15', taskId: '$parent' },
  ], [], now).snapshot
}

test('atomic actions, conservative recovery, concurrent edits and signed read tickets', () => {
  const base = sample()
  const parent = base.tasks[0]
  const original = JSON.stringify(base)
  assert.throws(() => applyActions(base, [{ op: 'update_task', id: parent.id, patch: { title: 'Changed' } }, { op: 'move_task', id: parent.id, target: '2027-01-01' }]), /outside/)
  assert.equal(JSON.stringify(base), original)
  const local = updateTask(base, parent.id, { title: 'Local' }, now)
  const remote = updateTask(base, base.tasks[1].id, { title: 'Remote child' }, now)
  const merged = mergeAgentChanges(base, local, remote)
  assert.equal(merged.tasks[0].title, 'Local')
  assert.equal(merged.tasks[1].title, 'Remote child')
  assert.throws(() => mergeAgentChanges(base, local, updateTask(base, parent.id, { title: 'Other' }, now)), /CONFLICT/)
  const added = addTask(base, createTask({ domain: 'daily', title: 'New arrival', cycleId: base.cycles[0].id, dateKey: '2026-01-15' }, now))
  assert.throws(() => mergeAgentChanges(base, deleteCycle(base, base.cycles[0].id), added), /scope changed/)
  const entry: TrashEntry = { id: crypto.randomUUID(), deleted_at: now, expires_at: '2026-02-15T12:00:00.000Z', payload: { cycles: [], tasks: base.tasks, focusBlocks: [] } }
  const restored = restoreTrash(deleteTask(base, parent.id), entry, {}, now)
  assert.equal(restored.tasks.length, 2)
  assert.equal(restored.focusBlocks[0].taskId, undefined, 'do not reattach surviving focus records')
  const movedProject = applyActions(emptySnapshot('UTC'), [{ op: 'create_project', name: 'Other', startDate: '2026-01-01', endDate: '2026-12-31' }], [], now).snapshot
  assert.throws(() => restoreTrash(movedProject, entry, {}, now), /Original project/)
  assert.equal(restoreTrash(movedProject, entry, { cycleId: movedProject.cycles[0].id, dateKey: '2026-02-01' }, now).tasks[0].dateKey, '2026-02-01')
  const running = { ...base.focusBlocks[0], status: 'running' as const, startedAt: '2026-01-15T11:59:00.000Z' }
  const focusEntry: TrashEntry = { ...entry, payload: { cycles: [], tasks: [], focusBlocks: [running] } }
  const stopped = restoreTrash(emptySnapshot('UTC'), focusEntry, {}, now).focusBlocks[0]
  assert.equal(stopped.status, 'paused'); assert.equal(stopped.elapsedMs, 60_000); assert.equal(stopped.startedAt, undefined)
  const caller = { userId: owner, clientId }
  const secret = 'x'.repeat(64)
  const ticket = issueReadTicket({ revision: 4, snapshot: base }, caller, secret, 100)
  assert.equal(readTicket(ticket, caller, secret, 101).revision, 4)
  assert.throws(() => readTicket(ticket, { ...caller, userId: other }, secret, 101), /different authorization/)
  assert.throws(() => readTicket(`${ticket.slice(0, -5)}aaaaa`, caller, secret, 101), /Invalid/)
  assert.throws(() => readTicket(ticket, caller, secret, 2_000_000), /expired/)
})

test('Postgres: owner isolation, CAS, trash, audit, restore, idempotency, audience, revocation and human-only purge', async () => {
  const db = new PGlite()
  await db.waitReady
  try {
    await db.exec(`
      create schema auth; create role anon; create role authenticated; create role supabase_auth_admin;
      create table auth.users(id uuid primary key);
      create table auth.sessions(id uuid primary key, user_id uuid, oauth_client_id uuid, not_after timestamptz);
      create table auth.oauth_consents(user_id uuid, client_id uuid, granted_at timestamptz default now(), revoked_at timestamptz);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      insert into auth.users values ('${owner}'), ('${other}');
      insert into auth.sessions values ('${session}', '${owner}', null, null), ('${oauthSession}', '${owner}', '${clientId}', null);
    `)
    for (const migration of ['001_private_board', '002_independent_boards', '003_task_text_limits', '004_remove_task_history', '005_project_task_scope', '006_agent_access', '007_mcp_rate_limit']) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${migration}.sql`, import.meta.url), 'utf8'))
    }
    const identity = async (userId: string, oauth = false, audience: string[] = ['authenticated', resource]) => {
      await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: userId, session_id: oauth ? oauthSession : session, ...(oauth ? { client_id: clientId } : {}), aud: audience })])
    }
    await identity(owner)
    await db.exec('set role authenticated')
    await db.query('select * from public.get_private_board()')
    const base = sample()
    await db.query('select * from public.cas_save_private_board(0, $1::jsonb)', [JSON.stringify(base)])
    const deleted = deleteTask(base, base.tasks[0].id)
    await db.query('select * from public.cas_save_private_board(1, $1::jsonb)', [JSON.stringify(deleted)])
    const trash = (await db.query<TrashEntry>('select * from public.get_board_trash()')).rows
    assert.equal(trash.length, 1); assert.equal(trash[0].payload.tasks.length, 2)
    await assert.rejects(db.query('select * from public.cas_save_private_board(1, $1::jsonb)', [JSON.stringify(base)]), (error: unknown) => (error as { code: string }).code === 'PT409')
    await identity(other)
    assert.equal((await db.query('select * from public.get_board_trash()')).rows.length, 0)
    await assert.rejects(db.query('select * from private.board_trash'), /permission denied/)
    await identity(owner)
    await db.exec('reset role')
    await db.query('insert into auth.oauth_consents(user_id, client_id) values ($1, $2)', [owner, clientId])
    await db.exec('set role authenticated')
    await identity(owner, true)
    for (let i = 0; i < 120; i++) {
      const quota = await db.query<{ value: { allowed: boolean } }>('select public.consume_mcp_request_budget() as value')
      assert.equal(quota.rows[0].value.allowed, true)
    }
    const denied = await db.query<{ value: { allowed: boolean; retryAfterSeconds: number } }>('select public.consume_mcp_request_budget() as value')
    assert.equal(denied.rows[0].value.allowed, false)
    assert(denied.rows[0].value.retryAfterSeconds >= 1 && denied.rows[0].value.retryAfterSeconds <= 60)
    await assert.rejects(db.query('select * from private.mcp_request_budgets'), /permission denied/)
    await db.exec("reset role; update private.mcp_request_budgets set window_started = now() - interval '2 minutes'; set role authenticated")
    assert.equal((await db.query<{ value: { allowed: boolean; remaining: number } }>('select public.consume_mcp_request_budget() as value')).rows[0].value.remaining, 119)
    await assert.rejects(db.query('select public.purge_board_trash($1)', [trash[0].id]), /direct user/)
    const restored = restoreTrash(deleted, trash[0])
    const requestId = crypto.randomUUID()
    const args = [JSON.stringify(restored), requestId, 'a'.repeat(64), [trash[0].id]]
    await assert.rejects(db.query('select public.commit_agent_board(2, $1::jsonb, $2::uuid, $3, $4::uuid[])', [JSON.stringify(deleted), requestId, 'a'.repeat(64), [trash[0].id]]), /every deleted object/)
    assert.equal((await db.query('select * from public.get_board_trash()')).rows.length, 1)
    const committed = await db.query<{ value: { revision: number } }>('select public.commit_agent_board(2, $1::jsonb, $2::uuid, $3, $4::uuid[]) as value', args)
    assert.equal(Number(committed.rows[0].value.revision), 3)
    const replay = await db.query<{ value: { replayed: boolean; revision: number } }>('select public.commit_agent_board(2, $1::jsonb, $2::uuid, $3, $4::uuid[]) as value', args)
    assert.equal(replay.rows[0].value.replayed, true); assert.equal(Number(replay.rows[0].value.revision), 3)
    assert.equal((await db.query('select * from public.get_board_trash()')).rows.length, 0)
    const audit = (await db.query<{ action: string }>('select * from public.get_board_audit()')).rows
    assert(audit.some((row) => row.action === 'restore')); assert(!JSON.stringify(audit).includes('Parent'))
    await identity(owner, true, ['authenticated'])
    await assert.rejects(db.query('select * from public.get_private_board()'), /revoked/)
    await identity(owner, true)
    await db.exec('reset role')
    await db.query('update auth.oauth_consents set revoked_at = now() where user_id = $1', [owner])
    await db.exec('set role authenticated')
    await assert.rejects(db.query('select * from public.get_private_board()'), /revoked/)
    await assert.rejects(db.query('select public.consume_mcp_request_budget()'), /revoked/)
    await assert.rejects(db.query('select * from public.cas_save_private_board(3, $1::jsonb)', [JSON.stringify(base)]), /revoked/)
    await identity(owner)
    await db.query('select * from public.cas_save_private_board(3, $1::jsonb)', [JSON.stringify(deleted)])
    const second = (await db.query<TrashEntry>('select * from public.get_board_trash()')).rows[0]
    await db.query('select public.purge_board_trash($1)', [second.id])
    assert.equal((await db.query('select * from public.get_board_trash()')).rows.length, 0)
    await db.exec('reset role; set role anon')
    await assert.rejects(db.query('select * from public.get_board_trash()'), /permission denied/)
  } finally { await db.close() }
})

test('MCP HTTP boundary challenges anonymous requests and rejects foreign origins', async () => {
  const old = { ...process.env }
  Object.assign(process.env, { TASKBOARD_MCP_URL: resource, TASKBOARD_MCP_SECRET: 'x'.repeat(64), SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test-key' })
  const server = createServer((req, res) => { void mcpHandler(req, res) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 401)
    assert.match(response.headers.get('www-authenticate') || '', /resource_metadata=/)
    const denied = await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', headers: { Origin: 'https://untrusted.example' } })
    assert.equal(denied.status, 403)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    for (const key of ['TASKBOARD_MCP_URL', 'TASKBOARD_MCP_SECRET', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY']) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]
    }
  }
})
