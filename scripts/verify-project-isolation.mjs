// 独立测试端口的 LOCAL DEMO，不访问云端或用户的演示板。
// VITE_SUPABASE_URL= VITE_SUPABASE_PUBLISHABLE_KEY= VITE_SUPABASE_ANON_KEY= pnpm exec vite --host 127.0.0.1 --port 5237 --strictPort
// EGO_TASK_SPACE_ID=<已有空间，可省略> ego-browser nodejs < scripts/verify-project-isolation.mjs
const assert = (await import('node:assert/strict')).default
const task = await taskSpace(process.env.EGO_TASK_SPACE_ID ? Number(process.env.EGO_TASK_SPACE_ID) : 'taskboard project isolation')
console.log({ spaceId: task.spaceId })
const page = task.page('p1')
const key = 'liubai-taskboard:demo-board:v1'
const stored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key)
const choose = (name) => page.click(`.domain-long .rail-item:has-text("${name}")`)
async function add(domain, title) {
  await page.click(`.domain-${domain} .add-button`)
  await page.fill('#task-title', title)
  await page.click('.dialog button[type="submit"]')
  await page.waitForSelector('.dialog', { state: 'hidden' })
}
async function savedTask(title) {
  await page.waitForSelector('.save-indicator.saved')
  const found = (await stored()).snapshot.tasks.find((task) => task.title === title)
  assert.ok(found, `任务 ${title} 应已持久化`)
  return found
}
await page.goto('http://127.0.0.1:5237/')
await page.evaluate(async (key) => {
  const { addDays, todayInTimeZone, weekKey } = await import('/src/domain.ts')
  const date = todayInTimeZone('UTC')
  const now = new Date().toISOString()
  const base = { note: '', checked: false, color: 'ink', createdAt: now, updatedAt: now }
  const cycles = ['A', 'B'].map((id) => ({ id, name: `项目 ${id}`, startDate: `${date.slice(0, 4)}-01-01`, endDate: `${date.slice(0, 4)}-12-31`, createdAt: now }))
  const endedDate = addDays(date, -8)
  cycles.push({ id: 'ended', name: '已结束项目', startDate: endedDate, endDate: endedDate, createdAt: now })
  cycles.push({ id: 'legacy-ended', name: '旧越界项目', startDate: endedDate, endDate: endedDate, createdAt: now })
  // 旧版数据：周、日没有 cycleId，只能通过已有的关联确定项目。
  const tasks = [
    { ...base, id: 'goal-a', title: 'A 目标', domain: 'long', cycleId: 'A' },
    { ...base, id: 'week-a', title: 'A 周计划', domain: 'weekly', weekKey: weekKey(date), upperTaskId: 'goal-a' },
    { ...base, id: 'day-a', title: 'A 日计划', domain: 'daily', dateKey: date, upperTaskId: 'week-a' },
    { ...base, id: 'unassigned', title: '旧独立任务', domain: 'daily', dateKey: date },
    { ...base, id: 'ended-week', title: '结束项目周计划', domain: 'weekly', cycleId: 'ended', weekKey: weekKey(endedDate) },
    { ...base, id: 'ended-day', title: '结束项目日计划', domain: 'daily', cycleId: 'ended', dateKey: endedDate },
    { ...base, id: 'legacy-goal', title: '旧越界目标', domain: 'long', cycleId: 'legacy-ended' },
    { ...base, id: 'legacy-week', title: '已被旧版顺延的周计划', domain: 'weekly', weekKey: weekKey(date), upperTaskId: 'legacy-goal' },
    { ...base, id: 'legacy-day', title: '已被旧版顺延的日计划', domain: 'daily', dateKey: date, upperTaskId: 'legacy-week' },
  ]
  const focusBlocks = [{ id: 'shared-focus', title: '共享专注', dateKey: date, durationMinutes: 45, elapsedMs: 0, status: 'paused', taskId: 'day-a', createdAt: now }]
  localStorage.setItem(key, JSON.stringify({ revision: 1, snapshot: { schemaVersion: 1, settings: { timeZone: 'UTC' }, cycles, tasks, focusBlocks } }))
  localStorage.setItem('liubai-taskboard:language:v1', 'zh')
}, key)
await page.reload()
await page.click("loc=role:button[name*='LOCAL DEMO']")
await page.waitForSelector('[data-task-id="week-a"]')
await page.click('.domain-long .rail-item:has-text("项目 B")')
const rows = await page.evaluate(() => [...document.querySelectorAll('.domain-weekly [data-task-id], .domain-daily [data-task-id]')].map((row) => row.dataset.taskId))
assert.deepEqual(rows, [], '切到项目 B 后，不应显示项目 A 或未归属的周、日计划')
assert.equal(await page.evaluate(() => document.querySelector('.focus-panel').textContent.includes('共享专注')), true, '专注块保持共享')
console.log('legacy project switch isolation + shared focus: passed')

for (const domain of ['weekly', 'daily']) {
  await page.click(`.domain-${domain} .add-button`)
  for (const field of ['task-association', 'task-parent']) {
    await page.click(`#${field}`)
    const options = await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent))
    assert.deepEqual(options, domain === 'daily' && field === 'task-association' ? ['不关联', 'B weekly'] : ['不关联'], '候选只包含同项目的上级、父任务')
    await page.keyboard.press('Escape')
  }
  await page.fill('#task-title', `B ${domain}`)
  await page.click('.dialog button[type="submit"]')
  const task = await savedTask(`B ${domain}`)
  assert.equal(task.cycleId, 'B', '独立任务也必须写入项目归属')
  assert.equal(task.upperTaskId, undefined)
}
const bDay = await savedTask('B daily')
await page.click(`[data-task-id="${bDay.id}"] > input[type="checkbox"]`)
await page.waitForSelector('.save-indicator.saved')
assert.equal((await stored()).snapshot.tasks.find((task) => task.id === 'day-a').checked, false)
await page.click(`[data-task-id="${bDay.id}"] .row-icon[aria-label="添加子任务"]`)
await page.fill('#task-title', 'B child')
await page.click('.dialog button[type="submit"]')
const child = await savedTask('B child')
assert.equal(child.parentId, bDay.id)
assert.equal(child.cycleId, 'B')
await choose('项目 A')
assert.equal(await page.evaluate(() => document.querySelector('.domain-daily').textContent.includes('B daily')), false)
await choose('未归属计划')
assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.domain-daily [data-task-id]')].map((row) => row.dataset.taskId)), ['unassigned'])
console.log('standalone creation + scoped candidates/subtasks + independent completion + unassigned legacy access: passed')
await choose('旧越界项目')
await page.waitForSelector('[data-task-id="legacy-day"]', { timeout: 3000 })
assert.equal(await page.evaluate(() => Boolean(document.querySelector('[data-task-id="legacy-week"]'))), true)
assert.equal(await page.evaluate(() => document.querySelector('.domain-daily .add-button').disabled), true, '历史越界日期可查看，但不能继续在周期外新建计划')
console.log('legacy out-of-range plans remain reachable in their own project: passed')
await choose('已结束项目')
await page.waitForSelector('[data-task-id="ended-day"]')
assert.equal(await page.evaluate(() => Boolean(document.querySelector('[data-task-id="ended-week"]'))), true)
assert.ok((await stored()).snapshot.tasks.filter((task) => task.cycleId === 'ended').every((task) => !task.archivedAt))
console.log('ended projects keep unfinished plans in their visible date range: passed')

// 项目 A 的失败新增：切到 B 后恢复草稿，必须仍然写回 A 的原日期。
const draftDate = (await stored()).snapshot.tasks.find((task) => task.id === 'ended-day').dateKey
await choose('项目 A')
await page.evaluate(() => {
  const original = navigator.locks.request.bind(navigator.locks)
  window.__restoreProjectTestLock = () => { navigator.locks.request = original }
  navigator.locks.request = () => Promise.reject(new Error('intentional project-save failure'))
})
await add('daily', 'A recovered draft')
await page.waitForSelector('.save-indicator.error')
await choose('项目 B')
await page.click('.domain-daily .current-return')
await page.evaluate(() => window.__restoreProjectTestLock())
await page.click('.draft-notice button:has-text("加载最新")')
await page.waitForSelector('.save-notice button:has-text("重新打开编辑器")')
await page.click('.save-notice button:has-text("重新打开编辑器")')
await page.waitForSelector('#task-title')
assert.equal(await page.evaluate(() => document.querySelector('#task-title').value), 'A recovered draft')
await page.click('.dialog button[type="submit"]')
const recovered = await savedTask('A recovered draft')
assert.equal(recovered.cycleId, 'A')
assert.equal(recovered.dateKey, draftDate)
console.log('failed draft retains original project and date after project switch: passed')

await page.reload()
await page.click("loc=role:button[name*='LOCAL DEMO']")
await page.waitForSelector('[data-task-id="week-a"]')
assert.equal(await page.evaluate(() => Boolean(document.querySelector('[data-task-id="unassigned"]'))), false)
await choose('项目 B')
await page.waitForSelector(`[data-task-id="${bDay.id}"]`)
assert.equal(await page.evaluate(() => document.querySelector('.domain-daily').textContent.includes('A recovered draft')), false)
assert.equal(await page.evaluate(() => document.querySelector('.focus-panel').textContent.includes('共享专注')), true)
console.log('reload preserves project ownership and shared focus: passed')
console.log(await page.snapshot())
