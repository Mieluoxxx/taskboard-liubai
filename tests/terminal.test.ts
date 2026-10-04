import assert from 'node:assert/strict'
import test from 'node:test'
import { addCycle, addTask, createTask, emptySnapshot } from '../src/domain'
import {
  buildIndex, commandsFor, completeCommand, fuzzyScore, isAnswer, isYes, lookupRef, parseDateArg, parseLine, parseMinutes,
  parseQuickAdd, parseRef, parseWeekArg, renderBanner, resolveCommand, restAfter,
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

test('dates, weeks and durations read the way people type them', () => {
  const base = '2026-10-04'
  const today = '2026-10-04'
  assert.equal(parseDateArg('+1', base, today), '2026-10-05')
  assert.equal(parseDateArg('-7', base, today), '2026-09-27')
  assert.equal(parseDateArg('10-6', base, today), '2026-10-06')
  assert.equal(parseDateArg('fri', base, today), '2026-10-02', 'weekdays stay inside the viewed ISO week')
  assert.equal(parseDateArg('周一', base, today), '2026-09-28')
  assert.equal(parseDateArg('明天', '2026-01-01', today), '2026-10-05', 'relative words follow the real today')
  assert.equal(parseDateArg('02-30', base, today), null)
  assert.equal(parseWeekArg('41', '2026-W40', '2026-W40'), '2026-W41')
  assert.equal(parseWeekArg('+1', '2026-W53', '2026-W40'), '2027-W01')
  assert.equal(parseWeekArg('now', '2026-W10', '2026-W40'), '2026-W40')
  assert.equal(parseWeekArg('2026-10-06', '2026-W10', '2026-W40'), '2026-W41')
  assert.equal(parseWeekArg('W54', '2026-W10', '2026-W40'), null)
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
