import assert from 'node:assert/strict'
import test from 'node:test'
import { addTask, carryForwardTasks, createTask, cycleForNavigation, deleteTask, emptySnapshot, mergeSnapshots, reorderSiblingTo, rescheduleDailyTask, rescheduleWeeklyTask, tasksForPlacement, updateTask, validateSnapshot } from '../src/domain'
import type { BoardSnapshot } from '../src/types'

const NOW = '2025-01-15T12:00:00.000Z'

function projectBoard(): BoardSnapshot {
  const cycles = ['A', 'B'].map((id) => ({ id, name: id, startDate: '2025-01-01', endDate: '2025-03-31', createdAt: NOW }))
  const tasks = cycles.flatMap(({ id: cycleId }) => [
    { ...createTask({ domain: 'long', title: 'Goal', cycleId }, NOW), id: `goal-${cycleId}` },
    { ...createTask({ domain: 'weekly', title: 'Week', cycleId, weekKey: '2025-W03' }, NOW), id: `week-${cycleId}` },
    { ...createTask({ domain: 'daily', title: 'Day', cycleId, dateKey: '2025-01-15' }, NOW), id: `day-${cycleId}` },
  ])
  return { ...emptySnapshot('UTC'), cycles, tasks }
}

test('overlapping projects isolate every task domain, including standalone tasks', () => {
  let board = validateSnapshot(projectBoard())
  for (const cycleId of ['A', 'B']) {
    for (const domain of ['long', 'weekly', 'daily'] as const) {
      const shown = tasksForPlacement(board, domain, { cycleId, weekKey: '2025-W03', dateKey: '2025-01-15' })
      assert.equal(shown.length, 1)
      assert.ok(shown.every((task) => task.cycleId === cycleId))
    }
  }
  board = updateTask(board, 'day-A', { checked: true, title: 'Edited' }, NOW)
  board = deleteTask(board, 'week-A', NOW)
  assert.equal(board.tasks.find((task) => task.id === 'day-B')?.checked, false)
  assert.equal(board.tasks.find((task) => task.id === 'day-B')?.title, 'Day')
  assert.ok(board.tasks.some((task) => task.id === 'week-B'))
  assert.equal(reorderSiblingTo(board, 'day-A', 'day-B'), board, 'cross-project sorting is a no-op')
})

test('legacy links recover ownership without guessing for standalone tasks or mutating input', () => {
  const legacy = projectBoard()
  for (const task of legacy.tasks) {
    if (task.domain === 'long') continue
    delete task.cycleId
    task.upperTaskId = `${task.domain === 'weekly' ? 'goal' : 'week'}-${task.id.slice(-1)}`
  }
  legacy.tasks.unshift({ ...createTask({ domain: 'daily', title: 'child', dateKey: '2025-01-15', parentId: 'day-A' }, NOW), id: 'child' })
  legacy.tasks.push({ ...createTask({ domain: 'daily', title: 'orphan', dateKey: '2025-01-15' }, NOW), id: 'orphan' })
  legacy.focusBlocks.push({ id: 'focus', title: 'Shared', dateKey: '2025-01-15', taskId: 'day-A', durationMinutes: 45, status: 'paused', elapsedMs: 0, createdAt: NOW })
  const original = structuredClone(legacy)
  const canonical = validateSnapshot(legacy)
  assert.deepEqual(legacy, original)
  assert.equal(canonical.tasks.find((task) => task.id === 'child')?.cycleId, 'A')
  assert.equal(canonical.tasks.find((task) => task.id === 'week-B')?.cycleId, 'B')
  assert.deepEqual(tasksForPlacement(canonical, 'daily', { dateKey: '2025-01-15' }).map((task) => task.id), ['orphan'])
  assert.deepEqual(validateSnapshot(canonical), canonical, 'normalization is idempotent')
  assert.deepEqual(canonical.focusBlocks, original.focusBlocks, 'shared focus blocks remain unchanged')
  const detached = deleteTask(canonical, 'goal-A', NOW)
  assert.equal(detached.tasks.find((task) => task.id === 'week-A')?.cycleId, 'A', 'unlinking does not change ownership')
})

test('project references reject invalid ownership and survive carry-forward and merge', () => {
  const board = validateSnapshot(projectBoard())
  assert.throws(() => updateTask(board, 'day-A', { upperTaskId: 'week-B' }), /association/i)
  assert.throws(() => updateTask(board, 'day-A', { parentId: 'day-B' }), /subtask/i)
  assert.throws(() => updateTask(board, 'week-A', { cycleId: 'missing' }), /cycle/i)
  const child = createTask({ domain: 'daily', title: 'Child', dateKey: '2025-01-15', parentId: 'day-A' }, NOW)
  const withChild = addTask(board, child)
  assert.equal(withChild.tasks.find((task) => task.id === child.id)?.cycleId, 'A')
  const carried = carryForwardTasks(withChild, '2025-01-22', NOW)
  for (const task of carried.tasks.filter((task) => task.rescheduledTo)) {
    assert.equal(carried.tasks.find((candidate) => candidate.id === task.rescheduledTo)?.cycleId, task.cycleId)
  }
  for (const cycleId of ['A', 'B']) {
    assert.equal(tasksForPlacement(carried, 'weekly', { cycleId, weekKey: '2025-W04' }).length, 1)
    assert.equal(tasksForPlacement(carried, 'daily', { cycleId, dateKey: '2025-01-22' }).length, cycleId === 'A' ? 2 : 1)
  }
  assert.equal(carryForwardTasks(carried, '2025-01-22', NOW), carried)
  const merged = mergeSnapshots(board, updateTask(board, 'day-A', { checked: true }), updateTask(board, 'day-B', { checked: true }))
  assert.deepEqual(merged.conflicts, [])
  assert.ok(merged.snapshot.tasks.filter((task) => task.domain === 'daily').every((task) => task.checked))
})

test('legacy reschedule history may end in a task that was later detached or linked elsewhere', () => {
  const legacy = projectBoard()
  legacy.tasks = legacy.tasks.filter((task) => task.id === 'goal-A' || task.id === 'goal-B')
  const old = { ...createTask({ domain: 'weekly', title: 'Old', weekKey: '2025-W02', upperTaskId: 'goal-A' }, NOW), id: 'old', archivedAt: NOW, archivedReason: 'rescheduled' as const, rescheduledTo: 'current' }
  const current = { ...createTask({ domain: 'weekly', title: 'Current', weekKey: '2025-W03' }, NOW), id: 'current' }
  const daily = createTask({ domain: 'daily', title: 'Day', dateKey: '2025-01-15', upperTaskId: old.id }, NOW)
  legacy.tasks.push(old, current, daily)
  for (const upperTaskId of [undefined, 'goal-B']) {
    current.upperTaskId = upperTaskId
    const normalized = validateSnapshot(legacy)
    assert.equal(normalized.tasks.find((task) => task.id === old.id)?.cycleId, 'A')
    assert.equal(normalized.tasks.find((task) => task.id === current.id)?.cycleId, upperTaskId ? 'B' : undefined)
    const carried = carryForwardTasks(normalized, '2025-01-15', NOW)
    assert.equal(carried.tasks.find((task) => task.id === daily.id)?.upperTaskId, old.id, 'history must not move a daily association into another project')
  }
})

test('ended projects keep unfinished plans reachable instead of carrying them outside their calendar', () => {
  const board = projectBoard()
  board.cycles[0].endDate = '2025-01-16'
  const carried = carryForwardTasks(board, '2025-01-22', NOW)
  for (const id of ['week-A', 'day-A']) {
    assert.deepEqual(carried.tasks.find((task) => task.id === id), board.tasks.find((task) => task.id === id))
  }
  assert.equal(tasksForPlacement(carried, 'daily', { cycleId: 'B', dateKey: '2025-01-22' }).length, 1)
  assert.throws(() => rescheduleDailyTask(board, 'day-A', '2025-01-17', NOW), /cycle/i)
  assert.throws(() => rescheduleWeeklyTask(board, 'week-A', '2025-W04', NOW), /cycle/i)
  assert.doesNotThrow(() => rescheduleDailyTask(board, 'day-A', '2025-01-16', NOW))
})

test('navigation includes legacy out-of-range plans only in their own project', () => {
  const legacy = projectBoard()
  legacy.cycles[0].endDate = '2025-01-10'
  for (const task of legacy.tasks.filter((task) => task.cycleId === 'A' && task.domain !== 'long')) {
    delete task.cycleId
    task.upperTaskId = task.domain === 'weekly' ? 'goal-A' : 'week-A'
  }
  const board = validateSnapshot(legacy)
  const nav = cycleForNavigation(board, board.cycles[0])!
  assert.equal(nav.endDate, '2025-01-19', 'include the entire legacy week for navigation')
  assert.equal(board.cycles[0].endDate, '2025-01-10', 'do not edit the actual cycle')
  assert.equal(cycleForNavigation(board, board.cycles[1]), board.cycles[1])
  assert.equal(cycleForNavigation(board), undefined)
  assert.equal(tasksForPlacement(board, 'daily', { cycleId: nav.id, dateKey: '2025-01-15' }).length, 1)
  assert.throws(() => rescheduleDailyTask(board, 'day-A', '2025-01-16'), /cycle/i, 'navigation expansion does not permit new out-of-range placement')
})
