// 独立 LOCAL DEMO 回归；会重置该测试端口的演示板，不访问云端。
// VITE_SUPABASE_URL= VITE_SUPABASE_PUBLISHABLE_KEY= VITE_SUPABASE_ANON_KEY= pnpm exec vite --host 127.0.0.1 --port 5236 --strictPort
// EGO_TASK_SPACE_ID=<已有空间，可省略> ego-browser nodejs < scripts/verify-drag.mjs
const assert = (await import('node:assert/strict')).default
const task = await taskSpace(process.env.EGO_TASK_SPACE_ID ? Number(process.env.EGO_TASK_SPACE_ID) : 'verify taskboard drag sorting')
console.log({ spaceId: task.spaceId })
const page = task.page('p1')
const key = 'liubai-taskboard:demo-board:v1'
const row = (id) => `[data-task-id="${id}"]`
const handle = (id) => `${row(id)} > .drag-handle`
const stored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key)
const settled = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const order = async (domain = 'long', parentId) => (await stored()).snapshot.tasks
  .filter((item) => item.domain === domain && item.parentId === parentId).map((item) => item.id)
const byId = (board) => board.snapshot.tasks.toSorted((a, b) => a.id.localeCompare(b.id))
async function saved(revision) {
  if (revision !== undefined) await page.waitForFunction(({ key, revision }) => JSON.parse(localStorage.getItem(key)).revision === revision, { key, revision })
  await page.waitForSelector('.save-indicator.saved', { state: 'visible' })
}
async function mouseDrag(source, target, changes = true) {
  const revision = (await stored()).revision
  const [start, end] = await page.evaluate((selectors) => selectors.map((selector) => {
    const rect = document.querySelector(selector).getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }), [source, target])
  // Ego 高层 mouse/dragAndDrop 会反复切焦点触发 visibilitychange，导致库正确取消拖拽。
  // CDP 仍发送真实输入事件，但不会切换页面；不绕过传感器、碰撞或取消保护。
  await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start })
  await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 })
  await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y + 12, buttons: 1 })
  await page.waitForSelector('.task-tree.is-dragging')
  await settled()
  await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...end, buttons: 1 })
  await settled()
  await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1 })
  await page.waitForSelector('.task-tree.is-dragging', { state: 'hidden' })
  await saved(revision + Number(changes))
}
async function openDemo() {
  await page.click("loc=role:button[name*='LOCAL DEMO']")
  await page.waitForSelector('.task-list .drag-handle')
}
async function keyboardMove(id, direction, end = 'Space') {
  const revision = (await stored()).revision
  await page.focus(handle(id))
  await page.keyboard.press('Space')
  await page.waitForSelector('.task-tree.is-dragging')
  await settled()
  await page.keyboard.press(direction)
  await settled()
  await page.keyboard.press(end)
  await page.waitForSelector('.task-tree.is-dragging', { state: 'hidden' })
  await saved(revision + Number(end !== 'Escape'))
}
async function view(domain) {
  await page.evaluate((domain) => document.querySelector(`.domain-${domain}`).scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'start' }), domain)
  await settled()
}

await page.goto('http://127.0.0.1:5236/')
await page.evaluate((key) => localStorage.removeItem(key), key)
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false })
await openDemo()
await page.evaluate((key) => {
  const board = JSON.parse(localStorage.getItem(key))
  const tasks = []
  for (const domain of ['long', 'weekly', 'daily']) {
    const template = board.snapshot.tasks.find((item) => item.domain === domain && !item.parentId && !item.archivedAt)
    for (const suffix of ['a', 'b', 'c']) tasks.push({
      ...template, id: `${domain}-${suffix}`, title: `${domain} ${suffix}`, note: '', checked: false,
      upperTaskId: domain === 'weekly' ? 'long-a' : domain === 'daily' ? 'weekly-a' : undefined,
    })
  }
  for (const [id, parentId] of [['child-one', 'long-a'], ['child-two', 'long-a'], ['cousin', 'long-b']]) {
    tasks.push({ ...tasks[0], id, title: id, parentId, upperTaskId: undefined })
  }
  board.snapshot.tasks = tasks
  board.snapshot.focusBlocks = []
  board.revision = 10
  localStorage.setItem(key, JSON.stringify(board))
  localStorage.setItem('liubai-taskboard:language:v1', 'zh')
}, key)
await page.reload()
await openDemo()
const baseline = await stored()

await mouseDrag(handle('long-a'), row('long-c'))
assert.deepEqual(await order(), ['long-b', 'long-c', 'long-a'])
assert.equal((await stored()).revision, 11, 'a drop must save exactly once')
assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.domain-long .task-list > .task-tree > .task-row')].map((el) => el.dataset.taskId)), ['long-b', 'long-c', 'long-a'])
assert.equal(await page.evaluate(() => document.querySelector('[data-task-id="child-one"]').closest('.subtask-list').parentElement.querySelector(':scope > .task-row').dataset.taskId), 'long-a')
console.log('mouse parent sorting + subtree + single save: passed')

await keyboardMove('long-a', 'ArrowUp')
assert.deepEqual(await order(), ['long-b', 'long-a', 'long-c'])
const beforeCancel = await stored()
await keyboardMove('long-a', 'ArrowUp', 'Escape')
assert.deepEqual(await stored(), beforeCancel)
await keyboardMove('child-one', 'ArrowDown')
assert.deepEqual(await order('long', 'long-a'), ['child-two', 'child-one'])
assert.deepEqual(await order(), ['long-b', 'long-a', 'long-c'])
console.log('keyboard sorting + Escape + independent child sorting: passed')

const beforeInvalid = await stored()
await mouseDrag(handle('child-one'), row('cousin'), false)
assert.deepEqual(await stored(), beforeInvalid)
await page.click(handle('long-a'))
assert.deepEqual(await stored(), beforeInvalid, 'clicking the handle must not start a drag or save')
await page.focus(handle('long-a'))
const beforeScroll = await page.evaluate(() => {
  const scroll = document.querySelector('.workspace-scroll')
  // 聚焦可能刚触发原生平滑滚动；先停住，再单独测量方向键是否触发面板导航。
  scroll.scrollTo({ left: scroll.scrollLeft, behavior: 'instant' })
  return scroll.scrollLeft
})
await page.keyboard.press('ArrowRight')
assert.equal(await page.evaluate(() => document.querySelector('.workspace-scroll').scrollLeft), beforeScroll)
console.log('invalid drop + click threshold + workspace keyboard isolation: passed')
assert.deepEqual(byId(await stored()), byId(baseline), 'sorting must preserve every task field')

await page.click(`${row('long-a')} > input[type="checkbox"]`)
await saved(beforeInvalid.revision + 1)
const afterCheckbox = await stored()
assert.equal(afterCheckbox.snapshot.tasks.find((item) => item.id === 'long-a').checked, true)
await page.click(`${row('long-a')} .row-icon[aria-label="编辑"]`)
await page.waitForSelector('#task-title')
await page.keyboard.press('Escape')
await page.waitForSelector('.dialog', { state: 'hidden' })
const beforeReload = await order()
await page.reload()
await openDemo()
assert.deepEqual(await order(), beforeReload)
assert.deepEqual(await order('long', 'long-a'), ['child-two', 'child-one'])
console.log('checkbox + editor + reload persistence: passed')

for (const domain of ['weekly', 'daily']) {
  await view(domain)
  await mouseDrag(handle(`${domain}-c`), row(`${domain}-a`))
  assert.deepEqual(await order(domain), [`${domain}-c`, `${domain}-a`, `${domain}-b`])
}
await view('weekly')
const beforeSwitch = await stored()
const selectedWeekLabel = await page.evaluate(() => document.querySelector('.domain-weekly .rail-item.selected').getAttribute('aria-label'))
await page.focus(handle('weekly-c'))
await page.keyboard.press('Space')
await page.waitForSelector('.task-tree.is-dragging')
await settled()
await page.keyboard.press('ArrowDown')
await settled()
await page.evaluate(() => [...document.querySelectorAll('.domain-weekly .rail-item')].find((item) => item.getAttribute('aria-current') !== 'page').click())
await page.waitForSelector(handle('weekly-c'), { state: 'hidden' })
await page.keyboard.press('Space')
await settled()
assert.deepEqual(await stored(), beforeSwitch, 'a sensor ending after its list unmounts must not save')
await page.evaluate((label) => [...document.querySelectorAll('.domain-weekly .rail-item')].find((item) => item.getAttribute('aria-label') === label).click(), selectedWeekLabel)
await page.waitForSelector(handle('weekly-c'))
console.log('switching periods cancels late drag completion: passed')
await view('long')
const beforeOutside = await stored()
await mouseDrag(handle('long-a'), row('weekly-c'), false)
assert.deepEqual(await stored(), beforeOutside, 'dropping in another column must not save')
await mouseDrag(handle('long-a'), handle('long-a'), false)
console.log('weekly + daily sorting + cross-column and same-position rejection: passed')

// 模拟存储失败：保留直接排序并可重试，不制造表单草稿条。
await page.evaluate(() => {
  const original = navigator.locks.request.bind(navigator.locks)
  window.__restoreDragTestLock = () => { navigator.locks.request = original }
  navigator.locks.request = () => Promise.reject(new Error('intentional drag-save failure'))
})
await page.focus(handle('long-c'))
await page.keyboard.press('Enter')
await page.waitForSelector('.task-tree.is-dragging')
await page.keyboard.press('ArrowUp')
await settled()
await page.keyboard.press('Enter')
await page.waitForSelector('.save-indicator.error')
assert.equal((await stored()).revision, beforeOutside.revision)
assert.equal(await page.evaluate(() => Boolean(document.querySelector('.draft-notice'))), false)
await page.evaluate(() => window.__restoreDragTestLock())
await page.click("loc=role:button[name='重试']")
await saved(beforeOutside.revision + 1)
assert.deepEqual(await order(), ['long-b', 'long-c', 'long-a'])
await keyboardMove('long-a', 'ArrowUp')
console.log('failed save + retained direct operation + retry + Enter controls: passed')

// 手机触屏通过真实 CDP 触摸事件走 PointerSensor，而不是调用排序函数。
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
await page.evaluate(() => {
  document.querySelector('.workspace-scroll').scrollTo({ left: 0, top: 0, behavior: 'instant' })
  window.scrollTo({ top: 0, behavior: 'instant' })
})
await settled()
const points = await page.evaluate(() => ['long-b', 'long-c'].map((id) => {
  const rect = document.querySelector(`[data-task-id="${id}"] > .drag-handle`).getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}))
assert.ok(points.every((point) => point.y > 0 && point.y < 844), 'touch targets must be in the viewport')
const beforeTouch = (await stored()).revision
await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]] })
await page.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: points[0].x, y: points[0].y + 12 }] })
await page.waitForSelector('.task-tree.is-dragging')
await settled()
await page.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [points[1]] })
await settled()
await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
await saved(beforeTouch + 1)
assert.deepEqual(await order(), ['long-a', 'long-c', 'long-b'])
assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.task-title')).touchAction), 'auto')
const swipe = await page.evaluate(() => {
  const rect = document.querySelector('[data-task-id="long-a"] > .task-title').getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
})
await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [swipe] })
for (let step = 1; step <= 6; step++) await page.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: swipe.x - step * 18, y: swipe.y }] })
await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
await page.waitForFunction(() => document.querySelector('.workspace-scroll').scrollLeft > 30)
assert.equal((await stored()).revision, beforeTouch + 1, 'swiping a title must scroll without sorting')
console.log('mobile touch sorting + real non-handle native scrolling: passed')

await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: false })
await page.cdp('Emulation.clearDeviceMetricsOverride')
const final = await stored()
assert.deepEqual(byId(final), byId(afterCheckbox), 'touch sorting must preserve every task field')
console.log('drag regression checks passed')
