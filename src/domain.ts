import { BoardError } from './notices'
import type { BoardSnapshot, Domain, FocusBlock, FocusStatus, GoalCycle, Task, TaskColor } from './types'

export const MAX_BOARD_BYTES = 900_000
export const MAX_TASKS = 2_000
export const MAX_TASK_TITLE_LENGTH = 450
export const MAX_TASK_NOTE_LENGTH = 3_000
export const MAX_FOCUS_BLOCKS = 500
export const MAX_TIMER_MINUTES = 24 * 60
export const MAX_ELAPSED_MS = 86_400_000

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = DATE_RE.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12))
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
}

function dateParts(dateKey: string): [number, number, number] {
  const match = DATE_RE.exec(dateKey)
  if (!match) throw new Error(`Invalid date key: ${dateKey}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** 日历运算在 UTC noon 进行，避免本地 DST 过渡移动日期。 */
export function addDays(dateKey: string, amount: number): string {
  if (!isDateKey(dateKey) || !Number.isInteger(amount)) throw new Error('Invalid calendar date arithmetic')
  const [year, month, day] = dateParts(dateKey)
  const date = new Date(Date.UTC(year, month - 1, day, 12))
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

export function compareDateKeys(left: string, right: string): number {
  if (!isDateKey(left) || !isDateKey(right)) throw new Error('Invalid date key comparison')
  return left < right ? -1 : left > right ? 1 : 0
}

export function isoDay(dateKey: string): number {
  if (!isDateKey(dateKey)) throw new Error('Invalid date key')
  const [year, month, day] = dateParts(dateKey)
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay() || 7
}

export function weekStart(dateKey: string): string {
  return addDays(dateKey, 1 - isoDay(dateKey))
}

export function weekKey(dateKey: string): string {
  const thursday = addDays(dateKey, 4 - isoDay(dateKey))
  const [year] = dateParts(thursday)
  const firstThursday = addDays(`${year}-01-04`, 4 - isoDay(`${year}-01-04`))
  const days = Math.round((calendarNoon(thursday).getTime() - calendarNoon(firstThursday).getTime()) / 86_400_000)
  return `${year}-W${String(Math.floor(days / 7) + 1).padStart(2, '0')}`
}

export function weekRange(key: string): { start: string; end: string } {
  const match = /^(\d{4})-W(\d{2})$/.exec(key)
  if (!match) throw new Error(`Invalid ISO week key: ${key}`)
  const year = Number(match[1])
  const week = Number(match[2])
  if (week < 1 || week > 53) throw new Error(`Invalid ISO week key: ${key}`)
  const firstThursday = addDays(`${year}-01-04`, 4 - isoDay(`${year}-01-04`))
  const start = addDays(firstThursday, (week - 1) * 7 - 3)
  if (weekKey(start) !== key) throw new Error(`Invalid ISO week key: ${key}`)
  return { start, end: addDays(start, 6) }
}

export function dateKeysInRange(startDate: string, endDate: string): string[] {
  if (!isDateKey(startDate) || !isDateKey(endDate) || compareDateKeys(startDate, endDate) > 0) throw new Error('Invalid date range')
  const dates: string[] = []
  for (let date = startDate; ; date = addDays(date, 1)) {
    dates.push(date)
    if (date === endDate) break
  }
  return dates
}

export function weekKeysInRange(startDate: string, endDate: string): string[] {
  if (!isDateKey(startDate) || !isDateKey(endDate) || compareDateKeys(startDate, endDate) > 0) throw new Error('Invalid date range')
  const weeks: string[] = []
  const lastWeekStart = weekStart(endDate)
  for (let date = weekStart(startDate); ; date = addDays(date, 7)) {
    weeks.push(weekKey(date))
    if (date === lastWeekStart) break
  }
  return weeks
}

function calendarNoon(dateKey: string): Date {
  const [year, month, day] = dateParts(dateKey)
  return new Date(Date.UTC(year, month - 1, day, 12))
}

export function todayInTimeZone(timeZone: string, now = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

// 与数据库 private.validate_board_snapshot 的 pg_timezone_names 成员校验对齐：
// Intl 还接受 "+08:00" 这类偏移时区，而 Postgres 时区表里没有，云端保存会被拒绝，
// 因此这里只接受 IANA 形状的名称，避免界面接受一个存不进去的值。
const IANA_ZONE_RE = /^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*$/

export function safeTimeZone(timeZone?: unknown): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  if (typeof timeZone !== 'string' || timeZone.length > 100) return fallback
  if (!IANA_ZONE_RE.test(timeZone)) return fallback
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
    return timeZone
  } catch {
    return fallback
  }
}

export function formatDateKey(dateKey: string, language: 'zh' | 'en', timeZone?: string): string {
  if (!isDateKey(dateKey)) return dateKey
  const [year, month, day] = dateParts(dateKey)
  // 日期键已经是 board 时区的日历日期；以 UTC 格式化可避免偏移到相邻日期。
  void timeZone
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)))
}

export function elapsedMsAt(block: FocusBlock, now = Date.now()): number {
  const started = block.startedAt ? Date.parse(block.startedAt) : NaN
  const live = block.status === 'running' && Number.isFinite(started) ? Math.max(0, now - started) : 0
  return Math.max(0, Math.round(block.elapsedMs) + live)
}

export function focusDisplayStatus(block: FocusBlock, now = Date.now()): FocusStatus | 'complete' {
  if (block.status === 'finished') return 'finished'
  return elapsedMsAt(block, now) >= block.durationMinutes * 60_000 ? 'complete' : block.status
}

export function validateDurationMinutes(value: unknown): number {
  const duration = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_TIMER_MINUTES) {
    throw new BoardError('noticeTimerDuration', `Timer duration must be between 0 and ${MAX_TIMER_MINUTES} minutes`)
  }
  return Math.round(duration * 10) / 10
}

export function createId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return `${prefix}_${uuid || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`
}

export function emptySnapshot(timeZone = safeTimeZone()): BoardSnapshot {
  return {
    schemaVersion: 1,
    settings: { timeZone },
    cycles: [],
    tasks: [],
    focusBlocks: [],
  }
}

function validEnum<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}


function validIso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
}

function validWeekKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-W\d{2}$/.test(value)) return false
  try { weekRange(value); return true } catch { return false }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (!validId(value)) throw new BoardError('noticeInvalidState', `Board ${key} is invalid`)
  return value
}

/** 所有外部快照先验证，再进入 React 或变更辅助函数。 */
export function validateSnapshot(value: unknown): BoardSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.settings)) {
    throw new BoardError('noticeInvalidState', 'Board snapshot has an unsupported shape')
  }
  const encoded = JSON.stringify(value)
  if (new TextEncoder().encode(encoded).byteLength > MAX_BOARD_BYTES) throw new BoardError('noticeInvalidState', 'Board snapshot is too large')
  if (value.settings.timeZone !== safeTimeZone(value.settings.timeZone)) throw new BoardError('noticeInvalidState', 'Board timezone is invalid')
  const timeZone = value.settings.timeZone
  if (typeof timeZone !== 'string') throw new BoardError('noticeInvalidState', 'Board timezone is invalid')
  if (!Array.isArray(value.cycles) || value.cycles.length > 200) throw new BoardError('noticeInvalidState', 'Board cycles are invalid')
  if (!Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS) throw new BoardError('noticeInvalidState', 'Board tasks are invalid')
  if (!Array.isArray(value.focusBlocks) || value.focusBlocks.length > MAX_FOCUS_BLOCKS) throw new BoardError('noticeInvalidState', 'Board focus blocks are invalid')

  const cycles: GoalCycle[] = []
  const cycleIds = new Set<string>()
  for (const raw of value.cycles) {
    if (!isRecord(raw) || !validId(raw.id) || cycleIds.has(raw.id) ||
      typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.length > 160 ||
      !isDateKey(raw.startDate) || !isDateKey(raw.endDate) || compareDateKeys(raw.startDate, raw.endDate) > 0 ||
      !validIso(raw.createdAt)) throw new BoardError('noticeInvalidState', 'Board cycle is invalid')
    const id = raw.id
    const name = raw.name
    const startDate = raw.startDate
    const endDate = raw.endDate
    const createdAt = raw.createdAt
    cycleIds.add(id)
    cycles.push({ id, name, startDate, endDate, createdAt })
  }

  const tasks: Task[] = []
  const taskIds = new Set<string>()
  for (const raw of value.tasks) {
    if (!isRecord(raw) || !validId(raw.id) || taskIds.has(raw.id) ||
      !validEnum(raw.domain, ['long', 'weekly', 'daily'] as const) ||
      typeof raw.title !== 'string' || raw.title.trim().length === 0 || raw.title.length > MAX_TASK_TITLE_LENGTH ||
      typeof raw.note !== 'string' || raw.note.length > MAX_TASK_NOTE_LENGTH || typeof raw.checked !== 'boolean' ||
      !validEnum(raw.color, ['ink', 'blue', 'orange', 'green', 'violet'] as const) ||
      !validIso(raw.createdAt) || !validIso(raw.updatedAt)) throw new BoardError('noticeInvalidState', 'Board task is invalid')
    const cycleId = optionalString(raw, 'cycleId')
    const week = optionalString(raw, 'weekKey')
    const date = raw.dateKey
    if (date !== undefined && !isDateKey(date)) throw new BoardError('noticeInvalidState', 'Board task placement is invalid')
    const parentId = optionalString(raw, 'parentId')
    const upperTaskId = optionalString(raw, 'upperTaskId')
    if (raw.domain === 'long' && (!cycleId || !cycleIds.has(cycleId) || week !== undefined || date !== undefined)) throw new BoardError('noticeInvalidState', 'Long-term task placement is invalid')
    if (raw.domain === 'weekly' && (cycleId !== undefined || date !== undefined || !validWeekKey(week))) throw new BoardError('noticeInvalidState', 'Weekly task placement is invalid')
    if (raw.domain === 'daily' && (cycleId !== undefined || week !== undefined || !isDateKey(date))) throw new BoardError('noticeInvalidState', 'Daily task placement is invalid')
    const archivedAt = raw.archivedAt
    if (archivedAt !== undefined && !validIso(archivedAt)) throw new BoardError('noticeInvalidState', 'Archived task timestamp is invalid')
    const archivedReason = raw.archivedReason
    if (archivedReason !== undefined && archivedReason !== 'rescheduled') throw new BoardError('noticeInvalidState', 'Archived task reason is invalid')
    const rescheduledTo = optionalString(raw, 'rescheduledTo')
    if ((archivedReason !== undefined || rescheduledTo !== undefined) && archivedAt === undefined) throw new BoardError('noticeInvalidState', 'Archived task metadata is invalid')
    const id = raw.id
    const domain = raw.domain
    const title = raw.title
    const note = raw.note
    const checked = raw.checked
    const color = raw.color
    const createdAt = raw.createdAt
    const updatedAt = raw.updatedAt
    taskIds.add(id)
    tasks.push({
      id, domain, title, note, checked, color,
      createdAt, updatedAt,
      ...(cycleId ? { cycleId } : {}), ...(week ? { weekKey: week } : {}), ...(date ? { dateKey: date } : {}),
      ...(parentId ? { parentId } : {}), ...(upperTaskId ? { upperTaskId } : {}),
      ...(archivedAt ? { archivedAt } : {}), ...(archivedReason ? { archivedReason } : {}), ...(rescheduledTo ? { rescheduledTo } : {}),
    })
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]))
  for (const task of tasks) {
    if (task.parentId !== undefined) {
      const parent = taskById.get(task.parentId)
      if (!parent || parent.domain !== task.domain || parent.parentId !== undefined || parent.id === task.id ||
        parent.cycleId !== task.cycleId || parent.weekKey !== task.weekKey || parent.dateKey !== task.dateKey) {
        throw new BoardError('noticeInvalidState', 'Task subtask graph is invalid')
      }
    }
    if (task.upperTaskId !== undefined) {
      if (task.parentId !== undefined) throw new BoardError('noticeInvalidState', 'Subtasks cannot cross-link')
      const upper = taskById.get(task.upperTaskId)
      const allowed = task.domain === 'weekly' ? upper?.domain === 'long' : task.domain === 'daily' ? upper?.domain === 'weekly' : false
      if (!upper || upper.parentId !== undefined || !allowed || upper.id === task.id) throw new BoardError('noticeInvalidState', 'Task association is invalid')
    }
    if (task.rescheduledTo !== undefined && !taskById.has(task.rescheduledTo)) throw new BoardError('noticeInvalidState', 'Reschedule target is invalid')
  }

  const focusBlocks: FocusBlock[] = []
  const focusIds = new Set<string>()
  let running = 0
  for (const raw of value.focusBlocks) {
    if (!isRecord(raw) || !validId(raw.id) || focusIds.has(raw.id) || !isDateKey(raw.dateKey) ||
      typeof raw.title !== 'string' || raw.title.trim().length === 0 || raw.title.length > 300 ||
      !validEnum(raw.status, ['running', 'paused', 'finished'] as const) || typeof raw.elapsedMs !== 'number' ||
      !Number.isFinite(raw.elapsedMs) || raw.elapsedMs < 0 || raw.elapsedMs > MAX_ELAPSED_MS || !validIso(raw.createdAt)) throw new BoardError('noticeInvalidState', 'Focus block is invalid')
    const durationMinutes = validateDurationMinutes(raw.durationMinutes)
    const taskId = optionalString(raw, 'taskId')
    const startedAt = raw.startedAt
    const finishedAt = raw.finishedAt
    if (startedAt !== undefined && !validIso(startedAt)) throw new BoardError('noticeInvalidState', 'Focus start timestamp is invalid')
    if (finishedAt !== undefined && !validIso(finishedAt)) throw new BoardError('noticeInvalidState', 'Focus finish timestamp is invalid')
    if (raw.status === 'running' && (startedAt === undefined || finishedAt !== undefined)) throw new BoardError('noticeInvalidState', 'Running focus timer is invalid')
    if (raw.status === 'paused' && startedAt !== undefined) throw new BoardError('noticeInvalidState', 'Paused focus timer is invalid')
    if (raw.status === 'finished' && (startedAt !== undefined || finishedAt === undefined)) throw new BoardError('noticeInvalidState', 'Finished focus timer is invalid')
    if (taskId !== undefined && taskById.get(taskId)?.domain !== 'daily') throw new BoardError('noticeInvalidState', 'Focus task association is invalid')
    const id = raw.id
    const dateKey = raw.dateKey
    const title = raw.title
    const status = raw.status
    const createdAt = raw.createdAt
    focusIds.add(id)
    if (raw.status === 'running') running += 1
    focusBlocks.push({
      id, dateKey, title, durationMinutes, status, elapsedMs: Math.round(raw.elapsedMs), createdAt,
      ...(taskId ? { taskId } : {}), ...(startedAt ? { startedAt } : {}), ...(finishedAt ? { finishedAt } : {}),
    })
  }
  if (running > 1) throw new BoardError('noticeInvalidState', 'Only one focus timer may be running')
  return { schemaVersion: 1, settings: { timeZone }, cycles, tasks, focusBlocks }
}

export function cloneSnapshot(snapshot: BoardSnapshot): BoardSnapshot {
  return structuredClone(snapshot)
}

export function activeTasks(snapshot: BoardSnapshot, domain?: Domain): Task[] {
  return snapshot.tasks.filter((task) => !task.archivedAt && (!domain || task.domain === domain))
}

export function updateTask(snapshot: BoardSnapshot, taskId: string, patch: Partial<Task>, now = new Date().toISOString()): BoardSnapshot {
  const next = cloneSnapshot(snapshot)
  const task = next.tasks.find((candidate) => candidate.id === taskId)
  if (!task || task.archivedAt) throw new BoardError('noticeTaskMissing', 'Task no longer exists')
  Object.assign(task, patch, { updatedAt: now })
  validateSnapshot(next)
  return next
}

export function deleteTask(snapshot: BoardSnapshot, taskId: string, now = new Date().toISOString()): BoardSnapshot {
  const next = cloneSnapshot(snapshot)
  const removed = new Set<string>([taskId])
  let changed = true
  while (changed) {
    changed = false
    for (const task of next.tasks) {
      if (task.parentId && removed.has(task.parentId) && !removed.has(task.id)) {
        removed.add(task.id)
        changed = true
      }
    }
  }
  if (!next.tasks.some((task) => task.id === taskId && !task.archivedAt)) throw new BoardError('noticeTaskMissing', 'Task no longer exists')
  // 删除任务只解除跨域下级关联，不在域之间级联。
  for (const task of next.tasks) {
    if (task.upperTaskId && removed.has(task.upperTaskId)) {
      task.upperTaskId = undefined
      task.updatedAt = now
    }
  }
  next.tasks = next.tasks.filter((task) => !removed.has(task.id))
  // 被删除的任务可能是别人的重排目标；清理指向它的悬空指针，否则快照校验会拒绝整个删除。
  for (const task of next.tasks) {
    if (task.rescheduledTo && removed.has(task.rescheduledTo)) {
      task.rescheduledTo = undefined
      task.updatedAt = now
    }
  }
  for (const block of next.focusBlocks) {
    if (block.taskId && removed.has(block.taskId)) block.taskId = undefined
  }
  validateSnapshot(next)
  return next
}

export function linkedChainIds(snapshot: BoardSnapshot, taskId: string): Set<string> {
  const related = new Set<string>([taskId])
  let changed = true
  while (changed) {
    changed = false
    for (const task of snapshot.tasks) {
      if (task.archivedAt) continue
      if ((task.upperTaskId && related.has(task.upperTaskId)) || (task.parentId && related.has(task.parentId))) {
        if (!related.has(task.id)) {
          related.add(task.id)
          changed = true
        }
      }
      if (related.has(task.id) && task.upperTaskId && !related.has(task.upperTaskId)) {
        related.add(task.upperTaskId)
        changed = true
      }
      if (related.has(task.id) && task.parentId && !related.has(task.parentId)) {
        related.add(task.parentId)
        changed = true
      }
    }
  }
  return related
}

// 顺序变更也是用户改动，需要能被「重新打开编辑器」重放：返回本次移动的领域与方向，
// 恢复时对同一任务再执行一次同样的移动即可（而不是把旧整板写回去）。
export function reorderOrigin(task: Task, direction: -1 | 1): { kind: 'reorder'; taskId: string; direction: -1 | 1; domain: Domain } {
  return { kind: 'reorder', taskId: task.id, direction, domain: task.domain }
}

/** 恢复一次「上移/下移」：尽力而为——目标任务若已不存在（被他端删除）则原样返回。 */
export function reapplyReorder(snapshot: BoardSnapshot, taskId: string, direction: -1 | 1): BoardSnapshot {
  if (!snapshot.tasks.some((task) => task.id === taskId && !task.archivedAt)) return snapshot
  return reorderSibling(snapshot, taskId, direction)
}

export function reorderSibling(snapshot: BoardSnapshot, taskId: string, direction: -1 | 1): BoardSnapshot {
  const task = snapshot.tasks.find((candidate) => candidate.id === taskId && !candidate.archivedAt)
  if (!task) throw new BoardError('noticeTaskMissing', 'Task no longer exists')
  const siblings = siblingTasks(snapshot, task)
  const target = siblings[siblings.indexOf(task) + direction]
  return target ? reorderSiblingTo(snapshot, taskId, target.id) : snapshot
}

function siblingTasks(snapshot: BoardSnapshot, task: Task): Task[] {
  return snapshot.tasks.filter((candidate) => !candidate.archivedAt && candidate.domain === task.domain &&
    candidate.parentId === task.parentId && candidate.cycleId === task.cycleId && candidate.weekKey === task.weekKey && candidate.dateKey === task.dateKey)
}

/** 一次性移到目标同级位置；无效或过期落点不写入，也不改变任务内容与其他列表的位置。 */
export function reorderSiblingTo(snapshot: BoardSnapshot, taskId: string, targetId: string): BoardSnapshot {
  const task = snapshot.tasks.find((candidate) => candidate.id === taskId && !candidate.archivedAt)
  if (!task || taskId === targetId) return snapshot
  const siblings = siblingTasks(snapshot, task)
  const targetIndex = siblings.findIndex((candidate) => candidate.id === targetId)
  if (targetIndex < 0) return snapshot
  const slots = new Set(siblings)
  siblings.splice(siblings.indexOf(task), 1)
  siblings.splice(targetIndex, 0, task)
  let index = 0
  return { ...snapshot, tasks: snapshot.tasks.map((candidate) => slots.has(candidate) ? siblings[index++] : candidate) }
}

// 日任务与周任务的顺延只差「改哪个放置键」：旧条目归档并指向副本，重复顺延形成可审阅链。
function reschedulePlacement(next: BoardSnapshot, root: Task, key: 'dateKey' | 'weekKey', target: string, now: string): void {
  if (root[key] === target) throw new BoardError('noticeRescheduleInvalid', 'Choose a different target period')
  const subtree = next.tasks.filter((task) => task.id === root.id || task.parentId === root.id)
  const idMap = new Map<string, string>()
  for (const task of subtree) idMap.set(task.id, createId('task'))
  const copies = subtree.map((task) => {
    const copy: Task = {
      ...task,
      id: idMap.get(task.id) as string,
      ...(key === 'dateKey' ? { dateKey: target } : { weekKey: target }),
      parentId: task.parentId ? idMap.get(task.parentId) : undefined,
      createdAt: now,
      updatedAt: now,
      archivedAt: undefined,
      archivedReason: undefined,
      rescheduledTo: undefined,
    }
    return copy
  })
  for (const task of subtree) {
    task.archivedAt = now
    task.archivedReason = 'rescheduled'
    task.rescheduledTo = idMap.get(task.id)
    task.updatedAt = now
  }
  next.tasks.push(...copies)
}

export function rescheduleDailyTask(snapshot: BoardSnapshot, taskId: string, targetDate: string, now = new Date().toISOString()): BoardSnapshot {
  if (!isDateKey(targetDate)) throw new BoardError('noticeRescheduleInvalid', 'Choose a valid target date')
  const next = cloneSnapshot(snapshot)
  const root = next.tasks.find((task) => task.id === taskId && !task.archivedAt)
  if (!root || root.domain !== 'daily') throw new BoardError('noticeRescheduleInvalid', 'Only active daily tasks can be rescheduled')
  reschedulePlacement(next, root, 'dateKey', targetDate, now)
  validateSnapshot(next)
  return next
}

export function rescheduleWeeklyTask(snapshot: BoardSnapshot, taskId: string, targetWeek: string, now = new Date().toISOString()): BoardSnapshot {
  if (!validWeekKey(targetWeek)) throw new BoardError('noticeRescheduleInvalid', 'Choose a valid target week')
  const next = cloneSnapshot(snapshot)
  const root = next.tasks.find((task) => task.id === taskId && !task.archivedAt)
  if (!root || root.domain !== 'weekly') throw new BoardError('noticeRescheduleInvalid', 'Only active weekly tasks can be rescheduled')
  reschedulePlacement(next, root, 'weekKey', targetWeek, now)
  validateSnapshot(next)
  return next
}

export function createTask(input: {
  domain: Domain
  title: string
  note?: string
  color?: TaskColor
  cycleId?: string
  weekKey?: string
  dateKey?: string
  upperTaskId?: string
  parentId?: string
}, now = new Date().toISOString()): Task {
  const task: Task = {
    id: createId('task'),
    domain: input.domain,
    title: input.title.trim(),
    note: input.note?.trim() || '',
    checked: false,
    color: input.color || 'ink',
    createdAt: now,
    updatedAt: now,
    cycleId: input.cycleId,
    weekKey: input.weekKey,
    dateKey: input.dateKey,
    upperTaskId: input.upperTaskId,
    parentId: input.parentId,
  }
  return task
}

export function setFocusCommand(snapshot: BoardSnapshot, blockId: string, command: 'start' | 'pause' | 'resume' | 'finish', now = new Date().toISOString()): BoardSnapshot {
  const next = cloneSnapshot(snapshot)
  const block = next.focusBlocks.find((candidate) => candidate.id === blockId)
  if (!block) throw new BoardError('noticeTimerMissing', 'Focus block no longer exists')
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) throw new BoardError('noticeTimerMissing', 'Invalid timer timestamp')
  if ((command === 'start' || command === 'resume') && next.focusBlocks.some((candidate) => candidate.id !== blockId && candidate.status === 'running')) {
    throw new BoardError('noticeTimerBusy', 'Another focus timer is already running')
  }
  if (command === 'start' || command === 'resume') {
    if (block.status === 'finished') throw new BoardError('noticeTimerFinished', 'Finished focus blocks cannot be restarted')
    block.status = 'running'
    block.startedAt = now
  } else {
    if (block.status === 'running' && block.startedAt) {
      // 上限截断：运行超过上限（例如忘了关）时，不截断会导致后续 finish 永远被校验拒绝。
      block.elapsedMs = Math.min(elapsedMsAt(block, nowMs), MAX_ELAPSED_MS)
    }
    block.startedAt = undefined
    if (command === 'pause') block.status = 'paused'
    if (command === 'finish') {
      block.status = 'finished'
      block.finishedAt = now
    }
  }
  validateSnapshot(next)
  return next
}

export function addCycle(snapshot: BoardSnapshot, name: string, startDate: string, endDate: string, now = new Date().toISOString()): BoardSnapshot {
  if (!name.trim() || !isDateKey(startDate) || !isDateKey(endDate) || compareDateKeys(startDate, endDate) > 0) {
    throw new BoardError('noticeCycleInvalid', 'Cycle name and date range are required')
  }
  const next = cloneSnapshot(snapshot)
  next.cycles.push({ id: createId('cycle'), name: name.trim(), startDate, endDate, createdAt: now })
  validateSnapshot(next)
  return next
}



export function validateStoredBoard(value: unknown): StoredBoardLike {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new BoardError('noticeInvalidState', 'Stored board revision is invalid')
  }
  return { revision: value.revision as number, snapshot: validateSnapshot(value.snapshot) }
}

export interface StoredBoardLike {
  revision: number
  snapshot: BoardSnapshot
}

export function createFocusBlock(input: {
  dateKey: string
  title: string
  taskId?: string
  durationMinutes?: number
}, now = new Date().toISOString()): FocusBlock {
  if (!isDateKey(input.dateKey) || !input.title.trim()) throw new BoardError('noticeFocusSaveFailed', 'Focus date and title are required')
  return {
    id: createId('focus'),
    dateKey: input.dateKey,
    title: input.title.trim(),
    taskId: input.taskId,
    durationMinutes: validateDurationMinutes(input.durationMinutes ?? 45),
    status: 'paused',
    elapsedMs: 0,
    createdAt: now,
  }
}

export function addTask(snapshot: BoardSnapshot, task: Task): BoardSnapshot {
  const next = cloneSnapshot(snapshot)
  next.tasks.push(task)
  validateSnapshot(next)
  return next
}

export function addFocusBlock(snapshot: BoardSnapshot, block: FocusBlock): BoardSnapshot {
  const next = cloneSnapshot(snapshot)
  next.focusBlocks.push(block)
  validateSnapshot(next)
  return next
}

export function updateFocusBlock(snapshot: BoardSnapshot, blockId: string, patch: Partial<FocusBlock>): BoardSnapshot {
  const next = cloneSnapshot(snapshot)
  const block = next.focusBlocks.find((candidate) => candidate.id === blockId)
  if (!block) throw new BoardError('noticeTimerMissing', 'Focus block no longer exists')
  if (block.status !== 'paused' || block.elapsedMs > 0) {
    if (patch.durationMinutes !== undefined && patch.durationMinutes !== block.durationMinutes) {
      throw new BoardError('noticeTimerLocked', 'Focus duration can only be changed before the first start')
    }
  }
  Object.assign(block, patch)
  validateSnapshot(next)
  return next
}

export function deleteFocusBlock(snapshot: BoardSnapshot, blockId: string): BoardSnapshot {
  const next = cloneSnapshot(snapshot)
  const index = next.focusBlocks.findIndex((block) => block.id === blockId)
  if (index < 0) throw new BoardError('noticeTimerMissing', 'Focus block no longer exists')
  next.focusBlocks.splice(index, 1)
  validateSnapshot(next)
  return next
}

/**
 * 三方合并：base 是本次编辑所基于的版本，local 是本地（含排队改动）的版本，remote 是最新云端版本。
 * 按实体逐条合并，绝不整板覆盖：本地改动叠加到云端结果上，云端不相关的改动全部保留。
 * 同一实体双方都改且结果不同时不算合并成功，而是记入 conflicts 交给用户决定（不猜测、不静默丢）。
 */
export function mergeSnapshots(base: BoardSnapshot, local: BoardSnapshot, remote: BoardSnapshot): { snapshot: BoardSnapshot; conflicts: string[] } {
  const conflicts: string[] = []
  const merged = cloneSnapshot(remote)

  // 时区：本地相对 base 改过就用本地，否则跟随云端。
  merged.settings.timeZone = local.settings.timeZone !== base.settings.timeZone ? local.settings.timeZone : remote.settings.timeZone

  const mergeList = <T extends { id: string }>(baseList: T[], localList: T[], remoteList: T[]): T[] => {
    const baseItems = new Map(baseList.map((item) => [item.id, JSON.stringify(item)]))
    const localItems = new Map(localList.map((item) => [item.id, item]))
    const remoteItems = new Map(remoteList.map((item) => [item.id, item]))
    const result: T[] = []

    // 保持云端顺序；云端已删除但本地改过的实体视为冲突。
    for (const remoteItem of remoteList) {
      const id = remoteItem.id
      const baseJson = baseItems.get(id)
      const localItem = localItems.get(id)
      const remoteJson = JSON.stringify(remoteItem)
      if (!localItem) {
        // base 里没有 → 这是云端新增的，必须保留（两台设备都从空板开始时 id 完全不同，之前的写法会丢掉它）。
        if (baseJson === undefined) { result.push(remoteItem); continue }
        // base 里有 → 本地删除了它；云端若同时改过就是真冲突，交给用户。
        if (baseJson !== remoteJson) { conflicts.push(id); result.push(remoteItem) }
        continue
      }
      const localJson = JSON.stringify(localItem)
      if (baseJson === localJson) { result.push(remoteItem); continue } // 本地没改，用云端
      if (baseJson === remoteJson) { result.push(localItem); continue } // 只有本地改了
      // base 里没有这个 id，但两侧都有且内容不同：base 落后（例如上次保存已落库但客户端没收到成功响应），
      // 无法判断谁更新，不能当作「本地新增」直接覆盖云端 —— 记为冲突交给用户。
      if (baseJson === undefined) { conflicts.push(id); result.push(remoteItem); continue }
      if (localJson === remoteJson) { result.push(remoteItem); continue } // 改成了同样的结果
      conflicts.push(id)
      result.push(remoteItem)
    }

    // 云端没有的实体：base 里也没有 → 本地新增，加入；base 里有 → 云端删除了它。
    for (const localItem of localList) {
      const id = localItem.id
      if (remoteItems.has(id)) continue
      const baseJson = baseItems.get(id)
      if (baseJson === undefined) { result.push(localItem); continue }
      // 云端已删除：本地未改动则服从删除，本地改过则是真冲突，交给用户。
      if (baseJson !== JSON.stringify(localItem)) conflicts.push(id)
    }
    return result
  }

  // 顺序也是用户改动：上移/下移只交换数组位置而不改实体本身，逐条比较看不到它。
  // 只比较「两侧都存在的 id」的相对次序：本地改过顺序就用本地顺序重排合并结果，
  // 双方都改过顺序则记为冲突（不猜测谁对）。
  const applyOrder = <T extends { id: string }>(mergedList: T[], baseList: T[], localList: T[], remoteList: T[]): void => {
    // 只按「base 与 local 都有」的 id 判断本地是否动过顺序：两边新增/删除的项不该制造假顺序变化。
    const localIds = new Set(localList.map((item) => item.id))
    const comparable = (list: T[]) => list.map((item) => item.id).filter((id) => localIds.has(id))
    const baseOrder = comparable(baseList).join('\u0000')
    const localOrder = comparable(localList).join('\u0000')
    const remoteOrder = comparable(remoteList).join('\u0000')
    if (localOrder === baseOrder) return // 本地没动顺序，保持云端顺序
    // 双方改成了同一个顺序，或本地顺序与云端结果一致：直接采用，不算冲突。
    if (localOrder === remoteOrder) return
    if (remoteOrder !== baseOrder) { conflicts.push('__order__'); return }
    const localIndex = new Map(localList.map((item, index) => [item.id, index]))
    mergedList.sort((left, right) => {
      const a = localIndex.get(left.id)
      const b = localIndex.get(right.id)
      // 本地新增项按它在本地列表里的位置排；云端新增项（本地没有）保持相对顺序排在末尾。
      if (a === undefined && b === undefined) return 0
      if (a === undefined) return 1
      if (b === undefined) return -1
      return a - b
    })
  }

  const mergedCycles = mergeList<GoalCycle>(base.cycles, local.cycles, remote.cycles)
  const mergedTasks = mergeList<Task>(base.tasks, local.tasks, remote.tasks)
  const mergedFocusBlocks = mergeList<FocusBlock>(base.focusBlocks, local.focusBlocks, remote.focusBlocks)
  applyOrder(mergedCycles, base.cycles, local.cycles, remote.cycles)
  applyOrder(mergedTasks, base.tasks, local.tasks, remote.tasks)
  applyOrder(mergedFocusBlocks, base.focusBlocks, local.focusBlocks, remote.focusBlocks)
  merged.cycles = mergedCycles
  merged.tasks = mergedTasks
  merged.focusBlocks = mergedFocusBlocks

  // 合并结果必须自身合法；不合法就当作未能自动合并（例如某实体引用了被删除的对象）。
  try {
    validateSnapshot(merged)
    return { snapshot: merged, conflicts }
  } catch {
    return { snapshot: remote, conflicts: conflicts.length ? conflicts : ['__invalid_merge__'] }
  }
}
