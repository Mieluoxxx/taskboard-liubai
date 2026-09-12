import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { addDays, createId, safeTimeZone, todayInTimeZone, validateSnapshot, weekKey } from './domain'
import { BoardError } from './notices'
import type { AdapterResult, AuthUser, BoardAdapter, BoardSnapshot, FocusBlock, GoalCycle, SaveResult, StoredBoard, Task } from './types'

const DEMO_STORAGE_KEY = 'liubai-taskboard:demo-board:v1'
const DEMO_LOCK_NAME = 'liubai-taskboard:demo-board'
const SESSION_SCOPE_CHANGED = 'session changed before board request'

function browserStorage(): Storage | null {
  return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
}

export interface SupabaseConfig {
  url: string
  key: string
}

export interface SessionSnapshot {
  userId: string
  accessToken: string
}

export interface SessionScope {
  userId: string
  getSession: () => Promise<SessionSnapshot | null>
}

export function getSupabaseConfig(): SupabaseConfig | null {
  const env = ((import.meta as ImportMeta & { env?: Record<string, unknown> }).env || {}) as Record<string, unknown>
  const url = typeof env.VITE_SUPABASE_URL === 'string' ? env.VITE_SUPABASE_URL.trim() : ''
  const key = typeof env.VITE_SUPABASE_PUBLISHABLE_KEY === 'string'
    ? env.VITE_SUPABASE_PUBLISHABLE_KEY.trim()
    : typeof env.VITE_SUPABASE_ANON_KEY === 'string'
      ? env.VITE_SUPABASE_ANON_KEY.trim()
      : ''
  if (!url || !key) return null
  if (!/^https?:\/\/[^\s/]+/i.test(url) || /(?:service_role|secret)/i.test(key)) return null
  return { url, key }
}

export function createSessionBoundFetch(scope: SessionScope, baseFetch: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch {
  return async (input, init) => {
    const session = await scope.getSession()
    if (!session || session.userId !== scope.userId) throw new Error(SESSION_SCOPE_CHANGED)
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${session.accessToken}`)
    return baseFetch(input, { ...init, headers })
  }
}

export function createSupabaseBoardAdapter(config: SupabaseConfig, scope?: SessionScope): SupabaseBoardAdapter {
  const client = createClient(config.url, config.key, scope ? {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: createSessionBoundFetch(scope) },
  } : undefined)
  return new SupabaseBoardAdapter(client, config)
}

function parseStoredBoard(value: unknown): StoredBoard {
  if (!value || typeof value !== 'object') throw new BoardError('noticeInvalidState', 'Cloud board payload has an invalid shape')
  const candidate = Array.isArray(value) ? value[0] : value
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new BoardError('noticeInvalidState', 'Cloud board payload has an invalid shape')
  const record = candidate as Record<string, unknown>
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) throw new BoardError('noticeInvalidState', 'Cloud board revision is invalid')
  return { revision: record.revision as number, snapshot: validateSnapshot(record.snapshot) }
}

export function adapterError(error: { message?: string; code?: string } | null | undefined, status?: number): AdapterResult<never> {
  const message = error?.message || 'Cloud request failed'
  // PT409 是数据库端用于“版本冲突”的自定义状态（HTTP 409）；40001 只是历史写法，一并识别。
  if (error?.code === 'PT409' || error?.code === '40001' || error?.code === '409' || /revision conflict|conflict|stale/i.test(message)) {
    return { ok: false, kind: 'conflict', code: 'noticeConflictCloud', message: 'Cloud board revision conflict' }
  }
  if (error?.code === '42501' && /board owner is not authorized/i.test(message)) {
    return { ok: false, kind: 'auth', code: 'noticeWrongOwner', message: 'Current account is not the configured board owner' }
  }
  if (status === 401 || error?.code === 'PGRST301' || /authentication required|session expired|session changed|jwt.*expired|expired.*jwt|invalid jwt|invalid token/i.test(message)) {
    return { ok: false, kind: 'auth', code: 'noticeSessionExpired', message: 'Cloud session expired' }
  }
  return { ok: false, kind: 'error', code: 'noticeCloudError', message }
}

export class SupabaseBoardAdapter implements BoardAdapter {
  readonly mode = 'cloud' as const

  constructor(readonly client: SupabaseClient, private readonly config?: SupabaseConfig) {}

  async getBoardAdapterForCurrentSession(expectedUserId?: string): Promise<SupabaseBoardAdapter | null> {
    if (!this.config) return null
    const scope = await this.getCurrentSessionSnapshot()
    if (!scope || (expectedUserId && scope.userId !== expectedUserId)) return null
    return createSupabaseBoardAdapter(this.config, {
      userId: scope.userId,
      getSession: () => this.getCurrentSessionSnapshot(),
    })
  }

  private async getCurrentSessionSnapshot(): Promise<SessionSnapshot | null> {
    const { data } = await this.client.auth.getSession()
    const session = data.session
    return session?.user && session.access_token ? { userId: session.user.id, accessToken: session.access_token } : null
  }

  async load(): Promise<AdapterResult<StoredBoard>> {
    let response
    try {
      response = await this.client.rpc('get_private_board')
    } catch (caught) {
      return adapterError({ message: caught instanceof Error ? caught.message : String(caught) })
    }
    const { data, error, status } = response
    if (error) return adapterError(error, status)
    try {
      return { ok: true, value: parseStoredBoard(data) }
    } catch (caught) {
      return { ok: false, kind: 'error', code: 'noticeInvalidState', message: caught instanceof Error ? caught.message : 'Cloud board is invalid' }
    }
  }

  async save(expectedRevision: number, snapshot: BoardSnapshot): Promise<AdapterResult<StoredBoard>> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return { ok: false, kind: 'offline', code: 'noticeOffline', message: 'Offline: save paused and draft kept' }
    }
    try {
      validateSnapshot(snapshot)
    } catch (caught) {
      return { ok: false, kind: 'error', code: 'noticeInvalidState', message: caught instanceof Error ? caught.message : 'Board is invalid' }
    }
    let response
    try {
      response = await this.client.rpc('cas_save_private_board', {
        p_expected_revision: expectedRevision,
        p_snapshot: snapshot,
      })
    } catch (caught) {
      return adapterError({ message: caught instanceof Error ? caught.message : String(caught) })
    }
    const { data, error, status } = response
    if (error) return adapterError(error, status)
    try {
      return { ok: true, value: parseStoredBoard(data) }
    } catch (caught) {
      return { ok: false, kind: 'error', code: 'noticeInvalidState', message: caught instanceof Error ? caught.message : 'Cloud save result is invalid' }
    }
  }

  async signIn(email: string, password: string): Promise<AdapterResult<AuthUser>> {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password })
    if (error || !data.user) return { ok: false, kind: 'auth', code: 'noticeInvalidCredentials', message: error?.message || 'Sign-in failed' }
    return { ok: true, value: { id: data.user.id, email: data.user.email || undefined } }
  }

  async getSessionUser(): Promise<AuthUser | null> {
    const { data } = await this.client.auth.getSession()
    return data.session?.user ? { id: data.session.user.id, email: data.session.user.email || undefined } : null
  }

  onAuthStateChange(callback: (user: AuthUser | null, event: AuthChangeEvent) => void): { unsubscribe: () => void } {
    const subscription = this.client.auth.onAuthStateChange((event, session: Session | null) => {
      callback(session?.user ? { id: session.user.id, email: session.user.email || undefined } : null, event)
    })
    return { unsubscribe: () => subscription.data.subscription.unsubscribe() }
  }

  async signOut(): Promise<AdapterResult<void>> {
    const { error } = await this.client.auth.signOut()
    return error ? adapterError(error) : { ok: true, value: undefined }
  }
}

function demoSample(): StoredBoard {
  const zone = safeTimeZone()
  const dateKey = todayInTimeZone(zone)
  const cycleStart = `${dateKey.slice(0, 7)}-01`
  const cycleEnd = addDays(cycleStart, 30)
  const week = weekKey(dateKey)
  const now = new Date().toISOString()
  const cycle: GoalCycle = { id: createId('cycle'), name: `留白 · ${dateKey.slice(0, 4)}`, startDate: cycleStart, endDate: cycleEnd, createdAt: now }
  const longTask: Task = {
    id: createId('task'), domain: 'long', title: '建立有余地的生活节奏 · Make room for a steady rhythm', note: '让长期方向可以被每周的小步行动看见。 Let small weekly steps reveal the long direction.', checked: false, color: 'blue', createdAt: now, updatedAt: now, cycleId: cycle.id, history: [],
  }
  const weeklyTask: Task = {
    id: createId('task'), domain: 'weekly', title: '整理本周的注意力边界 · Shape this week’s attention', note: '删掉一个不必要的承诺。 Remove one unnecessary promise.', checked: false, color: 'orange', createdAt: now, updatedAt: now, weekKey: week, upperTaskId: longTask.id, history: [],
  }
  const dailyTask: Task = {
    id: createId('task'), domain: 'daily', title: '写下今天最重要的一步 · Name today’s next step', note: '完成后再决定下一步。 Decide what follows only after this.', checked: false, color: 'green', createdAt: now, updatedAt: now, dateKey, upperTaskId: weeklyTask.id, history: [],
  }
  const subtask: Task = {
    id: createId('task'), domain: 'daily', title: '关掉一个通知入口 · Close one notification door', note: '', checked: true, color: 'ink', createdAt: now, updatedAt: now, dateKey, parentId: dailyTask.id, history: [],
  }
  const block: FocusBlock = {
    id: createId('focus'), dateKey, title: '深度工作 · 设计下一页 · Shape the next page', taskId: dailyTask.id, durationMinutes: 90, status: 'finished', elapsedMs: 90 * 60_000, finishedAt: now, createdAt: now,
  }
  const snapshot: BoardSnapshot = { schemaVersion: 1, settings: { timeZone: zone }, cycles: [cycle], tasks: [longTask, weeklyTask, dailyTask, subtask], focusBlocks: [block] }
  validateSnapshot(snapshot)
  return { revision: 1, snapshot }
}

export function createDemoBoardAdapter(): BoardAdapter {
  return new DemoBoardAdapter()
}

class DemoBoardAdapter implements BoardAdapter {
  readonly mode = 'demo' as const

  async load(): Promise<AdapterResult<StoredBoard>> {
    try {
      const storage = browserStorage()
      const raw = storage?.getItem(DEMO_STORAGE_KEY) || null
      if (!raw) {
        const sample = demoSample()
        browserStorage()?.setItem(DEMO_STORAGE_KEY, JSON.stringify(sample))
        return { ok: true, value: sample }
      }
      return { ok: true, value: parseStoredBoard(JSON.parse(raw)) }
    } catch (caught) {
      return { ok: false, kind: 'error', code: 'noticeDemoInvalid', message: caught instanceof Error ? caught.message : 'Local demo data is invalid' }
    }
  }

  async save(expectedRevision: number, snapshot: BoardSnapshot): Promise<AdapterResult<StoredBoard>> {
    try {
      // 演示板是本地共享状态：读取→比较→写入必须在同一临界区内完成，否则两个标签页会互相覆盖。
      // ponytail: 用浏览器原生 Web Locks 串行化跨标签写入；无该 API 时退化为同步读改写（本地演示可接受）。
      const write = (): AdapterResult<StoredBoard> => {
        const storage = browserStorage()
        const raw = storage?.getItem(DEMO_STORAGE_KEY) || null
        const baseline = raw ? parseStoredBoard(JSON.parse(raw)) : demoSample()
        if (baseline.revision !== expectedRevision) return { ok: false, kind: 'conflict', code: 'noticeConflictDemo', message: 'Demo board changed in another tab' }
        validateSnapshot(snapshot)
        const next: StoredBoard = { revision: expectedRevision + 1, snapshot }
        storage?.setItem(DEMO_STORAGE_KEY, JSON.stringify(next))
        return { ok: true, value: next }
      }
      const locks = (globalThis.navigator as Navigator & { locks?: LockManager } | undefined)?.locks
      if (!locks?.request) return write()
      return await locks.request(DEMO_LOCK_NAME, write)
    } catch (caught) {
      return { ok: false, kind: 'error', code: 'noticeDemoInvalid', message: caught instanceof Error ? caught.message : 'Local save failed' }
    }
  }

  async signOut(): Promise<AdapterResult<void>> {
    return { ok: true, value: undefined }
  }
}
