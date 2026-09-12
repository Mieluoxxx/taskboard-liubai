import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { addCycle, addFocusBlock, addTask, createTask, emptySnapshot, rescheduleDailyTask, safeTimeZone, validateSnapshot } from '../src/domain'

const OWNER = '00000000-0000-0000-0000-000000000001'
const OTHER = '00000000-0000-0000-0000-000000000002'
const THIRD = '00000000-0000-0000-0000-000000000003'

async function database(applyIndependentMigration = true) {
  const db = new PGlite()
  await db.waitReady
  await db.exec(`
    create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('${OWNER}'), ('${OTHER}'), ('${THIRD}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create role anon;
    create role authenticated;
  `)
  await db.exec(await readFile(new URL('../supabase/migrations/001_private_board.sql', import.meta.url), 'utf8'))
  if (!applyIndependentMigration) await db.exec(`insert into private.owner_config(owner_uuid) values ('${OWNER}');`)
  if (applyIndependentMigration) await db.exec(await readFile(new URL('../supabase/migrations/002_independent_boards.sql', import.meta.url), 'utf8'))
  await db.exec(`select set_config('request.jwt.claim.sub', '${OWNER}', false);`)
  return db
}

test('independent board migration preserves an existing user board', async () => {
  const db = await database(false)
  try {
    const before = await db.query<{ revision: number; snapshot: Record<string, unknown> }>('select * from public.get_private_board()')
    const snapshot = { ...before.rows[0].snapshot, settings: { timeZone: 'UTC' }, tasks: [{
      id: 'legacy-task', domain: 'daily', title: 'Legacy task', note: '', checked: false, color: 'ink',
      dateKey: '2025-01-15', history: [], createdAt: '2025-01-15T12:00:00.000Z', updatedAt: '2025-01-15T12:00:00.000Z',
    }] }
    await db.query('select * from public.cas_save_private_board($1, $2::jsonb)', [before.rows[0].revision, JSON.stringify(snapshot)])
    await db.exec(await readFile(new URL('../supabase/migrations/002_independent_boards.sql', import.meta.url), 'utf8'))
    const after = await db.query<{ revision: number; snapshot: { tasks: Array<{ id: string }> } }>('select * from public.get_private_board()')
    assert.equal(Number(after.rows[0].revision), 1)
    assert.deepEqual(after.rows[0].snapshot.tasks.map((task) => task.id), ['legacy-task'])
  } finally {
    await db.close()
  }
})

test('independent boards are created per authenticated user without owner provisioning', async () => {
  const db = await database()
  try {
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${OWNER}', false)`)
    const ownerBoard = await db.query<{ revision: number; snapshot: Record<string, unknown> }>('select * from public.get_private_board()')
    assert.equal(Number(ownerBoard.rows[0].revision), 0)
    const ownerSnapshot = { ...ownerBoard.rows[0].snapshot, settings: { timeZone: 'UTC' }, tasks: [{
      id: 'owner-task', domain: 'daily', title: 'Owner task', note: '', checked: false, color: 'ink',
      dateKey: '2025-01-15', history: [], createdAt: '2025-01-15T12:00:00.000Z', updatedAt: '2025-01-15T12:00:00.000Z',
    }] }
    const savedOwner = await db.query<{ revision: number }>('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(ownerSnapshot)])
    assert.equal(Number(savedOwner.rows[0].revision), 1)

    await db.exec(`select set_config('request.jwt.claim.sub', '${OTHER}', false)`)
    const otherBoard = await db.query<{ revision: number; snapshot: { tasks: unknown[] } }>('select * from public.get_private_board()')
    assert.equal(Number(otherBoard.rows[0].revision), 0)
    assert.deepEqual(otherBoard.rows[0].snapshot.tasks, [])
    const savedOther = await db.query<{ revision: number }>('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(otherBoard.rows[0].snapshot)])
    assert.equal(Number(savedOther.rows[0].revision), 1)

    await db.exec(`select set_config('request.jwt.claim.sub', '${OWNER}', false)`)
    const ownerAgain = await db.query<{ revision: number; snapshot: { tasks: Array<{ id: string }> } }>('select * from public.get_private_board()')
    assert.equal(Number(ownerAgain.rows[0].revision), 1)
    assert.deepEqual(ownerAgain.rows[0].snapshot.tasks.map((task) => task.id), ['owner-task'])
  } finally {
    await db.close()
  }
})

test('Supabase migration executes CAS and rejects stale or unsafe snapshots', async () => {
  const db = await database()
  try {
    const loaded = await db.query<{ revision: number; snapshot: Record<string, unknown> }>('select * from public.get_private_board()')
    assert.equal(Number(loaded.rows[0].revision), 0)
    const snapshot = loaded.rows[0].snapshot
    const saved = await db.query<{ revision: number }>('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(snapshot)])
    assert.equal(Number(saved.rows[0].revision), 1)
    await assert.rejects(
      db.query('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(snapshot)]),
      /Board revision conflict|revision conflict/i,
    )
    const unsafe = { ...emptySnapshot('UTC'), focusBlocks: [
      { id: 'a', dateKey: '2025-01-01', title: 'a', durationMinutes: 45, status: 'running', startedAt: '2025-01-01T00:00:00.000Z', elapsedMs: 0, createdAt: '2025-01-01T00:00:00.000Z' },
      { id: 'b', dateKey: '2025-01-01', title: 'b', durationMinutes: 45, status: 'running', startedAt: '2025-01-01T00:00:00.000Z', elapsedMs: 0, createdAt: '2025-01-01T00:00:00.000Z' },
    ] }
    await assert.rejects(
      db.query('select * from public.cas_save_private_board($1, $2::jsonb)', [1, JSON.stringify(unsafe)]),
      /Only one focus timer/i,
    )
  } finally {
    await db.close()
  }
})

test('Supabase migration rejects anonymous access and keeps direct table writes private', async () => {
  const db = await database()
  try {
    await db.exec(`select set_config('request.jwt.claim.sub', '${OTHER}', false)`)
    const loaded = await db.query<{ revision: number }>('select * from public.get_private_board()')
    assert.equal(Number(loaded.rows[0].revision), 0)
    await db.exec("select set_config('request.jwt.claim.sub', '', false)")
    await assert.rejects(db.query('select * from public.get_private_board()'), /Authentication required/i)
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${OWNER}', false)`)
    await assert.rejects(db.query('select * from private.personal_boards'), /permission denied/i)
    await db.exec('reset role')
  } finally {
    await db.close()
  }
})

test('the RPCs are callable by authenticated users and create independent boards', async () => {
  const db = await database()
  try {
    // Run as the real `authenticated` role instead of the PGlite superuser, so EXECUTE grants matter.
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${OWNER}', false)`)
    const loaded = await db.query<{ revision: number }>('select revision from public.get_private_board()')
    assert.equal(Number(loaded.rows[0].revision), 0)
    await db.exec(`select set_config('request.jwt.claim.sub', '${OTHER}', false)`)
    const other = await db.query<{ revision: number }>('select revision from public.get_private_board()')
    assert.equal(Number(other.rows[0].revision), 0)
    await db.exec('reset role')
  } finally {
    await db.close()
  }
})

test('the SQL validator rejects the same malformed snapshots the client rejects', async () => {
  const db = await database()
  try {
    const loaded = await db.query<{ snapshot: Record<string, unknown> }>('select snapshot from public.get_private_board()')
    const base = loaded.rows[0].snapshot
    const now = '2025-01-15T12:00:00.000Z'

    const cases: Array<[string, Record<string, unknown>]> = [
      ['missing checked', { tasks: [{ id: 't1', domain: 'daily', title: 'x', note: '', color: 'ink', dateKey: '2025-01-15', history: [], createdAt: now, updatedAt: now }] }],
      ['missing color', { tasks: [{ id: 't1', domain: 'daily', title: 'x', note: '', checked: false, dateKey: '2025-01-15', history: [], createdAt: now, updatedAt: now }] }],
      ['missing domain', { tasks: [{ id: 't1', title: 'x', note: '', checked: false, color: 'ink', dateKey: '2025-01-15', history: [], createdAt: now, updatedAt: now }] }],
      ['nonexistent ISO week', { tasks: [{ id: 't1', domain: 'weekly', title: 'x', note: '', checked: false, color: 'ink', weekKey: '2021-W53', history: [], createdAt: now, updatedAt: now }] }],
      ['missing focus date', { focusBlocks: [{ id: 'f1', title: 'x', status: 'paused', durationMinutes: 45, elapsedMs: 0, createdAt: now }] }],
      ['missing focus status', { focusBlocks: [{ id: 'f1', dateKey: '2025-01-15', title: 'x', durationMinutes: 45, elapsedMs: 0, createdAt: now }] }],
      ['missing cycle date', { cycles: [{ id: 'c1', name: 'Q1', startDate: '2025-01-01', createdAt: now }] }],
    ]
    for (const [label, patch] of cases) {
      const bad = { ...base, ...patch }
      await assert.rejects(
        db.query('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(bad)]),
        /invalid|unsupported|too large/i,
        `expected SQL to reject: ${label}`,
      )
    }
    // a real ISO week still passes, so the stricter check is not simply rejecting everything
    const good = { ...base, tasks: [{ id: 't2', domain: 'weekly', title: 'ok', note: '', checked: false, color: 'ink', weekKey: '2020-W53', history: [], createdAt: now, updatedAt: now }] }
    const saved = await db.query<{ revision: number }>('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(good)])
    assert.equal(Number(saved.rows[0].revision), 1)
  } finally {
    await db.close()
  }
})

test('a task or history entry missing its placement key is rejected, not silently accepted via SQL NULL semantics', async () => {
  const db = await database()
  try {
    const loaded = await db.query<{ snapshot: Record<string, unknown> }>('select snapshot from public.get_private_board()')
    const base = loaded.rows[0].snapshot
    const now = '2025-01-15T12:00:00.000Z'
    const task = (placement: Record<string, unknown>) => ({
      id: 't1', domain: placement.domain, title: 'x', note: '', checked: false, color: 'ink',
      history: [], createdAt: now, updatedAt: now, ...placement,
    })
    const cases: Array<[string, Record<string, unknown>]> = [
      ['weekly with no weekKey', { tasks: [task({ domain: 'weekly' })] }],
      ['daily with no dateKey', { tasks: [task({ domain: 'daily' })] }],
      ['long with no cycleId', { tasks: [task({ domain: 'long' })] }],
      ['weekly history with no weekKey', { tasks: [{ ...task({ domain: 'weekly', weekKey: '2020-W53' }), history: [{ domain: 'weekly', recordedAt: now }] }] }],
      ['history with only an empty cycleId', { tasks: [{ ...task({ domain: 'weekly', weekKey: '2020-W53' }), history: [{ domain: 'long', cycleId: '', recordedAt: now }] }] }],
    ]
    for (const [label, patch] of cases) {
      await assert.rejects(
        db.query('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify({ ...base, ...patch })]),
        /invalid|unsupported/i,
        `expected SQL to reject: ${label}`,
      )
    }
  } finally {
    await db.close()
  }
})

test('SQL type checks use NULL-safe comparison, so a missing key cannot bypass validation', async () => {
  const base = { schemaVersion: 1, settings: { timeZone: 'UTC' }, cycles: [], tasks: [], focusBlocks: [] }
  const now = '2025-01-15T12:00:00.000Z'
  const cases: Array<[string, unknown]> = [
    ['task missing the history array', { ...base, tasks: [{ id: 't1', domain: 'daily', title: 'x', note: '', checked: false, color: 'ink', dateKey: '2025-01-15', createdAt: now, updatedAt: now }] }],
    ['snapshot missing the cycles key', { schemaVersion: 1, settings: { timeZone: 'UTC' }, tasks: [], focusBlocks: [] }],
    ['snapshot missing the tasks key', { schemaVersion: 1, settings: { timeZone: 'UTC' }, cycles: [], focusBlocks: [] }],
    ['snapshot missing the focusBlocks key', { schemaVersion: 1, settings: { timeZone: 'UTC' }, cycles: [], tasks: [] }],
    ['archived metadata without archivedAt', { ...base, tasks: [{ id: 't1', domain: 'daily', title: 'x', note: '', checked: false, color: 'ink', dateKey: '2025-01-15', history: [], rescheduledTo: 't1', createdAt: now, updatedAt: now }] }],
    ['a dangling reschedule target', { ...base, tasks: [{ id: 't1', domain: 'daily', title: 'x', note: '', checked: false, color: 'ink', dateKey: '2025-01-15', history: [], archivedAt: now, archivedReason: 'rescheduled', rescheduledTo: 'ghost', createdAt: now, updatedAt: now }] }],
  ]
  for (const [label, payload] of cases) {
    // A fresh database per case: a wrongly accepted snapshot would bump the revision and turn later
    // cases into CAS conflicts, which would make this test pass for the wrong reason.
    const db = await database()
    try {
      await db.query('select * from public.get_private_board()')
      await assert.rejects(
        db.query('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(payload)]),
        /invalid|unsupported|too large/i,
        `expected SQL to reject: ${label}`,
      )
    } finally {
      await db.close()
    }
  }
  // the shape is not simply rejected wholesale
  const db = await database()
  try {
    await db.query('select * from public.get_private_board()')
    const saved = await db.query<{ revision: number }>('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(base)])
    assert.equal(Number(saved.rows[0].revision), 1)
  } finally {
    await db.close()
  }
})

test('a snapshot produced by the client always passes the database validator', async () => {
  // The two validators must agree: SQL must not be stricter than the client, or the app could not save.
  let snapshot = emptySnapshot('UTC')
  const now = '2025-01-15T12:00:00.000Z'
  snapshot = addCycle(snapshot, 'Q1', '2025-01-01', '2025-03-31', now)
  const cycleId = snapshot.cycles[0].id
  const goal = createTask({ domain: 'long', title: 'Direction', cycleId }, now)
  snapshot = addTask(snapshot, goal)
  const weekly = createTask({ domain: 'weekly', title: 'Weekly step', weekKey: '2025-W03', upperTaskId: goal.id }, now)
  snapshot = addTask(snapshot, weekly)
  const daily = createTask({ domain: 'daily', title: 'Daily step', dateKey: '2025-01-15', upperTaskId: weekly.id }, now)
  snapshot = addTask(snapshot, daily)
  const subtask = createTask({ domain: 'daily', title: 'Subtask', dateKey: '2025-01-15', parentId: daily.id }, now)
  snapshot = addTask(snapshot, subtask)
  snapshot = addFocusBlock(snapshot, { id: 'focus-1', dateKey: '2025-01-15', title: 'Deep work', taskId: daily.id, durationMinutes: 45, status: 'running', startedAt: now, elapsedMs: 0, createdAt: now })
  // 重排会保留归档条目与 rescheduledTo 指针，这是最容易被误拒的形状。
  snapshot = rescheduleDailyTask(snapshot, daily.id, '2025-01-17', '2025-01-16T00:00:00.000Z')
  validateSnapshot(snapshot)

  const db = await database()
  try {
    await db.query('select * from public.get_private_board()')
    const saved = await db.query<{ revision: number }>('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(snapshot)])
    assert.equal(Number(saved.rows[0].revision), 1)
    // and the stored snapshot round-trips through the client validator.
    // JSONB drops keys whose value was `undefined`, so compare the normalized JSON form.
    const loaded = await db.query<{ snapshot: unknown }>('select * from public.get_private_board()')
    assert.deepEqual(JSON.parse(JSON.stringify(validateSnapshot(loaded.rows[0].snapshot))), JSON.parse(JSON.stringify(snapshot)))
  } finally {
    await db.close()
  }
})

test('history placement must be domain-consistent, matching the client validator', async () => {
  const now = '2025-01-15T12:00:00.000Z'
  const weekly = (history: Array<Record<string, unknown>>) => ({
    schemaVersion: 1,
    settings: { timeZone: 'UTC' },
    cycles: [],
    tasks: [{ id: 't1', domain: 'weekly', title: 'x', note: '', checked: false, color: 'ink', weekKey: '2020-W53', history, createdAt: now, updatedAt: now }],
    focusBlocks: [],
  })
  // history records the ORIGINAL placement, so an entry may legitimately describe another domain;
  // what must hold is that each entry carries exactly the placement key its own domain uses.
  const rejected: Array<[string, Array<Record<string, unknown>>]> = [
    ['a long history entry with no cycleId', [{ domain: 'long', recordedAt: now }]],
    ['a daily history entry with no dateKey', [{ domain: 'daily', recordedAt: now }]],
    ['a weekly history entry carrying a dateKey too', [{ domain: 'weekly', weekKey: '2020-W53', dateKey: '2025-01-15', recordedAt: now }]],
    ['a long history entry carrying a weekKey as well', [{ domain: 'long', cycleId: 'c1', weekKey: '2020-W53', recordedAt: now }]],
  ]
  for (const [label, history] of rejected) {
    const db = await database()
    try {
      await db.query('select * from public.get_private_board()')
      await assert.rejects(
        db.query('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(weekly(history))]),
        /invalid/i,
        `expected SQL to reject: ${label}`,
      )
    } finally {
      await db.close()
    }
  }
  // a consistent weekly history entry is still accepted and round-trips through the client validator
  const db = await database()
  try {
    await db.query('select * from public.get_private_board()')
    const snapshot = weekly([{ domain: 'weekly', weekKey: '2020-W52', recordedAt: now }])
    const saved = await db.query<{ revision: number }>('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(snapshot)])
    assert.equal(Number(saved.rows[0].revision), 1)
    const loaded = await db.query<{ snapshot: unknown }>('select * from public.get_private_board()')
    validateSnapshot(loaded.rows[0].snapshot)
  } finally {
    await db.close()
  }
})

test('the database requires the same JSON types the client requires, not just matching text', async () => {
  const now = '2025-01-15T12:00:00.000Z'
  const base = { schemaVersion: 1, settings: { timeZone: 'UTC' }, cycles: [], tasks: [], focusBlocks: [] }
  const task = (extra: Record<string, unknown>) => ({ id: 't1', domain: 'daily', title: 'x', note: '', checked: false, color: 'ink', dateKey: '2025-01-15', history: [], createdAt: now, updatedAt: now, ...extra })
  const block = (extra: Record<string, unknown>) => ({ id: 'f1', dateKey: '2025-01-15', title: 'x', status: 'paused', durationMinutes: 45, elapsedMs: 0, createdAt: now, ...extra })
  // A text comparison would accept "true" / "0". The client rejects a string `checked`/`elapsedMs`
  // outright, so the database must too. (`durationMinutes` is the exception: the client coerces it
  // with Number(), so the DB is deliberately stricter there and this test asserts no client behaviour.)
  const cases: Array<[string, unknown]> = [
    ['checked as the string "true"', { ...base, tasks: [task({ checked: 'true' })] }],
    ['durationMinutes as the string "45"', { ...base, focusBlocks: [block({ durationMinutes: '45' })] }],
    ['elapsedMs as the string "0"', { ...base, focusBlocks: [block({ elapsedMs: '0' })] }],
  ]
  for (const [label, payload] of cases) {
    const db = await database()
    try {
      await db.query('select * from public.get_private_board()')
      await assert.rejects(
        db.query('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(payload)]),
        /invalid/i,
        `expected SQL to reject: ${label}`,
      )
    } finally {
      await db.close()
    }
  }
  // the correctly typed shapes still save and pass the client validator
  const db = await database()
  try {
    await db.query('select * from public.get_private_board()')
    const snapshot = { ...base, tasks: [task({ checked: true, color: 'blue' })], focusBlocks: [block({ durationMinutes: 45, elapsedMs: 0 })] }
    validateSnapshot(snapshot)
    const saved = await db.query<{ revision: number }>('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(snapshot)])
    assert.equal(Number(saved.rows[0].revision), 1)
    const loaded = await db.query<{ snapshot: unknown }>('select * from public.get_private_board()')
    validateSnapshot(loaded.rows[0].snapshot)
  } finally {
    await db.close()
  }
})

test('the database agrees with the client on explicit JSON nulls and whitespace-only text', async () => {
  // The client rejects an explicit JSON null for every optional key, and rejects whitespace-only
  // titles/names. SQL reads `->>` null and `null` alike, so these cases need JSON-level checks.
  const base = { schemaVersion: 1, settings: { timeZone: 'UTC' }, cycles: [], tasks: [], focusBlocks: [] }
  const now = '2025-01-15T12:00:00.000Z'
  const task = (extra: Record<string, unknown>) => ({ id: 't1', domain: 'daily', title: 'x', note: '', checked: false, color: 'ink', dateKey: '2025-01-15', history: [], createdAt: now, updatedAt: now, ...extra })
  const block = (extra: Record<string, unknown>) => ({ id: 'f1', dateKey: '2025-01-15', title: 'x', status: 'paused', durationMinutes: 45, elapsedMs: 0, createdAt: now, ...extra })
  const weekly = (extra: Record<string, unknown>) => ({ ...task({ domain: 'weekly', dateKey: undefined, weekKey: '2020-W53' }), ...extra })
  const cases: Array<[string, unknown]> = [
    ['weekly task with cycleId: null', { ...base, tasks: [weekly({ cycleId: null })] }],
    ['daily task with dateKey: null', { ...base, tasks: [task({ dateKey: null })] }],
    ['task with parentId: null', { ...base, tasks: [task({ parentId: null })] }],
    ['task with upperTaskId: null', { ...base, tasks: [task({ upperTaskId: null })] }],
    ['task with archivedAt: null', { ...base, tasks: [task({ archivedAt: null })] }],
    ['task with archivedReason: null', { ...base, tasks: [task({ archivedReason: null })] }],
    ['focus block with startedAt: null', { ...base, focusBlocks: [block({ startedAt: null })] }],
    ['focus block with taskId: null', { ...base, focusBlocks: [block({ taskId: null })] }],
    ['history entry with dateKey: null', { ...base, tasks: [weekly({ history: [{ domain: 'long', cycleId: 'c1', dateKey: null, recordedAt: now }] })] }],
    ['whitespace-only task title', { ...base, tasks: [task({ title: '   ' })] }],
    ['whitespace-only cycle name', { ...base, cycles: [{ id: 'c', name: '  ', startDate: '2025-01-01', endDate: '2025-02-01', createdAt: now }] }],
    ['whitespace-only focus title', { ...base, focusBlocks: [block({ title: ' ' })] }],
    ['an upper task that is itself a subtask', { ...base, tasks: [weekly({ id: 'w1' }), weekly({ id: 'w2', parentId: 'w1' }), { ...task({ id: 'd1', upperTaskId: 'w2' }) }] }],
  ]
  for (const [label, payload] of cases) {
    const db = await database()
    try {
      await db.query('select * from public.get_private_board()')
      // the client must reject it too, otherwise this test asserts the wrong thing
      assert.throws(() => validateSnapshot(payload), `client should reject: ${label}`)
      await assert.rejects(
        db.query('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(payload)]),
        /invalid|unsupported/i,
        `expected SQL to reject: ${label}`,
      )
    } finally {
      await db.close()
    }
  }
  // optional keys that are simply absent remain valid on both sides
  const db = await database()
  try {
    await db.query('select * from public.get_private_board()')
    const snapshot = { ...base, tasks: [task({})], focusBlocks: [block({})] }
    validateSnapshot(snapshot)
    const saved = await db.query<{ revision: number }>('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(snapshot)])
    assert.equal(Number(saved.rows[0].revision), 1)
  } finally {
    await db.close()
  }
})

test('the database rejects text-typed fields and ids the client would reject', async () => {
  const now = '2025-01-15T12:00:00.000Z'
  const base = { schemaVersion: 1, settings: { timeZone: 'UTC' }, cycles: [], tasks: [], focusBlocks: [] }
  const task = (extra: Record<string, unknown>) => ({ id: 't1', domain: 'daily', title: 'x', note: '', checked: false, color: 'ink', dateKey: '2025-01-15', history: [], createdAt: now, updatedAt: now, ...extra })
  const cycle = (extra: Record<string, unknown>) => ({ id: 'c1', name: 'Q', startDate: '2025-01-01', endDate: '2025-02-01', createdAt: now, ...extra })
  const cases: Array<[string, unknown]> = [
    ['schemaVersion as the string "1"', { ...base, schemaVersion: '1' }],
    ['task id of 161 characters', { ...base, tasks: [task({ id: 'x'.repeat(161) })] }],
    ['whitespace-only task id', { ...base, tasks: [task({ id: '   ' })] }],
    ['whitespace-only cycle id', { ...base, cycles: [cycle({ id: '  ' })] }],
    ['numeric task title', { ...base, tasks: [task({ title: 123 })] }],
    ['numeric task note', { ...base, tasks: [task({ note: 42 })] }],
    ['numeric cycle name', { ...base, cycles: [cycle({ name: 7 })] }],
    ['numeric task domain', { ...base, tasks: [task({ domain: 1 })] }],
    ['numeric task color', { ...base, tasks: [task({ color: 2 })] }],
    // the id donor must come FIRST: the task loop appends ids only after validating, so with the
    // donor last even a broken `cycleId = any(seen_ids)` check would reject it and the test could pass.
    ['a long task whose cycleId is an earlier task id', { ...base, tasks: [task({ id: 't1' }), { ...task({ id: 'task-as-cycle', domain: 'long', dateKey: undefined, cycleId: 't1' }) }] }],
  ]
  for (const [label, payload] of cases) {
    const db = await database()
    try {
      await db.query('select * from public.get_private_board()')
      assert.throws(() => validateSnapshot(payload), `client should reject: ${label}`)
      await assert.rejects(
        db.query('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(payload)]),
        /invalid|unsupported/i,
        `expected SQL to reject: ${label}`,
      )
    } finally {
      await db.close()
    }
  }
  // the properly typed shapes still save
  const db = await database()
  try {
    await db.query('select * from public.get_private_board()')
    const snapshot = { ...base, cycles: [cycle({})], tasks: [{ ...task({ domain: 'long', dateKey: undefined, cycleId: 'c1' }) }], focusBlocks: [] }
    validateSnapshot(snapshot)
    const saved = await db.query<{ revision: number }>('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(snapshot)])
    assert.equal(Number(saved.rows[0].revision), 1)
  } finally {
    await db.close()
  }
})

test('SQL matches JS trim() and String.length semantics, not btrim and character counts', async () => {
  const now = '2025-01-15T12:00:00.000Z'
  const base = { schemaVersion: 1, settings: { timeZone: 'UTC' }, cycles: [], tasks: [], focusBlocks: [] }
  const task = (extra: Record<string, unknown>) => ({ id: 't1', domain: 'daily', title: 'x', note: '', checked: false, color: 'ink', dateKey: '2025-01-15', history: [], createdAt: now, updatedAt: now, ...extra })
  const cycle = (extra: Record<string, unknown>) => ({ id: 'c1', name: 'Q', startDate: '2025-01-01', endDate: '2025-02-01', createdAt: now, ...extra })
  const cases: Array<[string, unknown]> = [
    // btrim's default trim set is a single space, so a bare tab used to survive; JS trim() removes it.
    ['tab-only task title', { ...base, tasks: [task({ title: '\t' })] }],
    ['tab-only task id', { ...base, tasks: [task({ id: '\t' })] }],
    ['tab-only cycle name', { ...base, cycles: [cycle({ name: '\t' })] }],
    ['NBSP-only task title', { ...base, tasks: [task({ title: '\u00a0' })] }],
    ['BOM-only task title', { ...base, tasks: [task({ title: '\ufeff' })] }],
    // JS counts UTF-16 code units: 160 astral characters are 320 units, so the client rejects it.
    ['160 astral characters as a title', { ...base, tasks: [task({ title: '😀'.repeat(160) })] }],
    ['160 astral characters as an id', { ...base, tasks: [task({ id: '😀'.repeat(160) })] }],
    // F1: dateKey: null was the one optional key with no JSON-level check.
    ['weekly task with dateKey: null', { ...base, tasks: [task({ domain: 'weekly', dateKey: null, weekKey: '2020-W53' })] }],
    ['long task with dateKey: null', { ...base, cycles: [cycle({})], tasks: [task({ domain: 'long', dateKey: null, cycleId: 'c1' })] }],
  ]
  for (const [label, payload] of cases) {
    const db = await database()
    try {
      await db.query('select * from public.get_private_board()')
      assert.throws(() => validateSnapshot(payload), `client should reject: ${label}`)
      await assert.rejects(
        db.query('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(payload)]),
        /invalid|unsupported/i,
        `expected SQL to reject: ${label}`,
      )
    } finally {
      await db.close()
    }
  }
  // legitimate values at the boundary must still save: 160 single-unit chars, and CJK titles
  const db = await database()
  try {
    await db.query('select * from public.get_private_board()')
    const boundary = { ...base, cycles: [cycle({})], tasks: [task({ id: 'i'.repeat(160), title: '中文标题🙂' })] }
    validateSnapshot(boundary)
    const saved = await db.query<{ revision: number }>('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(boundary)])
    assert.equal(Number(saved.rows[0].revision), 1)
  } finally {
    await db.close()
  }
})

test('RLS exposes each personal board only to its own authenticated user', async () => {
  const db = await database()
  try {
    await db.query('select * from public.get_private_board()')
    await db.exec(`select set_config('request.jwt.claim.sub', '${OTHER}', false)`)
    await db.query('select * from public.get_private_board()')
    // Grant table privileges INSIDE a transaction that is rolled back, so the POLICY (not a missing
    // GRANT) is what decides access. Without this the test would pass even if the policy were open.
    await db.exec('begin')
    await db.exec('grant usage on schema private to authenticated, anon; grant select, insert, update, delete on private.personal_boards to authenticated, anon')

    const contexts: Array<[string, string | null, boolean]> = [
      ['the first user', OWNER, true],
      ['the second user', OTHER, true],
      ['an anonymous session', null, false],
    ]
    for (const [label, subject, shouldSee] of contexts) {
      await db.exec(`set role ${subject === null ? 'anon' : 'authenticated'}; select set_config('request.jwt.claim.sub', ${subject === null ? 'null' : `'${subject}'`}, false)`)
      let rows = 0
      let blocked = false
      let ownerUuid = ''
      try {
        const result = await db.query<{ owner_uuid: string }>('select owner_uuid from private.personal_boards')
        rows = result.rows.length
        ownerUuid = result.rows[0]?.owner_uuid || ''
      } catch {
        blocked = true
      } finally {
        await db.exec('reset role')
      }
      assert.equal(
        rows > 0 && !blocked,
        shouldSee,
        `RLS decision for ${label}: saw ${rows} row(s), blocked=${blocked}`,
      )
      if (shouldSee) {
        assert.equal(rows, 1, `${label} must see exactly one personal board`)
        assert.equal(ownerUuid, subject, `${label} must see its own board`)
      }
    }

    // The second user may update their own row.
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${OTHER}', false)`)
    const ownUpdate = await db.query('update private.personal_boards set revision = revision + 1 where owner_uuid = $1 returning owner_uuid', [OTHER])
    assert.equal(ownUpdate.rows.length, 1, 'a user must be able to update their own board')

    const otherDelete = await db.query('delete from private.personal_boards where owner_uuid = $1 returning owner_uuid', [OWNER])
    assert.equal(otherDelete.rows.length, 0, 'a user must not delete another personal board')

    // WITH CHECK also prevents a user from reassigning their board to another Auth identity.
    await db.exec('savepoint reassign')
    let reassignRejection = ''
    try {
      await db.query('update private.personal_boards set owner_uuid = $1 where owner_uuid = $2 returning owner_uuid', [THIRD, OTHER])
    } catch (caught) {
      reassignRejection = caught instanceof Error ? caught.message : String(caught)
    }
    await db.exec('rollback to savepoint reassign')
    assert.match(reassignRejection, /row-level security|row level security/i, 'changing board ownership must be rejected')

    // A user cannot claim a third Auth identity's row. A policy violation aborts the transaction,
    // so isolate it in a savepoint and undo it.
    await db.exec('savepoint claim')
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${OTHER}', false)`)
    let inserted = 0
    let rejection = ''
    try {
      const result = await db.query("insert into private.personal_boards(owner_uuid, revision, snapshot) values ($1, 9, '{}'::jsonb) returning owner_uuid", [THIRD])
      inserted = result.rows.length
    } catch (caught) {
      rejection = caught instanceof Error ? caught.message : String(caught)
    }
    await db.exec('rollback to savepoint claim')
    assert.equal(inserted, 0, 'a user must not insert a board row for another user')
    assert.match(rejection, /row-level security|row level security/i, `expected a policy rejection, saw: ${rejection}`)

    // A user cannot update another user's row; USING filters it out without leaking an error.
    await db.exec('savepoint claim2')
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${OTHER}', false)`)
    let updated = -1
    try {
      const result = await db.query('update private.personal_boards set revision = revision + 1 where owner_uuid = $1', [OWNER])
      updated = result.affectedRows ?? 0
    } catch {
      updated = 0
    }
    await db.exec('rollback to savepoint claim2')
    assert.equal(updated, 0, 'a user must not be able to update another personal board')
    await db.exec('rollback')
    // Outside that grant, the private tables are not reachable by clients at all: all access goes
    // through the SECURITY DEFINER RPCs.
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${OWNER}', false)`)
    await assert.rejects(db.query('select owner_uuid from private.personal_boards'), /permission denied/i)
    await db.exec('reset role')
  } finally {
    await db.close()
  }
})

test('every time zone the client accepts is one the database also accepts', async () => {
  // The reverse direction matters: if the client accepted a zone Postgres does not know, a settings
  // change would save locally but be rejected by the RPC in cloud mode.
  const accepted = ['UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/London', 'Etc/GMT-8', 'Pacific/Kiritimati']
  const db = await database()
  try {
    const zones = await db.query<{ name: string }>('select name from pg_timezone_names')
    const known = new Set(zones.rows.map((row) => row.name))
    for (const zone of accepted) {
      assert.equal(safeTimeZone(zone), zone, `${zone} should be accepted by the client`)
      assert.equal(known.has(zone), true, `${zone} must also exist in pg_timezone_names`)
    }
    // and the client rejects what Postgres would reject
    for (const zone of ['+08:00', '-05:00', 'GMT+8']) {
      assert.notEqual(safeTimeZone(zone), zone, `${zone} must not pass the client check`)
    }
  } finally {
    await db.close()
  }
})

test('the private SECURITY DEFINER helpers are unreachable from client roles', async () => {
  // `grant usage on schema private` is needed so the RLS policy can resolve its helper. That also
  // makes PUBLIC's default EXECUTE meaningful, so the definer helpers must be revoked explicitly.
  const db = await database()
  try {
    for (const role of ['authenticated', 'anon']) {
      for (const call of ['select private.assert_authenticated_user()', "select private.validate_board_snapshot('{}'::jsonb)"]) {
        await db.exec(`set role ${role}`)
        await assert.rejects(db.query(call), /permission denied for function|permission denied for schema/i, `${role} must not call ${call}`)
        await db.exec('reset role')
      }
    }
    // the owner-facing RPCs still work, because they invoke those helpers as the definer
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${OWNER}', false)`)
    const loaded = await db.query<{ revision: number }>('select revision from public.get_private_board()')
    assert.equal(Number(loaded.rows[0].revision), 0)
    const saved = await db.query<{ revision: number }>('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(emptySnapshot('UTC'))])
    assert.equal(Number(saved.rows[0].revision), 1)
    await db.exec('reset role')
  } finally {
    await db.close()
  }
})

test('a revision conflict uses a non-retryable SQLSTATE and returns promptly', async () => {
  // Regression guard: the conflict used to raise 40001 (serialization_failure). Platforms treat
  // that as retryable, so every routine conflict was retried until the edge timed out (~125s) and
  // the client sat in "saving" while connections piled up. PT409 maps to HTTP 409 and is not retried.
  const db = await database()
  try {
    await db.query('select * from public.get_private_board()')
    const def = await db.query<{ def: string }>("select pg_get_functiondef('public.cas_save_private_board(bigint,jsonb)'::regprocedure) as def")
    assert.match(def.rows[0].def, /Board revision conflict' using errcode = 'PT409'/, 'the conflict must raise PT409')
    // only the raise itself matters; the surrounding comment intentionally mentions 40001
    assert.doesNotMatch(def.rows[0].def, /Board revision conflict' using errcode = '40001'/, 'the conflict must not use the retryable 40001 code')

    // bump the revision once so that a save at revision 0 is genuinely stale
    const first = await db.query<{ revision: number }>('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(emptySnapshot('UTC'))])
    assert.equal(Number(first.rows[0].revision), 1)

    // and the conflict really carries a non-retryable code
    const started = Date.now()
    let caught: { code?: string } | null = null
    try {
      await db.query('select * from public.cas_save_private_board($1, $2::jsonb)', [0, JSON.stringify(emptySnapshot('UTC'))])
    } catch (error) {
      caught = error as { code?: string }
    } finally {
      // the stale call must fail fast; a retry loop would show up as a large elapsed time here
      assert.ok(Date.now() - started < 2000, 'the conflict must fail immediately, not after a retry loop')
    }
    assert.ok(caught, 'a stale revision must be rejected')
    // PT409 is a non-numeric SQLSTATE, which is what keeps platforms from auto-retrying it
    assert.equal(String(caught?.code), 'PT409', `expected the PT409 code, saw ${caught?.code}`)
  } finally {
    await db.close()
  }
})
