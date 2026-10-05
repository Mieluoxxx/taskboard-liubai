import assert from 'node:assert/strict'
import test from 'node:test'
import { addCycle, addFocusBlock, addTask, createFocusBlock, createTask, emptySnapshot, updateTask } from '../src/domain'
import { bigClock, dayTree, daysOfWeekTask, dial, displayWidth, focusTree, goalsTree, GROUP_FOCUS, marks, timeline, weekTree, weeksOfGoal, windowAround, type DialRun } from '../src/scene'
import { buildIndex, changedIds, openBlock, parseSceneHash, reorderInScene, sceneHash } from '../src/terminal'
import type { BoardSnapshot, FocusBlock, Task } from '../src/types'

const DATE = '2026-10-05'
const WEEK = '2026-W41'

function board(): { snapshot: BoardSnapshot; ids: Record<string, string> } {
  let snapshot = addCycle(emptySnapshot('UTC'), 'Q4', '2026-10-01', '2026-12-31')
  const cycleId = snapshot.cycles[0].id
  const ids: Record<string, string> = {}
  const add = (key: string, input: Partial<Task> & Pick<Task, 'domain'>) => {
    const task = createTask({ title: key, cycleId, ...input })
    ids[key] = task.id
    snapshot = addTask(snapshot, task)
  }
  add('goal', { domain: 'long' })
  add('week-a', { domain: 'weekly', weekKey: WEEK, upperTaskId: undefined })
  add('week-b', { domain: 'weekly', weekKey: WEEK })
  // 存储顺序故意与分组交错：loose 排在 a1 前面，b1 夹在 a1 与 a2 之间。
  add('loose', { domain: 'daily', dateKey: DATE })
  add('a1', { domain: 'daily', dateKey: DATE })
  add('b1', { domain: 'daily', dateKey: DATE })
  add('a2', { domain: 'daily', dateKey: DATE })
  add('a1-sub', { domain: 'daily', dateKey: DATE, parentId: ids.a1 })
  snapshot = updateTask(snapshot, ids['week-a'], { upperTaskId: ids.goal })
  for (const key of ['a1', 'a2']) snapshot = updateTask(snapshot, ids[key], { upperTaskId: ids['week-a'] })
  snapshot = updateTask(snapshot, ids.b1, { upperTaskId: ids['week-b'] })
  return { snapshot, ids }
}

const selection = { cycleId: null, week: WEEK, date: DATE }

test('refs follow the drawn tree: grouped by their upper plan, unlinked last', () => {
  const { snapshot, ids } = board()
  const index = buildIndex(snapshot, selection)
  assert.deepEqual(index.w.map((row) => `${row.ref}:${row.task.title}`), ['w1:week-a', 'w2:week-b'], 'weeks linked to a goal come first')
  assert.deepEqual(index.d.map((row) => `${row.ref}:${row.task.title}`), ['d1:a1', 'd1.1:a1-sub', 'd2:a2', 'd3:b1', 'd4:loose'])
  assert.equal(index.groupOf.get(ids.a1), ids['week-a'])
  assert.equal(index.groupOf.get(ids.loose), '')
})

test('the day tree hangs today under this week and this week under its goal', () => {
  const { snapshot } = board()
  const lines = dayTree(buildIndex(snapshot, selection))
  const drawn = lines.map((line) => `${line.lead}${line.ref ?? '·'} ${line.task?.title ?? 'unlinked'}${line.context ? ' (ctx)' : ''}`)
  assert.deepEqual(drawn, [
    'g1 goal (ctx)',
    '└─ w1 week-a (ctx)',
    '   ├─ d1 a1',
    '   │  └─ d1.1 a1-sub',
    '   └─ d2 a2',
    'w2 week-b (ctx)',
    '└─ d3 b1',
    '· unlinked (ctx)',
    '└─ d4 loose',
  ])
  // 折行时沿用的连线：d1 下面既要接着画到 d2 的竖线，也要接到自己子任务的竖线。
  assert.equal(lines.find((line) => line.ref === 'd1')!.rest, '   │  │')
  assert.equal(lines.find((line) => line.ref === 'd2')!.rest, '      ')
  assert.equal(lines[0].rest, '│', 'a root with children continues straight down')
})

test('the focus tree hangs each block under its task, and numbers blocks in drawn order', () => {
  let { snapshot, ids } = board()
  const other = createTask({ domain: 'daily', title: 'other-day', cycleId: snapshot.cycles[0].id, dateKey: '2026-10-06' })
  snapshot = addTask(snapshot, other)
  const blocks: Record<string, FocusBlock> = {}
  // 存储顺序故意与树的顺序相反：编号必须跟着树走，而不是跟着存储。
  for (const [key, taskId, dateKey] of [['on-a2', ids.a2, DATE], ['on-a1', ids.a1, DATE], ['loose', undefined, DATE], ['on-sub', ids['a1-sub'], DATE], ['other-day', other.id, DATE], ['tomorrow', ids.a1, '2026-10-06']] as const) {
    blocks[key] = createFocusBlock({ dateKey, title: key, taskId })
    snapshot = addFocusBlock(snapshot, blocks[key])
  }
  const index = buildIndex(snapshot, selection)
  assert.deepEqual(index.f.map((row) => `${row.ref}:${row.block.title}`), ['f1:on-a1', 'f2:on-sub', 'f3:on-a2', 'f4:loose', 'f5:other-day'])
  const drawn = focusTree(index).map((line) => `${line.lead}${line.ref ?? '·'} ${line.task?.title ?? line.block?.title ?? line.id}`)
  assert.deepEqual(drawn, [
    'g1 goal',
    '└─ w1 week-a',
    '   ├─ d1 a1',
    '   │  ├─ f1 on-a1',
    '   │  └─ d1.1 a1-sub',
    '   │     └─ f2 on-sub',
    '   └─ d2 a2',
    '      └─ f3 on-a2',
    'w2 week-b',
    '└─ d3 b1',
    '· group:unlinked',
    '└─ d4 loose',
    `· ${GROUP_FOCUS}`,
    '├─ f4 loose',
    '└─ f5 other-day',
  ], 'blocks with no task in this day (unlinked, another day, another project) are kept in a last group')
  const bare = addFocusBlock(emptySnapshot('UTC'), createFocusBlock({ dateKey: DATE, title: 'solo' }))
  assert.deepEqual(focusTree(buildIndex(bare, selection)).map((line) => `${line.lead}${line.ref}`), ['f1'], 'without tasks the blocks are a plain list')
})

test('the block to pick up is the running one, then a half-done one, then a fresh one', () => {
  const block = (title: string, patch: Partial<FocusBlock>): FocusBlock => ({ ...createFocusBlock({ dateKey: DATE, title }), ...patch })
  const fresh = block('fresh', {})
  const half = block('half', { elapsedMs: 60_000 })
  const done = block('done', { status: 'finished', elapsedMs: 60_000 })
  const running = block('running', { status: 'running', startedAt: new Date().toISOString() })
  assert.equal(openBlock([done, fresh, half, running])?.title, 'running')
  assert.equal(openBlock([done, fresh, half])?.title, 'half')
  assert.equal(openBlock([fresh, block('fresh-2', {})])?.title, 'fresh', 'ties keep the given order')
  assert.equal(openBlock([done]), undefined)
})

/** 每个非空格子落在哪一行、哪一列，以及它的颜色层。 */
function cells(rows: DialRun[][]): Array<{ row: number; column: number; tone: DialRun['tone'] }> {
  return rows.flatMap((runs, row) => {
    let column = 0
    return runs.flatMap((run) => [...run.text].map((char) => ({ row, column: column++, tone: run.tone, char }))).filter((cell) => cell.char !== ' ')
  })
}

test('the dial is a square block face: a shrinking sector for a timer, hands for the wall clock', () => {
  const full = dial({ rows: 10, sector: [0, 1] })
  assert.equal(full.length, 10)
  assert.ok(full.every((runs) => runs.map((run) => run.text).join('').length === 20), 'two columns per row keep the dots square')
  assert.ok(full.every((runs) => [...runs.map((run) => run.text).join('')].every((char) => ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'.includes(char))), 'only quadrant blocks, which join seamlessly like the pixel digits')
  const filled = (rows: DialRun[][]) => cells(rows).filter((cell) => cell.tone === 'fill')
  const half = filled(dial({ rows: 10, sector: [0.5, 1] }))
  assert.ok(filled(full).length > half.length && half.length > 0, 'the sector shrinks as time passes')
  assert.ok(half.every((cell) => cell.column < 10), 'the second half of the turn is the left side of the face')
  assert.equal(filled(dial({ rows: 10 })).length, 0, 'no sector once time is up')
  const quarter = filled(dial({ rows: 10, sector: [0.75, 1] }))
  assert.ok(quarter.every((cell) => cell.column < 10 && cell.row < 5), 'the last quarter sits between nine and twelve')
  const three = cells(dial({ rows: 10, hands: [{ turn: 0.25, length: 0.8 }] })).filter((cell) => cell.tone === 'hand')
  assert.ok(three.length && three.every((cell) => cell.column >= 9 && cell.row >= 4 && cell.row <= 5), 'a hand at three o\'clock points right')
})

test('without any links the scene stays a plain list, with no fake unlinked root', () => {
  let snapshot = addCycle(emptySnapshot('UTC'), 'Q4', '2026-10-01', '2026-12-31')
  const cycleId = snapshot.cycles[0].id
  snapshot = addTask(snapshot, createTask({ domain: 'weekly', title: 'one', cycleId, weekKey: WEEK }))
  snapshot = addTask(snapshot, createTask({ domain: 'weekly', title: 'two', cycleId, weekKey: WEEK }))
  const lines = weekTree(buildIndex(snapshot, selection))
  assert.deepEqual(lines.map((line) => `${line.lead}${line.ref}`), ['w1', 'w2'])
  assert.deepEqual(goalsTree(buildIndex(snapshot, selection)), [])
})

test('moving up or down only swaps inside the drawn group', () => {
  const { snapshot, ids } = board()
  const order = (next: BoardSnapshot) => buildIndex(next, selection).d.filter((row) => !row.depth).map((row) => row.task.title)
  const moved = reorderInScene(snapshot, ids.a2, -1)
  assert.deepEqual(order(moved), ['a2', 'a1', 'b1', 'loose'], 'a2 jumps over a1, not over b1 that sits between them in storage')
  assert.equal(reorderInScene(snapshot, ids.b1, -1), snapshot, 'the first of its group has nowhere to go')
  assert.equal(reorderInScene(snapshot, ids.loose, 1), snapshot)
  assert.equal(reorderInScene(snapshot, 'missing', 1), snapshot)
})

test('a multi-week plan spreads its days per viewed week and its goal counts it in every covered week', () => {
  let snapshot = addCycle(emptySnapshot('UTC'), 'Q4', '2026-10-01', '2026-12-31')
  const cycleId = snapshot.cycles[0].id
  const goal = createTask({ domain: 'long', title: 'goal', cycleId })
  const span = createTask({ domain: 'weekly', title: 'span', cycleId, weekKey: '2026-W40', endWeekKey: '2026-W41', upperTaskId: goal.id })
  snapshot = addTask(addTask(snapshot, goal), span)
  snapshot = addTask(snapshot, createTask({ domain: 'daily', title: 'first week', cycleId, dateKey: '2026-10-01', upperTaskId: span.id }))
  snapshot = addTask(snapshot, createTask({ domain: 'daily', title: 'second week', cycleId, dateKey: '2026-10-06', upperTaskId: span.id }))
  // 两周的执行轨迹各自留在各自那一周里，而不是只看起始周。
  assert.deepEqual([...daysOfWeekTask(snapshot, span, '2026-W40').keys()], ['2026-10-01'])
  assert.deepEqual([...daysOfWeekTask(snapshot, span, '2026-W41').keys()], ['2026-10-06'])
  assert.deepEqual([...daysOfWeekTask(snapshot, span).keys()], ['2026-10-01'], 'without a viewed week it reads the start week')
  const weeks = weeksOfGoal(snapshot, goal, ['2026-W39', '2026-W40', '2026-W41', '2026-W42'])
  assert.deepEqual([...weeks.keys()], ['2026-W40', '2026-W41'])
  // 跨天的日计划在它占的每一天都点一格。
  snapshot = addTask(snapshot, createTask({ domain: 'daily', title: 'three days', cycleId, dateKey: '2026-10-07', endDateKey: '2026-10-09', upperTaskId: span.id }))
  assert.deepEqual([...daysOfWeekTask(snapshot, span, '2026-W41').keys()], ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'])
  // 第二周日视图里，这条周任务仍是今天任务的上级。
  const index = buildIndex(snapshot, { cycleId, week: '2026-W41', date: '2026-10-06' })
  assert.equal(index.groupOf.get(index.d[0].task.id), span.id)
})

test('every change is flagged so the redrawn row can flash', () => {
  const { snapshot, ids } = board()
  const next = updateTask(snapshot, ids.a1, { checked: true })
  assert.deepEqual([...changedIds(snapshot, next)], [ids.a1])
  assert.equal(changedIds(snapshot, snapshot).size, 0)
})

test('the scene round-trips through the address bar and ignores auth fragments', () => {
  assert.equal(sceneHash('day', { cycleId: 'cycle_1', week: WEEK, date: DATE }), '#/day/2026-10-05@cycle_1')
  assert.equal(sceneHash('week', { cycleId: '', week: WEEK, date: DATE }), '#/week/2026-W41@-')
  assert.equal(sceneHash('goals', { cycleId: null, week: WEEK, date: DATE }), '#/goals')
  assert.deepEqual(parseSceneHash('#/focus/2026-10-05@cycle_1'), { view: 'focus', cycleId: 'cycle_1', date: DATE })
  assert.deepEqual(parseSceneHash('#/week/2026-W41@-'), { view: 'week', cycleId: '', week: WEEK })
  assert.deepEqual(parseSceneHash('#/goals'), { view: 'goals', cycleId: undefined })
  assert.equal(parseSceneHash('#access_token=abc&type=recovery'), null)
  assert.equal(parseSceneHash('#/day/2026-02-30'), null)
  assert.equal(parseSceneHash('#/week/2026-W54'), null)
  assert.equal(parseSceneHash('#/tree'), null)
})

test('the drawing helpers line up in a monospace grid', () => {
  assert.equal(displayWidth('留白 Q4'), 7)
  assert.deepEqual(marks([]), { text: '·', tone: 'none' })
  const done = { checked: true } as Task
  const open = { checked: false } as Task
  assert.deepEqual(marks([open, done]), { text: '●○', tone: 'part' })
  assert.deepEqual(marks([done, done, done]), { text: '3', tone: 'done' }, 'too many marks collapse into a count')
  assert.deepEqual(windowAround([1, 2, 3, 4, 5, 6], 5, 3), [4, 5, 6])
  assert.deepEqual(windowAround([1, 2, 3, 4, 5, 6], 0, 3), [1, 2, 3])

  const runs = timeline({ start: '2026-10-01', end: '2026-10-10' }, '2026-10-04', { start: '2026-10-06', end: '2026-10-07' }, 40)
  assert.equal(runs.map((run) => run.text).join(''), '━━━●──────', 'one cell per day when the bar is wider than the project')
  assert.deepEqual(runs.map((run) => run.tone), ['past', 'today', 'future', 'span', 'future'])
  assert.equal(timeline({ start: '2026-01-01', end: '2026-12-31' }, '2026-07-01', null, 24).map((run) => run.text).join('').length, 24)

  const clock = bigClock('05:30')
  assert.equal(clock.length, 5)
  assert.ok(clock.every((row) => /^[█ ]+$/.test(row)))
  assert.equal(clock[0].length, (3 + 3 + 1 + 3 + 3) * 2 + 4 * 2, 'two characters per pixel, one pixel between glyphs')
  assert.equal(bigClock('+03:12').length, 5, 'overtime is drawn with a plus sign')
  assert.ok(bigClock('+03:12')[2].startsWith('██████'), 'the plus has a full bar through the middle')
})
