// 用法：
//   VITE_SUPABASE_URL= VITE_SUPABASE_PUBLISHABLE_KEY= VITE_SUPABASE_ANON_KEY= pnpm exec vite --port 5226
//   ego-browser nodejs < scripts/verify-workspace.mjs
// 只操作 LOCAL DEMO；不读取或移动项目 .env.local。

const task = await taskSpace("verify workspace task picker");
const page = task.page('p1')
const storageKey = 'liubai-taskboard:demo-board:v1'

async function bootDemo() {
  await page.goto('http://localhost:5226/')
  await page.waitForLoadState()
  await page.waitForTimeout(1200)
  await page.evaluate((key) => localStorage.removeItem(key), storageKey)
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => /LOCAL DEMO|打开/.test(button.textContent || ''))?.click())
  await page.waitForTimeout(1800)
  await page.evaluate(() => { const scroll = document.querySelector('.workspace-scroll'); if (scroll) { scroll.scrollLeft = 0; scroll.scrollTop = 0 } })
}

async function inspect() {
  return page.evaluate(() => {
    const dayRail = document.querySelector('.panel-shell.domain-daily .rail-items')
    const days = [...document.querySelectorAll('.panel-shell.domain-daily .day-item')]
    const weeks = [...document.querySelectorAll('.panel-shell.domain-weekly .rail-item')]
    return {
      cycle: JSON.parse(localStorage.getItem('liubai-taskboard:demo-board:v1') || '{}').snapshot?.cycles?.[0] || null,
      cycleLabel: document.querySelector('.panel-shell.domain-long .rail-item.selected')?.textContent.replace(/\s+/g, ' ').trim() || null,
      days: days.length,
      dayFirst: days[0]?.textContent.replace(/\s+/g, ' ').trim() || null,
      dayLast: days.at(-1)?.textContent.replace(/\s+/g, ' ').trim() || null,
      selectedDay: days.find((item) => item.getAttribute('aria-current') === 'page')?.textContent.replace(/\s+/g, ' ').trim() || null,
      weeks: weeks.length,
      selectedWeek: weeks.find((item) => item.getAttribute('aria-current') === 'page')?.textContent.replace(/\s+/g, ' ').trim() || null,
      range: dayRail ? {classed: dayRail.classList.contains('range-items'), clientHeight: dayRail.clientHeight, scrollHeight: dayRail.scrollHeight, scrollTop: dayRail.scrollTop} : null,
      draft: Boolean(document.querySelector('.draft-notice')),
      save: document.querySelector('.save-indicator')?.textContent.trim() || null,
    }
  })
}

async function setDateInputs(start, end) {
  await page.evaluate(({start, end}) => {
    const inputs = [...document.querySelectorAll('.dialog input[type="date"]')]
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    for (const [input, value] of [[inputs[0], start], [inputs[1], end]]) {
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', {bubbles: true}))
      input.dispatchEvent(new Event('change', {bubbles: true}))
    }
  }, {start, end})
}

async function deferDemoSave() {
  await page.evaluate(() => {
    const original = navigator.locks?.request?.bind(navigator.locks)
    if (!original) throw new Error('Web Locks API unavailable')
    let deferred = true
    window.__releaseDemoSave = null
    navigator.locks.request = (name, callback) => deferred
      ? new Promise((resolve) => {
          window.__releaseDemoSave = () => {
            deferred = false
            return original(name, callback).then(resolve)
          }
        })
      : original(name, callback)
  })
}

async function scrollDaily(direction) {
  await page.evaluate(() => document.querySelector('.panel-shell.domain-daily .rail-items')?.scrollIntoView({block: 'nearest', inline: 'center'}))
  await page.waitForTimeout(100)
  const rect = await page.evaluate(() => {
    const rect = document.querySelector('.panel-shell.domain-daily .rail-items').getBoundingClientRect()
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2}
  })
  await page.mouse.move(rect.x, rect.y)
  for (let index = 0; index < 3; index++) {
    await page.mouse.wheel(0, direction)
    await page.waitForTimeout(180)
  }
  await page.waitForTimeout(250)
  return inspect()
}

async function bring(selector) {
  await page.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({block: 'nearest', inline: 'center'}), selector)
  await page.waitForTimeout(100)
}

async function verifyAssociationPicker() {
  await bootDemo()
  const opener = await page.evaluate(() => ({className: document.querySelector('.panel-shell.domain-weekly .add-button')?.className || null}))
  await page.click('.panel-shell.domain-weekly .add-button')
  await page.waitForSelector('#task-association', {state: 'visible'})
  await page.evaluate(() => document.querySelector('#task-association')?.focus())
  await page.click('#task-association')
  await page.waitForSelector('[role="listbox"]', {state: 'visible'})
  const focusedBefore = await page.evaluate(() => ({id: document.activeElement?.id || null, role: document.activeElement?.getAttribute('role') || null}))
  await page.waitForTimeout(3200)
  const focusedAfter = await page.evaluate(() => ({id: document.activeElement?.id || null, role: document.activeElement?.getAttribute('role') || null}))
  await page.keyboard.press('Escape')
  await page.waitForSelector('[role="listbox"]', {state: 'hidden'})
  const afterFirstEscape = await page.evaluate(() => ({id: document.activeElement?.id || null, role: document.activeElement?.getAttribute('role') || null}))
  const scrollBeforeDialogKey = await page.evaluate(() => document.querySelector('.workspace-scroll')?.scrollLeft || 0)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('1')
  const scrollAfterDialogKey = await page.evaluate(() => document.querySelector('.workspace-scroll')?.scrollLeft || 0)
  await page.keyboard.press('Escape')
  await page.waitForSelector('.dialog-form', {state: 'hidden'})
  const restoredFocus = await page.evaluate(() => ({className: document.activeElement?.className || null}))
  await page.click('.panel-shell.domain-weekly .add-button')
  await page.waitForSelector('#task-association', {state: 'visible'})
  await page.click('#task-association')
  await page.waitForSelector('[role="listbox"]', {state: 'visible'})
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const choice = await page.evaluate(() => ({
    hasNativeAssociationSelect: Boolean(document.querySelector('select')),
    label: document.querySelector('#task-association')?.textContent?.trim() || null,
  }))
  await page.fill('#task-title', '关联测试任务')
  await page.click('.dialog button[type="submit"]')
  await page.waitForSelector('.dialog-form', {state: 'hidden'})
  await page.waitForTimeout(700)
  const saved = await page.evaluate(() => {
    const board = JSON.parse(localStorage.getItem('liubai-taskboard:demo-board:v1') || '{}')
    const task = board.snapshot?.tasks?.find((item) => item.title === '关联测试任务')
    return {upperTaskId: task?.upperTaskId || null}
  })
  return {opener, focusedBefore, focusedAfter, afterFirstEscape, scrollBeforeDialogKey, scrollAfterDialogKey, restoredFocus, choice, saved}
}

await page.cdp('Emulation.setDeviceMetricsOverride', {width: 1262, height: 894, deviceScaleFactor: 1, mobile: false})

const associationPicker = await verifyAssociationPicker()

// 删除正常保存：只有固定高度的保存状态，不出现草稿条。
await bootDemo()
await bring('.panel-shell.domain-weekly .row-icon.danger')
await deferDemoSave()
await page.evaluate(() => { window.confirm = () => true; document.querySelector('.panel-shell.domain-weekly .row-icon.danger')?.click() })
const deleteDuringSave = await inspect()
await page.waitForFunction(() => typeof window.__releaseDemoSave === 'function', undefined, {timeout: 3000})
await page.evaluate(() => window.__releaseDemoSave())
await page.waitForTimeout(500)
const deleteAfter = await inspect()

// 周期范围与长列表窗口：滚轮能抵达起止日。
await bootDemo()
const initial = await inspect()
const top = await scrollDaily(-5000)
const bottom = await scrollDaily(5000)

await bring('button[aria-label="编辑周期"]')
await page.evaluate(() => document.querySelector('button[aria-label="编辑周期"]')?.click())
await page.waitForSelector('.dialog input[type="date"]', {state: 'visible'})
await setDateInputs('2026-01-01', '2026-04-30')
await page.click('.dialog button[type="submit"]', {label: '保存长周期'})
await page.waitForSelector('.dialog-form', {state: 'hidden'})
await page.waitForTimeout(700)
const longRange = await inspect()
const longTop = await scrollDaily(-5000)
const longBottom = await scrollDaily(5000)

// 失败的周期范围编辑后丢弃：选中日期恢复到旧范围。
await page.evaluate(() => {
  const original = navigator.locks?.request?.bind(navigator.locks)
  if (!original) throw new Error('Web Locks API unavailable')
  window.__restoreDemoLock = () => { navigator.locks.request = original }
  navigator.locks.request = () => Promise.reject(new Error('intentional regression failure'))
})
await bring('button[aria-label="编辑周期"]')
await page.evaluate(() => document.querySelector('button[aria-label="编辑周期"]')?.click())
await page.waitForSelector('.dialog input[type="date"]', {state: 'visible'})
await setDateInputs('2026-12-10', '2026-12-12')
await page.click('.dialog button[type="submit"]', {label: '提交失败周期'})
await page.waitForSelector('.draft-notice', {state: 'visible'})
const failedRange = await inspect()
await page.evaluate(() => window.__restoreDemoLock())
await page.evaluate(() => document.querySelector('.draft-notice .muted-action')?.click())
await page.waitForFunction(() => !document.querySelector('.draft-notice'), undefined, {timeout: 5000})
const restoredRange = await inspect()

// 异步新增周期后，保存确认不能把选择切回旧周期。
await bootDemo()
await deferDemoSave()
await bring('.panel-shell.domain-long .rail-add')
await page.evaluate(() => document.querySelector('.panel-shell.domain-long .rail-add')?.click())
await page.waitForSelector('#cycle-name', {state: 'visible'})
await page.fill('#cycle-name', '周期 B')
await setDateInputs('2026-11-01', '2026-12-02')
await page.click('.dialog button[type="submit"]', {label: '保存第二周期'})
await page.waitForSelector('.dialog-form', {state: 'hidden'})
const selectedDuringSave = await inspect()
await page.waitForFunction(() => typeof window.__releaseDemoSave === 'function', undefined, {timeout: 3000})
await page.evaluate(() => window.__releaseDemoSave())
await page.waitForTimeout(700)
const selectedAfterSave = await inspect()

// 直接删除冲突：保留操作描述，加载最新前必须确认。
await bootDemo()
await deferDemoSave()
await page.evaluate(() => { window.confirm = () => true; document.querySelector('.panel-shell.domain-weekly .row-icon.danger')?.click() })
await page.waitForFunction(() => typeof window.__releaseDemoSave === 'function', undefined, {timeout: 3000})
await page.evaluate(async () => {
  const key = 'liubai-taskboard:demo-board:v1'
  const board = JSON.parse(localStorage.getItem(key))
  const task = board.snapshot.tasks.find((item) => item.domain === 'weekly' && !item.archivedAt)
  task.title += ' · remote edit'
  board.revision += 1
  localStorage.setItem(key, JSON.stringify(board))
  await window.__releaseDemoSave()
})
await page.waitForSelector('.save-notice', {state: 'visible', timeout: 5000})
const conflict = await page.evaluate(() => ({
  operation: document.querySelector('.save-operation')?.textContent.trim() || null,
  buttons: [...document.querySelectorAll('.save-notice .text-button')].map((button) => button.textContent.trim()),
  draft: Boolean(document.querySelector('.draft-notice')),
}))
await page.evaluate(() => { window.__confirmResult = false; window.confirm = () => window.__confirmResult })
await page.evaluate(() => document.querySelector('.save-notice .text-button')?.click())
await page.waitForTimeout(200)
const conflictKept = await page.evaluate(() => Boolean(document.querySelector('.save-notice')))
await page.evaluate(() => { window.__confirmResult = true })
await page.evaluate(() => document.querySelector('.save-notice .text-button')?.click())
await page.waitForFunction(() => !document.querySelector('.save-notice'), undefined, {timeout: 5000})
const conflictDiscarded = await page.evaluate(() => ({
  title: JSON.parse(localStorage.getItem('liubai-taskboard:demo-board:v1')).snapshot.tasks.find((item) => item.domain === 'weekly')?.title || null,
  notice: Boolean(document.querySelector('.save-notice')),
}))

console.log(JSON.stringify({associationPicker, deleteDuringSave, deleteAfter, initial, top, bottom, longRange, longTop, longBottom, failedRange, restoredRange, selectedDuringSave, selectedAfterSave, conflict, conflictKept, conflictDiscarded}, null, 1))

const checks = {
  associationPickerKeepsFocus: associationPicker.focusedBefore.role === 'option' && associationPicker.focusedAfter.role === 'option' && associationPicker.focusedAfter.id !== 'task-title',
  associationPickerEscapeRestores: associationPicker.afterFirstEscape.id === 'task-association' && associationPicker.restoredFocus.className === associationPicker.opener.className,
  associationPickerBlocksWorkspaceKeys: associationPicker.scrollBeforeDialogKey === associationPicker.scrollAfterDialogKey,
  associationPickerIsInApp: !associationPicker.choice.hasNativeAssociationSelect,
  associationPickerPersists: Boolean(associationPicker.saved.upperTaskId),
  deleteNoDraftDuringSave: !deleteDuringSave.draft,
  deleteNoDraftAfterSave: !deleteAfter.draft,
  initialShortWindow: initial.weeks === 5 && initial.days < 31,
  initialScrollable: Boolean(initial.range?.classed) && initial.range.clientHeight <= 480 && initial.range.scrollHeight > initial.range.clientHeight,
  nativeTopEndpoint: Boolean(top.dayFirst?.includes('09-01')),
  nativeBottomEndpoint: Boolean(bottom.dayLast?.includes('10-01')),
  longWindow: longRange.days < 120 && Boolean(longRange.range?.classed) && longRange.range.clientHeight <= 480 && longRange.range.scrollHeight > longRange.range.clientHeight && Boolean(longTop.dayFirst?.includes('01-01')) && Boolean(longBottom.dayLast?.includes('04-30')),
  failedRangeUsesBaseline: failedRange.cycle?.startDate === '2026-01-01' && failedRange.dayFirst?.includes('12-10') && failedRange.selectedDay === '周四12-10',
  restoredRangeSelection: restoredRange.cycle?.startDate === '2026-01-01' && restoredRange.selectedDay === '周四04-30',
  asyncSelectionDuringSave: Boolean(selectedDuringSave.cycleLabel?.includes('周期 B')),
  asyncSelectionAfterSave: Boolean(selectedAfterSave.cycleLabel?.includes('周期 B')),
  directConflictDescription: Boolean(conflict.operation?.includes('删除')),
  directConflictRecovery: !conflict.draft && conflict.buttons.includes('加载最新') && !conflict.buttons.includes('重新打开编辑器') && conflictKept,
  directConflictDiscarded: Boolean(conflictDiscarded.title?.includes('remote edit')) && !conflictDiscarded.notice,
}
console.log('checks:', JSON.stringify(checks))
const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
if (failedChecks.length) { console.error('failed checks:', failedChecks.join(', ')); process.exit(1) }
console.log('regression checks passed')
await page.cdp('Emulation.clearDeviceMetricsOverride')
