import { addDays, isDateKey, isoDay, tasksForPlacement, weekKey, weekRange } from './domain'
import type { BoardSnapshot, Domain, FocusBlock, GoalCycle, Language, Task, TaskColor } from './types'

export type ViewName = 'goals' | 'week' | 'day' | 'focus' | 'tree'
export type RefScope = 'g' | 'w' | 'd' | 'f'
export type ShellContext = 'guest' | 'board' | 'account'

export const VIEWS: ViewName[] = ['goals', 'week', 'day', 'focus', 'tree']
export const VIEW_KEYS: Record<ViewName, string> = { goals: 'G', week: 'W', day: 'D', focus: 'F', tree: 'T' }
export const VIEW_SCOPE: Record<ViewName, RefScope | null> = { goals: 'g', week: 'w', day: 'd', focus: 'f', tree: null }
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
  { name: 'week', aliases: ['w'], args: '[W41|+1|-1|now]', zh: '周计划', en: 'weekly plan', context: BOARD },
  { name: 'day', aliases: ['d'], args: '[10-06|+1|-1|mon|today]', zh: '日计划', en: 'daily plan', context: BOARD },
  { name: 'focus', aliases: ['f'], args: '[date]', zh: '专注块与计时器', en: 'focus blocks and timers', context: BOARD },
  { name: 'tree', aliases: ['t'], zh: '目标 → 周 → 日 的关联树', en: 'goal → week → day map', context: BOARD },
  { name: 'today', zh: '回到今天与本周', en: 'jump to today and this week', context: BOARD },
  { name: 'project', aliases: ['p', 'cd'], args: '[n|name|new|edit|rm|up|down]', zh: '列出、切换或管理项目', en: 'list, switch or manage projects', context: BOARD },
  { name: 'add', aliases: ['a'], args: '<title> [#color] [^ref]', zh: '在当前视图新增（直接输入文字也可以）', en: 'add to the current view (or just type)', context: BOARD, needsArg: true },
  { name: 'sub', args: '<ref> <title>', zh: '新增子任务', en: 'add a subtask', context: BOARD, needsArg: true },
  { name: 'done', aliases: ['x', 'check'], args: '<ref…>', zh: '勾选 / 取消勾选', en: 'toggle done', context: BOARD, needsArg: true },
  { name: 'edit', aliases: ['e'], args: '<ref>', zh: '逐项编辑', en: 'edit field by field', context: BOARD, needsArg: true },
  { name: 'note', args: '<ref> <text>', zh: '改备注', en: 'set the note', context: BOARD, needsArg: true },
  { name: 'color', args: '<ref> <ink|blue|orange|green|violet>', zh: '改标记色', en: 'set the marker color', context: BOARD, needsArg: true },
  { name: 'link', args: '<ref> <ref|none>', zh: '关联上级（日→周，周→目标）', en: 'link to an upper task (day→week, week→goal)', context: BOARD, needsArg: true },
  { name: 'mv', aliases: ['move'], args: '<ref> <up|down|top|bottom|date|week>', zh: '排序或改期（连同子任务）', en: 'reorder or move with subtasks', context: BOARD, needsArg: true },
  { name: 'defer', args: '<ref> [date|week]', zh: '顺延，原记录留档', en: 'carry forward, keep the original', context: BOARD, needsArg: true },
  { name: 'rm', aliases: ['del', 'delete'], args: '<ref>', zh: '删除（会确认）', en: 'delete (asks first)', context: BOARD, needsArg: true },
  { name: 'start', args: '<f1|d1> [minutes]', zh: '开始专注；对日任务会新建计时', en: 'start a timer; a daily task gets a new block', context: BOARD, needsArg: true },
  { name: 'pause', zh: '暂停计时', en: 'pause the timer', context: BOARD },
  { name: 'resume', zh: '继续计时', en: 'resume the timer', context: BOARD },
  { name: 'stop', zh: '结束计时并记录', en: 'finish and record the timer', context: BOARD },
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
  { name: 'clear', aliases: ['cls'], zh: '清空滚动区（Ctrl+L）', en: 'clear the scrollback (Ctrl+L)', context: ANY },
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

export function indexBlocks(blocks: FocusBlock[]): Array<{ block: FocusBlock; ref: string }> {
  return blocks.map((block, index) => ({ block, ref: `f${index + 1}` }))
}

export interface Selection { cycleId: string | null; week: string; date: string }

export interface BoardIndex {
  cycle?: GoalCycle
  g: IndexedTask[]
  w: IndexedTask[]
  d: IndexedTask[]
  f: Array<{ block: FocusBlock; ref: string }>
  refOf: Map<string, string>
}

/** 空串表示「未归属计划」；null 表示还没选，退回第一个项目（与旧版周期轨道一致）。 */
export function selectedCycleOf(snapshot: BoardSnapshot, cycleId: string | null): GoalCycle | undefined {
  if (cycleId === '') return undefined
  return snapshot.cycles.find((cycle) => cycle.id === cycleId) || snapshot.cycles[0]
}

export function buildIndex(snapshot: BoardSnapshot, selection: Selection): BoardIndex {
  const cycle = selectedCycleOf(snapshot, selection.cycleId)
  const placement = { cycleId: cycle?.id, weekKey: selection.week, dateKey: selection.date }
  const g = indexTasks(tasksForPlacement(snapshot, 'long', placement), 'g')
  const w = indexTasks(tasksForPlacement(snapshot, 'weekly', placement), 'w')
  const d = indexTasks(tasksForPlacement(snapshot, 'daily', placement), 'd')
  const f = indexBlocks(snapshot.focusBlocks.filter((block) => block.dateKey === selection.date))
  const refOf = new Map<string, string>()
  for (const row of [...g, ...w, ...d]) refOf.set(row.task.id, row.ref)
  for (const row of f) refOf.set(row.block.id, row.ref)
  return { cycle, g, w, d, f, refOf }
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
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7,
  周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周日: 7, 周天: 7,
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
}

/** 日期参数相对“正在看的那天”解析，today/明天 这类词才相对真实的今天。 */
export function parseDateArg(arg: string | undefined, base: string, today: string): string | null {
  if (!arg) return null
  const value = arg.trim().toLowerCase()
  if (['today', 'now', '.', '今天'].includes(value)) return today
  if (['tomorrow', 'tmr', '明天'].includes(value)) return addDays(today, 1)
  if (['yesterday', '昨天'].includes(value)) return addDays(today, -1)
  if (/^[+-]\d{1,4}$/.test(value)) return addDays(base, Number(value))
  if (isDateKey(value)) return value
  const short = /^(\d{1,2})[-/.](\d{1,2})$/.exec(value)
  if (short) {
    const candidate = `${base.slice(0, 4)}-${short[1].padStart(2, '0')}-${short[2].padStart(2, '0')}`
    return isDateKey(candidate) ? candidate : null
  }
  const weekday = WEEKDAYS[value]
  if (weekday) return addDays(base, weekday - isoDay(base))
  return null
}

export function isWeekKey(value: string): boolean {
  try { weekRange(value); return true } catch { return false }
}

export function parseWeekArg(arg: string | undefined, base: string, current: string): string | null {
  if (!arg) return null
  const value = arg.trim().toLowerCase()
  if (['now', 'this', '.', '本周', 'today'].includes(value)) return current
  if (/^[+-]\d{1,3}$/.test(value)) return weekKey(addDays(weekRange(base).start, Number(value) * 7))
  const short = /^w?(\d{1,2})$/.exec(value)
  if (short) {
    const candidate = `${base.slice(0, 4)}-W${short[1].padStart(2, '0')}`
    return isWeekKey(candidate) ? candidate : null
  }
  const full = /^(\d{4})-?w(\d{1,2})$/.exec(value)
  if (full) {
    const candidate = `${full[1]}-W${full[2].padStart(2, '0')}`
    return isWeekKey(candidate) ? candidate : null
  }
  if (isDateKey(value)) return weekKey(value)
  return null
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
