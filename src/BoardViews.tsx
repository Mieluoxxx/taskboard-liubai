import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { addDays, carriedFromLabels, elapsedMsAt, focusDisplayStatus, isoDay, linkedChainIds, todayInTimeZone, weekKey, weekKeysInRange, weekRange, cycleForNavigation } from './domain'
import { buildIndex, fill, formatClock, fuzzyScore, progressBar, type BoardIndex, type IndexedTask, type Selection, type ViewName } from './terminal'
import type { CopyKey } from './i18n'
import type { BoardSnapshot, FocusBlock, GoalCycle, Language, Task } from './types'

type Translate = (key: CopyKey) => string

// 日任务按日期、周任务按 ISO 周判断“已经过去”：同一套规则供行内标记与 /defer 的默认值复用。
export function isPastPlacement(task: Task, timeZone: string): boolean {
  if (task.checked) return false
  const today = todayInTimeZone(timeZone)
  if (task.domain === 'daily') return Boolean(task.dateKey && task.dateKey < today)
  if (task.domain === 'weekly') return Boolean(task.weekKey && task.weekKey < weekKey(today))
  return false
}

export function weekdayShort(dateKey: string, language: Language): string {
  const monday = new Date(Date.UTC(2024, 0, 1 + isoDay(dateKey) - 1, 12))
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short', timeZone: 'UTC' }).format(monday)
}

export const VIEW_LABEL: Record<ViewName, CopyKey> = { goals: 'navGoals', week: 'navWeek', day: 'navDay', focus: 'navFocus', tree: 'navTree' }

export interface BoardActions {
  run: (command: string) => void
  toggle: (task: Task) => void
  select: (id: string | null) => void
  navigate: (patch: Partial<Selection>) => void
  jump: (task: Task) => void
  focusCommand: (block: FocusBlock, command: 'start' | 'pause' | 'resume' | 'finish') => void
}

export interface BoardViewProps {
  view: ViewName
  snapshot: BoardSnapshot
  selection: Selection
  language: Language
  t: Translate
  now: number
  live: boolean
  cursorId: string | null
  expandedId: string | null
  actions: BoardActions
}

/** 一个视图块：标题行 + 标签页（原来的周期/周/日轨道）+ 行。冻结块用当时的快照渲染，只读。 */
export function BoardView({ view, snapshot, selection, language, t, now, live, cursorId, expandedId, actions }: BoardViewProps) {
  const index = useMemo(() => buildIndex(snapshot, selection), [snapshot, selection])
  const zone = snapshot.settings.timeZone
  const today = todayInTimeZone(zone)
  const chain = useMemo(() => (cursorId && live && snapshot.tasks.some((task) => task.id === cursorId) ? linkedChainIds(snapshot, cursorId) : new Set<string>()), [cursorId, live, snapshot])
  const carried = useMemo(() => carriedFromLabels(snapshot), [snapshot])
  const navigation = cycleForNavigation(snapshot, index.cycle)
  const header = viewHeader(view, index, selection, language, t, snapshot)
  return <section className={`board-view view-${view} ${live ? 'is-live' : 'is-frozen'}`} aria-label={t(VIEW_LABEL[view])} inert={!live || undefined}>
    <div className="view-head"><span className="view-title">{header.title}</span><span className="view-meta">{header.meta}</span></div>
    <ViewTabs view={view} snapshot={snapshot} selection={selection} cycle={index.cycle} navigation={navigation} today={today} language={language} t={t} actions={actions} />
    {view === 'focus'
      ? <FocusRows index={index} snapshot={snapshot} t={t} now={now} cursorId={cursorId} expandedId={expandedId} live={live} actions={actions} />
      : view === 'tree'
        ? <TreeRows index={index} snapshot={snapshot} selection={selection} language={language} t={t} cursorId={cursorId} actions={actions} />
        : <TaskRows rows={view === 'goals' ? index.g : view === 'week' ? index.w : index.d} index={index} snapshot={snapshot} zone={zone} carried={carried} chain={chain} t={t} cursorId={cursorId} expandedId={expandedId} live={live} actions={actions}
          empty={!index.cycle && view === 'goals' ? t('noCycles') : view === 'goals' ? t('emptyLong') : view === 'week' ? t('emptyWeekly') : t('emptyDaily')} />}
  </section>
}

function viewHeader(view: ViewName, index: BoardIndex, selection: Selection, language: Language, t: Translate, snapshot: BoardSnapshot): { title: string; meta: string } {
  const project = index.cycle ? index.cycle.name : t('unassignedPlans')
  const range = weekRange(selection.week)
  const count = (rows: IndexedTask[]) => `${rows.filter((row) => row.task.checked).length}/${rows.length}`
  if (view === 'goals') return { title: `${project}${index.cycle ? `  ${index.cycle.startDate} → ${index.cycle.endDate}` : ''}`, meta: count(index.g) }
  if (view === 'week') return { title: `${project} › ${selection.week.slice(5)}  ${range.start.slice(5)} → ${range.end.slice(5)}`, meta: count(index.w) }
  if (view === 'day') return { title: `${project} › ${selection.date.slice(5)} ${weekdayShort(selection.date, language)}`, meta: count(index.d) }
  if (view === 'focus') return { title: `${t('navFocus')} › ${selection.date.slice(5)} ${weekdayShort(selection.date, language)}`, meta: `${index.f.filter((row) => row.block.status === 'finished').length}/${index.f.length}` }
  return { title: `${project} › ${selection.week.slice(5)}`, meta: `${snapshot.tasks.filter((task) => !task.archivedAt && task.cycleId === index.cycle?.id).length}` }
}

function ViewTabs({ view, snapshot, selection, cycle, navigation, today, language, t, actions }: { view: ViewName; snapshot: BoardSnapshot; selection: Selection; cycle?: GoalCycle; navigation?: GoalCycle; today: string; language: Language; t: Translate; actions: BoardActions }) {
  if (view === 'goals') {
    const unassigned = snapshot.tasks.some((task) => !task.cycleId && !task.archivedAt) || selection.cycleId === ''
    return <div className="view-tabs" role="tablist">
      {snapshot.cycles.map((entry, position) => <Tab key={entry.id} active={entry.id === cycle?.id} label={entry.name} prefix={`${position + 1}`} onClick={() => actions.navigate({ cycleId: entry.id })} />)}
      {unassigned ? <Tab active={selection.cycleId === ''} label={t('unassignedPlans')} onClick={() => actions.navigate({ cycleId: '' })} /> : null}
      <button type="button" className="tab tab-add" onClick={() => actions.run('/project new')}>+ {t('addCycle')}</button>
    </div>
  }
  if (view === 'week' || view === 'tree') {
    const current = weekKey(today)
    const all = navigation ? weekKeysInRange(navigation.startDate, navigation.endDate) : [-3, -2, -1, 0, 1, 2, 3].map((offset) => weekKey(addDays(weekRange(selection.week).start, offset * 7)))
    const at = Math.max(0, all.indexOf(selection.week))
    const start = Math.max(0, Math.min(at - 3, all.length - 7))
    const shown = all.slice(start, start + 7)
    return <div className="view-tabs" role="tablist">
      <button type="button" className="tab tab-step" aria-label={t('previous')} disabled={at <= 0 && Boolean(navigation)} onClick={() => actions.navigate({ week: navigation ? all[at - 1] : weekKey(addDays(weekRange(selection.week).start, -7)) })}>‹</button>
      {shown.map((key) => <Tab key={key} active={key === selection.week} current={key === current} label={key.slice(5)} onClick={() => actions.navigate({ week: key })} />)}
      <button type="button" className="tab tab-step" aria-label={t('next')} disabled={at >= all.length - 1 && Boolean(navigation)} onClick={() => actions.navigate({ week: navigation ? all[at + 1] : weekKey(addDays(weekRange(selection.week).start, 7)) })}>›</button>
    </div>
  }
  const range = weekRange(selection.week)
  const days = Array.from({ length: 7 }, (_, offset) => addDays(range.start, offset))
  const inCycle = (date: string) => !navigation || (date >= navigation.startDate && date <= navigation.endDate)
  return <div className="view-tabs" role="tablist">
    <button type="button" className="tab tab-step" aria-label={t('previous')} onClick={() => actions.navigate({ date: addDays(selection.date, -7) })}>‹</button>
    {days.map((date) => <Tab key={date} active={date === selection.date} current={date === today} disabled={!inCycle(date)} label={`${weekdayShort(date, language)} ${date.slice(5)}`} onClick={() => actions.navigate({ date })} />)}
    <button type="button" className="tab tab-step" aria-label={t('next')} onClick={() => actions.navigate({ date: addDays(selection.date, 7) })}>›</button>
  </div>
}

function Tab({ label, prefix, active, current, disabled, onClick }: { label: string; prefix?: string; active: boolean; current?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" role="tab" aria-selected={active} disabled={disabled} className={`tab ${active ? 'active' : ''} ${current ? 'is-current' : ''}`} onClick={onClick}>
    {prefix ? <span className="tab-prefix">{prefix}</span> : null}{label}{current ? <span className="current-mark" aria-hidden="true">•</span> : null}
  </button>
}

function upperLabel(task: Task, index: BoardIndex, snapshot: BoardSnapshot): string | null {
  if (!task.upperTaskId) return null
  const ref = index.refOf.get(task.upperTaskId)
  if (ref) return ref
  const upper = snapshot.tasks.find((candidate) => candidate.id === task.upperTaskId)
  return upper ? upper.title.slice(0, 8) : null
}

function TaskRows({ rows, index, snapshot, zone, carried, chain, t, cursorId, expandedId, live, actions, empty }: { rows: IndexedTask[]; index: BoardIndex; snapshot: BoardSnapshot; zone: string; carried: Map<string, string>; chain: Set<string>; t: Translate; cursorId: string | null; expandedId: string | null; live: boolean; actions: BoardActions; empty: string }) {
  if (!rows.length) return <div className="view-empty">{empty}</div>
  return <div className="rows">{rows.map(({ task, ref, depth }) => {
    const selected = live && task.id === cursorId
    const expanded = live && task.id === expandedId
    const past = isPastPlacement(task, zone)
    const upper = upperLabel(task, index, snapshot)
    const from = carried.get(task.id)
    return <Fragment key={task.id}><div className={`row task-row depth-${depth} color-${task.color} ${task.checked ? 'is-checked' : ''} ${selected ? 'is-selected' : ''} ${chain.has(task.id) && !selected ? 'is-linked' : ''} ${past ? 'is-past' : ''}`} data-row-id={task.id}>
      <span className="row-ref">{depth ? '└' : ''}{ref}</span>
      <button type="button" role="checkbox" aria-checked={task.checked} className="row-check" aria-label={`${ref} ${task.title}`} onClick={() => actions.toggle(task)}>{task.checked ? '[x]' : '[ ]'}</button>
      <button type="button" className="row-title" aria-expanded={expanded} onClick={() => actions.select(task.id)} onDoubleClick={() => actions.run(`/edit ${ref}`)}>
        <span className="row-text">{task.title}</span>
        {task.note && !expanded ? <small className="row-note">{task.note}</small> : null}
      </button>
      <span className="row-meta">
        {upper ? <span className="meta-link" title={t('association')}>↖{upper}</span> : null}
        {from ? <span className="meta-carry" title={`${t('carriedFrom')} ${from}`}>←{from.slice(5)}</span> : null}
        {past ? <span className="meta-past" title={t('reschedule')}>!</span> : null}
      </span>
    </div>
      {expanded ? <div className="row-detail">
        {task.note ? <div className="detail-note">{task.note}</div> : null}
        <div className="detail-actions">
          <Act k="e" label={t('edit')} onClick={() => actions.run(`/edit ${ref}`)} />
          {!depth ? <Act k="s" label={t('addSubtask')} onClick={() => actions.run(`/sub ${ref}`)} /> : null}
          <Act k="K" label={t('moveUp')} onClick={() => actions.run(`/mv ${ref} up`)} />
          <Act k="J" label={t('moveDown')} onClick={() => actions.run(`/mv ${ref} down`)} />
          {task.domain !== 'long' && !depth ? <Act k="r" label={t('defer')} onClick={() => actions.run(`/defer ${ref}`)} /> : null}
          {task.domain === 'daily' ? <Act k="f" label={t('start')} onClick={() => actions.run(`/start ${ref}`)} /> : null}
          <Act k="⌫" label={t('delete')} danger onClick={() => actions.run(`/rm ${ref}`)} />
        </div>
      </div> : null}
    </Fragment>
  })}</div>
}

function Act({ k, label, danger, onClick }: { k: string; label: string; danger?: boolean; onClick: () => void }) {
  return <button type="button" className={`act ${danger ? 'danger' : ''}`} onClick={onClick}><span className="act-key">[{k}]</span>{label}</button>
}

function FocusRows({ index, snapshot, t, now, cursorId, expandedId, live, actions }: { index: BoardIndex; snapshot: BoardSnapshot; t: Translate; now: number; cursorId: string | null; expandedId: string | null; live: boolean; actions: BoardActions }) {
  if (!index.f.length) return <div className="view-empty">{t('emptyFocus')}</div>
  return <div className="rows">{index.f.map(({ block, ref }) => {
    const total = block.durationMinutes * 60_000
    const elapsed = Math.min(elapsedMsAt(block, now), total)
    const status = focusDisplayStatus(block, now)
    const task = block.taskId ? snapshot.tasks.find((candidate) => candidate.id === block.taskId && !candidate.archivedAt) : undefined
    const selected = live && cursorId === block.id
    const expanded = live && expandedId === block.id
    const glyph = status === 'running' ? '◉' : status === 'complete' ? '■' : status === 'finished' ? '✓' : block.elapsedMs > 0 ? '◐' : '○'
    const readout = status === 'running' ? formatClock(total - elapsed) : status === 'finished' || status === 'complete' ? `${Math.round(elapsed / 60_000)}/${block.durationMinutes}m` : block.elapsedMs > 0 ? formatClock(total - elapsed) : `${block.durationMinutes}m`
    const statusLabel = status === 'running' ? t('running') : status === 'paused' ? t('paused') : status === 'complete' ? t('complete') : t('finished')
    return <Fragment key={block.id}><div className={`row focus-row status-${status} ${selected ? 'is-selected' : ''}`} data-row-id={block.id}>
      <span className="row-ref">{ref}</span>
      <span className="row-check focus-glyph" aria-label={statusLabel} role="img">{glyph}</span>
      <button type="button" className="row-title" aria-expanded={expanded} onClick={() => actions.select(block.id)} onDoubleClick={() => actions.run(`/edit ${ref}`)}>
        <span className="row-text">{block.title}</span>
        {task ? <small className="row-note">↖{index.refOf.get(task.id) || ''} {task.title}</small> : null}
      </button>
      <span className="row-meta focus-meter"><span className="meter-bar" aria-hidden="true">{progressBar(elapsed / total, 16)}</span><span className="meter-read">{readout}</span></span>
      <span className="row-actions">
        {status === 'paused' ? <Act k="↵" label={block.elapsedMs > 0 ? t('resume') : t('start')} onClick={() => actions.focusCommand(block, block.elapsedMs > 0 ? 'resume' : 'start')} /> : null}
        {status === 'running' ? <Act k="p" label={t('pause')} onClick={() => actions.focusCommand(block, 'pause')} /> : null}
        {status === 'running' || status === 'complete' ? <Act k="s" label={t('stop')} onClick={() => actions.focusCommand(block, 'finish')} /> : null}
      </span>
    </div>
      {expanded ? <div className="row-detail"><div className="detail-actions">
        <Act k="e" label={t('edit')} onClick={() => actions.run(`/edit ${ref}`)} />
        <Act k="⌫" label={t('delete')} danger onClick={() => actions.run(`/rm ${ref}`)} />
        <span className="detail-dim">{block.dateKey} · {block.durationMinutes} {t('minutes')}</span>
      </div></div> : null}
    </Fragment>
  })}</div>
}

interface TreeNode { task: Task; ref?: string; children: TreeNode[] }

function TreeRows({ index, snapshot, selection, language, t, cursorId, actions }: { index: BoardIndex; snapshot: BoardSnapshot; selection: Selection; language: Language; t: Translate; cursorId: string | null; actions: BoardActions }) {
  const cycleId = index.cycle?.id
  const active = snapshot.tasks.filter((task) => !task.archivedAt && task.cycleId === cycleId)
  const subtasks = (task: Task): TreeNode[] => active.filter((child) => child.parentId === task.id).map((child) => ({ task: child, ref: index.refOf.get(child.id), children: [] }))
  const days = active.filter((task) => task.domain === 'daily' && !task.parentId && task.dateKey && weekKey(task.dateKey) === selection.week)
    .sort((a, b) => (a.dateKey! < b.dateKey! ? -1 : a.dateKey! > b.dateKey! ? 1 : 0))
  const weeks = active.filter((task) => task.domain === 'weekly' && !task.parentId && task.weekKey === selection.week)
  const goals = active.filter((task) => task.domain === 'long' && !task.parentId)
  const dayNode = (task: Task): TreeNode => ({ task, ref: index.refOf.get(task.id), children: subtasks(task) })
  const weekNode = (task: Task): TreeNode => ({ task, ref: index.refOf.get(task.id), children: [...subtasks(task), ...days.filter((day) => day.upperTaskId === task.id).map(dayNode)] })
  const roots: TreeNode[] = goals.map((goal) => ({ task: goal, ref: index.refOf.get(goal.id), children: [...subtasks(goal), ...weeks.filter((week) => week.upperTaskId === goal.id).map(weekNode)] }))
  const weekIds = new Set(weeks.map((week) => week.id))
  const goalIds = new Set(goals.map((goal) => goal.id))
  const loose: TreeNode[] = [...weeks.filter((week) => !week.upperTaskId || !goalIds.has(week.upperTaskId)).map(weekNode), ...days.filter((day) => !day.upperTaskId || !weekIds.has(day.upperTaskId)).map(dayNode)]
  if (!roots.length && !loose.length) return <div className="view-empty">{t('emptyTree')}</div>
  const roots_ = flattenTree(roots, true)
  const loose_ = flattenTree(loose, false)
  return <div className="rows tree-rows">
    {roots_.map(({ prefix, node }) => <TreeLine key={node.task.id} prefix={prefix} node={node} language={language} selected={cursorId === node.task.id} actions={actions} />)}
    {loose_.length ? <div className="tree-group">· {t('treeUnlinked')}</div> : null}
    {loose_.map(({ prefix, node }) => <TreeLine key={node.task.id} prefix={prefix} node={node} language={language} selected={cursorId === node.task.id} actions={actions} />)}
  </div>
}

// 顶层目标不画连线，便于把它们读成小标题；未关联分组从第一层就画线。
function flattenTree(nodes: TreeNode[], topless: boolean): Array<{ prefix: string; node: TreeNode }> {
  const lines: Array<{ prefix: string; node: TreeNode }> = []
  const walk = (level: TreeNode[], prefix: string, top: boolean) => level.forEach((node, position) => {
    const last = position === level.length - 1
    lines.push({ prefix: top ? '' : `${prefix}${last ? '└─ ' : '├─ '}`, node })
    walk(node.children, top ? '' : `${prefix}${last ? '   ' : '│  '}`, false)
  })
  walk(nodes, '', topless)
  return lines
}

function TreeLine({ prefix, node, language, selected, actions }: { prefix: string; node: TreeNode; language: Language; selected: boolean; actions: BoardActions }) {
  const { task } = node
  const place = task.domain === 'daily' && !task.parentId ? `${task.dateKey!.slice(5)} ${weekdayShort(task.dateKey!, language)}` : task.domain === 'weekly' && !task.parentId ? task.weekKey!.slice(5) : ''
  return <div className={`row tree-row domain-${task.domain} color-${task.color} ${task.checked ? 'is-checked' : ''} ${selected ? 'is-selected' : ''}`} data-row-id={task.id}>
    <span className="tree-prefix" aria-hidden="true">{prefix}</span>
    <button type="button" role="checkbox" aria-checked={task.checked} className="row-check" aria-label={task.title} onClick={() => actions.toggle(task)}>{task.checked ? '[x]' : '[ ]'}</button>
    <button type="button" className="row-title" onClick={() => actions.jump(task)}>
      {place ? <span className="tree-place">{place}</span> : null}<span className="row-text">{task.title}</span>
    </button>
    <span className="row-meta">{node.ref || ''}</span>
  </div>
}

export function Dashboard({ snapshot, selection, language, t, now, actions }: { snapshot: BoardSnapshot; selection: Selection; language: Language; t: Translate; now: number; actions: BoardActions }) {
  const zone = snapshot.settings.timeZone
  const today = todayInTimeZone(zone)
  const index = useMemo(() => buildIndex(snapshot, { ...selection, date: today, week: weekKey(today) }), [snapshot, selection, today])
  const running = snapshot.focusBlocks.find((block) => block.status === 'running')
  const carriedToday = useMemo(() => { const labels = carriedFromLabels(snapshot); return index.d.filter((row) => labels.has(row.task.id)).length }, [snapshot, index])
  const done = (rows: IndexedTask[]) => `${rows.filter((row) => row.task.checked).length}/${rows.length}`
  const range = weekRange(weekKey(today))
  const runningLine = running ? (() => {
    const total = running.durationMinutes * 60_000
    const elapsed = Math.min(elapsedMsAt(running, now), total)
    return { text: `◉ ${running.title}`, meta: `${progressBar(elapsed / total, 12)} ${formatClock(total - elapsed)}` }
  })() : null
  return <div className="dashboard">
    <button type="button" className="dash-row" onClick={() => actions.run(running ? `/focus ${running.dateKey}` : '/focus today')}>
      <span className="dash-key">{t('dashNow')}</span><span className={`dash-text ${running ? 'is-running' : 'dim'}`}>{runningLine ? runningLine.text : t('dashIdle')}</span><span className="dash-meta">{runningLine?.meta || ''}</span>
    </button>
    <button type="button" className="dash-row" onClick={() => actions.run('/today')}>
      <span className="dash-key">{t('dashToday')}</span><span className="dash-text">{today.slice(5)} {weekdayShort(today, language)} · {index.d.length ? fill(t('dashDone'), { done: done(index.d) }) : t('emptyDaily')}</span><span className="dash-meta">{carriedToday ? fill(t('dashCarried'), { count: carriedToday }) : ''}</span>
    </button>
    <button type="button" className="dash-row" onClick={() => actions.run('/week now')}>
      <span className="dash-key">{t('dashWeek')}</span><span className="dash-text">{weekKey(today).slice(5)} · {range.start.slice(5)} → {range.end.slice(5)} · {fill(t('dashDone'), { done: done(index.w) })}</span><span className="dash-meta" />
    </button>
    <button type="button" className="dash-row" onClick={() => actions.run('/goals')}>
      <span className="dash-key">{t('dashProject')}</span><span className="dash-text">{index.cycle ? `${index.cycle.name} · ${index.cycle.startDate} → ${index.cycle.endDate}` : t('noCycles')}</span><span className="dash-meta">{index.cycle ? fill(t('dashGoals'), { count: index.g.filter((row) => !row.depth).length }) : ''}</span>
    </button>
  </div>
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

