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

test('agents can create, shift, stretch and collapse multi-week plans', () => {
  const run = (actions: unknown[], board: ReturnType<typeof sample>) => applyActions(board, actions, [], now).snapshot
  const board = sample()
  const cycleId = board.cycles[0].id
  const base = run([
    { op: 'create_task', domain: 'weekly', title: 'Span', cycleId, weekKey: '2026-W03', endWeekKey: '2026-W05', ref: 'span' },
    { op: 'create_task', domain: 'weekly', title: 'Child', parentId: '$span' },
    { op: 'create_task', domain: 'weekly', title: 'Later', cycleId, weekKey: '2026-W05' },
  ], board)
  const [span, child, later] = base.tasks.filter((task) => task.domain === 'weekly')
  assert.deepEqual([child.weekKey, child.endWeekKey], ['2026-W03', '2026-W05'], 'a subtask inherits the whole span')
  const placement = (board: typeof base) => { const task = board.tasks.find((entry) => entry.id === span.id)!; return [task.weekKey, task.endWeekKey] }
  assert.deepEqual(placement(run([{ op: 'move_task', id: span.id, target: '2026-W10' }], base)), ['2026-W10', '2026-W12'])
  assert.deepEqual(placement(run([{ op: 'move_task', id: span.id, target: '2026-W03', endWeekKey: '2026-W08' }], base)), ['2026-W03', '2026-W08'])
  assert.deepEqual(placement(run([{ op: 'move_task', id: span.id, target: '2026-W04', endWeekKey: null }], base)), ['2026-W04', undefined])
  assert.throws(() => run([{ op: 'move_task', id: span.id, target: '2026-W52', endWeekKey: '2027-W02' }], base), /outside/)
  assert.throws(() => run([{ op: 'create_task', domain: 'weekly', title: 'Bad', cycleId: base.cycles[0].id, weekKey: '2026-W05', endWeekKey: '2026-W04' }], base), /placement is invalid/i)
  // 日任务同理，但跨度不能出周；字段只能用在各自的域上。
  const days = run([{ op: 'create_task', domain: 'daily', title: 'Days', cycleId, dateKey: '2026-01-12', endDateKey: '2026-01-14', ref: 'days' }], base)
  const daily = days.tasks.find((task) => task.title === 'Days')!
  const dayPlacement = (board: typeof base) => { const task = board.tasks.find((entry) => entry.id === daily.id)!; return [task.dateKey, task.endDateKey] }
  assert.deepEqual(dayPlacement(run([{ op: 'move_task', id: daily.id, target: '2026-01-15' }], days)), ['2026-01-15', '2026-01-17'])
  assert.deepEqual(dayPlacement(run([{ op: 'move_task', id: daily.id, target: '2026-01-12', endDateKey: '2026-01-18' }], days)), ['2026-01-12', '2026-01-18'])
  assert.deepEqual(dayPlacement(run([{ op: 'move_task', id: daily.id, target: '2026-01-13', endDateKey: null }], days)), ['2026-01-13', undefined])
  assert.throws(() => run([{ op: 'move_task', id: daily.id, target: '2026-01-17' }], days), /one ISO week/)
  assert.throws(() => run([{ op: 'move_task', id: daily.id, target: '2026-01-12', endWeekKey: '2026-W04' }], days), /endDateKey is for daily/)
  assert.throws(() => run([{ op: 'create_task', domain: 'daily', title: 'Bad', cycleId, dateKey: '2026-01-17', endDateKey: '2026-01-19' }], base), /placement is invalid/i)
  // 跨度相交的周任务在同一周里同时出现，因此可以互相排序。
  assert.equal(run([{ op: 'reorder_task', id: later.id, targetId: span.id }], base).tasks.filter((task) => task.domain === 'weekly' && !task.parentId)[0].id, later.id)
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
    for (const migration of ['001_private_board', '002_independent_boards', '003_task_text_limits', '004_remove_task_history', '005_project_task_scope', '006_agent_access', '007_mcp_rate_limit', '008_mcp_database_gateway', '009_weekly_span', '010_daily_span']) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${migration}.sql`, import.meta.url), 'utf8'))
    }
    await db.exec("update private.agent_config set oauth_issuer = 'https://example.supabase.co/auth/v1'")
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
    const principal = { sub: owner, client_id: clientId, session_id: oauthSession, role: 'authenticated', aud: [resource], iss: 'https://example.supabase.co/auth/v1', exp: Math.floor(Date.now() / 1000) + 3600 }
    const dispatch = (claims: unknown, method = 'get_private_board') => db.query<{ data: Array<{ revision: number }> }>('select public.mcp_dispatch($1::jsonb, $2, $3::jsonb) as data', [JSON.stringify(claims), method, '{}'])
    await assert.rejects(dispatch(principal), /permission denied/)
    await db.exec('reset role; set role liubai_mcp_gateway')
    await assert.rejects(db.query('select * from private.personal_boards'), /permission denied/)
    await assert.rejects(db.query('select * from public.get_private_board()'), /permission denied/)
    const previousClaims = (await db.query<{ value: string }>("select current_setting('request.jwt.claims') as value")).rows[0].value
    assert.equal(Number((await dispatch(principal)).rows[0].data[0].revision), 3)
    assert.equal((await db.query<{ value: string }>("select current_setting('request.jwt.claims') as value")).rows[0].value, previousClaims, 'pool context must not leak to the next query')
    await assert.rejects(dispatch(principal, 'purge_board_trash'), /not available/)
    await assert.rejects(dispatch({ ...principal, sub: other }), /revoked/)
    await assert.rejects(dispatch({ ...principal, client_id: '' }), /Invalid gateway/)
    await assert.rejects(dispatch({ ...principal, iss: 'https://other.example' }), /Invalid gateway/)
    await assert.rejects(dispatch({ ...principal, aud: ['authenticated'] }), /revoked/)
    await assert.rejects(dispatch({ ...principal, exp: 1 }), /expired/)
    await db.exec('reset role; set role authenticated')
    await identity(owner, true, ['authenticated'])
    await assert.rejects(db.query('select * from public.get_private_board()'), /revoked/)
    await identity(owner, true)
    await db.exec('reset role')
    await db.query('update auth.oauth_consents set revoked_at = now() where user_id = $1', [owner])
    await db.exec('set role authenticated')
    await assert.rejects(db.query('select * from public.get_private_board()'), /revoked/)
    await assert.rejects(db.query('select public.consume_mcp_request_budget()'), /revoked/)
    await assert.rejects(db.query('select * from public.cas_save_private_board(3, $1::jsonb)', [JSON.stringify(base)]), /revoked/)
    await db.exec('reset role; set role liubai_mcp_gateway')
    await assert.rejects(dispatch(principal), /revoked/)
    await db.exec('reset role; set role authenticated')
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
