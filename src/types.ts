import type { NoticeCode } from './notices'

export type Language = 'zh' | 'en'

export type { NoticeCode }

export type Domain = 'long' | 'weekly' | 'daily'

export type TaskColor = 'ink' | 'blue' | 'orange' | 'green' | 'violet'

export interface Task {
  id: string
  domain: Domain
  title: string
  note: string
  checked: boolean
  color: TaskColor
  createdAt: string
  updatedAt: string
  cycleId?: string // 三个任务域共用的项目归属；缺省仅表示未归属计划。
  weekKey?: string
  dateKey?: string
  parentId?: string
  upperTaskId?: string
  archivedAt?: string
  archivedReason?: 'rescheduled'
  rescheduledTo?: string
}

export interface GoalCycle {
  id: string
  name: string
  startDate: string
  endDate: string
  createdAt: string
}

export type FocusStatus = 'running' | 'paused' | 'finished'

export interface FocusBlock {
  id: string
  dateKey: string
  title: string
  taskId?: string
  durationMinutes: number
  status: FocusStatus
  startedAt?: string
  elapsedMs: number
  finishedAt?: string
  createdAt: string
}

export interface BoardSettings {
  timeZone: string
}

export interface BoardSnapshot {
  schemaVersion: 1
  settings: BoardSettings
  cycles: GoalCycle[]
  tasks: Task[]
  focusBlocks: FocusBlock[]
}

export interface StoredBoard {
  revision: number
  snapshot: BoardSnapshot
}

export interface SaveResult {
  ok: true
  board: StoredBoard
}

export type FailureKind = 'conflict' | 'offline' | 'auth' | 'error'

export interface SaveConflict {
  ok: false
  kind: FailureKind
  code?: NoticeCode
  message: string
}

export type AdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; kind?: FailureKind; code?: NoticeCode }

export interface BoardAdapter {
  readonly mode: 'demo' | 'cloud'
  load(): Promise<AdapterResult<StoredBoard>>
  save(expectedRevision: number, snapshot: BoardSnapshot): Promise<AdapterResult<StoredBoard>>
  signOut?(): Promise<AdapterResult<void>>
}

export interface AuthUser {
  id: string
  email?: string
}
