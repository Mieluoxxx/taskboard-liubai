import { addDays, coversDate, coversWeek, isDateKey, isoDay, reorderSiblingTo, shiftWeek, tasksForPlacement, weekKey, weekRange, type Span } from './domain'
import type { BoardSnapshot, Domain, FocusBlock, GoalCycle, Language, Task, TaskColor } from './types'

export type ViewName = 'goals' | 'week' | 'day' | 'focus'
export type RefScope = 'g' | 'w' | 'd' | 'f'
export type ShellContext = 'guest' | 'board' | 'account'
export type ClockFace = 'analog' | 'digital'

export const VIEWS: ViewName[] = ['goals', 'week', 'day', 'focus']
export const VIEW_KEYS: Record<ViewName, string> = { goals: 'G', week: 'W', day: 'D', focus: 'F' }
export const VIEW_SCOPE: Record<ViewName, RefScope> = { goals: 'g', week: 'w', day: 'd', focus: 'f' }
export const SCOPE_DOMAIN: Record<Exclude<RefScope, 'f'>, Domain> = { g: 'long', w: 'weekly', d: 'daily' }
export const DOMAIN_SCOPE: Record<Domain, Exclude<RefScope, 'f'>> = { long: 'g', weekly: 'w', daily: 'd' }
export const TASK_COLORS: TaskColor[] = ['ink', 'blue', 'orange', 'green', 'violet']

export interface CommandSpec {
  name: string
  aliases?: string[]
  args?: string
  zh: string
  en: string
  context: ShellContext[]
  /** 需要参数的命令在补全菜单里回车只插入，不直接执行。 */
  needsArg?: boolean
}

const BOARD: ShellContext[] = ['board']
const ANY: ShellContext[] = ['guest', 'board', 'account']

export const COMMANDS: CommandSpec[] = [
  { name: 'help', aliases: ['h', '?'], args: '[command]', zh: '列出全部命令', en: 'list every command', context: ANY },
  { name: 'login', args: '[email]', zh: '登录云端看板', en: 'sign in to your cloud board', context: ['guest', 'account'] },
  { name: 'demo', zh: '打开只存于本机的演示板', en: 'open the local demo board', context: ['guest'] },
  { name: 'goals', aliases: ['g'], zh: '长期目标', en: 'long-term goals', context: BOARD },
  { name: 'week', aliases: ['w'], args: '[W41|+1|-1|today]', zh: '周计划', en: 'weekly plan', context: BOARD },
  { name: 'day', aliases: ['d'], args: '[10-06|+1|-1|mon|today]', zh: '日计划', en: 'daily plan', context: BOARD },
  { name: 'focus', aliases: ['f'], args: '[date]', zh: '专注块与计时器', en: 'focus blocks and timers', context: BOARD },
  { name: 'today', zh: '回到今天与本周', en: 'jump to today and this week', context: BOARD },
  { name: 'project', aliases: ['p', 'cd'], args: '[n|name|new|edit|rm|up|down]', zh: '列出、切换或管理项目', en: 'list, switch or manage projects', context: BOARD },
  { name: 'add', aliases: ['a'], args: '<title> [#color] [^ref]', zh: '在当前视图新增（直接输入文字也可以）', en: 'add to the current view (or just type)', context: BOARD, needsArg: true },
  { name: 'sub', args: '<ref> <title>', zh: '新增子任务', en: 'add a subtask', context: BOARD, needsArg: true },
  { name: 'done', aliases: ['x', 'check'], args: '<ref…>', zh: '勾选 / 取消勾选', en: 'toggle done', context: BOARD, needsArg: true },
  { name: 'edit', aliases: ['e'], args: '<ref>', zh: '逐项编辑', en: 'edit field by field', context: BOARD, needsArg: true },
  { name: 'note', args: '<ref> <text>', zh: '改备注', en: 'set the note', context: BOARD, needsArg: true },
  { name: 'color', args: '<ref> <ink|blue|orange|green|violet>', zh: '改标记色', en: 'set the marker color', context: BOARD, needsArg: true },
  { name: 'link', args: '<ref> <ref|none>', zh: '关联上级（日→周，周→目标）', en: 'link to an upper task (day→week, week→goal)', context: BOARD, needsArg: true },
  { name: 'mv', aliases: ['move'], args: '<ref> <up|down|top|bottom|date|week|A..B>', zh: '排序、改期或设跨度（连同子任务）', en: 'reorder, move or span days/weeks, with subtasks', context: BOARD, needsArg: true },
  { name: 'defer', args: '<ref> [date|week]', zh: '顺延，原记录留档', en: 'carry forward, keep the original', context: BOARD, needsArg: true },
  { name: 'rm', aliases: ['del', 'delete'], args: '<ref>', zh: '删除（会确认）', en: 'delete (asks first)', context: BOARD, needsArg: true },
  { name: 'start', args: '[f1|d1] [minutes]', zh: '开始专注；日任务接着它没做完的那块，给时长就新开一块', en: 'start focusing; a daily task picks up its unfinished block, a duration opens a new one', context: BOARD },
  { name: 'pause', zh: '暂停计时', en: 'pause the timer', context: BOARD },
  { name: 'resume', zh: '继续计时', en: 'resume the timer', context: BOARD },
  { name: 'stop', args: '[f1|d1]', zh: '结束计时，记下实际时长', en: 'finish the timer and record the actual time', context: BOARD },
  { name: 'clock', args: '[analog|digital]', zh: '切换专注页的表盘', en: 'switch the focus clock face', context: BOARD },
  { name: 'find', aliases: ['k'], args: '[query]', zh: '查找任务、项目与视图（⌘K）', en: 'find tasks, projects and views (⌘K)', context: BOARD },
  { name: 'sync', aliases: ['reload'], zh: '加载最新版本（保留草稿）', en: 'load the latest version, keep drafts', context: BOARD },
  { name: 'retry', zh: '重试失败的保存', en: 'retry the failed save', context: BOARD },
  { name: 'reopen', zh: '在最新版本上重新编辑草稿', en: 're-edit the draft on the latest version', context: BOARD },
  { name: 'discard', zh: '丢弃草稿并加载最新', en: 'discard the draft and load latest', context: BOARD },
  { name: 'status', zh: '保存状态、版本与时区', en: 'save state, revision and time zone', context: BOARD },
  { name: 'tz', args: '[Asia/Shanghai]', zh: '查看或设置时区', en: 'show or set the time zone', context: BOARD },
  { name: 'account', zh: '授权、回收站与审计', en: 'access, trash and audit', context: BOARD },
  { name: 'board', zh: '回到看板', en: 'back to the board', context: ['account'] },
  { name: 'allow', zh: '同意这次授权请求', en: 'approve this authorization request', context: ['account'] },
  { name: 'deny', zh: '拒绝这次授权请求', en: 'deny this authorization request', context: ['account'] },
  { name: 'revoke', args: '<n>', zh: '撤销第 n 个已授权应用', en: 'revoke authorized app n', context: ['account'], needsArg: true },
  { name: 'restore', args: '<n>', zh: '恢复回收站第 n 批', en: 'restore trash batch n', context: ['account'], needsArg: true },
  { name: 'purge', args: '<n>', zh: '永久清除回收站第 n 批', en: 'purge trash batch n', context: ['account'], needsArg: true },
  { name: 'more', args: '<trash|audit> [prev]', zh: '翻页', en: 'page through', context: ['account'], needsArg: true },
  { name: 'refresh', zh: '重新读取', en: 'reload', context: ['account'] },
  { name: 'whoami', zh: '当前身份', en: 'who is signed in', context: ['board', 'account'] },
  { name: 'theme', args: '[dark|light|auto]', zh: '切换配色', en: 'switch the color theme', context: ANY },
  { name: 'lang', args: '[zh|en]', zh: '切换语言', en: 'switch the language', context: ANY },
  { name: 'clear', aliases: ['cls'], zh: '清空输出（Ctrl+L）', en: 'clear the output (Ctrl+L)', context: ANY },
  { name: 'logout', aliases: ['exit'], zh: '退出', en: 'sign out', context: ['board', 'account'] },
]

export function commandsFor(context: ShellContext): CommandSpec[] {
  return COMMANDS.filter((command) => command.context.includes(context))
}

export function resolveCommand(name: string, context: ShellContext): CommandSpec | undefined {
  const key = name.toLowerCase()
  return commandsFor(context).find((command) => command.name === key || command.aliases?.includes(key))
}

export type ParsedLine =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'command'; name: string; args: string[]; rest: string }

export function parseLine(raw: string): ParsedLine {
  const input = raw.trim()
  if (!input) return { kind: 'empty' }
  if (!input.startsWith('/')) return { kind: 'text', text: input }
  const match = /^\/(\S*)\s*([\s\S]*)$/.exec(input)!
  const rest = match[2].trim()
  return { kind: 'command', name: match[1].toLowerCase(), args: rest ? rest.split(/\s+/) : [], rest }
}

/** 去掉第一个参数后的原文：标题与备注里的多个空格不能被 split 吃掉。 */
export function restAfter(rest: string, count = 1): string {
  let remaining = rest.trimStart()
  for (let index = 0; index < count; index++) remaining = remaining.replace(/^\S+\s*/, '')
  return remaining.trim()
}

export interface Ref { scope: RefScope; label: string }

export function parseRef(token: string | undefined, fallback: RefScope | null): Ref | null {
  if (!token) return null
  const match = /^([gwdf])?(\d{1,4})(?:\.(\d{1,4}))?$/i.exec(token.trim())
  if (!match) return null
  const scope = (match[1]?.toLowerCase() as RefScope | undefined) || fallback
  if (!scope || Number(match[2]) < 1 || (match[3] !== undefined && Number(match[3]) < 1)) return null
  if (scope === 'f' && match[3] !== undefined) return null
  return { scope, label: `${scope}${Number(match[2])}${match[3] !== undefined ? `.${Number(match[3])}` : ''}` }
}

export interface IndexedTask { task: Task; ref: string; depth: 0 | 1 }

/** 编号只描述当前选区的显示顺序：顶层 d1、d2…，子任务 d1.1；它不写进数据，换选区就重新编号。 */
export function indexTasks(tasks: Task[], scope: RefScope): IndexedTask[] {
  const rows: IndexedTask[] = []
  tasks.filter((task) => !task.parentId).forEach((task, index) => {
    rows.push({ task, ref: `${scope}${index + 1}`, depth: 0 })
    tasks.filter((child) => child.parentId === task.id).forEach((child, childIndex) => {
      rows.push({ task: child, ref: `${scope}${index + 1}.${childIndex + 1}`, depth: 1 })
    })
  })
  return rows
}

export interface IndexedBlock { block: FocusBlock; ref: string }

export function indexBlocks(blocks: FocusBlock[]): IndexedBlock[] {
  return blocks.map((block, index) => ({ block, ref: `f${index + 1}` }))
}

// 一件事可能有好几个专注块：最值得看的是正在跑的、做了一半的、还没开始的，最后才是已结束的。
export function blockRank(block: FocusBlock): number {
  return block.status === 'running' ? 0 : block.status === 'paused' && block.elapsedMs > 0 ? 1 : block.status === 'paused' ? 2 : 3
}

/** 还能接着做的那一块：正在跑的、做了一半的、还没开始的；同一档按给出的顺序。都结束了就没有。 */
export function openBlock(blocks: FocusBlock[]): FocusBlock | undefined {
  return blocks.filter((block) => block.status !== 'finished').sort((a, b) => blockRank(a) - blockRank(b))[0]
}

export interface Selection { cycleId: string | null; week: string; date: string }

export interface BoardIndex {
  cycle?: GoalCycle
  g: IndexedTask[]
  w: IndexedTask[]
  d: IndexedTask[]
  f: IndexedBlock[]
  refOf: Map<string, string>
  /** 顶层任务所在的组：可见上级的 id，没有可见上级时为空串。场景按它画树，排序也只在组内进行。 */
  groupOf: Map<string, string>
}

/** 空串表示「未归属计划」；null 表示还没选，退回第一个项目（与旧版周期轨道一致）。 */
export function selectedCycleOf(snapshot: BoardSnapshot, cycleId: string | null): GoalCycle | undefined {
  if (cycleId === '') return undefined
  return snapshot.cycles.find((cycle) => cycle.id === cycleId) || snapshot.cycles[0]
}

// 上级不在本选区（别的周、已归档）时视为未关联：否则它会挂在一个看不见的节点下。
// 组序跟随上级的显示顺序，组内保持存储顺序，编号因此与树从上到下的顺序一致。
function groupByUpper(tasks: Task[], upperOrder: string[], groupOf: Map<string, string>): Task[] {
  const rank = new Map(upperOrder.map((id, position) => [id, position]))
  return tasks.map((task, position) => {
    const group = !task.parentId && task.upperTaskId && rank.has(task.upperTaskId) ? task.upperTaskId : ''
    if (!task.parentId) groupOf.set(task.id, group)
    return { task, position, order: group ? rank.get(group)! : upperOrder.length }
  }).sort((a, b) => a.order - b.order || a.position - b.position).map((entry) => entry.task)
}

const topIds = (rows: IndexedTask[]) => rows.filter((row) => !row.depth).map((row) => row.task.id)

export function buildIndex(snapshot: BoardSnapshot, selection: Selection): BoardIndex {
  const cycle = selectedCycleOf(snapshot, selection.cycleId)
  const placement = { cycleId: cycle?.id, weekKey: selection.week, dateKey: selection.date }
  const groupOf = new Map<string, string>()
  const g = indexTasks(tasksForPlacement(snapshot, 'long', placement), 'g')
  for (const row of g) if (!row.depth) groupOf.set(row.task.id, '')
  const w = indexTasks(groupByUpper(tasksForPlacement(snapshot, 'weekly', placement), topIds(g), groupOf), 'w')
  const d = indexTasks(groupByUpper(tasksForPlacement(snapshot, 'daily', placement), topIds(w), groupOf), 'd')
  // 专注块按它挂的日任务排（专注视图把块画在任务下面），挂不上的排最后、保持存储顺序，编号才与树从上到下一致。
  const taskOrder = new Map(d.map((row, position) => [row.task.id, position]))
  const order = (block: FocusBlock) => (block.taskId !== undefined && taskOrder.has(block.taskId) ? taskOrder.get(block.taskId)! : d.length)
  const f = indexBlocks(snapshot.focusBlocks.filter((block) => block.dateKey === selection.date).map((block, position) => ({ block, position }))
    .sort((a, b) => order(a.block) - order(b.block) || a.position - b.position).map((entry) => entry.block))
  const refOf = new Map<string, string>()
  for (const row of [...g, ...w, ...d]) refOf.set(row.task.id, row.ref)
  for (const row of f) refOf.set(row.block.id, row.ref)
  return { cycle, g, w, d, f, refOf, groupOf }
}

/** 场景里看得见的同级：同一父任务下的子任务，或同一组里的顶层任务。按任务自己的放置建索引，与当前选区无关；
 * 跨周、跨天任务在不同周、不同天里的邻居不同，所以给出正在看的选区时按那一周、那一天算。 */
export function sceneSiblings(snapshot: BoardSnapshot, task: Task, view?: Pick<Selection, 'week' | 'date'>): Task[] {
  const date = task.domain === 'daily' && view && coversDate(task, view.date) ? view.date : task.dateKey || ''
  const week = task.domain === 'weekly' && view && coversWeek(task, view.week) ? view.week : task.weekKey || (date ? weekKey(date) : '')
  const index = buildIndex(snapshot, { cycleId: task.cycleId ?? '', week, date })
  const group = index.groupOf.get(task.id)
  return index[DOMAIN_SCOPE[task.domain]].map((row) => row.task)
    .filter((candidate) => candidate.parentId === task.parentId && (task.parentId !== undefined || index.groupOf.get(candidate.id) === group))
}

/** 上移/下移只和组内相邻的一条换位：跟组外的同级换，界面上什么也不会变。冲突后重放也走这里。 */
export function reorderInScene(snapshot: BoardSnapshot, taskId: string, direction: -1 | 1, view?: Pick<Selection, 'week' | 'date'>): BoardSnapshot {
  const task = snapshot.tasks.find((candidate) => candidate.id === taskId && !candidate.archivedAt)
  if (!task) return snapshot
  const siblings = sceneSiblings(snapshot, task, view)
  const target = siblings[siblings.findIndex((candidate) => candidate.id === taskId) + direction]
  return target ? reorderSiblingTo(snapshot, taskId, target.id) : snapshot
}

/** 一次提交改到了哪些任务与专注块：重画后让这些行闪一下。顺序调整不改内容，由调用方另行标记。 */
export function changedIds(before: BoardSnapshot, after: BoardSnapshot): Set<string> {
  const previous = new Map<string, string>()
  for (const item of [...before.tasks, ...before.focusBlocks]) previous.set(item.id, JSON.stringify(item))
  const changed = new Set<string>()
  for (const item of [...after.tasks, ...after.focusBlocks]) if (previous.get(item.id) !== JSON.stringify(item)) changed.add(item.id)
  return changed
}

export function lookupRef(index: BoardIndex, ref: Ref): { task?: Task; block?: FocusBlock } | null {
  if (ref.scope === 'f') {
    const block = index.f.find((row) => row.ref === ref.label)?.block
    return block ? { block } : null
  }
  const task = index[ref.scope].find((row) => row.ref === ref.label)?.task
  return task ? { task } : null
}

const WEEKDAYS: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
  周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周日: 7,
}

const RELATIVE_DAYS: Record<string, number> = { today: 0, 今天: 0, tomorrow: 1, 明天: 1, yesterday: -1, 昨天: -1 }

/** 省略年份时怎么补：单点取离锚点最近的一年；区间终点与项目结束日期取锚点之后第一次出现（跨年只在半年之内），跨年的 W52..W02 才不会歧义。 */
export type YearFill = 'nearest' | 'onOrAfter'

const pad = (value: string) => value.padStart(2, '0')

const HALF_YEAR_MS = 183 * 86_400_000

// 最近的一年与之后第一次出现都落在锚点前后一年里；同样近时先取同一年，再下一年。
// 区间终点为了跨到下一年而补年份时只在半年之内成立：W52..W02 是跨年，W43..W41 多半是笔误，更远的请写年份。
function fillYear(anchorYear: number, anchorDate: string, build: (year: string) => string, valid: (key: string) => boolean, dateOf: (key: string) => string, fill: YearFill): string | null {
  const anchor = Date.parse(anchorDate)
  let best: string | null = null
  let distance = Infinity
  for (const candidate of [anchorYear, anchorYear + 1, anchorYear - 1].map((entry) => build(String(entry).padStart(4, '0'))).filter(valid)) {
    const gap = Date.parse(dateOf(candidate)) - anchor
    const score = fill === 'onOrAfter' ? (gap < 0 ? Infinity : gap) : Math.abs(gap)
    if (score < distance) { best = candidate; distance = score }
  }
  if (fill === 'onOrAfter' && best && Number(best.slice(0, 4)) > anchorYear && distance > HALF_YEAR_MS) return null
  return best
}

/**
 * 日期写法：2026-10-05、10-05、today/tomorrow/yesterday（今天/明天/昨天，相对真实的今天）、
 * mon…sun / 周一…周日（锚点所在的 ISO 周）、+N/-N（从锚点起的天数）。锚点是正在改的那个东西：正在看的那天，或任务自己的日期。
 */
export function parseDateArg(arg: string | undefined, anchor: string, today: string, fill: YearFill = 'nearest'): string | null {
  if (!arg) return null
  const value = arg.trim().toLowerCase()
  if (Object.hasOwn(RELATIVE_DAYS, value)) return addDays(today, RELATIVE_DAYS[value])
  if (/^[+-]\d{1,4}$/.test(value)) return addDays(anchor, Number(value))
  if (isDateKey(value)) return value
  const short = /^(\d{1,2})-(\d{1,2})$/.exec(value)
  if (short) return fillYear(Number(anchor.slice(0, 4)), anchor, (year) => `${year}-${pad(short[1])}-${pad(short[2])}`, isDateKey, (key) => key, fill)
  if (Object.hasOwn(WEEKDAYS, value)) return addDays(anchor, WEEKDAYS[value] - isoDay(anchor))
  return null
}

export function isWeekKey(value: string): boolean {
  try { weekRange(value); return true } catch { return false }
}

/** 周次写法：2026-W41、W41、+N/-N（从锚点起的周数），以及任何日期写法——取那一天所在的周（today 就是本周）。 */
export function parseWeekArg(arg: string | undefined, anchor: string, today: string, fill: YearFill = 'nearest'): string | null {
  if (!arg) return null
  const value = arg.trim().toLowerCase()
  if (/^[+-]\d{1,3}$/.test(value)) return shiftWeek(anchor, Number(value))
  const full = /^(\d{4})-w(\d{1,2})$/.exec(value)
  if (full) {
    const candidate = `${full[1]}-W${pad(full[2])}`
    return isWeekKey(candidate) ? candidate : null
  }
  const monday = weekRange(anchor).start
  const short = /^w(\d{1,2})$/.exec(value)
  if (short) return fillYear(Number(anchor.slice(0, 4)), monday, (year) => `${year}-W${pad(short[1])}`, isWeekKey, (key) => weekRange(key).start, fill)
  const date = parseDateArg(value, monday, today, fill)
  return date ? weekKey(date) : null
}

// 区间只认 `..`：两端各按单点解析，终点以起点为锚点（+N 从起点数，星期几落在起点那一周，省略年份取起点之后第一次出现）。
function parseSpan(arg: string | undefined, anchor: string, parse: (text: string, from: string, fill: YearFill) => string | null): Span | null {
  if (!arg) return null
  const parts = arg.split('..')
  if (parts.length > 2) return null
  const start = parse(parts[0], anchor, 'nearest')
  if (!start || parts.length === 1) return start ? { start, end: start } : null
  const end = parse(parts[1], start, 'onOrAfter')
  return end && end >= start ? { start, end } : null
}

/** `W41..W43`、`today..+2`（本周起共三周）、`W52..W02`（跨年）。 */
export function parseWeekSpanArg(arg: string | undefined, anchor: string, today: string): Span | null {
  return parseSpan(arg, anchor, (text, from, fill) => parseWeekArg(text, from, today, fill))
}

/** `mon..wed`、`10-05..10-07`、`today..+2`（今天起共三天）。是否出周由调用方判断。 */
export function parseDateSpanArg(arg: string | undefined, anchor: string, today: string): Span | null {
  return parseSpan(arg, anchor, (text, from, fill) => parseDateArg(text, from, today, fill))
}

/** 显示只在不是今年时带年份：日期比日历年，周次比今天所在周的 ISO 周年。 */
export function formatDate(date: string, today: string): string {
  return date.slice(0, 4) === today.slice(0, 4) ? date.slice(5) : date
}

export function formatWeek(week: string, today: string): string {
  return week.slice(0, 4) === weekKey(today).slice(0, 4) ? week.slice(5) : week
}

/** 区间终点的显示：起点带了年份时终点也带上——终点省略年份时按“起点之后第一次出现”解析，超过一年的区间会被读错。 */
export function formatSpanEnd(start: string, end: string, format: (key: string) => string): string {
  return format(start) === start ? end : format(end)
}

/** 区间写成 A..B，首尾相同只写一个；显示出来的文字以起点为锚点原样输入，能解析回同一个区间。 */
export function formatSpan(start: string, end: string | undefined, format: (key: string) => string): string {
  return !end || end === start ? format(start) : `${format(start)}..${formatSpanEnd(start, end, format)}`
}

export function parseMinutes(arg: string | undefined): number | null {
  if (!arg) return null
  const value = arg.trim().toLowerCase()
  const hours = /^(\d+(?:\.\d+)?)h(?:(\d+)m(?:in)?)?$/.exec(value)
  if (hours) return Number(hours[1]) * 60 + Number(hours[2] || 0)
  const minutes = /^(\d+(?:\.\d+)?)(?:m|min|分钟|分)?$/.exec(value)
  return minutes ? Number(minutes[1]) : null
}

export interface QuickAdd { title: string; color?: TaskColor; upper?: string; minutes?: number }

/** 行尾的 #色 / ^引用 / 时长 是可选修饰；只剥掉合法的修饰，标题里的“#1”之类原样保留。 */
export function parseQuickAdd(text: string, withMinutes = false): QuickAdd {
  const words = text.trim().split(/\s+/)
  const result: QuickAdd = { title: '' }
  while (words.length > 1) {
    const last = words[words.length - 1]
    const color = /^#(\w+)$/.exec(last)?.[1]?.toLowerCase()
    if (color && TASK_COLORS.includes(color as TaskColor) && !result.color) { result.color = color as TaskColor; words.pop(); continue }
    if (/^\^[gwdf]?\d+(?:\.\d+)?$/i.test(last) && !result.upper) { result.upper = last.slice(1); words.pop(); continue }
    const minutes = withMinutes && result.minutes === undefined ? parseMinutes(last) : null
    if (minutes !== null && minutes > 0) { result.minutes = minutes; words.pop(); continue }
    break
  }
  // 只有修饰被剥掉时才用重组的标题，否则保留原文里的空白。
  result.title = result.color || result.upper || result.minutes !== undefined ? words.join(' ') : text.trim()
  return result
}

export interface MenuItem { id: string; label: string; hint?: string; meta?: string; value?: string; run?: boolean }

export function completeCommand(input: string, context: ShellContext, language: Language): MenuItem[] {
  if (!input.startsWith('/') || /\s/.test(input)) return []
  const prefix = input.slice(1).toLowerCase()
  return commandsFor(context)
    .filter((command) => command.name.startsWith(prefix) || command.aliases?.some((alias) => alias.startsWith(prefix) && prefix.length > 0))
    .slice(0, 8)
    .map((command) => ({ id: command.name, label: `/${command.name}${command.args ? ` ${command.args}` : ''}`, hint: command[language], value: `/${command.name}`, run: !command.needsArg }))
}

/** 子序列模糊匹配：连续命中与词首命中加分；不匹配返回 null。 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase()
  if (!needle) return 0
  const hay = text.toLowerCase()
  const direct = hay.indexOf(needle)
  if (direct >= 0) return 1000 - direct - hay.length / 100
  let score = 0
  let position = -1
  let streak = 0
  for (const char of needle) {
    if (char === ' ') continue
    const next = hay.indexOf(char, position + 1)
    if (next < 0) return null
    streak = next === position + 1 ? streak + 1 : 0
    score += 10 + streak * 5 - Math.min(next - position, 10) + (next === 0 || /[\s\-_/·]/.test(hay[next - 1]) ? 8 : 0)
    position = next
  }
  return score
}

export function progressBar(fraction: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

// y/N 确认：空回车即“否”，与终端惯例一致；中文用户也可以答“是/否”。
export function isYes(answer: string): boolean { return /^(y|yes|是|好)$/i.test(answer.trim()) }
export function isAnswer(answer: string): boolean { return !answer.trim() || isYes(answer) || /^(n|no|否|不)$/i.test(answer.trim()) }

export interface SceneLocation { view: ViewName; cycleId?: string; date?: string; week?: string }

/** 场景写进地址栏：`#/day/2026-10-04@cycle_x`。浏览器的前进后退就是场景历史，刷新也停在原处。
 * 项目段可省（`@-` 表示未归属计划）；只认这一种形状，Supabase 回跳带的 `#access_token=` 不会被误读。 */
export function sceneHash(view: ViewName, selection: Selection): string {
  const place = view === 'week' ? `/${selection.week}` : view === 'goals' ? '' : `/${selection.date}`
  const project = selection.cycleId === null ? '' : `@${selection.cycleId || '-'}`
  return `#/${view}${place}${project}`
}

export function parseSceneHash(hash: string): SceneLocation | null {
  const match = /^#\/(goals|week|day|focus)(?:\/([0-9W-]+))?(?:@([\w-]+))?$/.exec(hash)
  if (!match) return null
  const view = match[1] as ViewName
  const cycleId = match[3] === undefined ? undefined : match[3] === '-' ? '' : match[3]
  const place = match[2]
  if (view === 'week') return place && isWeekKey(place) ? { view, cycleId, week: place } : place ? null : { view, cycleId }
  if (view === 'goals') return place ? null : { view, cycleId }
  return place && !isDateKey(place) ? null : { view, cycleId, date: place }
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match))
}

// 横幅字形：笔画由上到下从 : 渐变到 #，与 claude.dev 终端页的 ASCII 字同一路数。
const GLYPHS: Record<string, string[]> = {
  L: ['##......', '##......', '##......', '##......', '##......', '##......', '########'],
  I: ['######', '..##..', '..##..', '..##..', '..##..', '..##..', '######'],
  U: ['##....##', '##....##', '##....##', '##....##', '##....##', '##....##', '.######.'],
  B: ['#######.', '##....##', '##....##', '#######.', '##....##', '##....##', '#######.'],
  A: ['..####..', '.##..##.', '##....##', '##....##', '########', '##....##', '##....##'],
}
const INK: Array<[string, string]> = [[':', ':'], [':', '+'], ['+', ':'], ['+', '#'], ['#', '+'], ['#', '#'], ['#', '#']]

export function renderBanner(word = 'LIUBAI'): string[] {
  return INK.map((pair, row) => [...word].map((letter) => [...GLYPHS[letter][row]].map((pixel, column) => (pixel === '#' ? pair[column % 2] : ' ')).join('')).join('   ').trimEnd())
}
