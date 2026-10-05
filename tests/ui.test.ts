import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

// UI 契约测试：终端交互的约定无法用纯函数断言，因此直接检查渲染源码。
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const appSource = () => read('src/App.tsx')
const shellSource = () => read('src/Shell.tsx')
const viewsSource = () => read('src/BoardViews.tsx')
const accountSource = () => read('src/AccountPage.tsx')
const cssSource = () => read('src/styles.css')

test('the whole site is one shell: a prompt instead of dialogs, one scene instead of a scrollback', async () => {
  const [app, account, shell, css] = await Promise.all([appSource(), accountSource(), shellSource(), cssSource()])
  for (const [name, source] of [['App.tsx', app], ['AccountPage.tsx', account]] as const) {
    assert.match(source, /<ShellFrame /, `${name} must render inside the terminal frame`)
    assert.match(source, /<Prompt /, `${name} must take input through the prompt`)
    assert.match(source, /<OutputStrip output=\{output\}/, `${name} shows only the last output above the prompt`)
    assert.doesNotMatch(source, /window\.confirm|<form className="dialog-form"|className="dialog-backdrop"/, `${name} must not fall back to modal forms or browser confirms`)
    // 每条命令都是「先 clear 再执行」：没有回滚，也没有冻结的旧视图。
    assert.doesNotMatch(source, /scrollback|useStickToBottom|frozen|setEntries/, `${name} must not keep a scrollback`)
  }
  assert.doesNotMatch(app, /TaskPanel|ConnectorLayer|DndContext|workspace-stage/, 'the old four-panel board must be gone')
  const pkg = JSON.parse(await read('package.json'))
  assert.ok(!Object.keys(pkg.dependencies).some((name) => name.startsWith('@dnd-kit')), 'drag and drop is replaced by /mv and J/K')
  // 结果只保留最后一条：替换而不是追加；长输出换成整页，下一条命令或 esc 收起。
  assert.match(shell, /setOutput\(\(current\) => \(\{ id, echo: echo \?\? current\?\.echo, lines \}\)\)/)
  assert.match(shell, /if \(lines\.length > 3 \|\| lines\.some\(\(line\) => line\.cmd \|\| line\.key !== undefined\)\)/)
  assert.match(app, /if \(page\) \{ closePage\(\); setHelpMenu\(null\); return \}/, 'esc closes a page before it enters navigation mode')
  // 一屏固定：文档不滚，只有场景区滚，提示符始终在原位。
  assert.match(css, /body \{ min-width: 320px; overflow: hidden;/)
  assert.match(css, /\.scene \{[^}]*overflow: auto;/)
  assert.match(app, /<SceneHead view=\{view\}/)
  assert.match(app, /<Scene view=\{view\}/)
  // 账户页的整页输出只是盖住内容：卸载会重跑授权确认、丢掉已读取的列表。
  assert.match(account, /<div hidden=\{Boolean\(page\)\}>/)
})

test('relations are drawn as a tree, with guides that never break', async () => {
  const [views, css, app] = await Promise.all([viewsSource(), cssSource(), appSource()])
  assert.match(views, /view === 'goals' \? goalsTree\(index\) : view === 'week' \? weekTree\(index\) : dayTree\(index\)/)
  // 框线字符高 1.52em：行高超过 1.5 或行间留白，竖线就会断成虚线。
  assert.match(css, /\.row \{[^}]*margin: 0 -12px; padding: 0 12px; line-height: 1\.5;/)
  assert.match(css, /\.lead \{ align-self: stretch; overflow: hidden; contain: size;/, 'the guide column fills wrapped lines without growing the row')
  assert.match(views, /\{`\\n\$\{rest\}`\.repeat\(LEAD_REPEAT\)\}/)
  // 改动的行重画后闪一下；排序不改内容，单独标记。
  assert.match(app, /touch\(changedIds\(current\.snapshot, next\)\)/)
  assert.match(app, /reorderInScene\(current, task\.id, direction, selectionRef\.current\)[\s\S]{0,120}touch\(\[task\.id\]\)/)
  // /mv 与冲突重放都只在组内换位，和画出来的树一致；跨周、跨天任务按正在看的那一周、那一天找邻居。
  assert.match(app, /const next = reorderInScene\(board, origin\.taskId, origin\.direction, selectionRef\.current\)/)
})

test('the scene lives in the address bar, so back and refresh keep your place', async () => {
  const app = await appSource()
  assert.match(app, /const next = sceneHash\(view, \{ cycleId: selectedCycleId, week: selectedWeek, date: selectedDate \}\)/)
  assert.match(app, /if \(historyViewRef\.current && historyViewRef\.current !== view\) window\.history\.pushState\(null, '', url\)\n\s+else window\.history\.replaceState\(null, '', url\)/, 'only view changes add history entries')
  assert.match(app, /window\.addEventListener\('popstate', onPop\)/)
  assert.match(app, /if \(screen !== 'workspace' \|\| !routeToken \|\| routeToken !== boardLoadToken\) return/, 'the hash is not overwritten before the loaded board applies it')
  assert.match(app, /const location = parseSceneHash\(window\.location\.hash\)/)
})

test('signing in is a terminal login: login, then a password that is never echoed or remembered', async () => {
  const [app, shell, css] = await Promise.all([appSource(), shellSource(), cssSource()])
  const login = app.slice(app.indexOf('const startLogin = '), app.indexOf('const openTaskWizard = '))
  assert.match(login, /key: 'email', label: 'login', type: 'email', autoComplete: 'username'/)
  assert.match(login, /key: 'password', label: 'password', type: 'password', autoComplete: 'current-password'/)
  // 回显只写 “password:”，绝不带值。
  assert.match(login, /\{ text: 'password:', tone: 'dim' \}/)
  assert.doesNotMatch(login, /password:\s*\$\{/, 'the transcript must not contain the password')
  // 密码管理器需要同一表单里的用户名；历史只记录命令行，不记录任何提问的答案。
  assert.match(shell, /<input type="email" name="username" autoComplete="username" value=\{values\[previousUsername\.key\] \|\| ''\} readOnly hidden \/>/)
  const submitCommand = shell.slice(shell.indexOf('const submitCommand = '), shell.indexOf('const pickCompletion = '))
  assert.match(submitCommand, /history\.push\(trimmed\)/)
  assert.doesNotMatch(shell.slice(shell.indexOf('const finishField = '), shell.indexOf('const cancel = ')), /history\.push/, 'answers (including passwords) must never enter history')
  assert.match(shell, /setValues\(\{\}\)\n\s+setValue\(''\)\n\s+ask\.onDone\(nextValues\)/, 'the answers are cleared before they are handed over')
  assert.match(css, /\.prompt-input\.is-secret \{ color: transparent; caret-color: transparent; \}/, 'the password is not echoed, not even as dots')
  // 登录失败回到同一个提示符重试，保留邮箱。
  assert.match(app, /startLogin\(email\.trim\(\)\)/)
})

test('every click has a command behind it, so the mouse teaches the keyboard', async () => {
  const [app, views] = await Promise.all([appSource(), viewsSource()])
  for (const command of ['/edit ${ref}', '/sub ${ref}', '/mv ${ref} up', '/mv ${ref} down', '/defer ${ref}', '/start ${ref}', '/rm ${ref}', '/project new']) {
    assert.ok(views.includes(`actions.run(\`${command}\`)`) || views.includes(`actions.run('${command}')`), `missing click → ${command}`)
  }
  assert.match(app, /run: \(command\) => \{ execute\(command\); focusPrompt\(\) \}/, 'clicks run through the same executor and echo like typed commands')
  // 直接输入文字就是在当前视图新增；斜杠开头才是命令。
  assert.match(app, /if \(parsed\.kind === 'text'\) \{[\s\S]{0,240}return quickAdd\(parsed\.text, say, fail\)/)
})

test('navigation mode mirrors the sidebar hotkeys and keeps typing in the prompt', async () => {
  const app = await appSource()
  const keys = app.slice(app.indexOf('const keys: Record<string, () => void> = {'), app.indexOf('const handler = keys[event.key]'))
  for (const [key, command] of [['g', '/goals'], ['w', '/week'], ['d', '/day'], ['f', '/focus']]) {
    assert.match(keys, new RegExp(`${key}: \\(\\) => execute\\('${command}'\\)`), `${key} must open ${command}`)
  }
  assert.doesNotMatch(app, /\/tree/, 'every view is already a tree; there is no separate tree view')
  assert.match(keys, /J: \(\) => \{ if \(task && ref\) execute\(`\/mv \$\{ref\} down`\) \}/, 'J/K replace drag and drop')
  assert.match(app, /if \(navMode && typing\) setNavMode\(false\)/, 'focusing the prompt always returns to command mode')
  assert.match(app, /if \(\(event\.metaKey \|\| event\.ctrlKey\) && event\.key\.toLowerCase\(\) === 'k'\)/, '⌘K / Ctrl+K opens the finder')
  // 标签上写的键就是导航模式里按的键：p 开始/暂停专注，S 结束（小写 s 是子任务）。
  assert.match(keys, /p: \(\) => \{[\s\S]{0,260}execute\('\/pause'\)[\s\S]{0,80}execute\(ref \? `\/start \$\{ref\}` : '\/start'\)/, 'p pauses the running block and starts anything else')
  assert.match(keys, /S: \(\) => execute\(ref && \(block \|\| task\?\.domain === 'daily'\) \? `\/stop \$\{ref\}` : '\/stop'\)/, 'S finishes')
  assert.match(keys, /s: \(\) => \{ if \(task && !task\.parentId && ref\) execute\(`\/sub \$\{ref\}`\) \}/, 's stays the subtask key')
})

test('focus: tasks on the left, one clock on the right that follows the only timer', async () => {
  const [app, views, css] = await Promise.all([appSource(), viewsSource(), cssSource()])
  const buttons = views.slice(views.indexOf('function FocusButtons'), views.indexOf('const DIAL_ROWS'))
  assert.match(buttons, /<Act k="p" label=\{t\('pause'\)\} onClick=\{\(\) => actions\.run\('\/pause'\)\} \/>/, 'clicks run the same commands as the keys they show')
  assert.match(buttons, /<Act k="S" label=\{t\('finish'\)\}/)
  assert.doesNotMatch(views, /k="f"|k="↵"|k="s" label=\{t\('stop'\)\}/, 'no button advertises a key that does something else')
  assert.match(views, /const running = snapshot\.focusBlocks\.find\(\(block\) => block\.status === 'running'\)\n  const day = index\.f/, 'the clock follows the running timer on any date, not the cursor')
  assert.match(views, /running && view !== 'focus' \? <button type="button" className="head-running"/, 'the focus view does not repeat the timer in the scene head')
  assert.match(css, /\.view-focus\.is-split \{ display: grid; grid-template-columns: minmax\(0, 1fr\) clamp\(26ch, 36%, 38ch\);/)
  assert.match(css, /\.face \{[^}]*line-height: 1\.2;[^}]*font-size: min\(15px, calc\(round\(down, 100cqi \/ var\(--chars\), 1px\) \/ 0\.6\)\);/, 'the face scales with its column, on whole-pixel cells so blocks stay seamless')
  assert.match(app, /const tabTitle = runningBlock \? `\$\{focusDisplayStatus\(runningBlock, now\) === 'complete' \? '⏰' : '◉'\} \$\{clockLeft\(runningBlock, now\)\}/, 'the tab title carries the countdown and flags time up')
  assert.match(app, /localStorage\.getItem\(CLOCK_KEY\) === 'digital' \? 'digital' : 'analog'/, '/clock is a local preference like the theme')
})

test('task text wraps with bounded previews and the editor enforces the shared limits', async () => {
  const [app, css] = await Promise.all([appSource(), cssSource()])
  assert.match(css, /\.row-text \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;[^}]*-webkit-line-clamp: 2;/)
  assert.match(css, /\.row-note \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;[^}]*-webkit-line-clamp: 5;/)
  assert.match(css, /\.detail-note \{[^}]*white-space: pre-wrap;/, 'the expanded row shows the full note')
  assert.match(app, /maxLength: MAX_TASK_TITLE_LENGTH/)
  assert.match(app, /maxLength: MAX_TASK_NOTE_LENGTH/)
})

test('today and the selected period stay distinct, and calendars are scoped by the project', async () => {
  const [app, views, css] = await Promise.all([appSource(), viewsSource(), cssSource()])
  assert.match(app, /const todayKey = todayInTimeZone\(currentZone\)/, 'today comes from the board time zone')
  assert.match(views, /className=\{`cell \$\{active \? 'is-active' : ''\} \$\{current \? 'is-current' : ''\}`\}/, 'today must not reuse the selected class')
  assert.match(css, /\.cell\.is-current \.cell-label \{/, 'the current marker needs its own style')
  assert.match(views, /weekKeysInRange\(navigation\.startDate, navigation\.endDate\)/, 'week tabs come from the project range')
  assert.match(views, /disabled=\{!inCycle\(date\)\}/, 'days outside the project cannot be selected')
  assert.match(app, /const selection = selectionForSnapshot\(nextSnapshot, preferredCycleId, preferredDate\)/)
  assert.match(app, /if \(landed !== date\) return \{ text: fill\(t\('dateClamped'\)/, 'jumping outside the project says where it stopped')
})

test('unfinished plans are carried forward on load and the source stays visible', async () => {
  const [app, views] = await Promise.all([appSource(), viewsSource()])
  assert.match(app, /carryForwardTasks\(loadedSnapshot, todayInTimeZone\(loadedSnapshot\.settings\.timeZone\)\)/)
  assert.match(app, /if \(carried !== loadedSnapshot\) commitRef\.current\?\.\(carried, null\)/)
  assert.match(app, /const commitRef = useRef<\(\(next: BoardSnapshot, draft: string \| null\) => boolean\) \| null>\(null\)/)
  assert.match(views, /const carried = useMemo\(\(\) => carriedFromLabels\(snapshot\), \[snapshot\]\)/, 'the lookup is built once per snapshot')
  assert.match(views, /className="meta-carry" title=\{`\$\{t\('carriedFrom'\)\} \$\{from\}`\}>←\{from\.includes\('-W'\) \? formatWeek\(from, today\) : formatDate\(from, today\)\}/, 'the carry tag uses the same date and week format as everywhere else')
  assert.match(app, /task\.domain === 'weekly' \? rescheduleWeeklyTask\(current, task\.id, target\) : rescheduleDailyTask\(current, task\.id, target\)/, '/defer dispatches by domain')
  assert.match(app, /task\.domain === 'weekly'\) return \{ value: weekKey\(addDays\(weekRange[\s\S]{0,80}kind: 'week'/, 'weekly carry defaults to the following week')
})

test('save failures stay honest: direct edits never pose as form drafts, conflicts never overwrite', async () => {
  const app = await appSource()
  assert.match(app, /draftLabel && canReopenDraft && \(saveState === 'error' \|\| saveState === 'offline'\)/)
  assert.match(app, /const canReopenDraft = failedOrigin\?\.kind === 'task'/)
  assert.match(app, /failureKind === 'conflict' && failedJobRef\.current && !canReopenDraft/)
  assert.match(app, /confirmRef\.current\?\.\(t\('confirmDiscardDirect'\), \(\) => void reloadLatest\(false\)\)/, 'discarding a direct conflict must be confirmed')
  assert.match(app, /failedJobRef\.current\?\.draft && !canReopenDraft/)
  assert.match(app, /const selectionRef = useRef<SelectionState>/)
  assert.match(app, /const cycleDraftDiscarded = !keepDraft && \(failedJobRef\.current\?\.origin\?\.kind === 'cycle'/)
  // 冲突后重开的是同一个逐步编辑流程，带着保留的输入。
  assert.match(app, /wizardsRef\.current\?\.task\(\{ task: existing, domain: origin\.domain, parentId: origin\.parentId, initial: origin\.input, placement: origin\.placement \}\)/)
})

test('deleting a project needs its exact name and refuses stale or unsaved state', async () => {
  const app = await appSource()
  const remove = app.slice(app.indexOf("if (sub === 'rm' || sub === 'delete') {"), app.indexOf("if (sub === 'up' || sub === 'down') {"))
  assert.match(remove, /if \(!online \|\| saveState !== 'saved'\) return fail\(t\('deleteCycleBlocked'\)\)/)
  assert.match(remove, /validate: \(value\) => \(value === cycle\.name \? null : t\('deleteCycleNameMismatch'\)\)/)
  assert.match(remove, /deleteCycleConfirmed\(cycle, confirmedBoard\)/)
  assert.match(app, /if \(current !== confirmedBoard\) \{ setFlash\(t\('deleteCycleChanged'\)\); return \}/, 'a stale confirmation cannot delete a different snapshot')
})

test('the task editor only lets top-level plans change their date or week', async () => {
  const app = await appSource()
  const editor = app.slice(app.indexOf('const openTaskWizard = '), app.indexOf('const openCycleWizard = '))
  assert.match(editor, /const canEditDate = domain === 'daily' && !parent/)
  assert.match(editor, /const canEditWeek = domain === 'weekly' && !parent/)
  assert.match(editor, /candidate\.cycleId === ownCycle && \(candidate\.id === keptUpper \|\| fits\(candidate\)\)/, 'link candidates follow the chosen placement and keep the stored link')
  assert.match(editor, /coversWeek\(candidate, targetWeek\)/, 'a multi-week plan is a candidate in every week it covers')
  assert.match(editor, /parseWeekSpanArg\(values\.week, baseWeek, todayKey\)/, 'the week field accepts a span')
  assert.match(editor, /spanText\(showDate, task\?\.dateKey, task\?\.endDateKey\)/, 'the editor starts from the displayed format, which parses back against the task itself')
  assert.match(editor, /parseDateSpanArg\(value, baseDate, todayKey\)[\s\S]{0,160}t\('noticeDaySpanWeek'\)/, 'the date field accepts a span inside one week')
  assert.match(app, /next = moveDailyTask\(next, existing\.id, \{ start: input\.dateKey, end: input\.endDateKey \|\| input\.dateKey \}, now\)/)
  assert.match(app, /next = moveWeeklyTask\(next, existing\.id, \{ start: input\.weekKey, end: input\.endWeekKey \|\| input\.weekKey \}, now\)/)
})

test('the OAuth consent page asks one y/N question and keeps the redirect guard', async () => {
  const account = await accountSource()
  assert.match(account, /shell\.confirm\(fill\(t\('accountAllowQuestion'\), \{ name: details\.client\.name \}\), \(\) => void run\(\(\) => consent\(true\)\)\)/)
  assert.match(account, /url\.protocol !== 'https:' && !\(url\.protocol === 'http:' && \['localhost', '127\.0\.0\.1', '\[::1\]'\]\.includes\(url\.hostname\)\)/)
  assert.match(account, /if \(!authorizationId \|\| authorizationId\.length > 400\)/)
  assert.match(account, /shell\.confirm\(t\('accountPurgeConfirm'\)/, 'purging trash is confirmed in the prompt')
})

test('the logo is a single inline SVG mark reused in the page and as the favicon', async () => {
  const shell = await shellSource()
  assert.match(shell, /export function BrandMark\(\)/)
  assert.match(shell, /className="brand-mark"[\s\S]{0,200}aria-hidden="true"/)
  assert.match(shell, /viewBox="0 0 32 32"/)
  const svg = await read('public/favicon.svg')
  assert.equal((svg.match(/<rect/g) || []).length, 4, 'favicon = background + three bars')
  assert.equal((svg.match(/<circle/g) || []).length, 1, 'favicon = exactly one focus dot')
  assert.match(await read('index.html'), /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/)
})

test('fonts are self-hosted Maple Mono CN, preloaded in core-only size and lazily tiered', async () => {
  const html = await read('index.html')
  const critical = await read('src/fonts.css')
  const lazy = await read('public/fonts/maple-mono-cn/fonts-lazy.css')
  const styles = await cssSource()

  assert.doesNotMatch(html + critical + lazy + styles, /fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg\.com/, 'fonts must be self-hosted')
  const preloads = [...html.matchAll(/<link rel="preload"[^>]*as="font"[^>]*>/g)].map(([tag]) => tag)
  assert.equal(preloads.length, 2, 'exactly the two core faces should be preloaded')
  for (const tag of preloads) {
    assert.match(tag, /core-\d00\.woff2/, `only core faces may be preloaded, saw ${tag}`)
    assert.match(tag, /crossorigin/, `font preload needs crossorigin: ${tag}`)
  }
  assert.doesNotMatch(html, /preload[^>]*(common|tail|nerd)-/, 'large tiers must not be preloaded')
  assert.match(html, /<link rel="stylesheet" href="\/fonts\/maple-mono-cn\/fonts-lazy\.css" media="print" onload="this\.media='all'"/)
  assert.match(html, /<noscript><link rel="stylesheet" href="\/fonts\/maple-mono-cn\/fonts-lazy\.css" \/><\/noscript>/)
  assert.ok(critical.length < 20_000, `critical font CSS must stay small, got ${critical.length} bytes`)
  assert.doesNotMatch(critical, /(common|tail|nerd)-\d00\.woff2/, 'critical CSS must only reference core faces')
  for (const tier of ['common', 'tail', 'nerd']) {
    assert.match(lazy, new RegExp(`${tier}-400\\.woff2`))
    assert.match(lazy, new RegExp(`${tier}-600\\.woff2`))
  }
  for (const css of [critical, lazy]) {
    const faces = css.split('@font-face').slice(1)
    assert.ok(faces.length > 0, 'expected @font-face blocks')
    for (const block of faces) assert.match(block, /unicode-range:/, 'every face needs unicode-range')
  }
  assert.match(styles, /font-family: "Maple Mono CN"/, 'the app must actually use the font')
  assert.match(styles, /font: \d+ \d+px[^;]*"Maple Mono CN"/, 'shorthand font declarations must use it too')
  // <pre> 的浏览器默认字体会绕过 Maple Mono，横幅的字宽就对不齐了。
  assert.match(styles, /pre, code, kbd, samp \{ font-family: inherit; \}/)
  await read('public/fonts/LICENSE-maple-mono.txt')
})

test('both themes come from one palette and follow the system until the user picks one', async () => {
  const [css, shell, html] = await Promise.all([cssSource(), shellSource(), read('index.html')])
  assert.match(css, /--bg: #141413;/)
  assert.match(css, /:root\[data-theme="light"\] \{[^}]*--bg: #faf9f5;/)
  assert.match(shell, /matchMedia\('\(prefers-color-scheme: light\)'\)/)
  assert.match(shell, /document\.documentElement\.dataset\.theme = resolved/)
  assert.match(html, /<meta name="theme-color" content="#141413" media="\(prefers-color-scheme: dark\)" \/>/)
  assert.match(html, /<meta name="theme-color" content="#faf9f5" media="\(prefers-color-scheme: light\)" \/>/)
})
