// 独立 LOCAL DEMO；只重置测试端口的演示板，不访问云端或 .env.local。
// VITE_SUPABASE_URL= VITE_SUPABASE_PUBLISHABLE_KEY= VITE_SUPABASE_ANON_KEY= pnpm exec vite --host 127.0.0.1 --port 5238 --strictPort
// EGO_TASK_SPACE_ID=<已有空间，可省略> ego-browser nodejs < scripts/verify-wrapping.mjs
const assert = (await import('node:assert/strict')).default
const task = await taskSpace(process.env.EGO_TASK_SPACE_ID ? Number(process.env.EGO_TASK_SPACE_ID) : 'verify taskboard text wrapping')
console.log({ spaceId: task.spaceId })
const page = task.page('p1')
const key = 'liubai-taskboard:demo-board:v1'
const root = '[data-task-id="wrap-root"]'
const child = '[data-task-id="wrap-child"]'
const settled = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const stored = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), key)
async function openDemo() {
  await page.click("loc=role:button[name*='LOCAL DEMO']")
  await page.waitForSelector('.domain-weekly .task-row')
}
async function saveText(title, note) {
  const revision = (await stored()).revision
  await page.click(`${root} > .task-title`)
  await page.fill('#task-title', title)
  await page.fill('.dialog textarea', note)
  await page.click('.dialog button[type="submit"]')
  await page.waitForSelector('.dialog', { state: 'hidden' })
  await page.waitForFunction(({ key, revision }) => JSON.parse(localStorage.getItem(key)).revision === revision + 1, { key, revision })
  await settled()
}
async function inspect() {
  return page.evaluate(() => {
    const columns = [...document.querySelectorAll('.panel-shell')].map((el) => el.getBoundingClientRect().width)
    const fields = [...document.querySelectorAll('.domain-weekly .task-title > span, .domain-weekly .task-title > small')].map((el) => {
      const text = el.firstChild
      const rect = el.getBoundingClientRect()
      const parent = el.closest('.task-row').getBoundingClientRect()
      const style = getComputedStyle(el)
      const starts = []
      const lines = new Set()
      const visibleLines = new Set()
      // 测量字形位置与裁剪区域，区分已保存的完整文本和实际可见的预览行。
      for (let index = 0; index < text.length; index++) {
        const char = text.textContent[index]
        if (/\s/.test(char)) continue
        const range = document.createRange()
        range.setStart(text, index)
        range.setEnd(text, index + 1)
        const glyph = range.getBoundingClientRect()
        lines.add(Math.round(glyph.top))
        if (glyph.top >= rect.top - 2 && glyph.bottom <= rect.bottom + 3) visibleLines.add(Math.round(glyph.top))
        if (index === 0 || text.textContent[index - 1] === '\n') starts.push(glyph.top)
      }
      return { id: el.closest('.task-row').dataset.taskId, kind: el.tagName, chars: text.length, lines: lines.size, visibleLines: visibleLines.size, starts,
        height: rect.height, lineHeight: parseFloat(style.lineHeight), whiteSpace: style.whiteSpace,
        overflow: rect.left < parent.left - 1 || rect.right > parent.right + 1 || rect.bottom > parent.bottom + 2, clamp: style.webkitLineClamp }
    })
    const stage = document.querySelector('.workspace-stage')
    return { viewport: innerWidth, columns, stage: stage.getBoundingClientRect().width, fields }
  })
}

await page.goto('http://127.0.0.1:5238/')
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1262, height: 894, deviceScaleFactor: 1, mobile: false })
await openDemo()
await page.evaluate((key) => {
  const board = JSON.parse(localStorage.getItem(key))
  const template = board.snapshot.tasks.find((item) => item.domain === 'weekly' && !item.parentId)
  const parent = { ...template, id: 'wrap-root', title: '本周任务', note: '短备注', upperTaskId: undefined }
  board.snapshot.tasks = [parent, { ...parent, id: 'wrap-child', title: '子任务', note: '子备注', parentId: parent.id }, { ...parent, id: 'wrap-other', title: '另一个任务' }]
  board.snapshot.focusBlocks = []
  localStorage.setItem(key, JSON.stringify(board))
  localStorage.setItem('liubai-taskboard:language:v1', 'zh')
}, key)
await page.reload()
await openDemo()
const before = await inspect()
const multiline = '第一行\n  第二行\n第三行'
await saveText('本周任务', multiline)
const after = await inspect()
console.log('manual newlines:', JSON.stringify({ before: before.columns, after: after.columns, fields: after.fields }))
const note = after.fields.find((field) => field.id === 'wrap-root' && field.kind === 'SMALL')
assert.equal(note.visibleLines, 3, 'three nonblank note lines must be visible on three different lines')
assert.ok(note.height <= 5 * note.lineHeight + 1, 'the note preview is limited to five lines')
assert.equal(note.whiteSpace, 'pre-wrap', 'preserve indentation as well as manual line breaks')
assert.deepEqual(after.columns, before.columns, 'a note must not change any panel width')
assert.equal((await stored()).snapshot.tasks[0].note, multiline)
await saveText('本周任务', '第一行\n\n第三行\n第四行\n第五行\n第六行')
const blank = (await inspect()).fields.find((field) => field.id === 'wrap-root' && field.kind === 'SMALL')
assert.equal(blank.visibleLines, 4, 'a blank line consumes a preview line; the sixth line stays hidden')
assert.ok(blank.starts[1] - blank.starts[0] >= blank.lineHeight * 2 - 1, 'the blank line must retain its height')

for (const width of [390, 850, 851, 1262, 2560]) {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width, height: 894, deviceScaleFactor: 1, mobile: width <= 850 })
  await settled()
  const baseline = await inspect()
  const results = await page.evaluate(() => {
    const fields = [...document.querySelectorAll('.domain-weekly .task-title > span, .domain-weekly .task-title > small')]
    window.__wrappingOriginalText = fields.map((el) => el.textContent)
    return fields.length
  })
  assert.ok(results >= 4)
  for (const content of ['中文', 'unbroken']) {
    await page.evaluate((content) => {
      for (const el of document.querySelectorAll('.domain-weekly .task-title > span, .domain-weekly .task-title > small')) {
        const length = el.tagName === 'SPAN' ? 450 : 3000
        el.textContent = (content === '中文' ? '长文本' : 'https://example.test/abcdef').repeat(length).slice(0, length)
      }
    }, content)
    const result = await inspect()
    assert.deepEqual(result.columns, baseline.columns, `${width}px: ${content} must not resize any column`)
    assert.ok(result.fields.every((field) => {
      const limit = field.kind === 'SPAN' ? 2 : 5
      return field.chars === (field.kind === 'SPAN' ? 450 : 3000) && field.visibleLines === limit && field.height <= limit * field.lineHeight + 1 && !field.overflow && field.clamp === String(limit)
    }), `${width}px: full-length text must stay within bounded previews: ${JSON.stringify(result.fields)}`)
    const gap = width <= 850 ? 16 : 24
    assert.ok(result.stage + 1 >= result.columns.reduce((a, b) => a + b, 0) + gap * 3, 'the stage must still enclose all four columns')
  }
  await page.evaluate(() => {
    [...document.querySelectorAll('.domain-weekly .task-title > span, .domain-weekly .task-title > small')].forEach((el, index) => { el.textContent = window.__wrappingOriginalText[index] })
    delete window.__wrappingOriginalText
  })
  console.log(`${width}px: maximum-length Chinese, URL and subtask previews passed`)
}

// 再走真实表单确认输入上限内容可以保存、刷新、重新打开；上面的排版循环不改存储。
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1262, height: 894, deviceScaleFactor: 1, mobile: false })
const maxTitle = 'T'.repeat(450)
const maxNote = `${multiline}\n${'x'.repeat(3000 - multiline.length - 1)}`
await saveText(maxTitle, maxNote)
await page.reload()
await openDemo()
const loaded = await stored()
assert.equal(loaded.snapshot.tasks[0].title, maxTitle)
assert.equal(loaded.snapshot.tasks[0].note, maxNote)
assert.ok((await inspect()).fields.every((field) => !field.overflow))
await page.click(`${root} > .task-title`)
assert.deepEqual(await page.evaluate(() => [document.querySelector('#task-title').value, document.querySelector('.dialog textarea').value]), [maxTitle, maxNote])
assert.deepEqual(await page.evaluate(() => [document.querySelector('#task-title').maxLength, document.querySelector('.dialog textarea').maxLength]), [450, 3000])
await page.keyboard.press('Escape')
await page.waitForSelector('.dialog', { state: 'hidden' })
await page.click(`${child} > .task-title`)
assert.equal(await page.evaluate(() => document.querySelector('.dialog textarea').value), '子备注')
await page.keyboard.press('Escape')
await page.waitForSelector('.dialog', { state: 'hidden' })
await page.click(`${child} > input[type="checkbox"]`)
await page.waitForFunction(({ key, revision }) => JSON.parse(localStorage.getItem(key)).revision === revision + 1, { key, revision: loaded.revision })
await page.focus(`${root} > .drag-handle`)
await page.keyboard.press('Space')
await page.waitForSelector('.task-tree.is-dragging')
await settled()
await page.keyboard.press('ArrowDown')
await settled()
await page.keyboard.press('Space')
await page.waitForFunction(({ key, revision }) => JSON.parse(localStorage.getItem(key)).revision === revision + 2, { key, revision: loaded.revision })
assert.deepEqual((await stored()).snapshot.tasks.filter((item) => !item.parentId).map((item) => item.id), ['wrap-other', 'wrap-root'])
assert.equal((await stored()).snapshot.tasks.find((item) => item.id === 'wrap-root').note, maxNote)
await page.focus(`${root} > .drag-handle`)
await page.keyboard.press('Space')
await page.waitForSelector('.task-tree.is-dragging')
await settled()
await page.keyboard.press('ArrowUp')
await settled()
await page.keyboard.press('Space')
await page.waitForFunction(({ key, revision }) => JSON.parse(localStorage.getItem(key)).revision === revision + 3, { key, revision: loaded.revision })
assert.deepEqual((await stored()).snapshot.tasks.filter((item) => !item.parentId).map((item) => item.id), ['wrap-root', 'wrap-other'])
console.log('maximum-length card drag + checkbox interaction passed')
await page.cdp('Emulation.clearDeviceMetricsOverride')
console.log('wrapping regression checks passed')
