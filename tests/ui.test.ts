import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

// UI 契约测试：这两条是页面结构约定，无法用纯函数断言，因此直接检查渲染源码。
const appSource = async () => readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const cssSource = async () => readFile(new URL('../src/styles.css', import.meta.url), 'utf8')

test('the week rail shows the week start as MM-DD and highlights the week containing today', async () => {
  const source = await appSource()
  // 周轨道的第二行日期必须与日轨道一致使用 MM-DD（slice(5)），而不是本地化的长日期
  assert.match(source, /<small>\{weekRange\(key\)\.start\.slice\(5\)\}<\/small>/, 'week rail must render the start date as MM-DD')
  assert.doesNotMatch(source, /<small>\{formatDateKey\(weekRange\(key\)\.start/, 'week rail must not use the localized long date')
  // 本周：与选中的周比较的是“今天所在周”，而不是“当前查看的周”
  assert.match(source, /const currentWeekKey = weekKey\(todayKey\)/, 'the rail must compare against the week of today')
  assert.match(source, /const isCurrent = key === currentWeek/, 'week rail must mark the week containing today')
  assert.match(source, /currentWeek=\{currentWeekKey\}/, 'the week rail must receive the current week')
})

test('the day rail highlights today, separately from the day being viewed', async () => {
  const source = await appSource()
  assert.match(source, /const todayKey = todayInTimeZone\(currentZone\)/, 'the app must derive today once from the configured time zone')
  assert.match(source, /const isToday = date === todayKey/, 'day rail must mark the date that is today')
  assert.match(source, /todayKey=\{todayKey\}/, 'the day rail must receive today')
  // 选中态与“今天”必须落在不同的 class 上，否则用户无法区分“今天”和“正在查看”
  assert.match(source, /selectedDate === date \? 'selected' : ''} \$\{isToday \? 'is-current' : ''\}/, 'today must not reuse the selected class')
  assert.match(source, /selectedWeek === key \? 'selected' : ''} \$\{isCurrent \? 'is-current' : ''\}/, 'current week must not reuse the selected class')
})

test('the current-week and current-day markers are styled and announced accessibly', async () => {
  const css = await cssSource()
  assert.match(css, /\.rail-item\.is-current\b/, 'is-current needs a style of its own')
  assert.match(css, /\.current-mark\b/, 'the marker dot needs a style')
  const source = await appSource()
  // 屏幕阅读器要能分辨“今天”，而不是只靠颜色
  assert.match(source, /aria-label=\{isToday \? `\$\{label\} \$\{date\.slice\(8\)\} · \$\{t\('currentDay'\)\}`/, 'today must be announced')
  assert.match(source, /aria-label=\{isCurrent \? `\$\{key\.slice\(5\)\} · \$\{t\('currentWeek'\)\}`/, 'the current week must be announced')
})
