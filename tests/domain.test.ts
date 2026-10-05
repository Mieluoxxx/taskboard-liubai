import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addCycle,
  addDays,
  addFocusBlock,
  addTask,
  carryForwardTasks,
  carriedFromLabels,
  elapsedMsAt,
  emptySnapshot,
  MAX_ELAPSED_MS,
  focusDisplayStatus,
  cloneSnapshot,
  cycleForNavigation,
  mergeSnapshots,
  moveDailyTask,
  moveWeeklyTask,
  reapplyReorder,
  reorderOrigin,
  reorderCycleTo,
  reorderSibling,
  reorderSiblingTo,
  rescheduleDailyTask,
  rescheduleWeeklyTask,
  safeTimeZone,
  setFocusCommand,
  sharesOrderScope,
  tasksForPlacement,
  validateSnapshot,
  weekKey,
  weekRange,
  weekStart,
  createTask,
  deleteTask,
} from '../src/domain'
import type { BoardSnapshot, Task } from '../src/types'
import { BoardError } from '../src/notices'

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
  assert.deepEqual(dateKeysInRange('2024-02-29', '2024-02-29'), ['2024-02-29'])
  assert.deepEqual(dateKeysInRange('2025-01-30', '2025-02-02'), ['2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02'])
  assert.deepEqual(dateKeysInRange('2020-12-31', '2021-01-01'), ['2020-12-31', '2021-01-01'])
  assert.deepEqual(weekKeysInRange('2025-01-01', '2025-01-12'), ['2025-W01', '2025-W02'])
  assert.deepEqual(weekKeysInRange('2020-12-31', '2021-01-02'), ['2020-W53'])
  assert.deepEqual(dateKeysInRange('9999-12-31', '9999-12-31'), ['9999-12-31'])
  assert.deepEqual(weekKeysInRange('9999-12-31', '9999-12-31'), [weekKey('9999-12-31')])
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

test('rescheduling archives the original placement and avoids duplicate active copies', () => {
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
  // 原放置只保留在归档条目上：不再抄写一份放置快照到新任务。
  assert.equal(archived.find((task) => task.title === 'Move me')?.dateKey, '2025-01-10')
  assert.equal(archived[0].rescheduledTo, active.find((task) => task.title === archived[0].title)?.id)
  const nextRoot = active.find((task) => task.title === 'Move me')!
  snapshot = rescheduleDailyTask(snapshot, nextRoot.id, '2025-01-18', '2025-01-16T12:00:00.000Z')
  assert.equal(snapshot.tasks.filter((task) => !task.archivedAt).length, 2)
  assert.equal(snapshot.tasks.filter((task) => task.archivedReason === 'rescheduled').length, 4)
  assert.throws(() => rescheduleDailyTask(snapshot, snapshot.tasks.find((task) => !task.archivedAt && task.title === 'Move me')!.id, '2025-01-18', NOW), /different|valid target/i)
})

test('weekly rescheduling carries an unfinished week forward and keeps the original archived', () => {
  let snapshot = board()
  const root = createTask({ domain: 'weekly', title: 'Carry me', weekKey: '2025-W03' }, NOW)
  const child = createTask({ domain: 'weekly', title: 'Child', weekKey: '2025-W03', parentId: root.id }, NOW)
  snapshot = addTask(addTask(snapshot, root), child)
  snapshot = rescheduleWeeklyTask(snapshot, root.id, '2025-W04', '2025-01-20T00:00:00.000Z')
  const active = snapshot.tasks.filter((task) => !task.archivedAt)
  const archived = snapshot.tasks.filter((task) => task.archivedAt)
  assert.equal(active.length, 2)
  assert.equal(archived.length, 2)
  assert.ok(active.every((task) => task.weekKey === '2025-W04'))
  assert.ok(archived.every((task) => task.weekKey === '2025-W03' && task.archivedReason === 'rescheduled'))
  const nextRoot = active.find((task) => task.title === 'Carry me')!
  assert.equal(archived.find((task) => task.title === 'Carry me')?.rescheduledTo, nextRoot.id)
  // 子任务必须跟着父任务一起搬并改指新父任务，否则会挂在已归档的旧父任务上断开关联。
  assert.equal(active.find((task) => task.title === 'Child')?.parentId, nextRoot.id)
  validateSnapshot(snapshot)
  assert.throws(() => rescheduleWeeklyTask(snapshot, nextRoot.id, '2025-W04'), /different/i)
  assert.throws(() => rescheduleWeeklyTask(snapshot, nextRoot.id, '2025-13'), /valid target/i)
  // 两个顺延函数按域分流：传错域必须报错，避免生成跨域的顺延副本。
  const daily = createTask({ domain: 'daily', title: 'Day', dateKey: '2025-01-15' }, NOW)
  snapshot = addTask(snapshot, daily)
  assert.throws(() => rescheduleWeeklyTask(snapshot, daily.id, '2025-W05'), /weekly/i)
})

test('changing a daily task date in the editor moves its subtasks and never leaves the project cycle', () => {
  const base = withCycle(board())
  const cycle = base.cycles[0]
  const root = createTask({ domain: 'daily', title: 'root', dateKey: cycle.startDate, cycleId: cycle.id }, NOW)
  const child = createTask({ domain: 'daily', title: 'child', dateKey: cycle.startDate, cycleId: cycle.id, parentId: root.id }, NOW)
  const sibling = createTask({ domain: 'daily', title: 'sibling', dateKey: cycle.startDate, cycleId: cycle.id }, NOW)
  const snapshot = addTask(addTask(addTask(base, root), child), sibling)

  const moved = moveDailyTask(snapshot, root.id, cycle.endDate, NOW)
  const find = (id: string) => moved.tasks.find((candidate) => candidate.id === id)
  assert.equal(find(root.id)?.dateKey, cycle.endDate)
  assert.equal(find(child.id)?.dateKey, cycle.endDate, 'a subtask rides along, so its placement must match the parent')
  assert.equal(find(sibling.id)?.dateKey, cycle.startDate, 'other tasks on the same day stay put')
  validateSnapshot(moved)
  assert.equal(moveDailyTask(snapshot, root.id, cycle.startDate, NOW), snapshot, 'moving onto the same day is a no-op')
  assert.throws(
    () => moveDailyTask(snapshot, root.id, addDays(cycle.endDate, 1), NOW),
    (error: unknown) => error instanceof BoardError && error.code === 'noticeRescheduleOutsideCycle',
    'a date outside the project cycle must be rejected instead of silently written',
  )
})

test('changing a weekly task week in the editor moves its subtasks and never leaves the project cycle', () => {
  const base = withCycle(board())
  const cycle = base.cycles[0]
  const root = createTask({ domain: 'weekly', title: 'root', weekKey: '2025-W02', cycleId: cycle.id }, NOW)
  const child = createTask({ domain: 'weekly', title: 'child', weekKey: '2025-W02', cycleId: cycle.id, parentId: root.id }, NOW)
  const snapshot = addTask(addTask(base, root), child)

  const moved = moveWeeklyTask(snapshot, root.id, '2025-W05', NOW)
  const find = (id: string) => moved.tasks.find((candidate) => candidate.id === id)
  assert.equal(find(root.id)?.weekKey, '2025-W05')
  assert.equal(find(child.id)?.weekKey, '2025-W05', 'a subtask rides along, so its placement must match the parent')
  validateSnapshot(moved)
  assert.equal(moveWeeklyTask(snapshot, root.id, '2025-W02', NOW), snapshot, 'moving onto the same week is a no-op')
  assert.throws(
    () => moveWeeklyTask(snapshot, root.id, '2025-W20', NOW),
    (error: unknown) => error instanceof BoardError && error.code === 'noticeRescheduleOutsideCycle',
    'a week outside the project cycle must be rejected instead of silently written',
  )
})

test('a weekly task can span several ISO weeks, and every placement rule reads the whole span', () => {
  const base = withCycle(board())
  const cycle = base.cycles[0]
  const span = createTask({ domain: 'weekly', title: 'Span', weekKey: '2025-W02', endWeekKey: '2025-W04', cycleId: cycle.id }, NOW)
  const child = createTask({ domain: 'weekly', title: 'Child', weekKey: '2025-W02', endWeekKey: '2025-W04', cycleId: cycle.id, parentId: span.id }, NOW)
  const single = createTask({ domain: 'weekly', title: 'Single', weekKey: '2025-W04', cycleId: cycle.id }, NOW)
  const snapshot = addTask(addTask(addTask(base, span), child), single)

  assert.deepEqual(['2025-W01', '2025-W02', '2025-W03', '2025-W04', '2025-W05'].map((week) => tasksForPlacement(snapshot, 'weekly', { cycleId: cycle.id, weekKey: week }).length), [0, 2, 2, 3, 0])
  // 一个跨度只有一种写法：终点必须晚于起点，只有周任务能带，子任务必须与父任务一致。
  for (const patch of [{ endWeekKey: '2025-W02' }, { endWeekKey: '2025-W01' }, { endWeekKey: '2025-W60' }]) {
    assert.throws(() => validateSnapshot({ ...snapshot, tasks: snapshot.tasks.map((task) => task.id === single.id ? { ...task, ...patch } : task) }), /placement is invalid/i)
  }
  assert.throws(() => validateSnapshot(addTask(snapshot, { ...createTask({ domain: 'daily', title: 'Day', dateKey: '2025-01-15', cycleId: cycle.id }, NOW), endWeekKey: '2025-W04' })), /placement is invalid/i)
  assert.throws(() => validateSnapshot({ ...snapshot, tasks: snapshot.tasks.map((task) => task.id === child.id ? { ...task, endWeekKey: '2025-W03' } : task) }), /subtask graph/i)

  // 换周默认整段平移、保持周数；给区间就按区间重设，首尾相同时收成单周。
  const shifted = moveWeeklyTask(snapshot, span.id, '2025-W06', NOW)
  assert.deepEqual(shifted.tasks.filter((task) => task.id !== single.id).map((task) => [task.weekKey, task.endWeekKey]), [['2025-W06', '2025-W08'], ['2025-W06', '2025-W08']])
  const stretched = moveWeeklyTask(snapshot, single.id, { start: '2025-W04', end: '2025-W07' }, NOW)
  assert.equal(stretched.tasks.find((task) => task.id === single.id)?.endWeekKey, '2025-W07')
  const collapsed = moveWeeklyTask(snapshot, span.id, { start: '2025-W03', end: '2025-W03' }, NOW)
  assert.deepEqual(collapsed.tasks.filter((task) => task.id !== single.id).map((task) => [task.weekKey, task.endWeekKey]), [['2025-W03', undefined], ['2025-W03', undefined]])
  assert.equal(moveWeeklyTask(snapshot, span.id, { start: '2025-W02', end: '2025-W04' }, NOW), snapshot, 'the same span is a no-op')
  assert.throws(() => moveWeeklyTask(snapshot, span.id, { start: '2025-W04', end: '2025-W02' }, NOW), /invalid weekly placement/i)
  assert.throws(
    () => moveWeeklyTask(snapshot, span.id, '2025-W13', NOW),
    (error: unknown) => error instanceof BoardError && error.code === 'noticeRescheduleOutsideCycle',
    'the end of a shifted span must stay inside the project too',
  )

  // 手动顺延同样保持周数，原条目归档。
  const deferred = rescheduleWeeklyTask(snapshot, span.id, '2025-W03', NOW)
  const copy = deferred.tasks.find((task) => task.title === 'Span' && !task.archivedAt)!
  assert.deepEqual([copy.weekKey, copy.endWeekKey], ['2025-W03', '2025-W05'])

  // 整段落在项目外的旧数据：导航范围扩展到跨度的最后一周，而不只是起始周。
  const outside = { ...snapshot, tasks: snapshot.tasks.map((task) => task.id === single.id ? { ...task, weekKey: '2025-W15', endWeekKey: '2025-W16' } : task) }
  assert.equal(cycleForNavigation(outside, cycle)?.endDate, weekRange('2025-W16').end)
})

test('a daily task can span several days inside one ISO week', () => {
  const base = withCycle(board())
  const cycle = base.cycles[0]
  // 2025-01-13 是周一，2025-01-19 是周日。
  const span = createTask({ domain: 'daily', title: 'Span', dateKey: '2025-01-13', endDateKey: '2025-01-15', cycleId: cycle.id }, NOW)
  const child = createTask({ domain: 'daily', title: 'Child', dateKey: '2025-01-13', endDateKey: '2025-01-15', cycleId: cycle.id, parentId: span.id }, NOW)
  const single = createTask({ domain: 'daily', title: 'Single', dateKey: '2025-01-15', cycleId: cycle.id }, NOW)
  const snapshot = [span, child, single].reduce(addTask, base)

  assert.deepEqual(['2025-01-12', '2025-01-13', '2025-01-14', '2025-01-15', '2025-01-16'].map((date) => tasksForPlacement(snapshot, 'daily', { cycleId: cycle.id, dateKey: date }).length), [0, 2, 2, 3, 0])
  // 终点必须晚于起点、不能出周；只有日任务能带；子任务必须与父任务一致。
  for (const patch of [{ endDateKey: '2025-01-15' }, { endDateKey: '2025-01-14' }, { endDateKey: '2025-01-20' }, { endDateKey: '2025-02-30' }]) {
    assert.throws(() => validateSnapshot({ ...snapshot, tasks: snapshot.tasks.map((task) => task.id === single.id ? { ...task, ...patch } : task) }), /invalid/i, JSON.stringify(patch))
  }
  assert.throws(() => validateSnapshot(addTask(snapshot, { ...createTask({ domain: 'weekly', title: 'Week', weekKey: '2025-W03', cycleId: cycle.id }, NOW), endDateKey: '2025-01-15' })), /placement is invalid/i)
  assert.throws(() => validateSnapshot({ ...snapshot, tasks: snapshot.tasks.map((task) => task.id === child.id ? { ...task, endDateKey: '2025-01-14' } : task) }), /subtask graph/i)

  // 改日期默认整段平移、保持天数；给区间就按区间重设，首尾相同时收成单天；出周则明确拒绝。
  const shifted = moveDailyTask(snapshot, span.id, '2025-01-16', NOW)
  assert.deepEqual(shifted.tasks.filter((task) => task.id !== single.id).map((task) => [task.dateKey, task.endDateKey]), [['2025-01-16', '2025-01-18'], ['2025-01-16', '2025-01-18']])
  assert.equal(moveDailyTask(snapshot, single.id, { start: '2025-01-15', end: '2025-01-19' }, NOW).tasks.find((task) => task.id === single.id)?.endDateKey, '2025-01-19')
  assert.deepEqual(moveDailyTask(snapshot, span.id, { start: '2025-01-14', end: '2025-01-14' }, NOW).tasks.find((task) => task.id === span.id)?.endDateKey, undefined)
  for (const target of ['2025-01-18', { start: '2025-01-17', end: '2025-01-20' }]) {
    assert.throws(() => moveDailyTask(snapshot, span.id, target, NOW), (error: unknown) => error instanceof BoardError && error.code === 'noticeDaySpanWeek', JSON.stringify(target))
  }
  assert.throws(() => moveDailyTask(snapshot, span.id, { start: '2025-01-15', end: '2025-01-13' }, NOW), /invalid daily placement/i)

  // 手动顺延同样保持天数，原条目归档。
  const deferred = rescheduleDailyTask(snapshot, span.id, '2025-01-14', NOW)
  const copy = deferred.tasks.find((task) => task.title === 'Span' && !task.archivedAt)!
  assert.deepEqual([copy.dateKey, copy.endDateKey], ['2025-01-14', '2025-01-16'])
  assert.throws(() => rescheduleDailyTask(snapshot, span.id, '2025-01-18', NOW), (error: unknown) => error instanceof BoardError && error.code === 'noticeDaySpanWeek')

  // 同一天里同时出现的日任务可以互相排序。
  assert.equal(sharesOrderScope(span, single), true)
  assert.equal(sharesOrderScope(span, { ...single, dateKey: '2025-01-17' }), false)
})

test('overlapping weekly spans can be reordered against each other', () => {
  const span = createTask({ domain: 'weekly', title: 'Span', weekKey: '2025-W02', endWeekKey: '2025-W04' }, NOW)
  const later = createTask({ domain: 'weekly', title: 'Later', weekKey: '2025-W04' }, NOW)
  const apart = createTask({ domain: 'weekly', title: 'Apart', weekKey: '2025-W06' }, NOW)
  const snapshot = addTask(addTask(addTask(board(), span), later), apart)
  assert.equal(sharesOrderScope(span, later), true, 'both show up in W04')
  assert.equal(sharesOrderScope(span, apart), false)
  assert.deepEqual(reorderSiblingTo(snapshot, later.id, span.id).tasks.map((task) => task.title), ['Later', 'Span', 'Apart'])
  assert.equal(reorderSiblingTo(snapshot, apart.id, span.id), snapshot)
})

test('the carry tag follows the reschedule chain back to the original placement', () => {
  const base = withCycle(board())
  const cycle = base.cycles[0]
  const entry = (id: string, domain: 'daily' | 'weekly', extra: Partial<Task> = {}): Task => ({
    ...createTask(domain === 'daily' ? { domain, title: id, dateKey: '2025-01-16', cycleId: cycle.id } : { domain, title: id, weekKey: '2025-W03', cycleId: cycle.id }, NOW),
    id,
    ...extra,
  })
  const snapshot: BoardSnapshot = { ...base, tasks: [
    entry('orig', 'daily', { dateKey: '2025-01-02', archivedAt: NOW, archivedReason: 'rescheduled', rescheduledTo: 'mid' }),
    entry('mid', 'daily', { dateKey: '2025-01-09', archivedAt: NOW, archivedReason: 'rescheduled', rescheduledTo: 'live' }),
    entry('live', 'daily', { dateKey: '2025-01-16' }),
    entry('plain', 'daily'),
    entry('w-orig', 'weekly', { weekKey: '2025-W01', archivedAt: NOW, archivedReason: 'rescheduled', rescheduledTo: 'w-live' }),
    entry('w-live', 'weekly', { weekKey: '2025-W03' }),
  ] }

  const labels = carriedFromLabels(snapshot)
  assert.equal(labels.get('live'), '2025-01-02', 'the label must be the earliest placement, not the previous hop')
  assert.equal(labels.get('w-live'), '2025-W01', 'weekly labels use the week key')
  assert.equal(labels.has('plain'), false, 'a task with no archive pointer gets no tag')
})

test('carryForwardTasks stretches every unfinished past week up to the current week once', () => {
  let snapshot = board()
  const root = createTask({ domain: 'weekly', title: 'Carry me', weekKey: '2025-W01' }, NOW)
  const child = createTask({ domain: 'weekly', title: 'Child', weekKey: '2025-W01', parentId: root.id }, NOW)
  const done = createTask({ domain: 'weekly', title: 'Done', weekKey: '2025-W01' }, NOW)
  snapshot = addTask(addTask(addTask(snapshot, root), child), done)
  snapshot = { ...snapshot, tasks: snapshot.tasks.map((task) => task.id === done.id ? { ...task, checked: true } : task) }
  const carried = carryForwardTasks(snapshot, '2025-01-15', NOW)

  // 延长而不是复制：同一条任务覆盖 W01..W03，子任务跟着父任务；已完成的留在原处。
  const span = (task: Task) => [task.title, task.weekKey, task.endWeekKey]
  assert.deepEqual(carried.tasks.map(span), [['Carry me', '2025-W01', '2025-W03'], ['Child', '2025-W01', '2025-W03'], ['Done', '2025-W01', undefined]])
  assert.equal(carried.tasks.some((task) => task.archivedAt), false, 'nothing is archived, so the earlier weeks keep showing it')
  for (const week of ['2025-W01', '2025-W02', '2025-W03']) {
    assert.ok(tasksForPlacement(carried, 'weekly', { weekKey: week }).some((task) => task.id === root.id), `still visible in ${week}`)
  }
  validateSnapshot(carried)

  // 幂等：再跑一次不应该再改动；下一周载入时从原起点继续延长。
  assert.equal(carryForwardTasks(carried, '2025-01-15', NOW), carried)
  assert.equal(carryForwardTasks(carried, '2025-01-22', NOW).tasks.find((task) => task.id === root.id)?.endWeekKey, '2025-W04')
})

test('carryForwardTasks leaves a span alone until its last week has passed, and never stretches past the project', () => {
  const base = withCycle(board())
  const cycle = base.cycles[0]
  const running = createTask({ domain: 'weekly', title: 'Running', weekKey: '2025-W02', endWeekKey: '2025-W04', cycleId: cycle.id }, NOW)
  const ended = createTask({ domain: 'weekly', title: 'Ended', weekKey: '2025-W12', cycleId: cycle.id }, NOW)
  const snapshot = addTask(addTask(base, running), ended)
  assert.equal(carryForwardTasks(snapshot, '2025-01-15', NOW), snapshot, 'a span that still covers this week is not overdue')
  // 3 月 31 日之后本周已在项目外：未完成的计划留在原位，不被延长到可导航范围之外。
  const late = carryForwardTasks(snapshot, '2025-04-15', NOW)
  assert.equal(late.tasks.find((task) => task.id === ended.id)?.endWeekKey, undefined)
  assert.equal(late.tasks.find((task) => task.id === running.id)?.endWeekKey, '2025-W04')
})

test('carryForwardTasks stretches unfinished daily tasks of this week to today and copies those of last week', () => {
  let snapshot = board()
  const weekly = createTask({ domain: 'weekly', title: 'Week', weekKey: '2025-W01' }, NOW)
  // 上周五的事跨不过周一（日跨度不出周），只能归档后复制到今天；本周一的事原地延长到今天。
  const root = createTask({ domain: 'daily', title: 'Carry me', dateKey: '2025-01-10', upperTaskId: weekly.id }, NOW)
  const child = createTask({ domain: 'daily', title: 'Child', dateKey: '2025-01-10', parentId: root.id }, NOW)
  const stretch = createTask({ domain: 'daily', title: 'Stretch me', dateKey: '2025-01-13', upperTaskId: weekly.id }, NOW)
  const stretchChild = createTask({ domain: 'daily', title: 'Stretch child', dateKey: '2025-01-13', parentId: stretch.id }, NOW)
  const done = createTask({ domain: 'daily', title: 'Done', dateKey: '2025-01-13' }, NOW)
  const today = createTask({ domain: 'daily', title: 'Today', dateKey: '2025-01-15', upperTaskId: weekly.id }, NOW)
  snapshot = [weekly, root, child, stretch, stretchChild, done, today].reduce(addTask, snapshot)
  snapshot = { ...snapshot, tasks: snapshot.tasks.map((task) => task.id === done.id ? { ...task, checked: true } : task) }
  const carried = carryForwardTasks(snapshot, '2025-01-15', NOW)

  // 副本追加在列表末尾，数组顺序不稳定，所以按标题取用而不是比数组顺序。
  const byTitle = new Map(carried.tasks.filter((task) => !task.archivedAt).map((task) => [task.title, task]))
  const span = (title: string) => [byTitle.get(title)?.dateKey, byTitle.get(title)?.endDateKey]
  assert.deepEqual([...byTitle.keys()].sort(), ['Carry me', 'Child', 'Done', 'Stretch child', 'Stretch me', 'Today', 'Week'])
  assert.deepEqual(span('Carry me'), ['2025-01-15', undefined])
  assert.deepEqual(span('Child'), ['2025-01-15', undefined])
  assert.equal(byTitle.get('Child')?.parentId, byTitle.get('Carry me')?.id, 'subtasks ride along with the parent')
  assert.equal(byTitle.get('Stretch me')?.id, stretch.id, 'stretching keeps the same task, so Monday still shows it')
  assert.deepEqual(span('Stretch me'), ['2025-01-13', '2025-01-15'])
  assert.deepEqual(span('Stretch child'), ['2025-01-13', '2025-01-15'])
  assert.deepEqual(span('Done'), ['2025-01-13', undefined], 'a checked task stays where it was')
  assert.deepEqual(span('Today'), ['2025-01-15', undefined])
  // 周任务原地延长到本周：还是同一条，所以日任务的关联不用改，旧周里的执行轨迹也还在。
  assert.equal(byTitle.get('Week')?.id, weekly.id)
  assert.deepEqual([byTitle.get('Week')?.weekKey, byTitle.get('Week')?.endWeekKey], ['2025-W01', '2025-W03'])
  for (const title of ['Carry me', 'Stretch me', 'Today']) assert.equal(byTitle.get(title)?.upperTaskId, weekly.id)
  // 归档的旧日任务保留当时的历史关联，否则会丢掉「它原本挂在哪个周」这条线索。
  const archivedDaily = carried.tasks.find((task) => task.title === 'Carry me' && task.archivedAt)
  assert.equal(archivedDaily?.upperTaskId, weekly.id)
  assert.ok(archivedDaily?.rescheduledTo)
  assert.equal(carried.tasks.filter((task) => task.archivedAt).length, 2, 'only last week\'s task and its subtask are archived')
  validateSnapshot(carried)

  assert.equal(carryForwardTasks(carried, '2025-01-15', NOW), carried, 'carrying must be idempotent')
})

test('a daily task carried later still finds the weekly copy moved in an earlier load', () => {
  let snapshot = board()
  const oldWeek = createTask({ domain: 'weekly', title: 'Week', weekKey: '2025-W01' }, NOW)
  const newWeek = createTask({ domain: 'weekly', title: 'Week', weekKey: '2025-W03' }, NOW)
  const daily = createTask({ domain: 'daily', title: 'Day', dateKey: '2025-01-10', upperTaskId: oldWeek.id }, NOW)
  snapshot = addTask(addTask(addTask(snapshot, oldWeek), newWeek), daily)
  // 上一次载入已经把周任务搬到了 W03，只留下归档指针；本次调用不会再看到那条周任务。
  snapshot = { ...snapshot, tasks: snapshot.tasks.map((task) => task.id === oldWeek.id ? { ...task, archivedAt: NOW, archivedReason: 'rescheduled' as const, rescheduledTo: newWeek.id } : task) }

  const carried = carryForwardTasks(snapshot, '2025-01-15', NOW)
  const moved = carried.tasks.find((task) => task.title === 'Day' && !task.archivedAt)
  assert.equal(moved?.dateKey, '2025-01-15')
  assert.equal(moved?.upperTaskId, newWeek.id, 'the reference must be followed across loads, not only within one call')
  validateSnapshot(carried)
})

test('carryForwardTasks repairs a stale weekly link even when nothing has to move', () => {
  let snapshot = board()
  const oldWeek = createTask({ domain: 'weekly', title: 'Week', weekKey: '2025-W01' }, NOW)
  const newWeek = createTask({ domain: 'weekly', title: 'Week', weekKey: '2025-W03' }, NOW)
  const daily = createTask({ domain: 'daily', title: 'Day', dateKey: '2025-01-15', upperTaskId: oldWeek.id }, NOW)
  snapshot = addTask(addTask(addTask(snapshot, oldWeek), newWeek), daily)
  snapshot = { ...snapshot, tasks: snapshot.tasks.map((task) => task.id === oldWeek.id ? { ...task, archivedAt: NOW, archivedReason: 'rescheduled' as const, rescheduledTo: newWeek.id } : task) }

  const carried = carryForwardTasks(snapshot, '2025-01-15', NOW)
  assert.notEqual(carried, snapshot, 'a repaired link still needs to be saved')
  assert.equal(carried.tasks.find((task) => task.title === 'Day')?.upperTaskId, newWeek.id)
  assert.equal(carried.tasks.filter((task) => task.title === 'Day').length, 1, 'repairing a link must not duplicate the task')
  validateSnapshot(carried)
})

test('carryForwardTasks survives a reschedule chain that ends somewhere illegal', () => {
  let snapshot = board()
  const weekly = createTask({ domain: 'weekly', title: 'Week', weekKey: '2025-W01' }, NOW)
  const stray = createTask({ domain: 'daily', title: 'Stray', dateKey: '2025-01-10' }, NOW)
  const past = createTask({ domain: 'daily', title: 'Past', dateKey: '2025-01-10', upperTaskId: weekly.id }, NOW)
  snapshot = addTask(addTask(addTask(snapshot, weekly), stray), past)
  // 快照校验只要求 rescheduledTo 指向存在的 id，不限定域：链尾完全可能是一条日任务。
  snapshot = { ...snapshot, tasks: snapshot.tasks.map((task) => task.id === weekly.id ? { ...task, archivedAt: NOW, archivedReason: 'rescheduled' as const, rescheduledTo: stray.id } : task) }
  validateSnapshot(snapshot)

  const carried = carryForwardTasks(snapshot, '2025-01-15', NOW)
  const moved = carried.tasks.find((task) => task.title === 'Past' && !task.archivedAt)
  assert.equal(moved?.dateKey, '2025-01-15', 'one bad link must not abort the whole carry')
  assert.equal(moved?.upperTaskId, weekly.id, 'an illegal chain end must not be adopted')
  validateSnapshot(carried)
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

test('drag sorting moves across multiple siblings in either direction without changing unrelated slots or task contents', () => {
  for (const domain of ['long', 'weekly', 'daily'] as const) {
    const base = withCycle(board())
    const placement = domain === 'long' ? { cycleId: base.cycles[0].id } : domain === 'weekly' ? { weekKey: '2025-W03' } : { dateKey: '2025-01-15' }
    const [a, b, c] = ['a', 'b', 'c'].map((title) => createTask({ domain, title, ...placement }, NOW))
    const child = createTask({ domain, title: 'child', parentId: a.id, ...placement }, NOW)
    const unrelated = createTask({ domain: 'daily', title: 'another date', dateKey: '2025-02-01' }, NOW)
    const snapshot = { ...base, tasks: [a, child, b, unrelated, c] }
    const original = cloneSnapshot(snapshot)

    const down = reorderSiblingTo(snapshot, a.id, c.id)
    assert.deepEqual(down, { ...snapshot, tasks: [b, child, c, unrelated, a] })
    assert.deepEqual(reorderSiblingTo(down, a.id, b.id), snapshot)
    assert.deepEqual(reorderSiblingTo(snapshot, c.id, a.id), { ...snapshot, tasks: [c, child, a, unrelated, b] })
    assert.deepEqual(reorderSibling(snapshot, a.id, 1), reorderSiblingTo(snapshot, a.id, b.id))
    assert.deepEqual(snapshot, original, 'sorting must not mutate its input')
    validateSnapshot(down)
  }
})

test('drag sorting limits subtasks to the same parent and ignores stale or invalid drops', () => {
  const base = withCycle(board())
  const a = createTask({ domain: 'daily', title: 'a', dateKey: '2025-01-15' }, NOW)
  const b = { ...a, id: 'b', title: 'b' }
  const children = ['one', 'two', 'three'].map((title) => ({ ...a, id: title, title, parentId: a.id }))
  const cousin = { ...children[0], id: 'cousin', parentId: b.id }
  const archived = { ...a, id: 'archived', archivedAt: NOW, archivedReason: 'rescheduled' as const }
  const otherDate = { ...a, id: 'other-date', dateKey: '2025-01-16' }
  const weekly = createTask({ domain: 'weekly', title: 'weekly', weekKey: '2025-W03' }, NOW)
  const snapshot = { ...base, tasks: [a, children[0], b, cousin, children[1], archived, children[2], otherDate, weekly] }
  const sorted = reorderSiblingTo(snapshot, children[0].id, children[2].id)
  assert.deepEqual(sorted, { ...snapshot, tasks: [a, children[1], b, cousin, children[2], archived, children[0], otherDate, weekly] })
  validateSnapshot(sorted)
  for (const [source, target] of [
    [children[0].id, cousin.id], [children[0].id, a.id], [a.id, children[0].id],
    [a.id, a.id], [a.id, archived.id], [archived.id, a.id], [a.id, otherDate.id],
    [a.id, weekly.id], [a.id, 'deleted'], ['deleted', a.id],
  ]) assert.equal(reorderSiblingTo(snapshot, source, target), snapshot, `${source} → ${target} must be a no-op`)

  const long = createTask({ domain: 'long', title: 'long', cycleId: base.cycles[0].id }, NOW)
  const otherCycle = { ...long, id: 'other-cycle', cycleId: 'another-cycle' }
  const otherWeek = { ...weekly, id: 'other-week', weekKey: '2025-W04' }
  const scopes = { ...base, tasks: [long, otherCycle, weekly, otherWeek] }
  assert.equal(reorderSiblingTo(scopes, long.id, otherCycle.id), scopes)
  assert.equal(reorderSiblingTo(scopes, weekly.id, otherWeek.id), scopes)
  assert.equal(reorderSibling(snapshot, a.id, -1), snapshot)
})

test('drag sorting reorders projects without touching their contents or other scopes', () => {
  const first = addCycle(board(), 'first', '2025-01-01', '2025-03-31', NOW)
  const second = addCycle(first, 'second', '2025-04-01', '2025-06-30', NOW)
  const third = addCycle(second, 'third', '2025-07-01', '2025-09-30', NOW)
  const original = cloneSnapshot(third)
  const [a, b, c] = third.cycles

  const moved = reorderCycleTo(third, a.id, c.id)
  assert.deepEqual(moved.cycles.map((cycle) => cycle.id), [b.id, c.id, a.id])
  assert.deepEqual(reorderCycleTo(moved, a.id, b.id), third, 'moving back restores the original order')
  assert.deepEqual(third, original, 'sorting must not mutate its input')
  assert.equal(reorderCycleTo(third, a.id, a.id), third, 'a drop on itself is a no-op')
  assert.equal(reorderCycleTo(third, a.id, 'deleted'), third, 'a stale target is a no-op')
  assert.equal(reorderCycleTo(third, 'deleted', b.id), third, 'a stale source is a no-op')
  validateSnapshot(moved)
})
