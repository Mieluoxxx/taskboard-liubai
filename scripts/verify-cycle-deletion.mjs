// 独立 LOCAL DEMO 端口：只改测试数据，不访问云端。
// VITE_SUPABASE_URL= VITE_SUPABASE_PUBLISHABLE_KEY= VITE_SUPABASE_ANON_KEY= pnpm exec vite --host 127.0.0.1 --port 5237 --strictPort
// ego-browser nodejs < scripts/verify-cycle-deletion.mjs
const assert = (await import('node:assert/strict')).default
const task = await taskSpace('taskboard cycle deletion')
console.log({ spaceId: task.spaceId })
const page = task.page('p1')
const key = 'liubai-taskboard:demo-board:v1'
const stored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key)
const choose = (name) => page.click(`.domain-long .rail-item:has-text("${name}")`)
const saved = () => page.waitForSelector('.save-indicator.saved')
const openEdit = () => page.click('.rail-edit')
const openDelete = () => page.click('.cycle-delete-entry')
async function confirm(name) {
  if (name) await page.fill('#delete-cycle-name', name)
  await page.click('.danger-button')
  await page.waitForSelector('.dialog', { state: 'hidden' })
}
await page.goto('http://127.0.0.1:5237/')
await page.evaluate(async (key) => {
  const { todayInTimeZone, weekKey, validateSnapshot } = await import('/src/domain.ts')
  const date = todayInTimeZone('UTC')
  const now = new Date().toISOString()
  const base = { note: '', checked: false, color: 'ink', createdAt: now, updatedAt: now }
  const cycles = [['A', 'Rust 学习'], ['B', 'VLA'], ['empty', '空项目']].map(([id, name]) => ({ id, name, startDate: `${date.slice(0, 4)}-01-01`, endDate: `${date.slice(0, 4)}-12-31`, createdAt: now }))
  const tasks = [
    { ...base, id: 'goal-a', title: 'Goal A', domain: 'long', cycleId: 'A' },
    { ...base, id: 'week-a', title: 'Week A', domain: 'weekly', weekKey: weekKey(date), upperTaskId: 'goal-a' },
    { ...base, id: 'day-a', title: 'Day A', domain: 'daily', dateKey: date, upperTaskId: 'week-a' },
    { ...base, id: 'child-a', title: 'Child A', domain: 'daily', dateKey: date, parentId: 'day-a' },
    { ...base, id: 'archive-a', title: 'Archive A', domain: 'daily', dateKey: date, cycleId: 'A', archivedAt: now, archivedReason: 'rescheduled', rescheduledTo: 'day-a' },
    { ...base, id: 'day-b', title: 'Day B', domain: 'daily', dateKey: date, cycleId: 'B' },
    { ...base, id: 'archive-b', title: 'Archive B', domain: 'weekly', weekKey: weekKey(date), cycleId: 'B', archivedAt: now, archivedReason: 'rescheduled', rescheduledTo: 'week-a' },
    { ...base, id: 'orphan', title: 'Unassigned', domain: 'daily', dateKey: date },
  ]
  const timer = { dateKey: date, title: 'Shared focus', durationMinutes: 45, elapsedMs: 5000, createdAt: now }
  const focusBlocks = [
    { ...timer, id: 'running', taskId: 'day-a', status: 'running', startedAt: now },
    { ...timer, id: 'finished', taskId: 'archive-a', status: 'finished', finishedAt: now },
    { ...timer, id: 'other', taskId: 'day-b', status: 'paused' },
  ]
  localStorage.setItem(key, JSON.stringify({ revision: 10, snapshot: validateSnapshot({ schemaVersion: 1, settings: { timeZone: 'UTC' }, cycles, tasks, focusBlocks }) }))
  localStorage.setItem('liubai-taskboard:language:v1', 'zh')
}, key)
await page.reload()
await page.click("loc=role:button[name*='LOCAL DEMO']")
await page.waitForSelector('[data-task-id="day-a"]')
const original = await stored()
await page.click('.rail-add')
assert.equal(await page.evaluate(() => Boolean(document.querySelector('.cycle-delete-entry'))), false, 'new projects must not expose deletion')
await page.keyboard.press('Escape')
await openEdit()
await page.fill('#cycle-name', '保留这份编辑')
await openDelete()
assert.equal(await page.evaluate(() => document.querySelectorAll('[role="dialog"]').length), 1)
assert.ok(await page.evaluate(() => document.querySelector('.cycle-delete-summary').textContent.includes('5 条计划')))
await page.fill('#delete-cycle-name', 'wrong name')
assert.equal(await page.evaluate(() => document.querySelector('.danger-button').disabled), true)
await page.keyboard.press('Enter')
assert.deepEqual(await stored(), original, 'Enter with the wrong name must not delete anything')
await page.keyboard.press('Escape')
assert.equal(await page.evaluate(() => document.querySelector('#cycle-name').value), '保留这份编辑')
await page.keyboard.press('Escape')
console.log('editor-only entry + one modal + exact-name guard + cancel retains edit: passed')

await openEdit()
const positions = await page.evaluate(() => ['.cycle-delete-entry', '.cycle-dialog-actions .secondary-button'].map((selector) => {
  const rect = document.querySelector(selector).getBoundingClientRect()
  return { x: rect.x, y: rect.y, height: rect.height }
}))
assert.ok(positions[0].x < positions[1].x && positions[0].height >= 44)
await openDelete()
await page.fill('#delete-cycle-name', 'Rust 学习')
// 另一设备新增了项目任务；刷新后应更新数量并清空名称确认。
await page.evaluate((key) => {
  const board = JSON.parse(localStorage.getItem(key))
  board.revision++
  board.snapshot.tasks.push({ ...board.snapshot.tasks.find((task) => task.id === 'day-a'), id: 'new-a', title: 'Remote A task' })
  localStorage.setItem(key, JSON.stringify(board))
  document.querySelector('button[aria-label="刷新"]').click()
}, key)
await page.waitForFunction(() => document.querySelector('.cycle-delete-summary')?.textContent.includes('6 条计划'))
assert.equal(await page.evaluate(() => document.querySelector('#delete-cycle-name').value), '')
assert.equal(await page.evaluate(() => document.querySelector('.danger-button').disabled), true)
await page.screenshot({ path: '/tmp/taskboard-delete-desktop.png' })
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
assert.equal(await page.evaluate(() => { const dialog = document.querySelector('.dialog'); return dialog.scrollWidth <= dialog.clientWidth }), true)
await page.screenshot({ path: '/tmp/taskboard-delete-mobile.png' })
await page.cdp('Emulation.clearDeviceMetricsOverride')
const beforeDelete = await stored()
console.log('footer position + changed revision resets confirmation + mobile layout: passed')

await page.evaluate(() => {
  const original = navigator.locks.request.bind(navigator.locks)
  window.__restoreCycleDeleteLock = () => { navigator.locks.request = original }
  navigator.locks.request = () => Promise.reject(new Error('intentional deletion save failure'))
})
await confirm('Rust 学习')
await page.waitForSelector('.save-indicator.error')
assert.deepEqual(await stored(), beforeDelete, 'failed deletion must not alter persisted data')
assert.equal(await page.evaluate(() => Boolean(document.querySelector('.draft-notice'))), false)
await page.evaluate(() => window.__restoreCycleDeleteLock())
await page.click("loc=role:button[name='重试']")
await saved()
const afterDelete = await stored()
assert.equal(afterDelete.revision, beforeDelete.revision + 1)
assert.deepEqual(afterDelete.snapshot.cycles.map((cycle) => cycle.id), ['B', 'empty'])
assert.deepEqual(afterDelete.snapshot.tasks.map((task) => task.id), ['day-b', 'archive-b', 'orphan'])
assert.equal(afterDelete.snapshot.tasks.find((task) => task.id === 'archive-b').rescheduledTo, undefined)
assert.deepEqual(afterDelete.snapshot.focusBlocks, beforeDelete.snapshot.focusBlocks.map((block) => {
  const { taskId, ...timer } = block
  return block.id === 'other' ? block : timer
}))
console.log('failed save + retry + full deletion + untouched shared running/finished timers: passed')

await page.reload()
await page.click("loc=role:button[name*='LOCAL DEMO']")
await page.waitForSelector('[data-task-id="day-b"]')
await openEdit()
await openDelete()
// 删除提交前让另一个设备新增 B 任务，必须进入冲突，不能自动扩大删除范围。
await page.evaluate((key) => {
  const original = navigator.locks.request.bind(navigator.locks)
  navigator.locks.request = (name, callback) => {
    navigator.locks.request = original
    const board = JSON.parse(localStorage.getItem(key))
    board.revision++
    board.snapshot.tasks.push({ ...board.snapshot.tasks.find((task) => task.id === 'day-b'), id: 'new-b', title: 'Remote B task' })
    localStorage.setItem(key, JSON.stringify(board))
    return original(name, callback)
  }
}, key)
await confirm('VLA')
await page.waitForSelector('.save-notice button:has-text("加载最新")')
assert.ok((await stored()).snapshot.cycles.some((cycle) => cycle.id === 'B'))
assert.ok((await stored()).snapshot.tasks.some((task) => task.id === 'new-b'))
await page.click('.save-notice button:has-text("加载最新")')
await page.acceptDialog()
await saved()
await choose('VLA')
await openEdit()
await openDelete()
assert.equal(await page.evaluate(() => document.querySelector('#delete-cycle-name').value), '')
assert.ok(await page.evaluate(() => document.querySelector('.cycle-delete-summary').textContent.includes('3 条计划')))
await confirm('VLA')
await saved()
console.log('concurrent project additions require reload and renewed confirmation: passed')

await openEdit()
await openDelete()
assert.equal(await page.evaluate(() => Boolean(document.querySelector('#delete-cycle-name'))), false)
assert.equal(await page.evaluate(() => document.activeElement.id), 'cancel-cycle-delete')
await page.keyboard.press('Enter')
assert.ok(await page.evaluate(() => Boolean(document.querySelector('#cycle-name'))))
await openDelete()
await confirm()
await saved()
assert.deepEqual((await stored()).snapshot.cycles, [])
assert.deepEqual((await stored()).snapshot.tasks.map((task) => task.id), ['orphan'])
assert.equal((await stored()).snapshot.focusBlocks.length, 3)
await page.reload()
await page.click("loc=role:button[name*='LOCAL DEMO']")
await page.waitForSelector('[data-task-id="orphan"]')
await page.click('.rail-add')
await page.fill('#cycle-name', '再次开始')
await page.click('.dialog button[type="submit"]')
await saved()
assert.equal((await stored()).snapshot.cycles.length, 1)
assert.equal((await stored()).snapshot.focusBlocks.find((block) => block.id === 'running').status, 'running')
console.log('empty-project safe focus + last-project deletion + reload + creating a new project: passed')
