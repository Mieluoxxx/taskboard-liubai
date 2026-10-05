import assert from 'node:assert/strict'
import test from 'node:test'
import { addCycle, addTask, createTask, emptySnapshot } from '../src/domain'
import {
  buildIndex, commandsFor, completeCommand, formatDate, formatSpan, formatWeek, fuzzyScore, isAnswer, isYes, lookupRef, parseDateArg, parseLine, parseMinutes,
  parseDateSpanArg, parseQuickAdd, parseRef, parseWeekArg, parseWeekSpanArg, renderBanner, resolveCommand, restAfter, sceneSiblings,
} from '../src/terminal'

test('a line is either a slash command or text to add', () => {
  assert.deepEqual(parseLine('   '), { kind: 'empty' })
  assert.deepEqual(parseLine('回复邮件'), { kind: 'text', text: '回复邮件' })
  assert.deepEqual(parseLine('/Done d1  d2'), { kind: 'command', name: 'done', args: ['d1', 'd2'], rest: 'd1  d2' })
  assert.equal(restAfter('d1   写  测试'), '写  测试', 'titles keep their inner spacing')
})

test('commands resolve by alias and stay inside their context', () => {
  assert.equal(resolveCommand('x', 'board')?.name, 'done')
  assert.equal(resolveCommand('cd', 'board')?.name, 'project')
  assert.equal(resolveCommand('done', 'guest'), undefined, 'a guest cannot touch the board')
  assert.equal(resolveCommand('login', 'board'), undefined)
  assert.equal(resolveCommand('allow', 'account')?.name, 'allow')
  for (const context of ['guest', 'board', 'account'] as const) {
    const names = commandsFor(context).map((command) => command.name)
    assert.equal(new Set(names).size, names.length, `${context} has duplicate commands`)
    assert.ok(names.includes('help') && names.includes('theme') && names.includes('clear'))
  }
})

test('completion runs argument-free commands and inserts the rest', () => {
  const items = completeCommand('/de', 'board', 'en')
  assert.deepEqual(items.map((item) => item.value), ['/defer', '/rm'], '/delete is an alias of /rm')
  assert.equal(items[0].run, false, '/defer needs a ref, so Enter only inserts it')
  assert.equal(completeCommand('/tod', 'board', 'zh')[0].run, true)
  assert.deepEqual(completeCommand('/done d1', 'board', 'en'), [], 'no completion once arguments start')
  assert.deepEqual(completeCommand('hello', 'board', 'en'), [])
})

test('refs follow the current view and the displayed order', () => {
  assert.deepEqual(parseRef('3', 'd'), { scope: 'd', label: 'd3' })
  assert.deepEqual(parseRef('W2.1', 'd'), { scope: 'w', label: 'w2.1' })
  assert.equal(parseRef('2', null), null, 'the tree view needs an explicit scope')
  assert.equal(parseRef('f1.1', null), null, 'focus blocks have no subtasks')
  assert.equal(parseRef('d0', null), null)

  let snapshot = addCycle(emptySnapshot('UTC'), 'Q4', '2026-10-01', '2026-12-31')
  const cycleId = snapshot.cycles[0].id
  const first = createTask({ domain: 'daily', title: 'first', cycleId, dateKey: '2026-10-05' })
  snapshot = addTask(snapshot, first)
  snapshot = addTask(snapshot, createTask({ domain: 'daily', title: 'second', cycleId, dateKey: '2026-10-05' }))
  snapshot = addTask(snapshot, createTask({ domain: 'daily', title: 'child', cycleId, dateKey: '2026-10-05', parentId: first.id }))
  snapshot = addTask(snapshot, createTask({ domain: 'daily', title: 'other day', cycleId, dateKey: '2026-10-06' }))
  const index = buildIndex(snapshot, { cycleId: null, week: '2026-W41', date: '2026-10-05' })
  assert.deepEqual(index.d.map((row) => `${row.ref}:${row.task.title}`), ['d1:first', 'd1.1:child', 'd2:second'])
  assert.equal(lookupRef(index, parseRef('1.1', 'd')!)?.task?.title, 'child')
  assert.equal(lookupRef(index, parseRef('d3', null)!), null)
})

test('a multi-week plan shows up in every week it covers and is ordered against that week', () => {
  let snapshot = addCycle(emptySnapshot('UTC'), 'Q4', '2026-10-01', '2026-12-31')
  const cycleId = snapshot.cycles[0].id
  const span = createTask({ domain: 'weekly', title: 'span', cycleId, weekKey: '2026-W40', endWeekKey: '2026-W42' })
  const early = createTask({ domain: 'weekly', title: 'early', cycleId, weekKey: '2026-W40' })
  const late = createTask({ domain: 'weekly', title: 'late', cycleId, weekKey: '2026-W42' })
  snapshot = addTask(addTask(addTask(snapshot, span), early), late)
  const titles = (week: string) => buildIndex(snapshot, { cycleId, week, date: '2026-10-05' }).w.map((row) => row.task.title)
  assert.deepEqual([titles('2026-W40'), titles('2026-W41'), titles('2026-W42')], [['span', 'early'], ['span'], ['span', 'late']])
  // 同一条跨周任务，在不同周里的邻居不同：按正在看的那一周算。
  assert.deepEqual(sceneSiblings(snapshot, span).map((task) => task.title), ['span', 'early'])
  assert.deepEqual(sceneSiblings(snapshot, span, { week: '2026-W42', date: '2026-10-12' }).map((task) => task.title), ['span', 'late'])
  assert.deepEqual(sceneSiblings(snapshot, span, { week: '2026-W45', date: '2026-11-02' }).map((task) => task.title), ['span', 'early'], 'a week outside the span falls back to its start')
})

test('a multi-day plan shows up on every day it covers and is ordered against that day', () => {
  let snapshot = addCycle(emptySnapshot('UTC'), 'Q4', '2026-10-01', '2026-12-31')
  const cycleId = snapshot.cycles[0].id
  const span = createTask({ domain: 'daily', title: 'span', cycleId, dateKey: '2026-10-05', endDateKey: '2026-10-07' })
  const monday = createTask({ domain: 'daily', title: 'monday', cycleId, dateKey: '2026-10-05' })
  const wednesday = createTask({ domain: 'daily', title: 'wednesday', cycleId, dateKey: '2026-10-07' })
  snapshot = [span, monday, wednesday].reduce(addTask, snapshot)
  const titles = (date: string) => buildIndex(snapshot, { cycleId, week: '2026-W41', date }).d.map((row) => row.task.title)
  assert.deepEqual([titles('2026-10-05'), titles('2026-10-06'), titles('2026-10-07'), titles('2026-10-08')], [['span', 'monday'], ['span'], ['span', 'wednesday'], []])
  assert.deepEqual(sceneSiblings(snapshot, span, { week: '2026-W41', date: '2026-10-07' }).map((task) => task.title), ['span', 'wednesday'])
})

test('dates and weeks have one canonical grammar, anchored to what is being changed', () => {
  const anchor = '2026-10-06'
  const today = '2026-10-04'
  // 日期：完整、MM-DD、相对真实今天的词、锚点那一周的星期几、从锚点起的 ±N 天。
  for (const [typed, expected] of [
    ['2026-10-09', '2026-10-09'], ['10-09', '2026-10-09'], ['10-9', '2026-10-09'],
    ['today', today], ['今天', today], ['tomorrow', '2026-10-05'], ['明天', '2026-10-05'], ['yesterday', '2026-10-03'], ['昨天', '2026-10-03'],
    ['fri', '2026-10-09'], ['周一', '2026-10-05'], ['周日', '2026-10-11'], ['+1', '2026-10-07'], ['-7', '2026-09-29'],
  ] as const) assert.equal(parseDateArg(typed, anchor, today), expected, typed)
  // 被统一掉的别名一律不认，报错里会给出规范写法。
  for (const typed of ['now', '.', 'tmr', 'monday', '一', '周天', '10/09', '10.09', '02-30', 'constructor']) assert.equal(parseDateArg(typed, anchor, today), null, typed)

  // 周次：完整、Www、从锚点起的 ±N 周，以及任何日期写法取所在的那一周。
  for (const [typed, expected] of [
    ['2026-W41', '2026-W41'], ['W41', '2026-W41'], ['w41', '2026-W41'], ['+1', '2026-W42'], ['-1', '2026-W40'],
    ['today', '2026-W40'], ['tomorrow', '2026-W41'], ['10-20', '2026-W43'], ['2026-10-06', '2026-W41'], ['fri', '2026-W41'],
  ] as const) assert.equal(parseWeekArg(typed, '2026-W41', today), expected, typed)
  for (const typed of ['41', 'now', 'this', '本周', '.', '2026W41', 'W54', '2026-W00']) assert.equal(parseWeekArg(typed, '2026-W41', today), null, typed)
  assert.equal(parseWeekArg('+1', '2026-W53', today), '2027-W01')

  // 区间只认 `..`，两边可以有空格；终点以起点为锚点。
  assert.deepEqual(parseWeekSpanArg('W41..W43', '2026-W40', today), { start: '2026-W41', end: '2026-W43' })
  assert.deepEqual(parseWeekSpanArg('W41 .. W43', '2026-W40', today), { start: '2026-W41', end: '2026-W43' })
  assert.deepEqual(parseWeekSpanArg('today..+2', '2026-W10', today), { start: '2026-W40', end: '2026-W42' }, 'a relative end counts from the start')
  assert.deepEqual(parseWeekSpanArg('+1', '2026-W40', today), { start: '2026-W41', end: '2026-W41' })
  assert.deepEqual(parseDateSpanArg('mon..wed', anchor, today), { start: '2026-10-05', end: '2026-10-07' })
  assert.deepEqual(parseDateSpanArg('fri..+2', anchor, today), { start: '2026-10-09', end: '2026-10-11' })
  assert.deepEqual(parseDateSpanArg('today..+5', '2026-10-01', today), { start: '2026-10-04', end: '2026-10-09' }, 'parsing does not judge the week; the caller does')
  for (const typed of ['W43..W41', 'W41..', '..W41', 'W40..W41..W42', 'W40-W42', '2026-W40-W41', 'W40~W42', 'W40 到 W42', 'W40→W42']) assert.equal(parseWeekSpanArg(typed, '2026-W40', today), null, typed)
  for (const typed of ['wed..mon', '周一到周三', 'mon~wed', '10-05-10-07']) assert.equal(parseDateSpanArg(typed, anchor, today), null, typed)
})

test('an omitted year is the nearest for a point and the next occurrence for a span end', () => {
  const today = '2026-10-04'
  // 单点取离锚点最近的那一年：站在年底，W01 是明年；站在年初，W52、12-30 是去年。
  assert.equal(parseWeekArg('W01', '2026-W53', today), '2027-W01')
  assert.equal(parseWeekArg('W52', '2027-W01', today), '2026-W52')
  assert.equal(parseWeekArg('W53', '2026-W10', today), '2026-W53')
  assert.equal(parseDateArg('1-2', '2026-12-30', today), '2027-01-02')
  assert.equal(parseDateArg('12-30', '2027-01-02', today), '2026-12-30')
  // 区间终点取起点之后第一次出现，与锚点无关：跨年写短也不会歧义。
  assert.deepEqual(parseWeekSpanArg('W52..W02', '2026-W50', today), { start: '2026-W52', end: '2027-W02' })
  assert.deepEqual(parseWeekSpanArg('2026-W52..W02', '2026-W10', today), { start: '2026-W52', end: '2027-W02' })
  assert.deepEqual(parseDateSpanArg('12-30..01-02', '2026-12-28', today), { start: '2026-12-30', end: '2027-01-02' })
  assert.deepEqual(parseWeekSpanArg('W41..W41', '2026-W40', today), { start: '2026-W41', end: '2026-W41' }, 'the same week is on or after itself')
  // 为跨年补年份只在半年之内：W40..W10 是跨年，W43..W41 多半是笔误；同一年里多长都行。
  assert.deepEqual(parseWeekSpanArg('W40..W10', '2026-W40', today), { start: '2026-W40', end: '2027-W10' })
  assert.deepEqual(parseWeekSpanArg('W01..W50', '2026-W01', today), { start: '2026-W01', end: '2026-W50' })
  assert.deepEqual(parseWeekSpanArg('W43..2027-W41', '2026-W40', today), { start: '2026-W43', end: '2027-W41' })
  assert.equal(parseDateArg('10-31', '2026-11-01', today, 'onOrAfter'), null)
  // 项目结束日期也按区间终点补年份。
  assert.equal(parseDateArg('03-31', '2026-11-01', today, 'onOrAfter'), '2027-03-31')
  assert.equal(parseDateArg('12-31', '2026-01-01', today, 'onOrAfter'), '2026-12-31')
})

test('dates and weeks are shown the way they are typed, with the year only when it is not this year', () => {
  const today = '2026-10-04'
  assert.equal(formatDate('2026-10-05', today), '10-05')
  assert.equal(formatDate('2027-01-02', today), '2027-01-02')
  assert.equal(formatWeek('2026-W41', today), 'W41')
  assert.equal(formatWeek('2025-W52', today), '2025-W52')
  const week = (key: string) => formatWeek(key, today)
  const day = (key: string) => formatDate(key, today)
  assert.equal(formatSpan('2026-W40', '2026-W42', week), 'W40..W42')
  assert.equal(formatSpan('2026-W52', '2027-W02', week), 'W52..2027-W02')
  assert.equal(formatSpan('2025-W50', '2026-W03', week), '2025-W50..2026-W03', 'a start with its year keeps the end explicit too')
  assert.equal(formatSpan('2026-10-05', undefined, day), '10-05')
  assert.equal(formatSpan('2026-10-05', '2026-10-05', day), '10-05')
  // 周次比的是今天所在周的 ISO 周年：2027-01-02 仍在 2026-W53。
  assert.equal(formatWeek('2026-W53', '2027-01-02'), 'W53')
  assert.equal(formatDate('2027-01-02', '2027-01-02'), '01-02')

  // 显示出来的文字以起点为锚点原样输入，解析回同一个值（编辑器与 /mv 都以任务自己的起点为锚点）。
  for (const now of ['2026-10-04', '2026-12-30', '2027-01-02']) {
    for (const [start, end] of [['2026-W40', '2026-W42'], ['2026-W52', '2027-W02'], ['2025-W50', '2026-W03'], ['2026-W01', '2027-W05'], ['2026-W53', '2026-W53']]) {
      const text = formatSpan(start, end, (key) => formatWeek(key, now))
      assert.deepEqual(parseWeekSpanArg(text, start, now), { start, end }, `${now} ${text}`)
    }
    for (const [start, end] of [['2026-10-05', '2026-10-07'], ['2026-12-28', '2027-01-03'], ['2026-01-05', '2026-01-05'], ['2025-12-29', '2026-01-02']]) {
      const text = formatSpan(start, end, (key) => formatDate(key, now))
      assert.deepEqual(parseDateSpanArg(text, start, now), { start, end }, `${now} ${text}`)
    }
  }
})

test('durations read the way people type them', () => {
  assert.equal(parseMinutes('45'), 45)
  assert.equal(parseMinutes('25m'), 25)
  assert.equal(parseMinutes('1.5h'), 90)
  assert.equal(parseMinutes('1h30m'), 90)
  assert.equal(parseMinutes('soon'), null)
})

test('quick add strips only trailing modifiers it understands', () => {
  assert.deepEqual(parseQuickAdd('写测试 #blue ^w2'), { title: '写测试', color: 'blue', upper: 'w2' })
  assert.deepEqual(parseQuickAdd('issue #12 fix'), { title: 'issue #12 fix' }, 'unknown colors are part of the title')
  assert.deepEqual(parseQuickAdd('深度工作 25m', true), { title: '深度工作', minutes: 25 })
  assert.deepEqual(parseQuickAdd('read 3 papers'), { title: 'read 3 papers' }, 'numbers are only durations in the focus view')
  assert.deepEqual(parseQuickAdd('#blue'), { title: '#blue' }, 'a lone modifier is still a title')
})

test('confirmations default to no', () => {
  assert.equal(isYes('y'), true)
  assert.equal(isYes('是'), true)
  assert.equal(isYes(''), false)
  assert.equal(isAnswer(''), true)
  assert.equal(isAnswer('maybe'), false)
})

test('the banner spells the name with a graded ink and every row lines up', () => {
  const rows = renderBanner()
  assert.equal(rows.length, 7)
  assert.match(rows[0], /^[: ]+$/, 'the top row is the lightest ink')
  assert.match(rows[6], /^[# ]+$/, 'the bottom row is the heaviest ink')
  assert.ok(rows.every((row) => row.length <= 60), 'the banner fits a narrow terminal')
})

test('fuzzy matching prefers direct hits and rejects missing letters', () => {
  assert.ok(fuzzyScore('spec', 'write SPEC chapter')! > fuzzyScore('spc', 'write SPEC chapter')!)
  assert.equal(fuzzyScore('xyz', 'write SPEC chapter'), null)
  assert.equal(fuzzyScore('', 'anything'), 0)
})
