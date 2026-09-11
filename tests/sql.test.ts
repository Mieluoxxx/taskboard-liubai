import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { addCycle, addFocusBlock, addTask, createTask, emptySnapshot, rescheduleDailyTask, validateSnapshot } from '../src/domain'

const OWNER = '00000000-0000-0000-0000-000000000001'
const OTHER = '00000000-0000-0000-0000-000000000002'

async function database() {
  const db = new PGlite()
  await db.waitReady
  await db.exec(`
    create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('${OWNER}'), ('${OTHER}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create role anon;
    create role authenticated;
  `)
  await db.exec(await readFile(new URL('../supabase/migrations/001_private_board.sql', import.meta.url), 'utf8'))
  await db.exec(`insert into private.owner_config(owner_uuid) values ('${OWNER}'); select set_config('request.jwt.claim.sub', '${OWNER}', false);`)
  return db
}

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

test('Supabase migration denies a wrong owner and direct table writes', async () => {
  const db = await database()
  try {
    await db.exec(`select set_config('request.jwt.claim.sub', '${OTHER}', false)`)
    await assert.rejects(db.query('select * from public.get_private_board()'), /not authorized|owner/i)
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${OWNER}', false)`)
    await assert.rejects(db.query('select * from private.personal_boards'), /permission denied/i)
    await db.exec('reset role')
  } finally {
    await db.close()
  }
})

test('the RPCs are callable by the authenticated role and still enforce the owner check', async () => {
  const db = await database()
  try {
    // Run as the real `authenticated` role instead of the PGlite superuser, so EXECUTE grants matter.
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${OWNER}', false)`)
    const loaded = await db.query<{ revision: number }>('select revision from public.get_private_board()')
    assert.equal(Number(loaded.rows[0].revision), 0)
    await db.exec(`select set_config('request.jwt.claim.sub', '${OTHER}', false)`)
    await assert.rejects(db.query('select * from public.get_private_board()'), /not authorized|owner/i)
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
  // A text comparison would accept "true" / "0"; the client rejects them, so the DB must too.
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
