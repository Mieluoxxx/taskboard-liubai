import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { addDays, carriedFromLabels, coversDate, coversWeek, cycleForNavigation, daySpan, dateKeysInRange, elapsedMsAt, focusDisplayStatus, isoDay, linkedChainIds, todayInTimeZone, weekKey, weekKeysInRange, weekRange, weekSpan } from './domain'
import { bigClock, dayTree, daysOfWeekTask, dial, displayWidth, focusTree, goalsTree, GROUP_FOCUS, marks, timeline, weekTree, weeksOfGoal, windowAround, type Marks, type TreeLine } from './scene'
import { blockRank, buildIndex, fill, formatClock, formatDate, formatSpan, formatWeek, fuzzyScore, openBlock, progressBar, type BoardIndex, type ClockFace, type Selection, type ViewName } from './terminal'
import type { CopyKey } from './i18n'
import type { BoardSnapshot, FocusBlock, GoalCycle, Language, Task } from './types'

type Translate = (key: CopyKey) => string

// 日任务按跨度的最后一天、周任务按跨度的最后一个 ISO 周判断“已经过去”：同一套规则供行内标记与 /defer 的默认值复用。
export function isPastPlacement(task: Task, timeZone: string): boolean {
  if (task.checked) return false
  const today = todayInTimeZone(timeZone)
  if (task.domain === 'daily') return Boolean(task.dateKey && daySpan(task).end < today)
  if (task.domain === 'weekly') return Boolean(task.weekKey && weekSpan(task).end < weekKey(today))
  return false
}

/** 放置与输入同一种写法：W40、W40..W42、10-05、10-05..10-07，不是今年才带年份；目标没有放置。 */
export function placementLabel(task: Task, today: string): string {
  if (task.domain === 'weekly' && task.weekKey) return formatSpan(task.weekKey, task.endWeekKey, (key) => formatWeek(key, today))
  if (task.domain === 'daily' && task.dateKey) return formatSpan(task.dateKey, task.endDateKey, (key) => formatDate(key, today))
  return ''
}

export function weekdayShort(dateKey: string, language: Language): string {
  const monday = new Date(Date.UTC(2024, 0, 1 + isoDay(dateKey) - 1, 12))
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short', timeZone: 'UTC' }).format(monday)
}

export const VIEW_LABEL: Record<ViewName, CopyKey> = { goals: 'navGoals', week: 'navWeek', day: 'navDay', focus: 'navFocus' }

export interface BoardActions {
  run: (command: string) => void
  toggle: (task: Task) => void
  select: (id: string | null) => void
  navigate: (patch: Partial<Selection>) => void
  jump: (task: Task) => void
}

/** 刚被改动的行：重画后闪一下，告诉用户“动的是这一行”。nonce 交替切换动画名，连续改同一行也会重播。 */
export interface Touched { ids: Set<string>; nonce: number }

export interface SceneProps {
  view: ViewName
  snapshot: BoardSnapshot
  selection: Selection
  language: Language
  t: Translate
  now: number
  columns: number
  clockFace: ClockFace
  cursorId: string | null
  expandedId: string | null
  touched: Touched | null
  actions: BoardActions
}

function focusGlyph(block: FocusBlock, now: number): string {
  const status = focusDisplayStatus(block, now)
  return status === 'running' ? '◉' : status === 'complete' ? '■' : status === 'finished' ? '✓' : block.elapsedMs > 0 ? '◐' : '○'
}

/** 1h30m、25m：与 /start 的时长写法相同。 */
export function formatMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ''}` : `${minutes}m`
}

/** 倒计时；到点后不停在 00:00，而是写超出了多少（+03:12），忘了关也看得出来。 */
export function clockLeft(block: FocusBlock, now: number): string {
  const left = block.durationMinutes * 60_000 - elapsedMsAt(block, now)
  return left > 0 ? formatClock(left) : `+${formatClock(-left)}`
}

/** 一块专注的读数只有一条规则：还没结束的说还剩多少（没开始就是计划时长），结束了的说实际用了多久。 */
function blockReadout(block: FocusBlock, now: number): string {
  if (block.status === 'finished') return formatMinutes(elapsedMsAt(block, now))
  if (block.status === 'paused' && !block.elapsedMs) return formatMinutes(block.durationMinutes * 60_000)
  return clockLeft(block, now)
}

/**
 * 场景头就是「你在这里」的地图：面包屑（项目 › 周 › 日），项目时间轴（今天 ●、正在看的那段着色），
 * 再加一条随视图变化的条带——日/专注是这一周的 7 天，周是项目里的各周，目标是各个项目。
 */
export function SceneHead({ view, snapshot, selection, language, t, now, columns, actions }: Omit<SceneProps, 'clockFace' | 'cursorId' | 'expandedId' | 'touched'>) {
  const index = useMemo(() => buildIndex(snapshot, selection), [snapshot, selection])
  const today = todayInTimeZone(snapshot.settings.timeZone)
  const cycle = index.cycle
  const navigation = cycleForNavigation(snapshot, cycle)
  const running = snapshot.focusBlocks.find((block) => block.status === 'running')
  const range = weekRange(selection.week)
  const crumbs: Array<{ views: ViewName[]; label: string; command: string }> = [
    { views: ['goals'], label: cycle ? cycle.name : t('unassignedPlans'), command: '/goals' },
    { views: ['week'], label: `${formatWeek(selection.week, today)} ${formatSpan(range.start, range.end, (key) => formatDate(key, today))}`, command: '/week' },
    { views: ['day', 'focus'], label: `${formatDate(selection.date, today)} ${weekdayShort(selection.date, language)}`, command: view === 'focus' ? '/focus' : '/day' },
  ]
  return <header className="scene-head">
    <div className="head-line">
      <nav className="crumbs" aria-label={t('navGoals')}>
        {crumbs.map((crumb, position) => <span key={crumb.command} className="crumb-wrap">
          {position ? <span className="crumb-sep" aria-hidden="true">›</span> : null}
          <button type="button" className={`crumb ${crumb.views.includes(view) ? 'is-here' : ''}`} aria-current={crumb.views.includes(view) ? 'location' : undefined} onClick={() => actions.run(crumb.command)}>{crumb.label}</button>
        </span>)}
      </nav>
      {running && view !== 'focus' ? <button type="button" className="head-running" onClick={() => actions.run(`/focus ${running.dateKey}`)}>
        <span className="head-running-title">◉ {running.title}</span><span className="head-running-clock">{clockLeft(running, now)}</span>
      </button> : null}
    </div>
    {cycle && navigation ? <Timeline cycle={cycle} navigation={navigation} today={today} view={view} selection={selection} columns={columns} t={t} /> : null}
    {view === 'goals'
      ? <ProjectStrip snapshot={snapshot} selection={selection} cycle={cycle} t={t} actions={actions} />
      : view === 'week'
        ? <WeekStrip snapshot={snapshot} selection={selection} index={index} navigation={navigation} today={today} columns={columns} t={t} actions={actions} />
        : <DayStrip view={view} snapshot={snapshot} selection={selection} index={index} navigation={navigation} today={today} columns={columns} language={language} t={t} actions={actions} />}
  </header>
}

// 时间轴画的是导航范围（旧数据可能落在项目外，要看得到），但「第几天」只按项目自己的起止算。
function Timeline({ cycle, navigation, today, view, selection, columns, t }: { cycle: GoalCycle; navigation: GoalCycle; today: string; view: ViewName; selection: Selection; columns: number; t: Translate }) {
  const total = dateKeysInRange(cycle.startDate, cycle.endDate).length
  const inside = today >= cycle.startDate && today <= cycle.endDate
  const day = (key: string) => formatDate(key, today)
  const meta = inside ? fill(t('dayOfCycle'), { day: dateKeysInRange(cycle.startDate, today).length, total }) : formatSpan(cycle.startDate, cycle.endDate, day)
  const span = view === 'goals' ? null : view === 'week' ? weekRange(selection.week) : { start: selection.date, end: selection.date }
  const ends = [day(navigation.startDate), day(navigation.endDate)]
  const runs = timeline({ start: navigation.startDate, end: navigation.endDate }, today, span, Math.max(8, columns - ends.join('').length - 4 - displayWidth(meta) - 3))
  return <div className="head-line timeline" aria-label={`${formatSpan(navigation.startDate, navigation.endDate, day)} · ${meta}`}>
    <span className="timeline-bar" aria-hidden="true">
      <span className="timeline-end">{ends[0]} </span>
      {runs.map((run, position) => <span key={position} className={`tl-${run.tone}`}>{run.text}</span>)}
      <span className="timeline-end"> {ends[1]}</span>
    </span>
    <span className="head-meta">{meta}</span>
  </div>
}

// 格子宽度固定只放得下短写，完整写法（跨年时带年份）放在 title 里。
function Cell({ label, title, marks: shown, active, current, disabled, onClick }: { label: string; title: string; marks: Marks; active: boolean; current: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} disabled={disabled} title={title} className={`cell ${active ? 'is-active' : ''} ${current ? 'is-current' : ''}`} onClick={onClick}>
    <span className="cell-label">{label}</span>
    <span className={`cell-marks marks-${shown.tone}`}>{shown.text}</span>
  </button>
}

function blockMarks(blocks: FocusBlock[], now: number): Marks {
  if (!blocks.length) return { text: '·', tone: 'none' }
  const done = blocks.filter((block) => block.status === 'finished').length
  const tone = done === blocks.length ? 'done' : done ? 'part' : 'open'
  return blocks.length > 4 ? { text: String(blocks.length), tone } : { text: blocks.map((block) => focusGlyph(block, now)).join(''), tone }
}

function DayStrip({ view, snapshot, selection, index, navigation, today, columns, language, t, actions }: { view: ViewName; snapshot: BoardSnapshot; selection: Selection; index: BoardIndex; navigation?: GoalCycle; today: string; columns: number; language: Language; t: Translate; actions: BoardActions }) {
  const range = weekRange(selection.week)
  const days = dateKeysInRange(range.start, range.end)
  const inCycle = (date: string) => !navigation || (date >= navigation.startDate && date <= navigation.endDate)
  const cycleId = index.cycle?.id
  const now = Date.now()
  const dayMarks = (date: string) => view === 'focus'
    ? blockMarks(snapshot.focusBlocks.filter((block) => block.dateKey === date), now)
    : marks(snapshot.tasks.filter((task) => !task.archivedAt && task.domain === 'daily' && !task.parentId && task.cycleId === cycleId && coversDate(task, date)), 4)
  // 一格要放下「周日 10-04」：放不下时只留星期，再窄就只留一个字。
  const label = (date: string) => {
    const weekday = weekdayShort(date, language)
    if (columns >= 80) return `${weekday} ${date.slice(5)}`
    if (columns >= 52) return weekday
    return language === 'zh' ? weekday.slice(-1) : weekday.slice(0, 2)
  }
  return <div className="strip" role="tablist">
    <span className="strip-label">{formatWeek(selection.week, today)}</span>
    <button type="button" className="strip-step" aria-label={t('previous')} onClick={() => actions.navigate({ date: addDays(selection.date, -7) })}>‹</button>
    {days.map((date) => <Cell key={date} active={date === selection.date} current={date === today} disabled={!inCycle(date)} label={label(date)} title={formatDate(date, today)} marks={dayMarks(date)} onClick={() => actions.navigate({ date })} />)}
    <button type="button" className="strip-step" aria-label={t('next')} onClick={() => actions.navigate({ date: addDays(selection.date, 7) })}>›</button>
  </div>
}

function WeekStrip({ snapshot, selection, index, navigation, today, columns, t, actions }: { snapshot: BoardSnapshot; selection: Selection; index: BoardIndex; navigation?: GoalCycle; today: string; columns: number; t: Translate; actions: BoardActions }) {
  const current = weekKey(today)
  const all = navigation ? weekKeysInRange(navigation.startDate, navigation.endDate) : [-3, -2, -1, 0, 1, 2, 3].map((offset) => weekKey(addDays(weekRange(selection.week).start, offset * 7)))
  const at = all.indexOf(selection.week)
  const shown = windowAround(all, at, Math.max(3, Math.min(9, Math.floor((columns - 10) / 8))))
  const cycleId = index.cycle?.id
  const step = (delta: -1 | 1) => actions.navigate({ week: navigation ? all[at + delta] : weekKey(addDays(weekRange(selection.week).start, delta * 7)) })
  return <div className="strip" role="tablist">
    <button type="button" className="strip-step" aria-label={t('previous')} disabled={at <= 0 && Boolean(navigation)} onClick={() => step(-1)}>‹</button>
    {shown.map((key) => <Cell key={key} active={key === selection.week} current={key === current} label={key.slice(5)} title={formatWeek(key, today)} marks={marks(snapshot.tasks.filter((task) => !task.archivedAt && task.domain === 'weekly' && !task.parentId && task.cycleId === cycleId && coversWeek(task, key)), 4)} onClick={() => actions.navigate({ week: key })} />)}
    <button type="button" className="strip-step" aria-label={t('next')} disabled={at >= all.length - 1 && Boolean(navigation)} onClick={() => step(1)}>›</button>
  </div>
}

function ProjectStrip({ snapshot, selection, cycle, t, actions }: { snapshot: BoardSnapshot; selection: Selection; cycle?: GoalCycle; t: Translate; actions: BoardActions }) {
  const unassigned = snapshot.tasks.some((task) => !task.cycleId && !task.archivedAt) || selection.cycleId === ''
  return <div className="strip strip-tabs" role="tablist">
    {snapshot.cycles.map((entry, position) => <button key={entry.id} type="button" role="tab" aria-selected={entry.id === cycle?.id} className={`tab ${entry.id === cycle?.id ? 'is-active' : ''}`} onClick={() => actions.navigate({ cycleId: entry.id })}>
      <span className="tab-prefix">{position + 1}</span>{entry.name}
    </button>)}
    {unassigned ? <button type="button" role="tab" aria-selected={selection.cycleId === ''} className={`tab ${selection.cycleId === '' ? 'is-active' : ''}`} onClick={() => actions.navigate({ cycleId: '' })}><span className="tab-prefix">~</span>{t('unassignedPlans')}</button> : null}
    <button type="button" className="tab tab-add" onClick={() => actions.run('/project new')}>+ {t('addCycle')}</button>
  </div>
}

// 一行的分布格：日视图不需要；周视图 7 天，目标视图若干周。格宽固定，所有行的格子上下对齐。
interface Distribution { keys: string[]; labels: string[]; titles: string[]; cell: number; here?: string; current?: string; open: (key: string) => void; of: (task: Task) => Map<string, Task[]> }

export function Scene(props: SceneProps) {
  const { view, snapshot, selection, language, t, now, columns, actions } = props
  const index = useMemo(() => buildIndex(snapshot, selection), [snapshot, selection])
  const today = todayInTimeZone(snapshot.settings.timeZone)
  if (view === 'focus') return <FocusScene {...props} index={index} />
  const lines = view === 'goals' ? goalsTree(index) : view === 'week' ? weekTree(index) : dayTree(index)
  const empty = !index.cycle && view === 'goals' && !snapshot.cycles.length ? t('noCycles') : view === 'goals' ? t('emptyLong') : view === 'week' ? t('emptyWeekly') : t('emptyDaily')
  let distribution: Distribution | undefined
  if (view === 'week' && columns >= 64) {
    const days = dateKeysInRange(weekRange(selection.week).start, weekRange(selection.week).end)
    distribution = { keys: days, labels: days.map((date) => (language === 'zh' ? weekdayShort(date, language).slice(-1) : weekdayShort(date, language).slice(0, 2))), titles: days.map((date) => formatDate(date, today)), cell: 3, here: selection.date, current: today, open: (date) => actions.run(`/day ${date}`), of: (task) => daysOfWeekTask(snapshot, task, selection.week) }
  }
  if (view === 'goals' && index.cycle && columns >= 64) {
    const navigation = cycleForNavigation(snapshot, index.cycle)!
    const all = weekKeysInRange(navigation.startDate, navigation.endDate)
    const shown = windowAround(all, all.indexOf(selection.week), Math.max(2, Math.min(12, Math.floor((columns - 48) / 5))))
    distribution = { keys: shown, labels: shown.map((key) => key.slice(5)), titles: shown.map((key) => formatWeek(key, today)), cell: 5, here: selection.week, current: weekKey(today), open: (key) => actions.run(`/week ${key}`), of: (task) => weeksOfGoal(snapshot, task, all) }
  }
  if (!lines.length) return <section className={`board view-${view}`}><div className="scene-empty">{empty}{view === 'goals' && !snapshot.cycles.length ? <> · <button type="button" className="inline-cmd" onClick={() => actions.run('/project new')}>/project new</button></> : null}</div></section>
  const asideWidth = distribution ? distribution.keys.length * distribution.cell + 8 : undefined
  return <section className={`board view-${view} ${distribution ? 'has-dist' : ''}`} style={asideWidth ? { '--aside': `${asideWidth}ch` } as CSSProperties : undefined} aria-label={t(VIEW_LABEL[view])}>
    {distribution ? <div className="row dist-head" aria-hidden="true">
      <span /><span /><span />
      <span className="row-aside">{distribution.keys.map((key, position) => <span key={key} className={`dist-cell ${key === distribution!.here ? 'is-here' : ''} ${key === distribution!.current ? 'is-current' : ''}`} style={{ width: `${distribution!.cell}ch` }} title={distribution!.titles[position]}>{distribution!.labels[position]}</span>)}<span className="dist-count" /></span>
    </div> : null}
    <TreeRows {...props} lines={lines} index={index} distribution={distribution} />
  </section>
}

const LEAD_REPEAT = 40

function TreeRows({ view, lines, index, distribution, snapshot, selection, t, now, cursorId, expandedId, touched, actions }: SceneProps & { lines: TreeLine[]; index: BoardIndex; distribution?: Distribution }) {
  const zone = snapshot.settings.timeZone
  const today = todayInTimeZone(zone)
  const carried = useMemo(() => carriedFromLabels(snapshot), [snapshot])
  const chain = useMemo(() => (cursorId && snapshot.tasks.some((task) => task.id === cursorId) ? linkedChainIds(snapshot, cursorId) : new Set<string>()), [cursorId, snapshot])
  const refWidth = Math.max(3, ...lines.map((line) => (line.ref?.length ?? 0) + 1))
  return <div className="rows">{lines.map((line) => {
    if (line.block) return <BlockRow key={line.id} line={line} block={line.block} refWidth={refWidth} index={index} snapshot={snapshot} t={t} now={now} today={today} selected={line.block.id === cursorId} expanded={line.block.id === expandedId} touched={touched} actions={actions} />
    if (!line.task) {
      const label = `· ${t(line.id === GROUP_FOCUS ? 'focusLoose' : 'treeUnlinked')}`
      return <div key={line.id} className="row is-context is-group">
        <Lead lead={line.lead} rest={line.rest} label={label} width={line.lead.length + displayWidth(label)} />
      </div>
    }
    const task = line.task
    const ref = line.ref || ''
    const selected = task.id === cursorId
    const expanded = task.id === expandedId && !line.context
    const flash = touched?.ids.has(task.id)
    const className = ['row', 'task-row', `color-${task.color}`, line.context ? 'is-context' : '', task.checked ? 'is-checked' : '', selected ? 'is-selected' : '', chain.has(task.id) && !selected ? 'is-linked' : '', flash ? `is-touched touch-${touched!.nonce % 2}` : ''].filter(Boolean).join(' ')
    return <div key={task.id} className={className} data-row-id={task.id}>
      <Lead lead={line.lead} rest={line.rest} label={ref} width={line.lead.length + refWidth} />
      {line.context ? null : <button type="button" role="checkbox" aria-checked={task.checked} className="row-check" aria-label={`${ref} ${task.title}`} onClick={() => actions.toggle(task)}>{task.checked ? '[x]' : '[ ]'}</button>}
      <div className="row-main">
        <button type="button" className="row-title" aria-expanded={line.context ? undefined : expanded} onClick={() => (line.context ? actions.jump(task) : actions.select(task.id))} onDoubleClick={() => actions.run(`/edit ${ref}`)}>
          <span className="row-text">{task.endWeekKey || task.endDateKey ? <span className="row-span" title={task.endWeekKey ? `${task.weekKey}..${task.endWeekKey}` : `${task.dateKey}..${task.endDateKey}`}>{placementLabel(task, today)} </span> : null}{task.title}</span>
          {task.note && !expanded && !line.context ? <small className="row-note">{task.note}</small> : null}
        </button>
        {expanded ? <RowDetail task={task} ref_={ref} t={t} actions={actions} /> : null}
      </div>
      <span className="row-aside">
        {line.context ? null : distribution && !task.parentId ? <DistributionCells distribution={distribution} task={task} t={t} /> : <TaskMeta task={task} index={index} snapshot={snapshot} selection={selection} zone={zone} carried={carried} now={now} t={t} focus={view !== 'focus'} />}
      </span>
    </div>
  })}</div>
}

/** 编号与连线：第一行是 `│  ├─ d1`，之后每行重复 rest，被行高裁掉多余的部分，折行处的竖线因此不断。 */
function Lead({ lead, rest, label, width }: { lead: string; rest: string; label: string; width: number }) {
  return <span className="lead" style={{ width: `${width}ch` }}>
    <span className="guide" aria-hidden="true">{lead}</span><span className="row-ref">{label}</span>
    {rest.trim() ? <span className="guide" aria-hidden="true">{`\n${rest}`.repeat(LEAD_REPEAT)}</span> : null}
  </span>
}

function DistributionCells({ distribution, task, t }: { distribution: Distribution; task: Task; t: Translate }) {
  const spread = distribution.of(task)
  // 跨周任务会在好几格里出现，合计只数一次。
  const all = [...new Set([...spread.values()].flat())]
  const done = all.filter((entry) => entry.checked).length
  return <>
    {distribution.keys.map((key) => {
      const shown = marks(spread.get(key) ?? [], distribution.cell - 1)
      return <button key={key} type="button" tabIndex={-1} className={`dist-cell marks-${shown.tone} ${key === distribution.here ? 'is-here' : ''}`} style={{ width: `${distribution.cell}ch` }} onClick={() => distribution.open(key)}>{shown.text}</button>
    })}
    <span className={`dist-count ${all.length ? '' : 'is-empty'}`}>{all.length ? `${done}/${all.length}` : t('unplanned')}</span>
  </>
}

// 专注视图把块直接画在任务下面，行尾就不再重复（focus = false）。
function TaskMeta({ task, index, snapshot, selection, zone, carried, now, t, focus }: { task: Task; index: BoardIndex; snapshot: BoardSnapshot; selection: Selection; zone: string; carried: Map<string, string>; now: number; t: Translate; focus: boolean }) {
  const from = carried.get(task.id)
  const today = todayInTimeZone(zone)
  const past = isPastPlacement(task, zone)
  const blocks = focus && task.domain === 'daily' ? snapshot.focusBlocks.filter((block) => block.taskId === task.id && block.dateKey === selection.date) : []
  const block = [...blocks].sort((a, b) => blockRank(a) - blockRank(b))[0]
  return <>
    {block ? <span className={`meta-focus status-${focusDisplayStatus(block, now)}`}>{index.refOf.get(block.id)} {focusGlyph(block, now)} {blockReadout(block, now)}</span> : null}
    {from ? <span className="meta-carry" title={`${t('carriedFrom')} ${from}`}>←{from.includes('-W') ? formatWeek(from, today) : formatDate(from, today)}</span> : null}
    {past ? <span className="meta-past" title={t('reschedule')}>!</span> : null}
  </>
}

function RowDetail({ task, ref_: ref, t, actions }: { task: Task; ref_: string; t: Translate; actions: BoardActions }) {
  return <div className="row-detail">
    {task.note ? <div className="detail-note">{task.note}</div> : null}
    <div className="detail-actions">
      <Act k="e" label={t('edit')} onClick={() => actions.run(`/edit ${ref}`)} />
      {!task.parentId ? <Act k="s" label={t('addSubtask')} onClick={() => actions.run(`/sub ${ref}`)} /> : null}
      <Act k="K" label={t('moveUp')} onClick={() => actions.run(`/mv ${ref} up`)} />
      <Act k="J" label={t('moveDown')} onClick={() => actions.run(`/mv ${ref} down`)} />
      {task.domain !== 'long' && !task.parentId ? <Act k="r" label={t('defer')} onClick={() => actions.run(`/defer ${ref}`)} /> : null}
      {task.domain === 'daily' ? <Act k="p" label={t('start')} onClick={() => actions.run(`/start ${ref}`)} /> : null}
      <Act k="⌫" label={t('delete')} danger onClick={() => actions.run(`/rm ${ref}`)} />
    </div>
  </div>
}

function Act({ k, label, danger, onClick }: { k: string; label: string; danger?: boolean; onClick: () => void }) {
  return <button type="button" className={`act ${danger ? 'danger' : ''}`} onClick={onClick}><span className="act-key">[{k}]</span>{label}</button>
}

/** 挂在任务下的专注块：标题和任务一样时不再重复，改写它的状态；结束的写下结束时刻。 */
function BlockRow({ line, block, refWidth, index, snapshot, t, now, today, selected, expanded, touched, actions }: { line: TreeLine; block: FocusBlock; refWidth: number; index: BoardIndex; snapshot: BoardSnapshot; t: Translate; now: number; today: string; selected: boolean; expanded: boolean; touched: Touched | null; actions: BoardActions }) {
  const ref = line.ref || ''
  const status = focusDisplayStatus(block, now)
  const task = block.taskId ? snapshot.tasks.find((candidate) => candidate.id === block.taskId && !candidate.archivedAt) : undefined
  const underTask = Boolean(task && index.d.some((row) => row.task.id === task.id))
  const statusLabel = status === 'running' ? t('running') : status === 'complete' ? t('complete') : status === 'finished' ? t('finished') : block.elapsedMs > 0 ? t('paused') : t('notStarted')
  const finishedAt = block.finishedAt ? wallTime(Date.parse(block.finishedAt), snapshot.settings.timeZone) : ''
  const plain = underTask && block.title === task!.title
  const flash = touched?.ids.has(block.id)
  return <div className={['row', 'focus-row', `status-${status}`, selected ? 'is-selected' : '', flash ? `is-touched touch-${touched!.nonce % 2}` : ''].filter(Boolean).join(' ')} data-row-id={block.id}>
    <Lead lead={line.lead} rest={line.rest} label={ref} width={line.lead.length + refWidth} />
    <span className="row-check focus-glyph" role="img" aria-label={statusLabel}>{focusGlyph(block, now)}</span>
    <div className="row-main">
      <button type="button" className="row-title" aria-expanded={expanded} onClick={() => actions.select(block.id)} onDoubleClick={() => actions.run(`/edit ${ref}`)}>
        <span className={`row-text ${plain ? 'is-status' : ''}`}>{plain ? `${statusLabel}${status === 'finished' && finishedAt ? ` ${finishedAt}` : ''}` : block.title}</span>
        {task && !underTask ? <small className="row-note">↖ {index.refOf.get(task.id) ? `${index.refOf.get(task.id)} ` : ''}{task.title}</small> : null}
      </button>
      {expanded ? <div className="row-detail"><div className="detail-actions">
        <FocusButtons block={block} ref_={ref} now={now} t={t} actions={actions} />
        <Act k="e" label={t('edit')} onClick={() => actions.run(`/edit ${ref}`)} />
        <Act k="⌫" label={t('delete')} danger onClick={() => actions.run(`/rm ${ref}`)} />
        <span className="detail-dim">{formatDate(block.dateKey, today)} · {formatMinutes(block.durationMinutes * 60_000)}</span>
      </div></div> : null}
    </div>
    <span className="row-aside"><span className={`meta-focus status-${status}`}>{blockReadout(block, now)}</span></span>
  </div>
}

// 标签里的键就是导航模式里的键：p 开始/暂停，S 结束（s 留给子任务）。到点后只剩结束这一件事可做。
function FocusButtons({ block, ref_: ref, now, t, actions }: { block: FocusBlock; ref_?: string; now: number; t: Translate; actions: BoardActions }) {
  if (block.status === 'finished') return null
  return <>
    {focusDisplayStatus(block, now) === 'complete' ? null : block.status === 'running'
      ? <Act k="p" label={t('pause')} onClick={() => actions.run('/pause')} />
      : <Act k="p" label={block.elapsedMs > 0 ? t('resume') : t('start')} onClick={() => actions.run(ref ? `/start ${ref}` : '/resume')} />}
    {block.status === 'running' || block.elapsedMs > 0 ? <Act k="S" label={t('finish')} onClick={() => actions.run(ref ? `/stop ${ref}` : '/stop')} /> : null}
  </>
}

const DIAL_ROWS = 10
// 两栏时左边至少要放得下任务标题；再窄就把钟收成树上方的两行。
const SPLIT_COLUMNS = 72

/**
 * 专注视图：左边是这一天的任务树，专注块挂在各自的任务下；右边是一块钟——有计时在跑时是它的倒计时，没有时是现在几点。
 * 面板里不再画到目标的那条链：左边的树已经画着它。
 */
function FocusScene(props: SceneProps & { index: BoardIndex }) {
  const { index, columns, t } = props
  const lines = focusTree(index)
  const split = columns >= SPLIT_COLUMNS
  const tree = lines.length ? <TreeRows {...props} lines={lines} /> : <div className="scene-empty">{t('emptyFocus')}</div>
  return <section className={`board view-focus ${split ? 'is-split' : ''}`} aria-label={t('navFocus')}>
    {split ? <><div className="focus-tree">{tree}</div><FocusPanel {...props} compact={false} /></> : <><FocusPanel {...props} compact />{tree}</>}
  </section>
}

function FocusPanel({ index, snapshot, selection, t, now, clockFace, compact, actions }: SceneProps & { index: BoardIndex; compact: boolean }) {
  const zone = snapshot.settings.timeZone
  const today = todayInTimeZone(zone)
  // 计时器全局只有一个：不管它记在哪一天，钟都跟着它，而不是跟着光标或正在看的日子。
  const running = snapshot.focusBlocks.find((block) => block.status === 'running')
  const day = index.f.map((row) => row.block)
  const summary = day.length ? fill(t('focusSpent'), {
    day: selection.date === today ? t('today') : formatDate(selection.date, today),
    spent: formatMinutes(day.reduce((sum, block) => sum + elapsedMsAt(block, now), 0)),
    planned: formatMinutes(day.reduce((sum, block) => sum + block.durationMinutes * 60_000, 0)),
  }) : ''
  const toggle = compact ? null : <button type="button" className="inline-cmd panel-toggle" onClick={() => actions.run('/clock')}>/clock</button>
  if (running) {
    const total = running.durationMinutes * 60_000
    const elapsed = elapsedMsAt(running, now)
    const status = focusDisplayStatus(running, now)
    const left = clockLeft(running, now)
    const percent = Math.min(100, Math.round((elapsed / total) * 100))
    const ref = index.refOf.get(running.id)
    const target = `${left} / ${formatMinutes(total)}`
    return <aside className={`panel status-${status} ${compact ? 'is-compact' : ''}`} aria-label={t('running')}>
      <div className="panel-title">
        {ref ? <span className="row-ref">{ref}</span> : <button type="button" className="panel-date" onClick={() => actions.run(`/focus ${running.dateKey}`)}>{formatDate(running.dateKey, today)}</button>}
        {' '}<span className="focus-glyph">{focusGlyph(running, now)}</span> {running.title}
      </div>
      {compact ? null : <Face face={clockFace} digits={left} rows={dial({ rows: DIAL_ROWS, sector: status === 'complete' ? undefined : [Math.min(1, elapsed / total), 1] })} label={target} />}
      <div className="panel-meter">
        {compact ? <span className="meter-bar" aria-hidden="true">{progressBar(elapsed / total, 16)}</span> : null}
        <span className="meter-read">{compact || clockFace === 'digital' ? `${compact ? target : `/ ${formatMinutes(total)}`} · ${percent}%` : `${target} · ${percent}%`}</span>
        <span className="row-actions"><FocusButtons block={running} ref_={ref} now={now} t={t} actions={actions} /></span>
      </div>
      {summary && !compact ? <div className="panel-summary">{summary}</div> : null}
      {toggle}
    </aside>
  }
  const next = openBlock(day)
  const nextRef = next ? index.refOf.get(next.id) : undefined
  const clock = wallClock(now, zone)
  const time = `${String(clock.hours).padStart(2, '0')}:${String(clock.minutes).padStart(2, '0')}`
  return <aside className={`panel status-idle ${compact ? 'is-compact' : ''}`} aria-label={time}>
    {compact ? null : <Face face={clockFace} digits={time} rows={dial({ rows: DIAL_ROWS, hands: [{ turn: ((clock.hours % 12) + clock.minutes / 60) / 12, length: 0.5 }, { turn: (clock.minutes + clock.seconds / 60) / 60, length: 0.8 }] })} label={time} />}
    {summary || compact ? <div className="panel-summary">{compact ? `${time}${summary ? ` · ${summary}` : ''}` : summary}</div> : null}
    {next && nextRef ? <div className="panel-next">
      <span className="dim">{t('focusNext')}</span> <span className="row-ref">{nextRef}</span> {next.title} · {blockReadout(next, now)}
      {' '}<span className="row-actions"><FocusButtons block={next} ref_={nextRef} now={now} t={t} actions={actions} /></span>
    </div> : null}
    {toggle}
  </aside>
}

/** 表盘或像素数字。两者都按面板宽度缩放字号（容器单位），窄栏里也放得下 01:30:00。 */
function Face({ face, digits, rows, label }: { face: ClockFace; digits: string; rows: ReturnType<typeof dial>; label: string }) {
  if (face === 'digital') {
    const lines = bigClock(digits)
    return <pre className="face is-digital" role="img" aria-label={label} style={{ '--chars': Math.max(...lines.map((line) => line.length)) } as CSSProperties}>{lines.join('\n')}</pre>
  }
  return <pre className="face is-analog" role="img" aria-label={label} style={{ '--chars': DIAL_ROWS * 2 } as CSSProperties}>
    {rows.map((runs, row) => <span key={row}>{runs.map((run, position) => <span key={position} className={`dial-${run.tone}`}>{run.text}</span>)}{row < rows.length - 1 ? '\n' : null}</span>)}
  </pre>
}

// 墙上的钟按看板时区走，与“今天”是哪一天同一个时区。
function wallClock(now: number, zone: string): { hours: number; minutes: number; seconds: number } {
  const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23', timeZone: zone }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value ?? 0)
  return { hours: part('hour'), minutes: part('minute'), seconds: part('second') }
}

function wallTime(at: number, zone: string): string {
  if (!Number.isFinite(at)) return ''
  const clock = wallClock(at, zone)
  return `${String(clock.hours).padStart(2, '0')}:${String(clock.minutes).padStart(2, '0')}`
}

export interface FinderItem { id: string; kind: 'view' | 'project' | 'task' | 'focus'; title: string; meta?: string; open: () => void }

export function Finder({ user, items, initialQuery, t, onClose }: { user: string; items: FinderItem[]; initialQuery: string; t: Translate; onClose: () => void }) {
  const [query, setQuery] = useState(initialQuery)
  const [tab, setTab] = useState<'all' | FinderItem['kind']>('all')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  const results = useMemo(() => items
    .filter((item) => tab === 'all' || item.kind === tab)
    .map((item) => ({ item, score: fuzzyScore(query, `${item.title} ${item.meta || ''}`) }))
    .filter((entry) => entry.score !== null)
    .sort((a, b) => (query ? b.score! - a.score! : 0))
    .slice(0, 60)
    .map((entry) => entry.item), [items, query, tab])
  useEffect(() => { setCursor(0) }, [query, tab])
  useEffect(() => { listRef.current?.querySelector('.finder-row.active')?.scrollIntoView({ block: 'nearest' }) }, [cursor])
  const tabs: Array<['all' | FinderItem['kind'], CopyKey]> = [['all', 'finderAll'], ['view', 'finderViews'], ['project', 'finderProjects'], ['task', 'finderTasks'], ['focus', 'finderFocus']]
  const kindLabel: Record<FinderItem['kind'], CopyKey> = { view: 'finderKindView', project: 'finderKindProject', task: 'finderKindTask', focus: 'finderKindFocus' }
  const open = (item: FinderItem | undefined) => { if (!item) return; onClose(); item.open() }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose() }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((value) => Math.min(results.length - 1, value + 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((value) => Math.max(0, value - 1)) }
    else if (event.key === 'Enter') { event.preventDefault(); open(results[cursor]) }
    else if (event.key === 'Tab') {
      event.preventDefault()
      const at = tabs.findIndex(([key]) => key === tab)
      setTab(tabs[(at + (event.shiftKey ? tabs.length - 1 : 1)) % tabs.length][0])
    }
  }
  return <div className="finder-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="finder" role="dialog" aria-modal="true" aria-label={t('finderTitle')} onKeyDown={onKeyDown}>
      <div className="finder-head"><span>{t('finderTitle')}</span><button type="button" className="finder-close" onClick={onClose}>{t('finderClose')}</button></div>
      <div className="finder-input"><label htmlFor="finder-query" className="prompt-label">{user} <span className="dim">·/</span> &gt;</label><input id="finder-query" ref={inputRef} value={query} autoComplete="off" spellCheck={false} placeholder={t('finderPlaceholder')} onChange={(event) => setQuery(event.target.value)} role="combobox" aria-expanded="true" aria-controls="finder-list" aria-activedescendant={results.length ? `finder-${cursor}` : undefined} /></div>
      <div className="finder-tabs" role="tablist">{tabs.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => { setTab(key); inputRef.current?.focus() }}>{t(label)}</button>)}</div>
      <div className="finder-list" id="finder-list" role="listbox" ref={listRef}>
        {results.map((item, position) => <div key={item.id} id={`finder-${position}`} role="option" aria-selected={position === cursor} className={`finder-row ${position === cursor ? 'active' : ''}`} onMouseEnter={() => setCursor(position)} onMouseDown={(event) => event.preventDefault()} onClick={() => open(item)}>
          <span className="finder-num">{String(position + 1).padStart(2, '0')}</span><span className="finder-title">{item.title}</span>{item.meta ? <span className="finder-meta">{item.meta}</span> : null}<span className="finder-kind">{t(kindLabel[item.kind])}</span>
        </div>)}
        {!results.length ? <div className="finder-empty">{t('finderEmpty')}</div> : null}
      </div>
      <div className="finder-foot"><span>{t('finderFoot')}</span><span>{fill(t('finderCount'), { count: results.length })}</span></div>
    </div>
  </div>
}

