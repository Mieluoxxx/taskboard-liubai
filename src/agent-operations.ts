import { z } from 'zod'
import {
  addCycle, addFocusBlock, addTask, carryForwardTasks, cloneSnapshot, createFocusBlock,
  createTask, deleteCycle, deleteFocusBlock, deleteTask, elapsedMsAt, MAX_ELAPSED_MS,
  mergeSnapshots, moveDailyTask, moveWeeklyTask, reorderCycleTo, reorderSiblingTo,
  rescheduleDailyTask, rescheduleWeeklyTask, setFocusCommand, updateFocusBlock,
  updateTask, validateSnapshot, weekKey,
} from './domain.js'
import type { BoardSnapshot, FocusBlock, Task } from './types.js'

const id = z.string().min(1).max(160)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const week = z.string().regex(/^\d{4}-W\d{2}$/)
const color = z.enum(['ink', 'blue', 'orange', 'green', 'violet'])
const ref = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/).optional()
const taskPatch = z.object({
  title: z.string().trim().min(1).max(450).optional(), note: z.string().max(3000).optional(),
  color: color.optional(), checked: z.boolean().optional(), upperTaskId: id.nullable().optional(),
}).strict()
export const restoreTargetSchema = z.object({ cycleId: id.optional(), dateKey: date.optional(), weekKey: week.optional() }).strict()
export type RestoreTarget = z.infer<typeof restoreTargetSchema>
export const actionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create_project'), name: z.string().trim().min(1).max(160), startDate: date, endDate: date, ref }).strict(),
  z.object({ op: z.literal('update_project'), id, patch: z.object({ name: z.string().trim().min(1).max(160).optional(), startDate: date.optional(), endDate: date.optional() }).strict() }).strict(),
  z.object({ op: z.literal('delete_project'), id }).strict(),
  z.object({ op: z.literal('reorder_project'), id, targetId: id }).strict(),
  z.object({ op: z.literal('create_task'), domain: z.enum(['long', 'weekly', 'daily']), title: z.string().trim().min(1).max(450), note: z.string().max(3000).optional(), color: color.optional(), cycleId: id.optional(), dateKey: date.optional(), weekKey: week.optional(), parentId: id.optional(), upperTaskId: id.optional(), ref }).strict(),
  z.object({ op: z.literal('update_task'), id, patch: taskPatch }).strict(),
  z.object({ op: z.literal('delete_task'), id }).strict(),
  z.object({ op: z.literal('move_task'), id, target: z.string().min(1).max(10) }).strict(),
  z.object({ op: z.literal('reschedule_task'), id, target: z.string().min(1).max(10) }).strict(),
  z.object({ op: z.literal('reorder_task'), id, targetId: id }).strict(),
  z.object({ op: z.literal('create_focus'), title: z.string().trim().min(1).max(300), dateKey: date, durationMinutes: z.number().min(0.1).max(1440).optional(), taskId: id.optional(), ref }).strict(),
  z.object({ op: z.literal('update_focus'), id, patch: z.object({ title: z.string().trim().min(1).max(300).optional(), durationMinutes: z.number().min(0.1).max(1440).optional(), taskId: id.nullable().optional() }).strict() }).strict(),
  z.object({ op: z.literal('delete_focus'), id }).strict(),
  z.object({ op: z.literal('focus_command'), id, command: z.enum(['start', 'pause', 'resume', 'finish']) }).strict(),
  z.object({ op: z.literal('set_timezone'), timeZone: z.string().min(1).max(100) }).strict(),
  z.object({ op: z.literal('carry_forward'), today: date }).strict(),
  z.object({ op: z.literal('restore'), trashId: z.uuid(), target: restoreTargetSchema.optional() }).strict(),
])
export const actionsSchema = z.array(actionSchema).min(1).max(100)
export type BoardAction = z.infer<typeof actionSchema>
export type TrashEntry = { id: string; deleted_at: string; expires_at: string; payload: Pick<BoardSnapshot, 'cycles' | 'tasks' | 'focusBlocks'> }

function ensurePlacement(snapshot: BoardSnapshot, task: Task) {
  const cycle = snapshot.cycles.find((entry) => entry.id === task.cycleId)
  if (task.cycleId && !cycle) throw new Error('Project no longer exists')
  if (!cycle || task.domain === 'long') return
  const target = task.domain === 'weekly' ? task.weekKey! : task.dateKey!
  const start = task.domain === 'weekly' ? weekKey(cycle.startDate) : cycle.startDate
  const end = task.domain === 'weekly' ? weekKey(cycle.endDate) : cycle.endDate
  if (target < start || target > end) throw new Error('Placement is outside the project; adjust its dates first')
}

/** 只恢复回收集合，不改仍存活对象；父项目缺失时必须明确提供新归属。 */
export function restoreTrash(snapshot: BoardSnapshot, entry: TrashEntry, target: RestoreTarget = {}, now = new Date().toISOString()): BoardSnapshot {
  if (Date.parse(entry.expires_at) <= Date.parse(now)) throw new Error('Trash entry expired')
  const next = cloneSnapshot(snapshot)
  const payload = structuredClone(entry.payload)
  for (const key of ['cycles', 'tasks', 'focusBlocks'] as const) {
    if (!Array.isArray(payload[key])) throw new Error('Invalid trash payload')
    if (payload[key].some((item) => next[key].some((current) => current.id === item.id))) throw new Error('An object to restore already exists')
  }
  if (payload.cycles.length && target.cycleId) throw new Error('A deleted project must be restored as its original project')
  next.cycles.push(...payload.cycles)
  if (target.cycleId && !next.cycles.some((cycle) => cycle.id === target.cycleId)) throw new Error('Target project does not exist')
  for (const task of payload.tasks) {
    if (target.cycleId) task.cycleId = target.cycleId
    if (target.dateKey && task.domain === 'daily') task.dateKey = target.dateKey
    if (target.weekKey && task.domain === 'weekly') task.weekKey = target.weekKey
    if (task.cycleId && !next.cycles.some((cycle) => cycle.id === task.cycleId)) throw new Error('Original project is missing; choose another project and placement')
    if (target.cycleId || target.dateKey || target.weekKey) ensurePlacement(next, task)
    task.updatedAt = now
  }
  next.tasks.push(...payload.tasks)
  const byId = new Map(next.tasks.map((task) => [task.id, task]))
  for (const task of payload.tasks) {
    const parent = byId.get(task.parentId || '')
    if (!parent || parent.parentId || parent.domain !== task.domain || parent.cycleId !== task.cycleId || parent.dateKey !== task.dateKey || parent.weekKey !== task.weekKey) delete task.parentId
    const upper = byId.get(task.upperTaskId || '')
    if (task.parentId || !upper || upper.parentId || upper.cycleId !== task.cycleId || upper.domain !== (task.domain === 'daily' ? 'weekly' : task.domain === 'weekly' ? 'long' : '')) delete task.upperTaskId
    if (task.rescheduledTo && !byId.has(task.rescheduledTo)) delete task.rescheduledTo
  }
  for (const block of payload.focusBlocks) {
    if (block.status === 'running') {
      block.elapsedMs = Math.min(MAX_ELAPSED_MS, elapsedMsAt(block, Date.parse(entry.deleted_at)))
      block.status = 'paused'
      delete block.startedAt
    }
    if (block.taskId && byId.get(block.taskId)?.domain !== 'daily') delete block.taskId
    if (target.dateKey) block.dateKey = target.dateKey
  }
  next.focusBlocks.push(...payload.focusBlocks)
  return validateSnapshot(next)
}

/** 同一个批次只计算一次，再通过一条 CAS 提交；$ref 只引用本批次前面创建的对象。 */
export function applyActions(snapshot: BoardSnapshot, input: unknown, trash: TrashEntry[] = [], now = new Date().toISOString()) {
  const actions = actionsSchema.parse(input)
  let next = validateSnapshot(snapshot)
  const refs: Record<string, string> = {}
  const restored: string[] = []
  const resolve = (value: string | undefined) => {
    if (!value?.startsWith('$')) return value
    const found = Object.hasOwn(refs, value.slice(1)) ? refs[value.slice(1)] : undefined
    if (!found) throw new Error(`Unknown batch reference: ${value}`)
    return found
  }
  const remember = (name: string | undefined, value: string) => {
    if (!name) return
    if (Object.hasOwn(refs, name)) throw new Error(`Duplicate batch reference: ${name}`)
    refs[name] = value
  }
  for (const action of actions) {
    const objectId = 'id' in action ? resolve(action.id)! : ''
    const task = () => {
      const found = next.tasks.find((item) => item.id === objectId && !item.archivedAt)
      if (!found) throw new Error('Active task not found')
      return found
    }
    switch (action.op) {
      case 'create_project':
        next = addCycle(next, action.name, action.startDate, action.endDate, now)
        remember(action.ref, next.cycles.at(-1)!.id)
        break
      case 'update_project': {
        const project = next.cycles.find((item) => item.id === objectId)
        if (!project) throw new Error('Project not found')
        Object.assign(project, action.patch)
        break
      }
      case 'delete_project': next = deleteCycle(next, objectId, now); break
      case 'reorder_project': {
        const targetId = resolve(action.targetId)!
        if (![objectId, targetId].every((value) => next.cycles.some((item) => item.id === value))) throw new Error('Project not found')
        next = reorderCycleTo(next, objectId, targetId)
        break
      }
      case 'create_task': {
        const created = createTask({ ...action, cycleId: resolve(action.cycleId), parentId: resolve(action.parentId), upperTaskId: resolve(action.upperTaskId) }, now)
        if (created.parentId) {
          const parent = next.tasks.find((item) => item.id === created.parentId && !item.archivedAt && !item.parentId)
          if (!parent || parent.domain !== created.domain || created.upperTaskId) throw new Error('Invalid parent task')
          Object.assign(created, { cycleId: parent.cycleId, dateKey: parent.dateKey, weekKey: parent.weekKey })
        }
        ensurePlacement(next, created)
        next = addTask(next, created)
        remember(action.ref, created.id)
        break
      }
      case 'update_task':
        next = updateTask(next, objectId, { ...action.patch, ...('upperTaskId' in action.patch ? { upperTaskId: resolve(action.patch.upperTaskId ?? undefined) } : {}) } as Partial<Task>, now)
        break
      case 'delete_task': next = deleteTask(next, objectId, now); break
      case 'move_task': {
        const current = task()
        if (current.parentId || current.domain === 'long') throw new Error('Only top-level weekly/daily tasks can move')
        next = current.domain === 'daily' ? moveDailyTask(next, objectId, action.target, now) : moveWeeklyTask(next, objectId, action.target, now)
        break
      }
      case 'reschedule_task': {
        const current = task()
        if (current.parentId || current.checked || current.domain === 'long' || action.target <= (current.dateKey || current.weekKey || '')) throw new Error('Reschedule requires an unfinished top-level task and a later placement')
        next = current.domain === 'daily' ? rescheduleDailyTask(next, objectId, action.target, now) : rescheduleWeeklyTask(next, objectId, action.target, now)
        break
      }
      case 'reorder_task': {
        const current = task()
        const target = next.tasks.find((item) => item.id === resolve(action.targetId) && !item.archivedAt)
        if (!target || ['domain', 'cycleId', 'parentId', 'dateKey', 'weekKey'].some((key) => current[key as keyof Task] !== target[key as keyof Task])) throw new Error('Only siblings can be reordered')
        next = reorderSiblingTo(next, objectId, target.id)
        break
      }
      case 'create_focus': {
        const block = createFocusBlock({ ...action, taskId: resolve(action.taskId) }, now)
        next = addFocusBlock(next, block)
        remember(action.ref, block.id)
        break
      }
      case 'update_focus':
        next = updateFocusBlock(next, objectId, { ...action.patch, ...('taskId' in action.patch ? { taskId: resolve(action.patch.taskId ?? undefined) } : {}) } as Partial<FocusBlock>)
        break
      case 'delete_focus': next = deleteFocusBlock(next, objectId); break
      case 'focus_command': {
        const block = next.focusBlocks.find((item) => item.id === objectId)
        if (!block || block.status === 'finished' || ((action.command === 'start' || action.command === 'resume') && block.status !== 'paused')) throw new Error('Invalid timer state transition')
        next = setFocusCommand(next, objectId, action.command, now)
        break
      }
      case 'set_timezone': next.settings.timeZone = action.timeZone; break
      case 'carry_forward': next = carryForwardTasks(next, action.today, now); break
      case 'restore': {
        const entry = trash.find((item) => item.id === action.trashId)
        if (!entry || restored.includes(entry.id)) throw new Error('Trash entry missing or already restored')
        next = restoreTrash(next, entry, { ...action.target, cycleId: resolve(action.target?.cycleId) }, now)
        restored.push(entry.id)
        break
      }
    }
    next = validateSnapshot(next)
  }
  return { snapshot: next, refs, restored }
}

/** 删除范围已变化就停止，不让通用三方合并悄悄扩大删除。 */
export function mergeAgentChanges(base: BoardSnapshot, local: BoardSnapshot, remote: BoardSnapshot): BoardSnapshot {
  for (const project of base.cycles.filter((item) => !local.cycles.some((candidate) => candidate.id === item.id))) {
    const scope = (board: BoardSnapshot) => JSON.stringify({ project: board.cycles.find((item) => item.id === project.id), tasks: board.tasks.filter((item) => item.cycleId === project.id) })
    if (scope(base) !== scope(remote)) throw new Error('CONFLICT: project deletion scope changed; read and review again')
  }
  if (local.settings.timeZone !== base.settings.timeZone && remote.settings.timeZone !== base.settings.timeZone && local.settings.timeZone !== remote.settings.timeZone) throw new Error('CONFLICT: timezone changed')
  const merged = mergeSnapshots(base, local, remote)
  if (merged.conflicts.length) throw new Error('CONFLICT: another editor changed the same object; read and review again')
  return validateSnapshot(merged.snapshot)
}
