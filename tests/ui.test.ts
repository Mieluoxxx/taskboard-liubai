import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

// UI 契约测试：这两条是页面结构约定，无法用纯函数断言，因此直接检查渲染源码。
const appSource = async () => readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const cssSource = async () => readFile(new URL('../src/styles.css', import.meta.url), 'utf8')

test('task previews wrap with bounded lines and open the editor for full content', async () => {
  const css = await cssSource()
  assert.match(css, /\.workspace-stage \{[^}]*min-width: calc\(4 \* 520px \+ 3 \* 24px\)/)
  assert.match(css, /\.task-title span \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/)
  assert.match(css, /\.task-title small \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/)
  for (const [rule] of css.matchAll(/\.task-title (?:span|small) \{[^}]*\}/g)) {
    assert.doesNotMatch(rule, /white-space: nowrap/, 'previews must wrap instead of collapsing every line')
  }
  assert.match(css, /\.task-title span \{[^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden;/)
  assert.match(css, /\.task-title small \{[^}]*-webkit-line-clamp: 5;[^}]*overflow: hidden;/)
  const mobile = css.slice(css.indexOf('@media (max-width: 850px) {'))
  assert.match(mobile, /\.workspace-stage \{[^}]*min-width: max-content;/, 'fixed viewport tracks must not inherit the desktop stage minimum')
  assert.match(await appSource(), /className="task-title" onClick=\{\(\) => \{ onSelect\(task.id\); onEdit\(task\) \}\}/, 'clicking a preview must open the existing editor')
  assert.match(await appSource(), /maxLength=\{MAX_TASK_TITLE_LENGTH\}/)
  assert.match(await appSource(), /maxLength=\{MAX_TASK_NOTE_LENGTH\}/)
})

test('the week rail shows the week start as MM-DD and highlights the week containing today', async () => {
  const source = await appSource()
  // 周轨道的第二行日期必须与日轨道一致使用 MM-DD（slice(5)），而不是本地化的长日期
  assert.match(source, /start: weekRange\(key\)\.start\.slice\(5\)/, 'week rail must render the start date as MM-DD')
  assert.doesNotMatch(source, /<small>\{formatDateKey\(weekRange\(key\)\.start/, 'week rail must not use the localized long date')
  // 本周：与选中的周比较的是“今天所在周”，而不是“当前查看的周”
  assert.match(source, /const currentWeekKey = weekKey\(todayKey\)/, 'the rail must compare against the week of today')
  assert.match(source, /isCurrent: key === currentWeek/, 'week rail must mark the week containing today')
  assert.match(source, /currentWeek=\{currentWeekKey\}/, 'the week rail must receive the current week')
})

test('the day rail highlights today, separately from the day being viewed', async () => {
  const source = await appSource()
  assert.match(source, /const todayKey = todayInTimeZone\(currentZone\)/, 'the app must derive today once from the configured time zone')
  assert.match(source, /isToday: date === todayKey/, 'day rail must mark the date that is today')
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
  assert.match(source, /aria-label=\{isToday \? `\$\{label\} \$\{date\.slice\(5\)\} · \$\{t\('currentDay'\)\}`/, 'today must be announced')
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

test('task marker colors use visual native radio swatches instead of text-only select options', async () => {
  const source = await appSource()
  const css = await cssSource()
  assert.match(source, /<fieldset className="color-field">/, 'color choices need a labelled fieldset')
  assert.match(source, /type="radio" name="task-color"/, 'color choices must remain keyboard-accessible native radios')
  assert.doesNotMatch(source, /<select value=\{color\}/, 'marker colors must not be a text-only select')
  for (const color of ['ink', 'blue', 'orange', 'green', 'violet']) {
    assert.match(source, new RegExp(`'${color}', 'color`), `${color} needs a visual swatch`)
  }
  assert.match(css, /\.color-swatch \{[^}]*width: 32px;[^}]*height: 32px;[^}]*border-radius: 50%/, 'swatches must be circular')
  assert.match(css, /\.dialog-form \.color-choice \{[^}]*width: 44px;[^}]*height: 44px;/, 'swatches need touch-sized hit targets')
  assert.match(css, /\.color-choice input:checked \+ \.color-swatch/, 'selected color needs a visible ring')
  assert.match(css, /\.color-choice input:focus-visible \+ \.color-swatch/, 'keyboard focus needs a visible outline')
})

test('the rails stay list-only while "back to this week / today" lives in the panel header', async () => {
  const source = await appSource()
  const css = await cssSource()
  const weekRail = source.slice(source.indexOf('function WeekRail'), source.indexOf('function DayRail'))
  const dayRail = source.slice(source.indexOf('function DayRail'), source.indexOf('function ReturnToCurrent'))

  // 设计：跳转不再占轨道底部，轨道只负责列表，也不再接收跳转回调。
  assert.doesNotMatch(weekRail, /rail-return|onGoCurrent/, 'the week rail must not host the back control anymore')
  assert.doesNotMatch(dayRail, /rail-return|onGoToday/, 'the day rail must not host the back control anymore')

  // 跳转是面板头部下方右对齐的胶囊：当前圆点 + 返回箭头 + 短标签，完整语义由 aria-label 承担。
  const control = source.slice(source.indexOf('function ReturnToCurrent'), source.indexOf('function SortableTaskList'))
  assert.match(control, /<div className="panel-current"><button className="current-return" onClick=\{onClick\} aria-label=\{hint\} title=\{hint\}>/, 'the control must be an announced chip')
  assert.match(control, /<i className="current-mark" aria-hidden="true" \/><Icon name="back" \/>\{label\}/, 'the chip pairs the current dot with the back arrow')
  assert.match(source, /const goCurrentWeek = canGoCurrentWeek && selectedWeek !== currentWeekKey \? <ReturnToCurrent label=\{t\('thisWeek'\)\} hint=\{t\('backToCurrentWeek'\)\}/, 'the week chip only appears when off the current week')
  assert.match(source, /const goToday = canGoToday && selectedDate !== todayKey \? <ReturnToCurrent label=\{t\('today'\)\} hint=\{t\('backToCurrentDay'\)\}/, 'the day chip only appears when off today')
  assert.match(source, /const canGoCurrentWeek = !selectedCycle \|\| \(currentWeekKey >= weekKey\(selectedCycle\.startDate\) && currentWeekKey <= weekKey\(selectedCycle\.endDate\)\)/, 'the week chip needs the cycle-aware range check')
  assert.match(source, /const canGoToday = !selectedCycle \|\| dateInRange\(todayKey, selectedCycle\.startDate, selectedCycle\.endDate\)/, 'the day chip needs the cycle-aware range check')

  // 渲染位置：面板头部之后、内容之前；TasksPanel 与 FocusPanel 都接 currentAction。
  assert.match(source, /currentAction\?: React\.ReactNode/, 'panels take the chip through a prop')
  assert.match(source, /\{t\('addTask'\)\}<\/button><\/div>\n      \{currentAction\}/, 'the chip row sits right under the panel header')
  assert.equal((source.match(/<DayRail /g) || []).length, 2, 'both day rails (daily and focus) stay in place')
  assert.equal((source.match(/currentAction=\{goToday\}/g) || []).length, 2, 'both day panels must offer back-to-today')
  assert.equal((source.match(/currentAction=\{goCurrentWeek\}/g) || []).length, 1, 'the week panel must offer back-to-this-week')

  assert.match(css, /\.panel-current \{ display: flex; justify-content: flex-end; padding-top: 16px; \}/, 'the chip row must be right-aligned under the header')
  assert.match(css, /\.current-return \{[^}]*border: 1px solid #e7dcd4;[^}]*background: #fffaf6;/, 'the chip keeps the warm current-period tint from the design')
  assert.match(css, /\.current-return \.current-mark \{ margin-left: 0; \}/, 'the dot inside the chip must not inherit the rail offset')
  assert.match(css, /\.focus-panel \.current-return \{[^}]*background: rgba\(255,255,255,\.06\);/, 'the chip needs a dark-panel variant')
  assert.doesNotMatch(css, /\.rail-return\b/, 'the old rail-bottom control is gone')
})

test('unfinished weekly tasks are carried forward automatically, without a confirm bar', async () => {
  const source = await appSource()
  const css = await cssSource()
  // 不再有顶部确认条：组件、样式与 i18n 键一起删除，加载时直接顺延。
  assert.doesNotMatch(source, /PastSuggestions/, 'the top suggestion bar is gone')
  assert.doesNotMatch(css, /\.past-suggestions\b/, 'the bar styles are gone')
  assert.doesNotMatch(source, /pastHint|weeklyPastHint/, 'the bar hint keys are gone')
  assert.match(source, /carryForwardTasks\(loadedSnapshot, todayInTimeZone\(loadedSnapshot\.settings\.timeZone\)\)/, 'loading must carry past weekly tasks forward')
  assert.match(source, /if \(carried !== loadedSnapshot\) commitRef\.current\?\.\(carried, null\)/, 'the carry is committed through the normal CAS path only when something moved')
  assert.match(source, /const commitRef = useRef<\(\(next: BoardSnapshot, draft: string \| null\) => boolean\) \| null>\(null\)/, 'openBoard reaches the commit entry point through a ref')

  // 日任务仍保留手动入口：面板提示 + 行内按钮 + 同一个顺延对话框。
  assert.match(source, /function isPastPlacement\(task: Task, timeZone: string\)/, 'past detection must be shared between domains')
  assert.match(source, /task\.domain === 'weekly'\) return \{ value: weekKey\(addDays\(weekRange[\s\S]{0,80}kind: 'week'/, 'weekly rescheduling must default to the following week')
  assert.match(source, /task\.domain === 'weekly' \? rescheduleWeeklyTask\(current, task\.id, target\) : rescheduleDailyTask\(current, task\.id, target\)/, 'the shared dialog must dispatch by domain')
  assert.match(source, /onAddSubtask=\{\(task\) => setDialog\(\{ kind: 'task', domain: 'weekly', parentId: task\.id \}\)\} onReschedule=/, 'weekly rows need the reschedule action')

  // 顺延标签：从归档条目的 rescheduledTo 反查来源周期，不需要新增快照字段。
  assert.match(source, /function carriedFromLabels\(snapshot: BoardSnapshot\): Map<string, string>/, 'carry tags must be derived from the archive pointers')
  assert.match(source, /if \(task\.archivedReason !== 'rescheduled' \|\| !task\.rescheduledTo\) continue/, 'only rescheduled archive entries name a source')
  assert.match(source, /const placement = task\.domain === 'weekly' \? task\.weekKey : task\.dateKey/, 'the source label is the domain placement key')
  assert.match(source, /const carrySource = carriedFromLabels\(snapshot\)/, 'the panel must build the lookup once')
  assert.match(source, /className="carry-tag"/, 'the tag needs its own styleable element')
  assert.match(source, /title=\{`\$\{t\('carriedFrom'\)\} \$\{carriedFrom\}`\}/, 'the tag explains itself on hover')
  assert.match(source, /\{carriedFrom\.slice\(5\)\}/, 'the tag shows the compact MM-DD or Wnn form')
  assert.match(source, /onReschedule=\{onReschedule\} carrySource=\{carrySource\} /, 'carry sources must reach both task rows')
  assert.match(css, /\.carry-tag \{[^}]*flex: 0 0 auto;[^}]*white-space: nowrap;/, 'the tag must not be squeezed into a vertical column')

  // 窄屏下“建议重新安排”不得与标题争宽：title 的 flex-basis 必须为 0（basis auto 会被长标题
  // 按 max-content 换行），并用零高度断行点把按钮区推到第二行。
  assert.match(css, /\.task-row \{[^}]*flex-wrap: wrap;[^}]*row-gap: 0;/, 'rows must be able to wrap so the action area can take its own line')
  assert.match(css, /\.task-title \{[^}]*flex: 1 1 0;/, 'a zero basis keeps the title on the first line instead of being pushed by its own max-content width')
  assert.match(css, /\.row-break \{ display: block; flex: 0 0 100%; height: 0; \}/, 'the zero-height break element is what starts the action line')
  assert.match(css, /@media \(min-width: 851px\) \{\s*\.row-break \{ display: none; \}\s*\.row-actions \{ position: absolute;[^}]*\}/, 'wide screens keep one line by floating the action buttons')
  assert.match(source, /<span className="row-break" aria-hidden="true" \/>/, 'the break element must stay out of the accessibility tree')

  // 专注块面板与卡片：网格项 min-width: auto 会被 nowrap 内容撑开，卡片会溢出深色面板。
  assert.match(css, /\.focus-panel \{[^}]*min-width: 0;/, 'the focus panel must not be sized by its nowrap content')
  assert.match(css, /\.focus-list \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/, 'the focus list needs an explicit shrinkable column')
  assert.match(css, /\.focus-subtasks \{ display: grid; min-width: 0;/, 'subtask rows must be able to ellipsize inside the card')
  assert.match(css, /\.paper-panel, \.focus-panel \{[^}]*\}\.focus-time span \{ font-size: 20px; \}/, 'the big timer readout must shrink on narrow screens')
  // 回到本周/今天：浅灰描边与其余小部件一致，暖色只留给“当前”标记。
  assert.match(css, /\.current-return \{[^}]*white-space: nowrap;/, 'the chip label must stay on one line')
})

test('direct mutations do not flash a form-draft banner during a normal save', async () => {
  const source = await appSource()
  // 删除、勾选、排序、计时等直接操作仍走 CAS，但不应把表单草稿提示条当作“保存中”指示器。
  assert.match(source, /draftLabel && canReopenDraft && \(saveState === 'error' \|\| saveState === 'offline'\)/, 'draft banner must only appear for failed/offline form saves')
  assert.match(source, /const canReopenDraft = failedOrigin\?\.kind === 'task'/, 'only form-origin failures may reopen an editor')
  assert.match(source, /failureKind === 'conflict' && failedJobRef\.current && !canReopenDraft/, 'direct conflicts need load-latest recovery, not a fake editor')
  assert.match(source, /if \(window\.confirm\(t\('confirmDiscardDirect'\)\)\) void reloadLatest\(false\)/, 'discarding a direct conflict must be confirmed')
  assert.match(source, /failedJobRef\.current\?\.draft && !canReopenDraft/, 'direct failures must identify the operation without calling it a form draft')
  assert.match(source, /const selectionRef = useRef<SelectionState>/, 'async saves need a synchronous latest-selection ref')
  assert.match(source, /const cycleDraftDiscarded = !keepDraft && \(failedJobRef\.current\?\.origin\?\.kind === 'cycle'/, 'discarding a failed cycle edit must force selection normalization')
})

test('task association uses an in-app listbox instead of the native select popup', async () => {
  const source = await appSource()
  const css = await cssSource()
  assert.match(source, /function TaskChoice\(/, 'task choices need an application component')
  assert.match(source, /role="listbox"/, 'task choices need an accessible listbox')
  assert.match(source, /role="option"/, 'task choices need accessible options')
  assert.match(source, /<TaskChoice id="task-association"/, 'association must use the in-app choice component')
  assert.doesNotMatch(source, /<select value=\{upperTaskId\}/, 'association must not use the native select popup')
  assert.match(css, /\.choice-menu\s*\{/, 'the listbox needs application styling')
  assert.match(css, /\.choice-option\.selected\s*\{/, 'the selected option needs application styling')
})

test('dialog initial focus runs once while the keyboard handler tracks the latest close callback', async () => {
  const source = await appSource()
  assert.match(source, /const onCloseRef = useRef\(onClose\)/, 'dialog close handling needs a stable callback ref')
  assert.match(source, /const previousFocus = document\.activeElement/, 'dialog must remember the opener for focus restoration')
  assert.match(source, /return \(\) => \{ if \(previousFocus\?\.isConnected\) previousFocus\.focus\(\) \}/, 'dialog must restore focus on close')
  assert.match(source, /\}, \[\]\)\n  const onKeyDown/, 'initial focus must not rerun on parent rerenders')
  assert.match(source, /onKeyDown=\{onKeyDown\}/, 'keyboard handling must stay on the dialog')
})


test('cycle duration scopes the week and day rails', async () => {
  const source = await appSource()
  assert.match(source, /weekKeysInRange/, 'the week rail must derive weeks from the cycle range')
  assert.match(source, /dateKeysInRange/, 'the day rail must derive dates from the cycle range')
  assert.match(source, /cycle=\{selectedCycle\}/g, 'all calendar rails must receive the selected cycle')
  assert.match(source, /const selection = selectionForSnapshot\(nextSnapshot, preferredCycleId, preferredDate\)/, 'selection normalization must use one cycle-aware helper')
  assert.match(source, /const selectCycle = \(cycleId: string\) => reconcileSelection\(snapshot, cycleId, selectionRef\.current\.date\)/, 'switching cycles must preserve or clamp the selected date')
  assert.match(source, /const date = dateForWeek\(key, selectedCycle, selectionRef\.current\.date\)/, 'selecting a week must choose an in-range date')
  assert.match(source, /const virtual = items\.length > RAIL_VIRTUAL_THRESHOLD/, 'long ranges must use a render window')
  assert.match(source, /visible: items\.slice\(start, end\)/, 'the render window must preserve scrollable endpoints with spacers')
  assert.match(source, /<div className="rail-spacer" style=\{\{ height: windowed\.paddingTop \}\}/, 'virtual rails need an upper spacer')
  assert.match(source, /const canCreateInCycle = !selectedCycle \|\| dateInRange\(selectedDate, selectedCycle\.startDate, selectedCycle\.endDate\)/, 'out-of-cycle timer views must not permit ordinary creation')
  assert.match(source, /setDate\(runningBlock\.dateKey, true\)/, 'the running timer banner may intentionally enter an out-of-cycle date')
  assert.match(source, /canAdd canCreate=\{canCreateInCycle\}/, 'weekly and daily creation must follow the effective cycle selection')
  assert.match(source, /canAdd=\{canCreateInCycle\}/, 'focus creation must follow the effective cycle selection')
  assert.match(source, /const RAIL_VIRTUAL_THRESHOLD = 9/, 'ranges that exceed the rail viewport must not render every item at once')
  assert.doesNotMatch(source, /className="rail-hint"/, 'static current-period hints are unnecessary beside scoped rails')
  assert.match(source, /<small>\{date\.slice\(5\)\}<\/small>/, 'daily entries must show MM-DD across month boundaries')
})

test('each panel offers exactly one add entry, so no action is duplicated', async () => {
  const source = await appSource()
  // 周与日是固定的日历周期，不存在“新建周/新建日”：它们的周期轨道上不能有添加按钮，
  // 否则会与面板自身的「添加任务」重复（同一动作两个入口）。
  const weekRail = source.slice(source.indexOf('function WeekRail'), source.indexOf('function DayRail'))
  const dayRail = source.slice(source.indexOf('function DayRail'), source.indexOf('function ReturnToCurrent'))
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
