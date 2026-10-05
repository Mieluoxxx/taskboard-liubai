// 终端界面的端到端验收：只操作 LOCAL DEMO，不访问云端，也不读取 .env.local。
// VITE_SUPABASE_URL= VITE_SUPABASE_PUBLISHABLE_KEY= pnpm exec vite --host 127.0.0.1 --port 5237 --strictPort
// EGO_TASK_SPACE_ID=<已有空间，可省略> VERIFY_URL=http://127.0.0.1:5237/ ego-browser nodejs < scripts/verify-terminal.mjs
const assert = (await import('node:assert/strict')).default
const task = await taskSpace(process.env.EGO_TASK_SPACE_ID ? Number(process.env.EGO_TASK_SPACE_ID) : 'taskboard terminal verification')
console.log({ spaceId: task.spaceId })
const page = task.page('p1')
const url = process.env.VERIFY_URL || 'http://127.0.0.1:5237/'
const key = 'liubai-taskboard:demo-board:v1'
const stored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key)
const active = async () => (await stored()).snapshot.tasks.filter((task) => !task.archivedAt)
const byTitle = async (title) => (await active()).find((task) => task.title === title)
const lastOutput = () => page.evaluate(() => document.querySelector('.page')?.innerText || document.querySelector('.output')?.innerText || '')
const saved = () => page.waitForSelector('.sl-save.is-saved', { timeout: 10000 })

// fill 而不是逐键输入：中文后面的空格在逐键模拟里会被吞掉。
async function run(line) {
  await page.fill('#prompt-input', line)
  await page.press('#prompt-input', 'Enter')
  await page.waitForTimeout(120)
}
async function answer(value) {
  await page.fill('#prompt-input', value)
  await page.press('#prompt-input', 'Enter')
  await page.waitForTimeout(120)
}

await page.goto(url)
await page.evaluate(async (key) => {
  const { addDays, todayInTimeZone, weekKey } = await import('/src/domain.ts')
  const date = todayInTimeZone('UTC')
  const now = new Date().toISOString()
  const base = { note: '', checked: false, color: 'ink', createdAt: now, updatedAt: now }
  const year = date.slice(0, 4)
  const cycles = ['A', 'B'].map((id) => ({ id, name: `项目 ${id}`, startDate: `${year}-01-01`, endDate: `${year}-12-31`, createdAt: now }))
  const tasks = [
    { ...base, id: 'goal-a', title: 'A 目标', domain: 'long', cycleId: 'A' },
    { ...base, id: 'week-a', title: 'A 周计划', domain: 'weekly', cycleId: 'A', weekKey: weekKey(date), upperTaskId: 'goal-a' },
    { ...base, id: 'day-a', title: 'A 日计划', domain: 'daily', cycleId: 'A', dateKey: date, upperTaskId: 'week-a', note: '第一行\n第二行' },
    { ...base, id: 'day-a2', title: 'A 第二件事'.repeat(30), domain: 'daily', cycleId: 'A', dateKey: date },
    { ...base, id: 'past-a', title: 'A 过去的事', domain: 'daily', cycleId: 'A', dateKey: addDays(date, -1) },
  ]
  const focusBlocks = [{ id: 'shared-focus', title: '共享专注', dateKey: date, durationMinutes: 45, elapsedMs: 0, status: 'paused', taskId: 'day-a', createdAt: now }]
  localStorage.clear()
  localStorage.setItem(key, JSON.stringify({ revision: 1, snapshot: { schemaVersion: 1, settings: { timeZone: 'UTC' }, cycles, tasks, focusBlocks } }))
  localStorage.setItem('liubai-taskboard:language:v1', 'zh')
}, key)
await page.reload()
await page.waitForSelector('#prompt-input')

await run('/done d1')
assert.match(await lastOutput(), /liubai: command not found|没有 \/done/, 'a guest cannot touch the board')
await run('/demo')
await page.waitForSelector('.scene [data-row-id="day-a"]')
await saved()
// 昨天与今天同一周时原地延长到今天，跨过周一则复制到今天：两种情况的最后一天都是今天。
const carried = await byTitle('A 过去的事')
assert.equal(carried.endDateKey ?? carried.dateKey, (await byTitle('A 日计划')).dateKey, 'loading carries yesterday forward')
console.log('boot + carry forward: passed')

const clamp = await page.evaluate(() => getComputedStyle(document.querySelector('[data-row-id="day-a2"] .row-text')).webkitLineClamp)
assert.equal(clamp, '2', 'long titles are clamped to two lines')
const tree = await page.evaluate(() => {
  const row = (id) => document.querySelector(`.scene [data-row-id="${id}"]`)
  const lead = (id) => row(id).querySelector('.lead')
  return {
    order: [...document.querySelectorAll('.scene [data-row-id] .row-text')].map((element) => element.lastChild.textContent.slice(0, 6)),
    dayLead: lead('day-a').textContent.split('\n')[0],
    wrappedFill: lead('day-a2').getBoundingClientRect().height === row('day-a2').getBoundingClientRect().height,
    wrapped: row('day-a2').getBoundingClientRect().height > parseFloat(getComputedStyle(row('day-a2')).lineHeight) * 1.5,
    group: !!document.querySelector('.scene .row.is-group'),
  }
})
assert.deepEqual(tree.order, ['A 目标', 'A 周计划', 'A 日计划', 'A 第二件事', 'A 过去的事'], 'today hangs under this week and its goal; unlinked plans come last')
assert.equal(tree.dayLead, '   └─ d1', 'the daily plan is drawn as a branch of its week, under its goal')
assert.ok(tree.wrapped && tree.wrappedFill, 'the guide column stretches through wrapped titles')
assert.ok(tree.group, 'unlinked plans sit under their own group')
console.log('tree: passed')
await page.click('[data-row-id="day-a"] .row-title')
assert.match(await page.evaluate(() => document.querySelector('.row-detail .detail-note').textContent), /第一行\n第二行/, 'expanding a row shows the full note')
console.log('wrapping + detail: passed')

await run('/project 2')
const rowsB = await page.evaluate(() => [...document.querySelectorAll('.scene [data-row-id]')].map((row) => row.dataset.rowId))
assert.deepEqual(rowsB, [], 'project B must not show project A goals')
await run('/day')
assert.equal(await page.evaluate(() => document.querySelectorAll('.scene [data-row-id]').length), 0, 'project B day is empty')
await run('B 日计划 #green')
await saved()
const bDay = await byTitle('B 日计划')
assert.equal(bDay.cycleId, 'B')
assert.equal(bDay.color, 'green')
await run('/focus')
assert.ok(await page.evaluate(() => !!document.querySelector('.scene [data-row-id="shared-focus"]')), 'focus blocks are shared across projects')
console.log('project isolation + shared focus: passed')

await run('/week')
await run('B 周计划')
await saved()
await run('/day')
await run('/link d1 w1')
await saved()
assert.equal((await byTitle('B 日计划')).upperTaskId, (await byTitle('B 周计划')).id)
await run('/link d1 g1')
assert.match(await lastOutput(), /不能关联到 g1/, 'a daily plan can only link to this week')
console.log('link: passed')

await run('/done d1')
await saved()
assert.equal((await byTitle('B 日计划')).checked, true)
assert.equal((await byTitle('A 日计划')).checked, false, 'toggling in B never touches A')
// d1 挂在 w1 下；新加的两件未关联，排在「未关联」组里：d2、d3。
await run('B 第二件')
await run('B 第三件')
await run('/mv d2 up')
assert.match(await lastOutput(), /已经到头了/, 'the first of its group cannot move up, and says so')
await run('/mv d3 up')
await saved()
const order = (await active()).filter((task) => task.cycleId === 'B' && task.domain === 'daily').map((task) => task.title)
assert.deepEqual(order, ['B 日计划', 'B 第三件', 'B 第二件'], '/mv swaps inside the drawn group and never across it')
console.log('done + reorder: passed')

await run('/edit d3')
await answer('B 第二件（改）')
await answer('一行备注')
await page.press('#prompt-input', 'Enter') // color: keep
await page.press('#prompt-input', 'Enter') // date: keep
await page.waitForTimeout(120)
await page.press('#prompt-input', 'Enter') // link: keep
await saved()
const edited = await byTitle('B 第二件（改）')
assert.equal(edited.note, '一行备注')
await run('/sub d3 子任务')
await saved()
assert.equal((await byTitle('子任务')).parentId, edited.id)
await run('/rm d3')
assert.ok(await page.evaluate(() => !!document.querySelector('.ask-title')), 'deleting asks first')
await answer('n')
assert.ok(await byTitle('B 第二件（改）'), 'n keeps the task')
await run('/rm d3')
await answer('y')
await saved()
assert.equal(await byTitle('B 第二件（改）'), undefined)
assert.equal(await byTitle('子任务'), undefined, 'subtasks go with their parent')
console.log('edit wizard + subtask + confirmed delete: passed')

await run('/start d1 25')
await saved()
let blocks = (await stored()).snapshot.focusBlocks
const started = blocks.find((block) => block.title === 'B 日计划')
assert.equal(started.status, 'running')
assert.equal(started.durationMinutes, 25)
await run('/pause')
await saved()
await run('/stop')
await saved()
blocks = (await stored()).snapshot.focusBlocks
assert.equal(blocks.find((block) => block.id === started.id).status, 'finished')
console.log('focus timer: passed')

await run('/project new 临时项目')
await answer('临时项目')
await page.press('#prompt-input', 'Enter')
await page.press('#prompt-input', 'Enter')
await saved()
assert.ok((await stored()).snapshot.cycles.some((cycle) => cycle.name === '临时项目'))
await run('/project rm')
await answer('y')
await saved()
assert.ok(!(await stored()).snapshot.cycles.some((cycle) => cycle.name === '临时项目'))
await run('/project 1')
await run('/project rm')
await answer('项目 X')
assert.match(await page.evaluate(() => document.querySelector('.prompt-error')?.textContent || ''), /名称不一致/, 'a project with plans needs its exact name')
await page.press('#prompt-input', 'Escape')
assert.ok((await stored()).snapshot.cycles.some((cycle) => cycle.id === 'A'))
console.log('project create + guarded delete: passed')

await run('/day')
await page.press('#prompt-input', 'Escape')
await page.keyboard.press('j')
const cursor = await page.evaluate(() => document.querySelector('.scene .row.is-selected')?.dataset.rowId)
assert.ok(cursor, 'esc enters navigation mode with a cursor')
await page.keyboard.press('x')
await saved()
assert.equal((await active()).find((task) => task.id === cursor)?.checked, true, 'x toggles the row under the cursor')
await page.keyboard.press('/')
await page.waitForTimeout(100)
assert.equal(await page.evaluate(() => document.activeElement?.id), 'prompt-input', '/ returns to the prompt')
console.log('navigation mode: passed')

await run('/help')
assert.ok(await page.evaluate(() => !!document.querySelector('.page') && !document.querySelector('.scene [data-row-id]')), '/help takes the whole scene')
await page.press('#prompt-input', 'Escape')
await page.waitForTimeout(100)
assert.ok(await page.evaluate(() => !document.querySelector('.page') && document.querySelectorAll('.output').length <= 1), 'esc closes the page; only one output is ever on screen')
await run('/week')
assert.match(await page.evaluate(() => location.hash), /^#\/week\/\d{4}-W\d{2}@/, 'the scene is written into the address bar')
await page.evaluate(() => history.back())
await page.waitForTimeout(200)
assert.match(await page.evaluate(() => location.hash), /^#\/day\//, 'back returns to the previous view')
assert.ok(await page.evaluate(() => !!document.querySelector('.scene .board.view-day')))
console.log('page + history: passed')

await page.keyboard.press('ControlOrMeta+k')
await page.waitForSelector('.finder')
await page.keyboard.type('B 周')
await page.keyboard.press('Enter')
await page.waitForTimeout(200)
assert.equal(await page.evaluate(() => !!document.querySelector('.scene .board.view-week')), true, 'the finder jumps to the task view')
console.log('finder: passed')

await run('/theme light')
assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
await run('/theme auto')
console.log('theme: passed')
console.log('ALL TERMINAL CHECKS PASSED')
