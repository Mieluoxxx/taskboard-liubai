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

test('the logo is a single inline SVG mark reused in the page and as the favicon', async () => {
  const source = await appSource()
  // 品牌标记必须是内联 SVG（可随尺寸缩放、无额外请求），且对屏幕阅读器隐藏（品牌名由文字承担）
  assert.match(source, /function BrandMark\(\)/, 'a BrandMark component must exist')
  assert.match(source, /className="brand-mark"[\s\S]{0,200}aria-hidden="true"/, 'the mark must be decorative for assistive tech')
  assert.match(source, /viewBox="0 0 32 32"/, 'the mark must be scalable')
  // 旧的字母占位符不应再出现
  assert.doesNotMatch(source, /<span className="brand-mark">l<\/span>/, 'the letter placeholder must be gone')
  // 三根递降柱 + 一个暖橙点，与 favicon.svg 同形
  const svg = await readFile(new URL('../public/favicon.svg', import.meta.url), 'utf8')
  for (const shape of ['<rect', '<circle']) assert.ok(svg.includes(shape), `favicon must draw ${shape}`)
  assert.equal((svg.match(/<rect/g) || []).length, 4, 'favicon = background + three bars')
  assert.equal((svg.match(/<circle/g) || []).length, 1, 'favicon = exactly one focus dot')
  // favicon 必须被 index.html 引用，否则浏览器标签页没有图标
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/, 'index.html must link the favicon')
})

test('fonts are self-hosted Maple Mono CN, preloaded in core-only size and lazily tiered', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  const critical = await readFile(new URL('../src/fonts.css', import.meta.url), 'utf8')
  const lazy = await readFile(new URL('../public/fonts/maple-mono-cn/fonts-lazy.css', import.meta.url), 'utf8')
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')

  // 自托管：不请求任何第三方字体 CDN
  assert.doesNotMatch(html + critical + lazy + styles, /fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg\.com/, 'fonts must be self-hosted')

  // 只有 core（界面必需）被预加载，且字体预加载必须带 crossorigin（否则会被丢弃并重复请求）
  const preloads = [...html.matchAll(/<link rel="preload"[^>]*as="font"[^>]*>/g)].map(([tag]) => tag)
  assert.equal(preloads.length, 2, 'exactly the two core faces should be preloaded')
  for (const tag of preloads) {
    assert.match(tag, /core-\d00\.woff2/, `only core faces may be preloaded, saw ${tag}`)
    assert.match(tag, /crossorigin/, `font preload needs crossorigin: ${tag}`)
  }
  assert.doesNotMatch(html, /preload[^>]*(common|tail|nerd)-/, 'large tiers must not be preloaded')

  // 大分片走异步样式表，不阻塞渲染
  assert.match(html, /<link rel="stylesheet" href="\/fonts\/maple-mono-cn\/fonts-lazy\.css" media="print" onload="this\.media='all'"/, 'lazy tiers must load asynchronously')
  assert.match(html, /<noscript><link rel="stylesheet" href="\/fonts\/maple-mono-cn\/fonts-lazy\.css" \/><\/noscript>/, 'lazy tiers need a noscript fallback')

  // 关键 CSS 只包含 core，体积必须保持很小（它是阻塞渲染的）
  assert.ok(critical.length < 20_000, `critical font CSS must stay small, got ${critical.length} bytes`)
  assert.doesNotMatch(critical, /(common|tail|nerd)-\d00\.woff2/, 'critical CSS must only reference core faces')
  for (const tier of ['common', 'tail', 'nerd']) {
    assert.match(lazy, new RegExp(`${tier}-400\\.woff2`), `${tier} tier must be declared lazily`)
    assert.match(lazy, new RegExp(`${tier}-600\\.woff2`), `${tier} tier must cover the 600 weight too`)
  }

  // 每个 @font-face 都必须带 unicode-range，否则浏览器会整片无条件下载
  for (const css of [critical, lazy]) {
    const faces = css.split('@font-face').slice(1)
    assert.ok(faces.length > 0, 'expected @font-face blocks')
    for (const block of faces) assert.match(block, /unicode-range:/, 'every face needs unicode-range')
  }

  // 界面本身必须使用该字体族
  assert.match(styles, /font-family: "Maple Mono CN"/, 'the app must actually use the font')
  assert.match(styles, /font: \d+ \d+px[^;]*"Maple Mono CN"/, 'shorthand font declarations must use it too')
  // 且必须声明许可（OFL 要求随字体分发许可文本）
  await readFile(new URL('../public/fonts/LICENSE-maple-mono.txt', import.meta.url), 'utf8')
})

test('each panel offers exactly one add entry, so no action is duplicated', async () => {
  const source = await appSource()
  // 周与日是固定的日历周期，不存在“新建周/新建日”：它们的周期轨道上不能有添加按钮，
  // 否则会与面板自身的「添加任务」重复（同一动作两个入口）。
  const weekRail = source.slice(source.indexOf('function WeekRail'), source.indexOf('function DayRail'))
  const dayRail = source.slice(source.indexOf('function DayRail'), source.indexOf('function PastSuggestions'))
  assert.doesNotMatch(weekRail, /rail-add/, 'the week rail must not offer an add button')
  assert.doesNotMatch(dayRail, /rail-add/, 'the day rail must not offer an add button')
  assert.doesNotMatch(weekRail, /onAdd/, 'WeekRail should not even accept an onAdd prop')
  assert.doesNotMatch(dayRail, /onAdd/, 'DayRail should not even accept an onAdd prop')

  // 周期轨道保留「新周期」——它是另一件事（新建周期），不是重复的添加任务
  const cycleRail = source.slice(source.indexOf('function CycleRail'), source.indexOf('function WeekRail'))
  assert.match(cycleRail, /rail-add/, 'the cycle rail keeps its own "new cycle" action')
  assert.match(cycleRail, /addCycle/, 'and that action is labelled as creating a cycle')

  // 四个面板都仍然各有唯一的添加入口
  for (const domain of ['long', 'weekly', 'daily']) {
    const calls = source.match(new RegExp(`onAdd=\\{\\(\\) => setDialog\\(\\{ kind: 'task', domain: '${domain}'`, 'g')) || []
    assert.equal(calls.length, 1, `${domain} panel must have exactly one add action, saw ${calls.length}`)
  }
  const focusCalls = source.match(/onAdd=\{\(\) => setDialog\(\{ kind: 'focus' \}\)\}/g) || []
  assert.equal(focusCalls.length, 1, `the focus panel must have exactly one add action, saw ${focusCalls.length}`)
  // 调用处不得再给周/日轨道传 onAdd
  assert.doesNotMatch(source, /<WeekRail[^>]*onAdd=/, 'WeekRail call site must not pass onAdd')
  assert.equal((source.match(/<DayRail[^>]*onAdd=/g) || []).length, 0, 'DayRail call sites must not pass onAdd')
})
