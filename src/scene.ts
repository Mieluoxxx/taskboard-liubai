import { activeTasks, coversDate, coversWeek, dateKeysInRange, weekRange } from './domain'
import type { BoardIndex, IndexedBlock, IndexedTask } from './terminal'
import type { BoardSnapshot, FocusBlock, Task } from './types'

/**
 * 场景是画出来的：「目标 → 周 → 日」用 ├─ └─ 连成树，分布用 ●○ 点在格子里，进度与时钟用块字符。
 * 这里只算字符，不碰 DOM，便于在 node 里测；对齐依赖 Maple Mono CN 的 1:2 半角/全角宽度。
 */

const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/

/** 终端里的显示宽度：东亚宽字符占两格。只用于界面自带的短标签，用户标题不靠它对齐。 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += WIDE.test(char) ? 2 : 1
  return width
}

export interface TreeLine {
  /** 任务或专注块的 id；分组行用 `group:unlinked` / `group:focus`。 */
  id: string
  task?: Task
  block?: FocusBlock
  ref?: string
  /** 上层的上下文行：灰显、不带勾选框，点一下跳到它自己的视图。 */
  context: boolean
  /** 第一行的连线前缀。 */
  lead: string
  /** 第一行之后（折行、备注、展开的操作）沿用的连线，竖线才不会在长标题处断开。 */
  rest: string
}

interface TreeNode { id: string; task?: Task; block?: FocusBlock; ref?: string; context: boolean; children: TreeNode[] }

// 顶层节点之间不连线，读起来像小标题；第 n 层的连接符正好落在父节点编号的第一格下面。
export function flattenTree(roots: TreeNode[]): TreeLine[] {
  const lines: TreeLine[] = []
  const walk = (nodes: TreeNode[], prefix: string, root: boolean) => nodes.forEach((node, position) => {
    const last = position === nodes.length - 1
    const lead = root ? '' : `${prefix}${last ? '└─ ' : '├─ '}`
    const childPrefix = root ? '' : `${prefix}${last ? '   ' : '│  '}`
    lines.push({ id: node.id, task: node.task, block: node.block, ref: node.ref, context: node.context, lead, rest: `${childPrefix}${node.children.length ? '│' : ''}` })
    walk(node.children, childPrefix, false)
  })
  walk(roots, '', true)
  return lines
}

const UNLINKED = 'group:unlinked'
export const GROUP_FOCUS = 'group:focus'

type Attach = (task: Task) => TreeNode[]
const nothing: Attach = () => []

// attach 挂在任务自己的子任务前面：专注块说的是这件事本身，子任务是它拆出来的下一层。
function rowNode(row: IndexedTask, rows: IndexedTask[], context = false, attach = nothing): TreeNode {
  const children = rows.filter((child) => child.depth && child.task.parentId === row.task.id)
  return { id: row.task.id, task: row.task, ref: row.ref, context, children: [...attach(row.task), ...children.map((child) => ({ id: child.task.id, task: child.task, ref: child.ref, context, children: attach(child.task) }))] }
}

/** 没有任何关联时不画「未关联」这一层：一张纯列表比一棵只有一个假根的树好读。 */
function withUnlinked(linked: TreeNode[], loose: TreeNode[]): TreeNode[] {
  if (!linked.length) return loose
  return loose.length ? [...linked, { id: UNLINKED, context: true, children: loose }] : linked
}

function groupRows(rows: IndexedTask[], index: BoardIndex): Map<string, IndexedTask[]> {
  const groups = new Map<string, IndexedTask[]>()
  for (const row of rows) {
    if (row.depth) continue
    const key = index.groupOf.get(row.task.id) ?? ''
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return groups
}

export function goalsTree(index: BoardIndex): TreeLine[] {
  return flattenTree(index.g.filter((row) => !row.depth).map((row) => rowNode(row, index.g)))
}

/** 周视图：本周的周计划挂在各自的目标下，目标只作上下文。 */
export function weekTree(index: BoardIndex): TreeLine[] {
  const byGoal = groupRows(index.w, index)
  const linked = index.g.filter((goal) => !goal.depth && byGoal.has(goal.task.id))
    .map((goal) => ({ ...rowNode(goal, [], true), children: byGoal.get(goal.task.id)!.map((row) => rowNode(row, index.w)) }))
  return flattenTree(withUnlinked(linked, (byGoal.get('') ?? []).map((row) => rowNode(row, index.w))))
}

function dayNodes(index: BoardIndex, attach = nothing): TreeNode[] {
  const byWeek = groupRows(index.d, index)
  const weekNode = (week: IndexedTask): TreeNode => ({ ...rowNode(week, [], true), children: byWeek.get(week.task.id)!.map((row) => rowNode(row, index.d, false, attach)) })
  const weeks = index.w.filter((week) => !week.depth && byWeek.has(week.task.id))
  const goals = index.g.filter((goal) => !goal.depth && weeks.some((week) => index.groupOf.get(week.task.id) === goal.task.id))
  const linked = [
    ...goals.map((goal) => ({ ...rowNode(goal, [], true), children: weeks.filter((week) => index.groupOf.get(week.task.id) === goal.task.id).map(weekNode) })),
    ...weeks.filter((week) => !index.groupOf.get(week.task.id)).map(weekNode),
  ]
  return withUnlinked(linked, (byWeek.get('') ?? []).map((row) => rowNode(row, index.d, false, attach)))
}

/** 日视图：今天的事挂在本周计划下，本周计划再挂在目标下；没有今天任务的分支不画。 */
export function dayTree(index: BoardIndex): TreeLine[] {
  return flattenTree(dayNodes(index))
}

/**
 * 专注视图：日视图那棵树，每件日任务下面挂它这一天的专注块。挂不上的块（未关联、关联到别的项目或别的日子的任务）
 * 收进最后一组——专注块按日期跨项目共享，不能因为换了项目就看不见。
 */
export function focusTree(index: BoardIndex): TreeLine[] {
  const shown = new Set(index.d.map((row) => row.task.id))
  const node = (row: IndexedBlock): TreeNode => ({ id: row.block.id, block: row.block, ref: row.ref, context: false, children: [] })
  const tasks = dayNodes(index, (task) => index.f.filter((row) => row.block.taskId === task.id).map(node))
  const loose = index.f.filter((row) => !row.block.taskId || !shown.has(row.block.taskId)).map(node)
  if (!tasks.length) return flattenTree(loose)
  return flattenTree(loose.length ? [...tasks, { id: GROUP_FOCUS, context: true, children: loose }] : tasks)
}

export interface Marks { text: string; tone: 'none' | 'open' | 'part' | 'done' }

/** 一格里的分布：· 没有，● 完成，○ 未完成；放不下就写数字，格子够宽时写成「完成/总数」。 */
export function marks(tasks: Task[], width = 2): Marks {
  const done = tasks.filter((task) => task.checked).length
  if (!tasks.length) return { text: '·', tone: 'none' }
  const tone = done === tasks.length ? 'done' : done ? 'part' : 'open'
  if (tasks.length > width) return { text: width >= 4 ? `${done}/${tasks.length}` : String(tasks.length), tone }
  return { text: '●'.repeat(done) + '○'.repeat(tasks.length - done), tone }
}

/** 周计划落到了哪几天：只数挂在它下面、日期在这一周里的顶层日计划，跨天的日计划在它占的每一天都算。跨周任务按正在看的那一周数。 */
export function daysOfWeekTask(snapshot: BoardSnapshot, week: Task, viewWeek?: string): Map<string, Task[]> {
  const days = new Map<string, Task[]>()
  if (!week.weekKey) return days
  const range = weekRange(viewWeek && coversWeek(week, viewWeek) ? viewWeek : week.weekKey)
  const dates = dateKeysInRange(range.start, range.end)
  for (const task of activeTasks(snapshot, 'daily')) {
    if (task.parentId || task.upperTaskId !== week.id) continue
    for (const date of dates) if (coversDate(task, date)) days.set(date, [...(days.get(date) ?? []), task])
  }
  return days
}

/** 目标拆到了哪几周：跨周任务在它占的每一周都算一次，所以只在给定的周里展开，不按跨度逐周遍历。 */
export function weeksOfGoal(snapshot: BoardSnapshot, goal: Task, keys: string[]): Map<string, Task[]> {
  const weeks = new Map<string, Task[]>()
  for (const task of activeTasks(snapshot, 'weekly')) {
    if (task.parentId || task.upperTaskId !== goal.id) continue
    for (const key of keys) if (coversWeek(task, key)) weeks.set(key, [...(weeks.get(key) ?? []), task])
  }
  return weeks
}

/** 以 at 为中心取不超过 size 个，贴边时整体平移，保证总能取满。 */
export function windowAround<T>(items: T[], at: number, size: number): T[] {
  if (items.length <= size) return items
  const start = Math.max(0, Math.min(Math.max(0, at) - Math.floor(size / 2), items.length - size))
  return items.slice(start, start + size)
}

export type TimelineTone = 'past' | 'future' | 'span' | 'today'
export interface TimelineRun { text: string; tone: TimelineTone }

/**
 * 项目时间轴：一格代表一段日子，已过去 ━、未到 ─、今天 ●，正在看的那一段（span）另行着色。
 * 天数少于宽度时一格一天，不拉伸，免得 7 天的项目看起来和一年一样长。
 */
export function timeline(range: { start: string; end: string }, today: string, span: { start: string; end: string } | null, width: number): TimelineRun[] {
  const dates = dateKeysInRange(range.start, range.end)
  const cells = Math.max(1, Math.min(width, dates.length))
  const runs: TimelineRun[] = []
  for (let cell = 0; cell < cells; cell++) {
    const from = dates[Math.floor((cell * dates.length) / cells)]
    const to = dates[Math.floor(((cell + 1) * dates.length) / cells) - 1]
    const hasToday = from <= today && today <= to
    const char = hasToday ? '●' : to < today ? '━' : '─'
    const tone: TimelineTone = hasToday ? 'today' : span && from <= span.end && to >= span.start ? 'span' : to < today ? 'past' : 'future'
    const previous = runs[runs.length - 1]
    if (previous?.tone === tone) previous.text += char
    else runs.push({ text: char, tone })
  }
  return runs
}

// 3×5 像素数字，一个像素画成两个 █：等宽字一格是 0.6em 宽、行高约 1.25em，两格才接近正方形。
const DIGITS: Record<string, string[]> = {
  0: ['###', '#.#', '#.#', '#.#', '###'],
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['###', '..#', '###', '#..', '###'],
  3: ['###', '..#', '###', '..#', '###'],
  4: ['#.#', '#.#', '###', '..#', '..#'],
  5: ['###', '#..', '###', '..#', '###'],
  6: ['###', '#..', '###', '#.#', '###'],
  7: ['###', '..#', '..#', '..#', '..#'],
  8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '###'],
  ':': ['.', '#', '.', '#', '.'],
  '+': ['...', '.#.', '###', '.#.', '...'],
}

export function bigClock(text: string): string[] {
  const glyphs = [...text].map((char) => DIGITS[char]).filter(Boolean)
  return Array.from({ length: 5 }, (_, row) => glyphs.map((glyph) => glyph[row].replace(/#/g, '██').replace(/\./g, '  ')).join('  ').trimEnd())
}

export type DialTone = 'ring' | 'fill' | 'hand'
export interface DialRun { text: string; tone: DialTone }

export interface DialSpec {
  /** 行数；列数是它的两倍，钟面因此是正方形。 */
  rows: number
  /** 填满的扇形，以圈为单位从 12 点顺时针量，含起点不含终点。 */
  sector?: [number, number]
  /** 指针：方向以圈为单位，长度是半径的比例。 */
  hands?: Array<{ turn: number; length: number }>
}

// 一格四个象限像素，位序 左上 1、右上 2、左下 4、右下 8。
const QUADRANTS = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'
const DIAL_RANK: Record<DialTone, number> = { ring: 0, fill: 1, hand: 2 }
const SUB_X = 3
const SUB_Y = 6

/**
 * 方块字画的钟面：外圈 + 12 个刻度，可选一块扇形（计时器剩下的时间）和几根指针（墙上的钟）。
 * 盲文点阵在这款字体里点小、格间距大，画出来是散的；象限方块与像素大钟一样在行高 1.2 时上下相接。
 * 一格 0.6em × 1.2em 切成 2×2 个像素，像素是 1:2 的竖条，所以在以像素宽为单位、竖向放大一倍的坐标里画：
 * 面（表圈、扇形）按超采样覆盖过四成点亮；线（刻度、指针）沿线逐点取最近的像素，细横线才不会落在两行像素之间消失。
 * 一格只能有一种颜色，取最显眼的那层：指针 > 扇形 > 表圈。
 */
export function dial({ rows, sector, hands = [] }: DialSpec): DialRun[][] {
  const columns = rows * 2
  const center = rows * 2
  const radius = center - 0.5
  const lit = new Map<number, DialTone>()
  const put = (px: number, py: number, tone: DialTone) => {
    if (px < 0 || py < 0 || px >= columns * 2 || py >= rows * 2) return
    const key = py * columns * 2 + px
    const current = lit.get(key)
    if (!current || DIAL_RANK[tone] > DIAL_RANK[current]) lit.set(key, tone)
  }
  const area = (x: number, y: number): DialTone | null => {
    const distance = Math.hypot(x - center, y - center)
    if (sector && distance <= radius - 3) {
      const turn = (Math.atan2(x - center, center - y) / (2 * Math.PI) + 1) % 1
      if (turn >= sector[0] && turn < sector[1]) return 'fill'
    }
    return distance <= radius && distance >= radius - 1.6 ? 'ring' : null
  }
  for (let py = 0; py < rows * 2; py++) {
    for (let px = 0; px < columns * 2; px++) {
      const hits: Partial<Record<DialTone, number>> = {}
      for (let sy = 0; sy < SUB_Y; sy++) {
        for (let sx = 0; sx < SUB_X; sx++) {
          const tone = area(px + (sx + 0.5) / SUB_X, (py + (sy + 0.5) / SUB_Y) * 2)
          if (tone) hits[tone] = (hits[tone] ?? 0) + 1
        }
      }
      for (const tone of Object.keys(hits) as DialTone[]) if (hits[tone]! >= SUB_X * SUB_Y * 0.4) put(px, py, tone)
    }
  }
  // 线宽以像素宽为单位：offsets 是垂直于线的平移，时针比分针粗一像素。
  const line = (turn: number, from: number, to: number, tone: DialTone, offsets: number[]) => {
    const angle = turn * 2 * Math.PI
    const [dx, dy] = [Math.sin(angle), -Math.cos(angle)]
    for (const offset of offsets) {
      for (let step = from; step <= to; step += 0.25) put(Math.floor(center + dx * step - dy * offset), Math.floor((center + dy * step + dx * offset) / 2), tone)
    }
  }
  for (let hour = 0; hour < 12; hour++) line(hour / 12, radius - 1.6 - (hour % 3 ? 1.5 : 3), radius - 1.6, 'ring', [0])
  for (const hand of hands) line(hand.turn, 0, radius * hand.length, 'hand', hand.length < 0.6 ? [-0.5, 0.5] : [0])
  return Array.from({ length: rows }, (_, row) => {
    const runs: DialRun[] = []
    for (let column = 0; column < columns; column++) {
      let bits = 0
      let tone: DialTone = 'ring'
      for (const [bit, dx, dy] of [[1, 0, 0], [2, 1, 0], [4, 0, 1], [8, 1, 1]]) {
        const found = lit.get((row * 2 + dy) * columns * 2 + column * 2 + dx)
        if (!found) continue
        bits |= bit
        if (DIAL_RANK[found] > DIAL_RANK[tone]) tone = found
      }
      const char = QUADRANTS[bits]
      const previous = runs[runs.length - 1]
      // 空格没有颜色，并进前一段，免得一行被切成很多段。
      if (previous && (previous.tone === tone || !bits)) previous.text += char
      else runs.push({ text: char, tone })
    }
    return runs
  })
}
