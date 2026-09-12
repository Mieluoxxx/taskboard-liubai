import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addCycle,
  addDays,
  addFocusBlock,
  addTask,
  elapsedMsAt,
  emptySnapshot,
  MAX_ELAPSED_MS,
  focusDisplayStatus,
  cloneSnapshot,
  mergeSnapshots,
  reapplyReorder,
  reorderOrigin,
  rescheduleDailyTask,
  safeTimeZone,
  setFocusCommand,
  validateSnapshot,
  weekKey,
  weekRange,
  weekStart,
  createTask,
  deleteTask,
} from '../src/domain'
import type { BoardSnapshot } from '../src/types'

const NOW = '2025-01-15T12:00:00.000Z'
function board(): BoardSnapshot {
  return { ...emptySnapshot('America/New_York') }
}

function withCycle(snapshot: BoardSnapshot): BoardSnapshot {
  return addCycle(snapshot, 'Q1', '2025-01-01', '2025-03-31', NOW)
}

test('calendar and ISO week helpers are DST-safe and ISO-year correct', () => {
  assert.equal(addDays('2024-03-09', 1), '2024-03-10')
  assert.equal(addDays('2024-11-02', 1), '2024-11-03')
  assert.equal(weekStart('2021-01-01'), '2020-12-28')
  assert.equal(weekKey('2021-01-01'), '2020-W53')
  assert.deepEqual(weekRange('2020-W53'), { start: '2020-12-28', end: '2021-01-03' })
})

test('cycle ranges produce inclusive dates and every intersecting ISO week', async () => {
  const { dateKeysInRange, weekKeysInRange } = await import('../src/domain')
  assert.deepEqual(dateKeysInRange('2025-01-30', '2025-02-02'), ['2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02'])
  assert.deepEqual(weekKeysInRange('2025-01-01', '2025-01-12'), ['2025-W01', '2025-W02'])
  assert.deepEqual(weekKeysInRange('2020-12-31', '2021-01-02'), ['2020-W53'])
})

test('linked tasks remain independent when completed', () => {
  let snapshot = withCycle(board())
  const cycleId = snapshot.cycles[0].id
  const long = createTask({ domain: 'long', title: 'Direction', cycleId }, NOW)
  snapshot = addTask(snapshot, long)
  const weekly = createTask({ domain: 'weekly', title: 'Weekly step', weekKey: '2025-W03', upperTaskId: long.id }, NOW)
  snapshot = addTask(snapshot, weekly)
  const daily = createTask({ domain: 'daily', title: 'Daily step', dateKey: '2025-01-15', upperTaskId: weekly.id }, NOW)
  snapshot = addTask(snapshot, daily)
  assert.equal(snapshot.tasks.find((task) => task.id === long.id)?.checked, false)
  snapshot = { ...snapshot, tasks: snapshot.tasks.map((task) => task.id === daily.id ? { ...task, checked: true } : task) }
  validateSnapshot(snapshot)
  assert.equal(snapshot.tasks.find((task) => task.id === daily.id)?.checked, true)
  assert.equal(snapshot.tasks.find((task) => task.id === weekly.id)?.checked, false)
  assert.equal(snapshot.tasks.find((task) => task.id === long.id)?.checked, false)
})

test('deleting an upper task detaches lower associations without cross-domain cascade', () => {
  let snapshot = withCycle(board())
  const cycleId = snapshot.cycles[0].id
  const long = createTask({ domain: 'long', title: 'Direction', cycleId }, NOW)
  snapshot = addTask(snapshot, long)
  const weekly = createTask({ domain: 'weekly', title: 'Weekly step', weekKey: '2025-W03', upperTaskId: long.id }, NOW)
  snapshot = addTask(snapshot, weekly)
  const daily = createTask({ domain: 'daily', title: 'Daily step', dateKey: '2025-01-15', upperTaskId: weekly.id }, NOW)
  snapshot = addTask(snapshot, daily)
  snapshot = deleteTask(snapshot, long.id, NOW)
  assert.equal(snapshot.tasks.some((task) => task.id === long.id), false)
  assert.equal(snapshot.tasks.find((task) => task.id === weekly.id)?.upperTaskId, undefined)
  assert.equal(snapshot.tasks.find((task) => task.id === daily.id)?.upperTaskId, weekly.id)
})

test('rescheduling keeps original placement history and avoids duplicate active copies', () => {
  let snapshot = board()
  const root = createTask({ domain: 'daily', title: 'Move me', dateKey: '2025-01-10' }, NOW)
  const child = createTask({ domain: 'daily', title: 'Child', dateKey: '2025-01-10', parentId: root.id }, NOW)
  snapshot = addTask(addTask(snapshot, root), child)
  snapshot = rescheduleDailyTask(snapshot, root.id, '2025-01-16', '2025-01-15T12:00:00.000Z')
  const active = snapshot.tasks.filter((task) => !task.archivedAt)
  const archived = snapshot.tasks.filter((task) => task.archivedAt)
  assert.equal(active.length, 2)
  assert.equal(archived.length, 2)
  assert.equal(active[0].dateKey, '2025-01-16')
  assert.equal(active[0].history.at(-1)?.dateKey, '2025-01-10')
  assert.equal(archived[0].rescheduledTo, active.find((task) => task.title === archived[0].title)?.id)
  const nextRoot = active.find((task) => task.title === 'Move me')!
  snapshot = rescheduleDailyTask(snapshot, nextRoot.id, '2025-01-18', '2025-01-16T12:00:00.000Z')
  assert.equal(snapshot.tasks.filter((task) => !task.archivedAt).length, 2)
  assert.equal(snapshot.tasks.filter((task) => task.archivedReason === 'rescheduled').length, 4)
  assert.throws(() => rescheduleDailyTask(snapshot, snapshot.tasks.find((task) => !task.archivedAt && task.title === 'Move me')!.id, '2025-01-18', NOW), /different|valid target/i)
})

test('timer restoration uses timestamps and rejects a second running timer', () => {
  let snapshot = board()
  snapshot = addFocusBlock(snapshot, { id: 'focus-a', dateKey: '2025-01-15', title: 'A', durationMinutes: 45, status: 'running', startedAt: '2025-01-15T12:00:00.000Z', elapsedMs: 5_000, createdAt: NOW })
  const block = snapshot.focusBlocks[0]
  assert.equal(elapsedMsAt(block, Date.parse('2025-01-15T12:30:00.000Z')), 1_805_000)
  assert.equal(focusDisplayStatus(block, Date.parse('2025-01-15T13:00:00.000Z')), 'complete')
  const second = { ...block, id: 'focus-b', status: 'paused' as const, startedAt: undefined }
  snapshot = { ...snapshot, focusBlocks: [...snapshot.focusBlocks, second] }
  assert.throws(() => setFocusCommand(snapshot, 'focus-b', 'start', NOW), /already running/)
  snapshot = setFocusCommand(snapshot, 'focus-a', 'finish', '2025-01-15T12:20:00.000Z')
  assert.equal(snapshot.focusBlocks[0].status, 'finished')
  assert.equal(snapshot.focusBlocks[0].startedAt, undefined)
})

test('invalid external state is rejected before use', () => {
  assert.throws(() => validateSnapshot({ ...board(), settings: { timeZone: 'not/a-zone' } }), /timezone/i)
  const running = { id: 'focus-a', dateKey: '2025-01-15', title: 'A', durationMinutes: 30, status: 'running', elapsedMs: 0, createdAt: NOW }
  const second = { ...running, id: 'focus-b' }
  assert.throws(() => validateSnapshot({ ...board(), focusBlocks: [running, second] }), /one focus timer|running/i)
  const parent = createTask({ domain: 'daily', title: 'P', dateKey: '2025-01-15' }, NOW)
  const child = createTask({ domain: 'daily', title: 'C', dateKey: '2025-01-15', parentId: parent.id }, NOW)
  const grandchild = createTask({ domain: 'daily', title: 'G', dateKey: '2025-01-15', parentId: child.id }, NOW)
  assert.throws(() => validateSnapshot({ ...board(), tasks: [parent, child, grandchild] }), /subtask graph/i)
})

test('a rescheduled task can still be deleted without leaving a dangling reschedule target', () => {
  let snapshot = board()
  const root = createTask({ domain: 'daily', title: 'Move then delete', dateKey: '2025-01-10' }, NOW)
  snapshot = addTask(snapshot, root)
  snapshot = rescheduleDailyTask(snapshot, root.id, '2025-01-16', NOW)
  const active = snapshot.tasks.find((task) => !task.archivedAt && task.title === 'Move then delete')!
  // Deleting the active successor used to fail validation because the archived entry still pointed at it.
  snapshot = deleteTask(snapshot, active.id, NOW)
  assert.equal(snapshot.tasks.some((task) => task.id === active.id), false)
  const archived = snapshot.tasks.find((task) => task.archivedReason === 'rescheduled')!
  assert.equal(archived.rescheduledTo, undefined)
  validateSnapshot(snapshot)
})

test('a timer running far past its limit can still be paused and finished', () => {
  let snapshot = board()
  snapshot = addFocusBlock(snapshot, { id: 'long-run', dateKey: '2025-01-15', title: 'Forgotten timer', durationMinutes: 45, status: 'running', startedAt: '2025-01-01T00:00:00.000Z', elapsedMs: 0, createdAt: NOW })
  const late = '2025-01-15T00:00:00.000Z'
  snapshot = setFocusCommand(snapshot, 'long-run', 'finish', late)
  assert.equal(snapshot.focusBlocks[0].status, 'finished')
  assert.ok(snapshot.focusBlocks[0].elapsedMs <= MAX_ELAPSED_MS)
  validateSnapshot(snapshot)
})

test('safeTimeZone only accepts names Postgres also knows, so a settings change cannot be silently dropped', () => {
  // Intl additionally accepts offset zones such as "+08:00"; pg_timezone_names does not contain them,
  // so accepting one here would make the cloud RPC reject the whole snapshot.
  assert.equal(safeTimeZone('+08:00'), safeTimeZone(undefined))
  assert.equal(safeTimeZone('-05:00'), safeTimeZone(undefined))
  assert.equal(safeTimeZone('GMT+8'), safeTimeZone(undefined))
  assert.equal(safeTimeZone('   '), safeTimeZone(undefined))
  assert.equal(safeTimeZone('x'.repeat(101)), safeTimeZone(undefined))
  // IANA-shaped names survive unchanged
  for (const zone of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Etc/GMT-8', 'Europe/London']) {
    assert.equal(safeTimeZone(zone), zone)
  }
})

test('mergeSnapshots keeps the local change and the remote change when they touch different entities', () => {
  let base = board()
  base = addCycle(base, 'Q1', '2025-01-01', '2025-03-31', NOW)
  const goal = createTask({ domain: 'long', title: 'Goal', cycleId: base.cycles[0].id }, NOW)
  base = addTask(base, goal)
  const dailyA = createTask({ domain: 'daily', title: 'A', dateKey: '2025-01-15' }, NOW)
  const dailyB = createTask({ domain: 'daily', title: 'B', dateKey: '2025-01-15' }, NOW)
  base = addTask(addTask(base, dailyA), dailyB)

  // remote checked the goal; local checked A and added a new task — no overlap
  const remote = cloneSnapshot(base)
  remote.tasks.find((task) => task.id === goal.id)!.checked = true
  const local = cloneSnapshot(base)
  local.tasks.find((task) => task.id === dailyA.id)!.checked = true
  local.tasks.push(createTask({ domain: 'daily', title: 'C', dateKey: '2025-01-15' }, NOW))

  const merged = mergeSnapshots(base, local, remote)
  assert.deepEqual(merged.conflicts, [])
  assert.equal(merged.snapshot.tasks.find((task) => task.id === goal.id)?.checked, true, 'remote change preserved')
  assert.equal(merged.snapshot.tasks.find((task) => task.id === dailyA.id)?.checked, true, 'local change preserved')
  assert.equal(merged.snapshot.tasks.some((task) => task.title === 'C'), true, 'local addition preserved')
  validateSnapshot(merged.snapshot)
})

test('mergeSnapshots reports a real conflict instead of guessing when both sides changed the same entity', () => {
  let base = board()
  const task = createTask({ domain: 'daily', title: 'Same', dateKey: '2025-01-15' }, NOW)
  base = addTask(base, task)
  const remote = cloneSnapshot(base)
  remote.tasks[0].title = 'remote title'
  const local = cloneSnapshot(base)
  local.tasks[0].title = 'local title'

  const merged = mergeSnapshots(base, local, remote)
  assert.deepEqual(merged.conflicts, [task.id])
  // the remote value is what stays on the board; the local intent is reported, never silently applied
  assert.equal(merged.snapshot.tasks[0].title, 'remote title')
})

test('mergeSnapshots honours a local deletion and a remote deletion', () => {
  let base = board()
  const kept = createTask({ domain: 'daily', title: 'kept', dateKey: '2025-01-15' }, NOW)
  const removedLocally = createTask({ domain: 'daily', title: 'removed-locally', dateKey: '2025-01-15' }, NOW)
  const removedRemotely = createTask({ domain: 'daily', title: 'removed-remotely', dateKey: '2025-01-15' }, NOW)
  base = addTask(addTask(addTask(base, kept), removedLocally), removedRemotely)

  const local = cloneSnapshot(base)
  local.tasks = local.tasks.filter((task) => task.id !== removedLocally.id)
  const remote = cloneSnapshot(base)
  remote.tasks = remote.tasks.filter((task) => task.id !== removedRemotely.id)

  const merged = mergeSnapshots(base, local, remote)
  assert.deepEqual(merged.conflicts, [])
  assert.equal(merged.snapshot.tasks.some((task) => task.id === removedLocally.id), false)
  assert.equal(merged.snapshot.tasks.some((task) => task.id === removedRemotely.id), false)
  assert.equal(merged.snapshot.tasks.some((task) => task.id === kept.id), true)
})

test('mergeSnapshots flags a local edit to an entity the remote already deleted', () => {
  let base = board()
  const task = createTask({ domain: 'daily', title: 'gone', dateKey: '2025-01-15' }, NOW)
  base = addTask(base, task)
  const local = cloneSnapshot(base)
  local.tasks[0].checked = true
  const remote = cloneSnapshot(base)
  remote.tasks = []

  const merged = mergeSnapshots(base, local, remote)
  assert.deepEqual(merged.conflicts, [task.id])
  assert.equal(merged.snapshot.tasks.some((candidate) => candidate.id === task.id), false)
})

test('mergeSnapshots keeps both sides when two devices start from an empty board with disjoint ids', () => {
  // Two devices both start at revision 0, so each creates its own first task with its own id.
  // Neither id exists in the other board; neither may be dropped.
  const base = board()
  const remote = cloneSnapshot(base)
  remote.tasks.push(createTask({ domain: 'daily', title: 'device-1 task', dateKey: '2025-01-15' }, NOW))
  const local = cloneSnapshot(base)
  local.tasks.push(createTask({ domain: 'daily', title: 'device-2 task', dateKey: '2025-01-15' }, NOW))

  const merged = mergeSnapshots(base, local, remote)
  assert.deepEqual(merged.conflicts, [])
  assert.equal(merged.snapshot.tasks.some((task) => task.title === 'device-1 task'), true, 'the remote addition must be kept')
  assert.equal(merged.snapshot.tasks.some((task) => task.title === 'device-2 task'), true, 'the local addition must be kept')
  validateSnapshot(merged.snapshot)
})

test('mergeSnapshots does not resurrect an entity the local side deleted and the remote never touched', () => {
  let base = board()
  const doomed = createTask({ domain: 'daily', title: 'doomed', dateKey: '2025-01-15' }, NOW)
  base = addTask(base, doomed)
  const local = cloneSnapshot(base)
  local.tasks = []
  const merged = mergeSnapshots(base, local, cloneSnapshot(base))
  assert.deepEqual(merged.conflicts, [])
  assert.equal(merged.snapshot.tasks.length, 0, 'a local deletion must be honoured')
})

test('mergeSnapshots keeps a local sibling reorder that changes only array order', () => {
  let base = board()
  const first = createTask({ domain: 'daily', title: 'first', dateKey: '2025-01-15' }, NOW)
  const second = createTask({ domain: 'daily', title: 'second', dateKey: '2025-01-15' }, NOW)
  base = addTask(addTask(base, first), second)

  // A reorder swaps positions without touching updatedAt, so per-entity comparison cannot see it.
  const local = cloneSnapshot(base)
  local.tasks = [local.tasks[1], local.tasks[0]]
  const remote = cloneSnapshot(base)
  remote.tasks.find((task) => task.id === second.id)!.checked = true

  const merged = mergeSnapshots(base, local, remote)
  assert.deepEqual(merged.conflicts, [])
  assert.deepEqual(merged.snapshot.tasks.map((task) => task.id), [second.id, first.id], 'the local order must survive')
  assert.equal(merged.snapshot.tasks.find((task) => task.id === second.id)?.checked, true, 'the remote edit must survive')
})

test('mergeSnapshots reports a conflict when both sides reordered differently', () => {
  let base = board()
  const a = createTask({ domain: 'daily', title: 'a', dateKey: '2025-01-15' }, NOW)
  const b = createTask({ domain: 'daily', title: 'b', dateKey: '2025-01-15' }, NOW)
  const c = createTask({ domain: 'daily', title: 'c', dateKey: '2025-01-15' }, NOW)
  base = addTask(addTask(addTask(base, a), b), c)

  const local = cloneSnapshot(base)
  local.tasks = [local.tasks[1], local.tasks[0], local.tasks[2]] // b, a, c
  const remote = cloneSnapshot(base)
  remote.tasks = [remote.tasks[0], remote.tasks[2], remote.tasks[1]] // a, c, b

  const merged = mergeSnapshots(base, local, remote)
  assert.ok(merged.conflicts.includes('__order__'), `expected an order conflict, saw ${JSON.stringify(merged.conflicts)}`)
})

test('mergeSnapshots treats both sides making the same reorder as agreement, not a conflict', () => {
  let base = board()
  const a = createTask({ domain: 'daily', title: 'a', dateKey: '2025-01-15' }, NOW)
  const b = createTask({ domain: 'daily', title: 'b', dateKey: '2025-01-15' }, NOW)
  base = addTask(addTask(base, a), b)

  const swapped = (snapshot: BoardSnapshot) => {
    const next = cloneSnapshot(snapshot)
    next.tasks = [next.tasks[1], next.tasks[0]]
    return next
  }
  const merged = mergeSnapshots(base, swapped(base), swapped(base))
  assert.deepEqual(merged.conflicts, [], 'identical reorders must not be reported as a conflict')
  assert.deepEqual(merged.snapshot.tasks.map((task) => task.id), [b.id, a.id])
})

test('mergeSnapshots keeps the local position of a locally created task when the order changed', () => {
  let base = board()
  const a = createTask({ domain: 'daily', title: 'a', dateKey: '2025-01-15' }, NOW)
  const b = createTask({ domain: 'daily', title: 'b', dateKey: '2025-01-15' }, NOW)
  base = addTask(addTask(base, a), b)

  const local = cloneSnapshot(base)
  const fresh = createTask({ domain: 'daily', title: 'n', dateKey: '2025-01-15' }, NOW)
  local.tasks = [fresh, ...local.tasks] // N first, ahead of everything

  const merged = mergeSnapshots(base, local, cloneSnapshot(base))
  assert.deepEqual(merged.conflicts, [])
  assert.equal(merged.snapshot.tasks[0]?.id, fresh.id, 'a locally created task keeps its local position')
  assert.deepEqual(merged.snapshot.tasks.map((task) => task.id), [fresh.id, a.id, b.id])
})

test('mergeSnapshots reports a conflict when the base is behind and both sides hold different data', () => {
  // This is the dropped-response case: a save committed server-side but the client never saw the
  // acknowledgement, so base lacks an entity that both local and remote now have with different data.
  let base = board()
  const stable = createTask({ domain: 'daily', title: 'stable', dateKey: '2025-01-15' }, NOW)
  base = addTask(base, stable)

  const remote = cloneSnapshot(base)
  const shared = createTask({ domain: 'daily', title: 'from-server', dateKey: '2025-01-15' }, NOW)
  remote.tasks.push(shared)
  const local = cloneSnapshot(base)
  local.tasks.push({ ...shared, title: 'from-client' })

  const merged = mergeSnapshots(base, local, remote)
  assert.deepEqual(merged.conflicts, [shared.id], 'a base-behind divergence must not silently overwrite the remote value')
  assert.equal(merged.snapshot.tasks.find((task) => task.id === shared.id)?.title, 'from-server')
})

test('a reorder can be replayed onto a newer board, and is skipped when the target is gone', () => {
  let base = board()
  const a = createTask({ domain: 'daily', title: 'a', dateKey: '2025-01-15' }, NOW)
  const b = createTask({ domain: 'daily', title: 'b', dateKey: '2025-01-15' }, NOW)
  base = addTask(addTask(base, a), b)

  const origin = reorderOrigin(b, -1)
  assert.deepEqual(origin, { kind: 'reorder', taskId: b.id, direction: -1, domain: 'daily' })

  // replay onto a newer board that also has an extra task: the move must land
  const newer = cloneSnapshot(base)
  newer.tasks.push(createTask({ domain: 'daily', title: 'c', dateKey: '2025-01-15' }, NOW))
  const replayed = reapplyReorder(newer, origin.taskId, origin.direction)
  assert.deepEqual(replayed.tasks.map((task) => task.title), ['b', 'a', 'c'])
  validateSnapshot(replayed)

  // if the target was deleted elsewhere, replay is a no-op instead of throwing
  const withoutTarget = cloneSnapshot(base)
  withoutTarget.tasks = withoutTarget.tasks.filter((task) => task.id !== b.id)
  const skipped = reapplyReorder(withoutTarget, origin.taskId, origin.direction)
  assert.deepEqual(skipped.tasks.map((task) => task.title), ['a'])
})
