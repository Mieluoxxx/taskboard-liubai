import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useSensor, useSensors, type Announcements, type KeyboardCoordinateGetter } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  activeTasks,
  MAX_TASK_TITLE_LENGTH,
  MAX_TASK_NOTE_LENGTH,
  addCycle,
  addFocusBlock,
  addTask,
  addDays,
  cloneSnapshot,
  mergeSnapshots,
  reapplyReorder,
  reorderOrigin,
  compareDateKeys,
  createFocusBlock,
  createTask,
  carryForwardTasks,
  dateKeysInRange,
  deleteFocusBlock,
  deleteTask,
  elapsedMsAt,
  focusDisplayStatus,
  formatDateKey,
  linkedChainIds,
  isoDay,
  reorderSibling,
  reorderSiblingTo,
  rescheduleDailyTask,
  rescheduleWeeklyTask,
  safeTimeZone,
  setFocusCommand,
  todayInTimeZone,
  updateFocusBlock,
  updateTask,
  validateDurationMinutes,
  validateSnapshot,
  weekKey,
  weekKeysInRange,
  weekRange,
} from './domain'
import { AuthLifecycle, type AuthIdentity, type AuthTransition } from './auth-flow'
import { copy, type CopyKey } from './i18n'
import { BoardError, isNoticeCode, type NoticeCode } from './notices'
import { createDemoBoardAdapter, createSupabaseBoardAdapter, getSupabaseConfig, type SupabaseBoardAdapter } from './storage'
import type { BoardAdapter, BoardSnapshot, Domain, FocusBlock, GoalCycle, Language, StoredBoard, Task, TaskColor } from './types'
import './fonts.css'
import './styles.css'

const LANGUAGE_KEY = 'liubai-taskboard:language:v1'
type Screen = 'setup' | 'auth' | 'loading' | 'workspace'
type SaveState = 'saved' | 'pending' | 'saving' | 'error' | 'offline'
type DialogState =
  | { kind: 'task'; task?: Task; domain: Domain; parentId?: string; initial?: TaskInput }
  | { kind: 'cycle'; cycle?: GoalCycle; initial?: { name: string; startDate: string; endDate: string } }
  | { kind: 'focus'; block?: FocusBlock; initial?: FocusInput }
  | { kind: 'settings' }
  | { kind: 'reschedule'; task: Task }
  | null

type TaskInput = {
  title: string
  note: string
  color: TaskColor
  upperTaskId?: string
  parentId?: string
}

type SelectionState = { cycleId: string | null; date: string; week: string }

type FocusInput = { title: string; durationMinutes: string; taskId?: string }

// 失败变更除了快照，还要记住它来自哪个表单与输入值：
// 冲突后绝不整板回写（会覆盖其他设备的新改动），而是让用户在新版本上重新编辑同一份输入。
type DraftOrigin =
  | { kind: 'reorder'; taskId: string; direction: -1 | 1; domain: Domain }
  | { kind: 'task'; input: TaskInput; taskId?: string; domain: Domain; parentId?: string }
  | { kind: 'cycle'; input: { name: string; startDate: string; endDate: string }; cycleId?: string }
  | { kind: 'focus'; input: FocusInput; blockId?: string }

type PendingJob = { expectedRevision: number; snapshot: BoardSnapshot; draft: string | null; origin?: DraftOrigin }
type AuthLoad = { userId: string; generation: number; promise: Promise<void> }

function readLanguage(): Language {
  try {
    return localStorage.getItem(LANGUAGE_KEY) === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

function persistLanguage(language: Language): void {
  try { localStorage.setItem(LANGUAGE_KEY, language) } catch { /* private mode can reject preferences */ }
}

function noticeText(value: { code?: NoticeCode; message?: string } | null | undefined, fallback: NoticeCode): NoticeCode | string {
  return value?.code && isNoticeCode(value.code) ? value.code : value?.message || fallback
}

function errorNotice(error: unknown, fallback: NoticeCode): NoticeCode | string {
  if (error instanceof BoardError) return error.code
  // 内部错误的英文诊断只用于排查，不能原样显示给用户（否则中文界面会泄漏英文）。
  if (error instanceof Error && error.message) console.warn('[taskboard]', error.message)
  return fallback
}

function weekdayLabel(dateKey: string, language: Language): string {
  const monday = new Date(Date.UTC(2024, 0, 1 + isoDay(dateKey) - 1, 12))
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'long', timeZone: 'UTC' }).format(monday)
}

function weekdayShortLabel(dateKey: string, language: Language): string {
  const monday = new Date(Date.UTC(2024, 0, 1 + isoDay(dateKey) - 1, 12))
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short', timeZone: 'UTC' }).format(monday)
}

function dateInRange(date: string, startDate: string, endDate: string): boolean {
  return compareDateKeys(date, startDate) >= 0 && compareDateKeys(date, endDate) <= 0
}

function clampDate(date: string, startDate: string, endDate: string): string {
  if (compareDateKeys(date, startDate) < 0) return startDate
  if (compareDateKeys(date, endDate) > 0) return endDate
  return date
}

function dateForCycleSelection(preferredDate: string, cycle: GoalCycle, todayDate: string): string {
  return dateInRange(preferredDate, cycle.startDate, cycle.endDate) ? preferredDate : clampDate(todayDate, cycle.startDate, cycle.endDate)
}

// 日任务按日期、周任务按 ISO 周判断“已经过去”：同一套规则供建议条、面板提示与行内按钮复用。
function isPastPlacement(task: Task, timeZone: string): boolean {
  if (task.checked) return false
  const today = todayInTimeZone(timeZone)
  if (task.domain === 'daily') return Boolean(task.dateKey && task.dateKey < today)
  if (task.domain === 'weekly') return Boolean(task.weekKey && task.weekKey < weekKey(today))
  return false
}

// 顺延标签：归档条目上的 rescheduledTo 指向新任务，反查即可知道「它是从哪个周期顺延过来的」。
// 不新增快照字段：旧数据同样能标出标签，也不需要新的数据库校验。
function carriedFromLabels(snapshot: BoardSnapshot): Map<string, string> {
  const labels = new Map<string, string>()
  for (const task of snapshot.tasks) {
    if (task.archivedReason !== 'rescheduled' || !task.rescheduledTo) continue
    const placement = task.domain === 'weekly' ? task.weekKey : task.dateKey
    if (placement) labels.set(task.rescheduledTo, placement)
  }
  return labels
}

function dateForWeek(key: string, cycle: GoalCycle | undefined, preferredDate: string): string {
  const range = weekRange(key)
  const start = cycle && compareDateKeys(cycle.startDate, range.start) > 0 ? cycle.startDate : range.start
  const end = cycle && compareDateKeys(cycle.endDate, range.end) < 0 ? cycle.endDate : range.end
  return dateInRange(preferredDate, start, end) ? preferredDate : start
}

function selectionForSnapshot(snapshot: BoardSnapshot, preferredCycleId: string | null, preferredDate: string): { cycleId: string | null; date: string; week: string } {
  const cycle = snapshot.cycles.find((candidate) => candidate.id === preferredCycleId) || snapshot.cycles[0]
  const date = cycle ? dateForCycleSelection(preferredDate, cycle, todayInTimeZone(snapshot.settings.timeZone)) : preferredDate
  return { cycleId: cycle?.id || null, date, week: weekKey(date) }
}

function cycleRangesDiffer(left: BoardSnapshot | null, right: BoardSnapshot): boolean {
  if (!left || left.cycles.length !== right.cycles.length) return true
  return left.cycles.some((cycle, index) => {
    const other = right.cycles[index]
    return !other || cycle.id !== other.id || cycle.startDate !== other.startDate || cycle.endDate !== other.endDate
  })
}


export default function App() {
  const config = useMemo(() => getSupabaseConfig(), [])
  const [language, setLanguage] = useState<Language>(readLanguage)
  const [screen, setScreen] = useState<Screen>(config ? 'auth' : 'setup')
  const screenRef = useRef<Screen>(screen)
  const [adapter, setAdapter] = useState<BoardAdapter | null>(null)
  const adapterRef = useRef<BoardAdapter | null>(null)
  const cloudRef = useRef<SupabaseBoardAdapter | null>(null)
  const [authLifecycle] = useState(() => new AuthLifecycle())
  const authLoadRef = useRef<AuthLoad | null>(null)
  const [user, setUser] = useState<AuthIdentity | null>(null)
  const userRef = useRef<AuthIdentity | null>(null)
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [stored, setStored] = useState<StoredBoard | null>(null)
  const storedRef = useRef<StoredBoard | null>(null)
  // 最近一次与后端一致的快照（成功加载/保存后的版本），三方合并的 base。
  const baselineRef = useRef<BoardSnapshot | null>(null)
  const [boardLoadToken, setBoardLoadToken] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveMessage, setSaveMessage] = useState('')
  // 失败种类单独记录，避免用提示文本反推冲突（提示文本会随语言变化）。
  const [failureKind, setFailureKind] = useState<'conflict' | null>(null)
  const [draftLabel, setDraftLabel] = useState<string | null>(null)
  const failedJobRef = useRef<PendingJob | null>(null)
  const saveEpochRef = useRef(0)
  const pendingJobRef = useRef<PendingJob | null>(null)
  const saveInFlightRef = useRef(false)
  const drainRef = useRef<(() => Promise<void>) | null>(null)
  // openBoard 定义在 commitSnapshot 之前，但只在加载完成后调用，因此用 ref 取当下的提交入口。
  const commitRef = useRef<((next: BoardSnapshot, draft: string | null) => boolean) | null>(null)
  const loadTokenRef = useRef(0)
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null)
  const [selectedWeek, setSelectedWeek] = useState(() => weekKey(todayInTimeZone(safeTimeZone())))
  const [selectedDate, setSelectedDate] = useState(() => todayInTimeZone(safeTimeZone()))
  const selectionRef = useRef<SelectionState>({ cycleId: null, date: selectedDate, week: selectedWeek })
  const [now, setNow] = useState(() => Date.now())
  const workspaceScrollRef = useRef<HTMLDivElement | null>(null)
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null)
  const panelRefs = useRef<Array<HTMLElement | null>>([])
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const [flash, setFlash] = useState('')

  const t = useCallback((key: CopyKey) => copy[language][key], [language])
  // 保存提示可能是 notice code（可本地化），也可能是无 code 的诊断文本。
  const noticeLabel = useCallback((value: string) => (isNoticeCode(value) ? copy[language][value] : value), [language])
  const applySelection = useCallback((selection: SelectionState) => {
    selectionRef.current = selection
    setSelectedCycleId(selection.cycleId)
    setSelectedDate(selection.date)
    setSelectedWeek(selection.week)
  }, [])
  const reconcileSelection = useCallback((nextSnapshot: BoardSnapshot, preferredCycleId = selectionRef.current.cycleId, preferredDate = selectionRef.current.date) => {
    const selection = selectionForSnapshot(nextSnapshot, preferredCycleId, preferredDate)
    applySelection(selection)
  }, [applySelection])

  useEffect(() => { persistLanguage(language) }, [language])
  useEffect(() => { screenRef.current = screen }, [screen])
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
    document.title = copy[language].documentTitle
  }, [language])
  useEffect(() => { storedRef.current = stored }, [stored])
  useEffect(() => { adapterRef.current = adapter }, [adapter])

  useEffect(() => {
    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline) }
  }, [])

  useEffect(() => {
    if (screen !== 'workspace') return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [screen])

  const clearPrivateState = useCallback((nextScreen: Screen) => {
    const resetDate = todayInTimeZone(safeTimeZone())
    loadTokenRef.current += 1
    saveEpochRef.current += 1
    pendingJobRef.current = null
    failedJobRef.current = null
    saveInFlightRef.current = false
    storedRef.current = null
    baselineRef.current = null
    setStored(null)
    setSelectedTaskId(null)
    selectionRef.current = { cycleId: null, date: resetDate, week: weekKey(resetDate) }
    setSelectedCycleId(null)
    setSelectedDate(resetDate)
    setSelectedWeek(weekKey(resetDate))
    setDraftLabel(null)
    setAuthPassword('')
    setAuthError('')
    setSaveMessage('')
    setFailureKind(null)
    setSaveState('saved')
    setDialog(null)
    setScreen(nextScreen)
  }, [])

  const openBoard = useCallback(async (nextAdapter: BoardAdapter, nextScreen: Screen = 'workspace', expectedAuthGeneration = authLifecycle.generation()) => {
    const token = ++loadTokenRef.current
    saveEpochRef.current += 1
    setAdapter(nextAdapter)
    adapterRef.current = nextAdapter
    setScreen('loading')
    setSaveMessage('')
    setSaveState('saved')
    pendingJobRef.current = null
    failedJobRef.current = null
    setDraftLabel(null)
    const result = await nextAdapter.load()
    if (token !== loadTokenRef.current || !authLifecycle.isCurrent(expectedAuthGeneration)) return
    if (!result.ok) {
      setSaveState(result.kind === 'offline' ? 'offline' : 'error')
      if (result.message) console.warn('[taskboard]', result.message)
      setSaveMessage(noticeText(result, nextAdapter.mode === 'cloud' ? 'noticeCloudError' : 'noticeInvalidState'))
      setScreen(nextScreen === 'workspace' ? (nextAdapter.mode === 'cloud' ? 'auth' : 'setup') : nextScreen)
      return
    }
    try {
      const loadedSnapshot = validateSnapshot(result.value.snapshot)
      // SQL 空板只能使用 UTC 哨兵；第一次本地变更会通过同一条 CAS 写入浏览器时区。
      if (result.value.revision === 0 && loadedSnapshot.tasks.length === 0 && loadedSnapshot.focusBlocks.length === 0 && loadedSnapshot.cycles.length === 0) {
        loadedSnapshot.settings.timeZone = safeTimeZone()
      }
      const safeBoard: StoredBoard = { revision: result.value.revision, snapshot: loadedSnapshot }
      storedRef.current = safeBoard
      baselineRef.current = cloneSnapshot(loadedSnapshot)
      setStored(safeBoard)
      setBoardLoadToken((value) => value + 1)
      setScreen('workspace')
      // 未完成的过去任务直接顺延到当前周期（周→本周，日→今天），不弹确认条；走同一条 CAS 保存路径，
      // 失败/离线照常进入重试与草稿提示。顺延本身出错时不能拖垮加载，只记日志。
      try {
        const carried = carryForwardTasks(loadedSnapshot, todayInTimeZone(loadedSnapshot.settings.timeZone))
        if (carried !== loadedSnapshot) commitRef.current?.(carried, null)
      } catch (caught) {
        if (caught instanceof Error) console.warn('[taskboard]', caught.message)
      }
    } catch (caught) {
      const message = errorNotice(caught, 'noticeBoardInvalid')
      clearPrivateState(nextAdapter.mode === 'cloud' ? 'auth' : 'setup')
      setSaveState('error')
      setSaveMessage(message)
    }
  }, [authLifecycle, clearPrivateState])

  const openSessionBoard = useCallback(async (cloud: SupabaseBoardAdapter, expectedUserId: string, expectedAuthGeneration = authLifecycle.generation()) => {
    if (userRef.current?.id !== expectedUserId || !authLifecycle.isCurrent(expectedAuthGeneration)) return
    const activeLoad = authLoadRef.current
    if (activeLoad?.userId === expectedUserId && activeLoad.generation === expectedAuthGeneration) {
      await activeLoad.promise
      return
    }
    const promise = (async () => {
      try {
        const board = await cloud.getBoardAdapterForCurrentSession(expectedUserId)
        if (userRef.current?.id !== expectedUserId || !authLifecycle.isCurrent(expectedAuthGeneration)) return
        if (!board) {
          clearPrivateState('auth')
          setSaveState('error')
          setSaveMessage('noticeSessionExpired')
          return
        }
        await openBoard(board, 'workspace', expectedAuthGeneration)
      } catch (caught) {
        if (userRef.current?.id !== expectedUserId || !authLifecycle.isCurrent(expectedAuthGeneration)) return
        if (caught instanceof Error) console.warn('[taskboard]', caught.message)
        setSaveState('error')
        setSaveMessage('noticeCloudError')
        setScreen('auth')
      }
    })()
    authLoadRef.current = { userId: expectedUserId, generation: expectedAuthGeneration, promise }
    try {
      await promise
    } finally {
      if (authLoadRef.current?.promise === promise) authLoadRef.current = null
    }
  }, [authLifecycle, clearPrivateState, openBoard])

  const applyAuthTransition = useCallback((cloud: SupabaseBoardAdapter | null, transition: AuthTransition) => {
    userRef.current = transition.user
    setUser(transition.user)
    if (!transition.user) {
      clearPrivateState('auth')
      return
    }
    if (transition.shouldClear) clearPrivateState(transition.shouldClear)
    if (transition.shouldLoad && cloud) void openSessionBoard(cloud, transition.user.id, transition.generation)
  }, [clearPrivateState, openSessionBoard])

  useEffect(() => {
    if (!config) return
    const cloud = createSupabaseBoardAdapter(config)
    cloudRef.current = cloud
    let alive = true
    // 初始 session 查询可能晚于 auth 事件返回；用 epoch 保证过期的初始结果不会覆盖更新的登录状态。
    let sessionEpoch = 0
    const initialGeneration = authLifecycle.generation()
    void cloud.getSessionUser().then((nextUser) => {
      if (!alive || sessionEpoch !== 0 || !authLifecycle.isCurrent(initialGeneration)) return
      applyAuthTransition(cloud, authLifecycle.accept(userRef.current, nextUser, screenRef.current, Boolean(storedRef.current), false))
    })
    const subscription = cloud.onAuthStateChange((nextUser) => {
      if (!alive) return
      sessionEpoch += 1
      applyAuthTransition(cloud, authLifecycle.receiveAuthEvent(userRef.current, nextUser, screenRef.current, Boolean(storedRef.current)))
    })
    return () => { alive = false; authLifecycle.invalidate(); subscription.unsubscribe() }
  }, [applyAuthTransition, authLifecycle, config])

  useEffect(() => {
    if (!stored || !boardLoadToken) return
    const current = todayInTimeZone(stored.snapshot.settings.timeZone)
    reconcileSelection(stored.snapshot, stored.snapshot.cycles[0]?.id || null, current)
    setSelectedTaskId(null)
  }, [boardLoadToken, reconcileSelection]) // 仅显式加载会改变 boardLoadToken，普通保存不会重置当前周期。

  const drainSave = useCallback(async () => {
    if (saveInFlightRef.current || !adapterRef.current) return
    const currentAdapter = adapterRef.current
    const job = pendingJobRef.current
    if (!job || !currentAdapter) return
    const epoch = saveEpochRef.current
    pendingJobRef.current = null
    saveInFlightRef.current = true
    setSaveState('saving')
    let result
    try {
      result = await currentAdapter.save(job.expectedRevision, job.snapshot)
    } catch (thrown) {
      // 适配器理论上自行捕获异常，但网络层抛错时不能让这次保存悬空：
      // 否则 saveInFlightRef 永远为 true，界面卡在“保存中”且后续保存全部被跳过。
      if (thrown instanceof Error) console.warn('[taskboard]', thrown.message)
      if (epoch !== saveEpochRef.current || adapterRef.current !== currentAdapter) return
      saveInFlightRef.current = false
      failedJobRef.current = job
      setSaveState('error')
      setSaveMessage('noticeCloudError')
      setFailureKind(null)
      setDraftLabel(job.draft)
      return
    }
    if (epoch !== saveEpochRef.current || adapterRef.current !== currentAdapter) return
    saveInFlightRef.current = false
    if (result.ok) {
      failedJobRef.current = null
      const current = storedRef.current
      const pending = pendingJobRef.current as PendingJob | null
      const cycleRangesChanged = cycleRangesDiffer(baselineRef.current, result.value.snapshot)
      if (pending && current) {
        // 这次保存已经落库，base 必须前进到「刚提交的那份快照」，而不是停在更早的版本：
        // base 落后会把「后端已有、base 里还没有」的实体误判成本地新增，
        // 从而在之后的合并里覆盖另一台设备对这些实体的改动。
        baselineRef.current = cloneSnapshot(result.value.snapshot)
        const merged: StoredBoard = { revision: result.value.revision, snapshot: current.snapshot }
        const nextPending: PendingJob = { ...pending, expectedRevision: result.value.revision }
        pendingJobRef.current = nextPending
        storedRef.current = merged
        setStored(merged)
        if (cycleRangesChanged) reconcileSelection(current.snapshot)
        setSaveState('pending')
        setSaveMessage('')
        setFailureKind(null)
        setDraftLabel(nextPending.draft)
        queueMicrotask(() => { void drainRef.current?.() })
      } else {
        storedRef.current = result.value
        baselineRef.current = cloneSnapshot(result.value.snapshot)
        setStored(result.value)
        if (cycleRangesChanged) reconcileSelection(result.value.snapshot)
        setSaveState('saved')
        setSaveMessage('')
        setFailureKind(null)
        setDraftLabel(null)
      }
    } else {
      if (result.kind === 'auth') { clearPrivateState('auth'); return }
      // 失败时可能已有更新的编辑在排队：保留更新的那份输入，避免用户最后一次输入被静默丢弃。
      // 显式标注类型：函数开头已把 pendingJobRef.current 置空，TS 会把后续读取收窄成 null。
      const newer = pendingJobRef.current as PendingJob | null
      // 保留更新的快照用于重试，但若更新的那次来自直接操作（没有表单来源），
      // 仍保留失败表单的 origin，使“重新打开编辑器”仍有可重放的输入。
      const retained: PendingJob = newer ? { ...newer, origin: newer.origin ?? job.origin } : job
      // 冲突时先做三方合并：本地排队改动与云端改动各自独立时，两者都应保留。
      // 合并成功即用新 revision 以 CAS 再推一次；真有同实体冲突才交给用户。
      if (result.kind === 'conflict') {
        const base = baselineRef.current
        const remoteBoard = await currentAdapter.load()
        if (epoch !== saveEpochRef.current || adapterRef.current !== currentAdapter) return
        if (epoch === saveEpochRef.current && adapterRef.current === currentAdapter && remoteBoard.ok) {
          const remoteSnapshot = remoteBoard.value.snapshot
          const merged = base ? mergeSnapshots(base, retained.snapshot, remoteSnapshot) : { snapshot: remoteSnapshot, conflicts: ['__no_base__'] }
          if (merged.conflicts.length === 0) {
            const cycleRangesChanged = cycleRangesDiffer(base, merged.snapshot)
            baselineRef.current = cloneSnapshot(remoteSnapshot)
            storedRef.current = { revision: remoteBoard.value.revision, snapshot: merged.snapshot }
            setStored(storedRef.current)
            if (cycleRangesChanged) reconcileSelection(merged.snapshot)
            const mergeJob: PendingJob = { expectedRevision: remoteBoard.value.revision, snapshot: merged.snapshot, draft: retained.draft, origin: retained.origin }
            pendingJobRef.current = mergeJob
            failedJobRef.current = null
            setSaveState('pending')
            setSaveMessage('')
            setFailureKind(null)
            queueMicrotask(() => { void drainRef.current?.() })
            return
          }
          // 无法自动合并：如实告知哪些改动需要人工决定，并保留草稿。
          setFlash(copy[language].mergeConflicts)
        }
      }
      failedJobRef.current = retained
      setSaveState(result.kind === 'offline' ? 'offline' : 'error')
      if (result.message) console.warn('[taskboard]', result.message)
      setSaveMessage(noticeText(result, 'noticeCloudError'))
      setFailureKind(result.kind === 'conflict' ? 'conflict' : null)
      setDraftLabel(retained.draft)
    }
  }, [clearPrivateState, language, reconcileSelection])
  drainRef.current = drainSave

  const commitSnapshot = useCallback((next: BoardSnapshot, draft: string | null = null, origin?: DraftOrigin): boolean => {
    try { validateSnapshot(next) } catch (caught) {
      setSaveState('error')
      setSaveMessage(errorNotice(caught, 'noticeBoardInvalid'))
      setDraftLabel(draft)
      return false
    }
    const current = storedRef.current
    if (!current || !adapterRef.current) return false
    const local: StoredBoard = { revision: current.revision, snapshot: next }
    storedRef.current = local
    setStored(local)
    const job: PendingJob = { expectedRevision: current.revision, snapshot: next, draft, origin }
    pendingJobRef.current = job
    failedJobRef.current = null
    setDraftLabel(draft)
    setSaveMessage('')
    setSaveState('pending')
    void drainRef.current?.()
    return true
  }, [])
  commitRef.current = commitSnapshot

  // 返回是否成功换上了新的板（false = 仍在旧板/被取代/失败）。调用方据此决定是否继续依赖它。
  // automatic=true 表示这是焦点/联网触发的自动刷新：只要还有未保存改动（在途、排队、失败保留），
  // 就直接放弃刷新。否则自动刷新会把刚失败的改动连同草稿一起丢掉，界面还会显示「已保存」。
  const reloadLatest = useCallback(async (keepDraft = true, automatic = false): Promise<boolean> => {
    if (automatic && (saveInFlightRef.current || pendingJobRef.current || failedJobRef.current)) return false
    const currentAdapter = adapterRef.current
    if (!currentAdapter) return false
    if (saveInFlightRef.current) {
      setSaveMessage('noticeSaveInProgress')
      return false
    }
    const epoch = ++saveEpochRef.current
    const result = await currentAdapter.load()
    if (epoch !== saveEpochRef.current || adapterRef.current !== currentAdapter) return false
    if (!result.ok) {
      if (result.kind === 'auth') { clearPrivateState('auth'); return false }
      setSaveState(result.kind === 'offline' ? 'offline' : 'error')
      if (result.message) console.warn('[taskboard]', result.message)
      setSaveMessage(noticeText(result, 'noticeCloudError'))
      return false
    }
    const existingDraft = draftLabel
    let safeBoard: StoredBoard
    try {
      const loadedSnapshot = validateSnapshot(result.value.snapshot)
      if (result.value.revision === 0 && loadedSnapshot.tasks.length === 0 && loadedSnapshot.focusBlocks.length === 0 && loadedSnapshot.cycles.length === 0) loadedSnapshot.settings.timeZone = safeTimeZone()
      safeBoard = { revision: result.value.revision, snapshot: loadedSnapshot }
    } catch (caught) {
      setSaveState('error')
      setSaveMessage(errorNotice(caught, 'noticeInvalidState'))
      return false
    }
    // 冲突时用户若选择“保留草稿”，失败的那次快照要留着，否则草稿只剩一个标题字符串，改动等于丢失。
    const cycleDraftDiscarded = !keepDraft && (failedJobRef.current?.origin?.kind === 'cycle' || pendingJobRef.current?.origin?.kind === 'cycle')
    const retained = keepDraft ? (failedJobRef.current || pendingJobRef.current) : null
    const cycleRangesChanged = cycleDraftDiscarded || cycleRangesDiffer(baselineRef.current, safeBoard.snapshot) || !safeBoard.snapshot.cycles.some((cycle) => cycle.id === selectionRef.current.cycleId)
    pendingJobRef.current = null
    failedJobRef.current = retained
    storedRef.current = safeBoard
    baselineRef.current = cloneSnapshot(safeBoard.snapshot)
    setStored(safeBoard)
    if (cycleRangesChanged) reconcileSelection(safeBoard.snapshot)
    setSaveState(retained ? 'error' : 'saved')
    setSaveMessage(retained ? 'noticeReapplyDraft' : '')
    setFailureKind(retained ? 'conflict' : null)
    if (!keepDraft) setDraftLabel(null)
    else setDraftLabel(existingDraft)
    return true
  }, [clearPrivateState, draftLabel, language, reconcileSelection])

  const retrySave = useCallback(() => {
    // 若已有更新的待保存变更，保留它；重试只补上失败的那次，不能用旧快照覆盖新改动。
    if (!failedJobRef.current) return
    if (!pendingJobRef.current) pendingJobRef.current = failedJobRef.current
    failedJobRef.current = null
    setSaveState('pending')
    setSaveMessage('')
    setFailureKind(null)
    void drainRef.current?.()
  }, [])

  const discardDirectConflict = useCallback(() => {
    if (window.confirm(t('confirmDiscardDirect'))) void reloadLatest(false)
  }, [reloadLatest, t])

  const previousOnlineRef = useRef(online)
  useEffect(() => {
    const becameOnline = !previousOnlineRef.current && online
    previousOnlineRef.current = online
    if (screen !== 'workspace' || !becameOnline || adapter?.mode !== 'cloud') return
    void reloadLatest(false, true)
  }, [adapter, online, reloadLatest, screen])

  useEffect(() => {
    if (screen !== 'workspace' || adapter?.mode !== 'cloud') return
    const refreshOnFocus = () => { void reloadLatest(false, true) }
    window.addEventListener('focus', refreshOnFocus)
    return () => window.removeEventListener('focus', refreshOnFocus)
  }, [adapter, reloadLatest, screen])

  // 冲突后只保留输入值：先刷新到最新 revision，再打开编辑器让用户重新确认，
  // 绝不用旧整板快照覆盖其他设备的新改动（那会静默丢失对方数据）。
  const reopenDraft = useCallback(async () => {
    const origin = failedJobRef.current?.origin
    if (!origin) { setFlash(copy[language].noRetainedInput); return }
    const generation = authLifecycle.generation()
    const expectedAdapter = adapterRef.current
    const expectedUserId = userRef.current?.id
    // 只有真正换上新板才继续：刷新失败（离线/错误）或会话已变时中止，避免在过期版本上继续编辑。
    const reloaded = await reloadLatest(true)
    if (!reloaded) return
    if (!authLifecycle.isCurrent(generation) || adapterRef.current !== expectedAdapter || userRef.current?.id !== expectedUserId) return
    const board = storedRef.current?.snapshot
    if (!board) return
    if (origin.kind === 'reorder') {
      // 顺序改动没有表单可打开：直接把这次移动重放到最新版本，再作为一次新的受保护变更提交。
      if (!board.tasks.some((task) => task.id === origin.taskId && !task.archivedAt)) {
        setFlash(copy[language].draftTargetMissing)
        return
      }
      const next = reapplyReorder(board, origin.taskId, origin.direction)
      const applied = commitSnapshot(next, `${t('title')}: ${board.tasks.find((task) => task.id === origin.taskId)?.title || ''}`, origin)
      if (applied) setFlash(copy[language].reorderReapplied)
      return
    }
    if (origin.kind === 'task') {
      const existing = origin.taskId ? board.tasks.find((task) => task.id === origin.taskId) : undefined
      // 目标已被删除时不再静默改成「新建」：那会悄悄产生一个重复任务，改为明确告知并保留输入。
      if (origin.taskId && !existing) { setFlash(copy[language].draftTargetMissing); return }
      setDialog({ kind: 'task', task: existing, domain: origin.domain, parentId: origin.parentId, initial: origin.input })
    } else if (origin.kind === 'cycle') {
      const existing = origin.cycleId ? board.cycles.find((cycle) => cycle.id === origin.cycleId) : undefined
      if (origin.cycleId && !existing) { setFlash(copy[language].draftTargetMissing); return }
      setDialog({ kind: 'cycle', cycle: existing, initial: origin.input })
    } else {
      const existing = origin.blockId ? board.focusBlocks.find((block) => block.id === origin.blockId) : undefined
      if (origin.blockId && !existing) { setFlash(copy[language].draftTargetMissing); return }
      setDialog({ kind: 'focus', block: existing, initial: origin.input })
    }
  }, [language, reloadLatest])

  const openDemo = useCallback(() => {
    void openBoard(createDemoBoardAdapter())
  }, [openBoard])

  const signIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const cloud = cloudRef.current
    if (!cloud || !authEmail.trim() || !authPassword) return
    const attempt = authLifecycle.beginLogin()
    if (attempt === null) return
    setAuthBusy(true)
    setAuthError('')
    try {
      const result = await cloud.signIn(authEmail.trim(), authPassword)
      if (!authLifecycle.isLoginCurrent(attempt)) return
      if (!result.ok) {
        setAuthError(result.code ? t(result.code) : result.message || t('invalidCredentials'))
        return
      }
      const transition = authLifecycle.completeLogin(attempt, userRef.current, result.value, screenRef.current, Boolean(storedRef.current))
      if (!transition) return
      applyAuthTransition(cloud, transition)
      setAuthPassword('')
    } catch (caught) {
      if (!authLifecycle.isLoginCurrent(attempt)) return
      if (caught instanceof Error) console.warn('[taskboard]', caught.message)
      setAuthError(t('cloudError'))
    } finally {
      if (authLifecycle.finishLogin(attempt)) setAuthBusy(false)
    }
  }

  const signOut = async () => {
    const cloud = cloudRef.current
    const generation = authLifecycle.beginLogout()
    if (generation === null) return
    try {
      const result = cloud ? await cloud.signOut() : { ok: true as const, value: undefined }
      if (!authLifecycle.isCurrent(generation)) return
      if (!result.ok) {
        setSaveState(result.kind === 'offline' ? 'offline' : 'error')
        setSaveMessage(noticeText(result, 'noticeCloudError'))
        return
      }
      applyAuthTransition(cloud, { user: null, changed: true, generation, shouldClear: 'auth', shouldLoad: false })
    } catch (caught) {
      if (!authLifecycle.isCurrent(generation)) return
      if (caught instanceof Error) console.warn('[taskboard]', caught.message)
      setSaveState('error')
      setSaveMessage('noticeCloudError')
    } finally {
      authLifecycle.finishLogout(generation)
    }
  }

  useEffect(() => {
    if (!flash) return
    const timeout = window.setTimeout(() => setFlash(''), 3500)
    return () => window.clearTimeout(timeout)
  }, [flash])

  useEffect(() => {
    if (screen !== 'workspace') return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.drag-handle')) { if (event.key.startsWith('Arrow')) event.preventDefault(); return }
      if (event.defaultPrevented || target?.closest('[role="dialog"]')) return
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (target?.isContentEditable) return
      if (event.key === 'Escape') { setDialog(null); return }
      if (/^[1-4]$/.test(event.key)) {
        event.preventDefault()
        panelRefs.current[Number(event.key) - 1]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' })
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault()
        workspaceScrollRef.current?.scrollBy({ left: event.key === 'ArrowRight' ? 460 : -460, behavior: 'smooth' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [screen])

  const updateSnapshot = (operation: (snapshot: BoardSnapshot) => BoardSnapshot, draft: string | null, origin?: DraftOrigin) => {
    const current = storedRef.current
    if (!current) return
    try {
      const next = operation(current.snapshot)
      if (next !== current.snapshot) commitSnapshot(next, draft, origin)
    } catch (caught) {
      setSaveState('error')
      setSaveMessage(errorNotice(caught, 'noticeOperationFailed'))
      setDraftLabel(draft)
    }
  }

  const submitTask = (input: TaskInput, existing?: Task, domain?: Domain, parentId?: string) => {
    const current = storedRef.current
    if (!current) return
    const targetDomain = domain || existing?.domain || 'daily'
    if (!existing && targetDomain !== 'long' && selectedCycle && !dateInRange(selectedDate, selectedCycle.startDate, selectedCycle.endDate)) {
      setFlash(t('selectionOutsideCycle'))
      return
    }
    const draft = `${t('title')}: ${input.title.trim()}`
    try {
      const next = existing
        ? updateTask(current.snapshot, existing.id, { title: input.title, note: input.note, color: input.color, upperTaskId: input.parentId ? undefined : input.upperTaskId, parentId: input.parentId }, new Date().toISOString())
        : addTask(current.snapshot, createTask({
          domain: targetDomain,
          title: input.title,
          note: input.note,
          color: input.color,
          parentId: parentId || input.parentId,
          upperTaskId: parentId || input.parentId ? undefined : input.upperTaskId,
          cycleId: targetDomain === 'long' ? selectedCycle?.id : undefined,
          weekKey: targetDomain === 'weekly' ? selectedWeek : undefined,
          dateKey: targetDomain === 'daily' ? selectedDate : undefined,
        }))
      if (commitSnapshot(next, draft, { kind: 'task', input, taskId: existing?.id, domain: targetDomain, parentId })) setDialog(null)
    } catch (caught) {
      setSaveState('error')
      setSaveMessage(errorNotice(caught, 'noticeTaskSaveFailed'))
      setDraftLabel(draft)
    }
  }

  const submitCycle = (input: { name: string; startDate: string; endDate: string }, existing?: GoalCycle) => {
    const current = storedRef.current
    if (!current) return
    try {
      let next: BoardSnapshot
      if (!existing) next = addCycle(current.snapshot, input.name, input.startDate, input.endDate)
      else {
        next = cloneSnapshot(current.snapshot)
        const cycle = next.cycles.find((candidate) => candidate.id === existing.id)
        if (!cycle) throw new BoardError('noticeCycleMissing', 'Cycle no longer exists')
        if (!input.name.trim() || compareDateKeys(input.startDate, input.endDate) > 0) throw new BoardError('noticeCycleInvalid', 'Cycle name and date range are required')
        cycle.name = input.name.trim(); cycle.startDate = input.startDate; cycle.endDate = input.endDate
        validateSnapshot(next)
      }
      if (commitSnapshot(next, `${t('cycle')}: ${input.name}`, { kind: 'cycle', input, cycleId: existing?.id })) {
        const created = next.cycles.find((cycle) => !existing && cycle.name === input.name.trim())
        const nextCycleId = existing?.id || created?.id || selectedCycleId
        reconcileSelection(next, nextCycleId, selectionRef.current.date)
        setDialog(null)
      }
    } catch (caught) {
      setSaveState('error'); setSaveMessage(errorNotice(caught, 'noticeCycleSaveFailed')); setDraftLabel(input.name)
    }
  }

  const submitFocus = (input: FocusInput, existing?: FocusBlock) => {
    const current = storedRef.current
    if (!current) return
    if (!existing && selectedCycle && !dateInRange(selectedDate, selectedCycle.startDate, selectedCycle.endDate)) {
      setFlash(t('selectionOutsideCycle'))
      return
    }
    const draft = `${t('focusTitle')}: ${input.title.trim()}`
    try {
      const duration = validateDurationMinutes(input.durationMinutes)
      const next = existing
        ? updateFocusBlock(current.snapshot, existing.id, { title: input.title.trim(), durationMinutes: duration, taskId: input.taskId || undefined })
        : addFocusBlock(current.snapshot, createFocusBlock({ dateKey: selectedDate, title: input.title, taskId: input.taskId || undefined, durationMinutes: duration }))
      if (commitSnapshot(next, draft, { kind: 'focus', input, blockId: existing?.id })) setDialog(null)
    } catch (caught) {
      setSaveState('error'); setSaveMessage(errorNotice(caught, 'noticeFocusSaveFailed')); setDraftLabel(draft)
    }
  }

  const selectedChain = useMemo(() => stored ? (selectedTaskId ? linkedChainIds(stored.snapshot, selectedTaskId) : new Set<string>()) : new Set<string>(), [stored, selectedTaskId])
  const currentZone = stored?.snapshot.settings.timeZone || safeTimeZone()
  // “今天”只算一次，供两条周期轨道标注本周/本日（与“选中”是两件事）。
  const todayKey = todayInTimeZone(currentZone)
  const currentWeekKey = weekKey(todayKey)
  const runningBlock = stored?.snapshot.focusBlocks.find((block) => block.status === 'running')
  const failedOrigin = failedJobRef.current?.origin
  const canReopenDraft = failedOrigin?.kind === 'task' || failedOrigin?.kind === 'cycle' || failedOrigin?.kind === 'focus'

  if (screen === 'setup') {
    return <SetupScreen language={language} setLanguage={setLanguage} t={t} onDemo={openDemo} />
  }
  if (screen === 'auth') {
    return <AuthScreen language={language} setLanguage={setLanguage} t={t} email={authEmail} password={authPassword} setEmail={setAuthEmail} setPassword={setAuthPassword} busy={authBusy} error={authError || (saveState === 'error' ? noticeLabel(saveMessage) : '')} onSubmit={signIn} />
  }
  if (screen === 'loading' || !stored) {
    return <LoadingScreen language={language} t={t} />
  }

  const snapshot = stored.snapshot
  const selectedCycle = snapshot.cycles.find((cycle) => cycle.id === selectedCycleId) || snapshot.cycles[0]
  const selectCycle = (cycleId: string) => reconcileSelection(snapshot, cycleId, selectionRef.current.date)
  const selectWeek = (key: string) => {
    const date = dateForWeek(key, selectedCycle, selectionRef.current.date)
    applySelection({ cycleId: selectedCycle?.id || null, date, week: key })
  }
  const setDate = (date: string, allowOutsideCycle = false) => {
    const nextDate = !allowOutsideCycle && selectedCycle ? clampDate(date, selectedCycle.startDate, selectedCycle.endDate) : date
    applySelection({ cycleId: selectedCycle?.id || null, date: nextDate, week: weekKey(nextDate) })
  }
  const panelRef = (index: number) => (element: HTMLElement | null) => { panelRefs.current[index] = element }
  const registerRow = (id: string) => (element: HTMLElement | null) => {
    if (element) rowRefs.current.set(id, element)
    else rowRefs.current.delete(id)
  }

  const panelTasks = (domain: Domain) => activeTasks(snapshot, domain).filter((task) => {
    if (domain === 'long') return task.cycleId === selectedCycle?.id
    if (domain === 'weekly') return task.weekKey === selectedWeek
    return task.dateKey === selectedDate
  })
  // 过去未完成的任务不再用顶部提示条确认：周任务在载入时已经自动顺延（见 openBoard），
  // 日任务保留面板提示与行内“建议重新安排”作为手动入口。

  // 「回到当前」只在今天/本周仍在所选周期范围内、且已离开当前周期时出现。
  const canGoCurrentWeek = !selectedCycle || (currentWeekKey >= weekKey(selectedCycle.startDate) && currentWeekKey <= weekKey(selectedCycle.endDate))
  const canGoToday = !selectedCycle || dateInRange(todayKey, selectedCycle.startDate, selectedCycle.endDate)
  const goCurrentWeek = canGoCurrentWeek && selectedWeek !== currentWeekKey ? <ReturnToCurrent label={t('thisWeek')} hint={t('backToCurrentWeek')} onClick={() => selectWeek(currentWeekKey)} /> : null
  const goToday = canGoToday && selectedDate !== todayKey ? <ReturnToCurrent label={t('today')} hint={t('backToCurrentDay')} onClick={() => setDate(todayKey)} /> : null

  const taskForFocus = activeTasks(snapshot, 'daily')
  const canCreateInCycle = !selectedCycle || dateInRange(selectedDate, selectedCycle.startDate, selectedCycle.endDate)

  return (
    <div className="app-shell">
      <Header language={language} setLanguage={setLanguage} t={t} mode={adapter?.mode || 'cloud'} email={user?.email} saveState={saveState} saveMessage={noticeLabel(saveMessage)} online={online} onSettings={() => setDialog({ kind: 'settings' })} onRefresh={() => void reloadLatest(true)} onLogout={adapter?.mode === 'cloud' ? signOut : () => clearPrivateState(config ? 'auth' : 'setup')} />
      {saveState === 'error' || saveState === 'offline' || !online ? (
        <div className="notice-bar save-notice" role="status">
          <span className="notice-dot" />
          <span>{saveMessage ? noticeLabel(saveMessage) : saveState === 'offline' || !online ? t('offline') : t('error')}</span>
          {failedJobRef.current?.draft && !canReopenDraft ? <span className="save-operation">{failedJobRef.current.draft}</span> : null}
          {failedJobRef.current && (saveState === 'error' || saveState === 'offline') && failureKind !== 'conflict' ? <button className="text-button" onClick={retrySave}>{t('retry')}</button> : null}
          {failureKind === 'conflict' && !failedJobRef.current ? <button className="text-button" onClick={() => void reloadLatest(true)}>{t('reloadLatest')}</button> : null}
          {failureKind === 'conflict' && failedJobRef.current && !canReopenDraft ? <button className="text-button" onClick={discardDirectConflict}>{t('reloadLatestDirect')}</button> : null}
          {failureKind === 'conflict' && canReopenDraft ? <button className="text-button" onClick={() => void reopenDraft()}>{t('reopenDraft')}</button> : null}
        </div>
      ) : null}
      {draftLabel && canReopenDraft && (saveState === 'error' || saveState === 'offline') ? (
        <div className="notice-bar draft-notice" role="status">
          <div><strong>{t('draftTitle')}</strong><span>{draftLabel}</span></div>
          <div className="notice-actions">
            <button className="text-button" onClick={() => void reloadLatest(true)}>{t('reloadLatest')}</button>
            <button className="text-button muted-action" onClick={() => void reloadLatest(false)}>{t('discardDraft')}</button>
          </div>
        </div>
      ) : null}
      {runningBlock && runningBlock.dateKey !== selectedDate ? (
        <div className="running-banner" role="status">
          <span className="pulse-dot" />{t('runningElsewhere')} · {formatDateKey(runningBlock.dateKey, language, currentZone)}
          <button className="text-button" onClick={() => { setDate(runningBlock.dateKey, true); panelRefs.current[3]?.scrollIntoView({ behavior: 'smooth', inline: 'start' }) }}>{t('jumpFocus')}</button>
        </div>
      ) : null}
      <main className="workspace-scroll" ref={workspaceScrollRef} aria-label={t('subtitle')}>
        <div className="workspace-stage" ref={setStageElement}>
          <ConnectorLayer stage={stageElement} snapshot={snapshot} rowRefs={rowRefs} selectedChain={selectedChain} />
          <TaskPanel
            onSort={sortTask}
            panelRef={panelRef(0)} domain="long" title={t('long')} hint={t('longHint')} language={language} t={t}
            tasks={panelTasks('long')} snapshot={snapshot} timeZone={currentZone} selectedId={selectedTaskId} selectedChain={selectedChain} registerRow={registerRow}
            rail={<CycleRail cycles={snapshot.cycles} selectedId={selectedCycle?.id} language={language} t={t} onSelect={selectCycle} onAdd={() => setDialog({ kind: 'cycle' })} onEdit={(cycle) => setDialog({ kind: 'cycle', cycle })} />}
            canAdd={Boolean(selectedCycle)} onAdd={() => setDialog({ kind: 'task', domain: 'long' })} onEdit={(task) => setDialog({ kind: 'task', task, domain: 'long' })}
            onDelete={deleteTaskWithConfirm} onToggle={toggleTask} onReorder={reorderTask} onSelect={setSelectedTaskId} onAddSubtask={(task) => setDialog({ kind: 'task', domain: 'long', parentId: task.id })} />
          <TaskPanel
            onSort={sortTask}
            panelRef={panelRef(1)} domain="weekly" title={t('weekly')} hint={t('weeklyHint')} language={language} t={t}
            tasks={panelTasks('weekly')} snapshot={snapshot} timeZone={currentZone} selectedId={selectedTaskId} selectedChain={selectedChain} registerRow={registerRow}
            rail={<WeekRail selectedWeek={selectedWeek} currentWeek={currentWeekKey} cycle={selectedCycle} language={language} t={t} onSelect={selectWeek} />}
            currentAction={goCurrentWeek}
            canAdd canCreate={canCreateInCycle} onAdd={() => setDialog({ kind: 'task', domain: 'weekly' })} onEdit={(task) => setDialog({ kind: 'task', task, domain: 'weekly' })}
            onDelete={deleteTaskWithConfirm} onToggle={toggleTask} onReorder={reorderTask} onSelect={setSelectedTaskId} onAddSubtask={(task) => setDialog({ kind: 'task', domain: 'weekly', parentId: task.id })} onReschedule={(task) => setDialog({ kind: 'reschedule', task })} />
          <TaskPanel
            onSort={sortTask}
            panelRef={panelRef(2)} domain="daily" title={`${t('daily')} · ${weekdayLabel(selectedDate, language)}`} hint={t('dailyHint')} language={language} t={t}
            tasks={panelTasks('daily')} snapshot={snapshot} timeZone={currentZone} selectedId={selectedTaskId} selectedChain={selectedChain} registerRow={registerRow}
            rail={<DayRail selectedDate={selectedDate} selectedWeek={selectedWeek} todayKey={todayKey} cycle={selectedCycle} language={language} t={t} onSelect={setDate} />}
            currentAction={goToday}
            canAdd canCreate={canCreateInCycle} onAdd={() => setDialog({ kind: 'task', domain: 'daily' })} onEdit={(task) => setDialog({ kind: 'task', task, domain: 'daily' })}
            onDelete={deleteTaskWithConfirm} onToggle={toggleTask} onReorder={reorderTask} onSelect={setSelectedTaskId} onAddSubtask={(task) => setDialog({ kind: 'task', domain: 'daily', parentId: task.id })} onReschedule={(task) => setDialog({ kind: 'reschedule', task })} />
          <FocusPanel
            panelRef={panelRef(3)} blocks={snapshot.focusBlocks.filter((block) => block.dateKey === selectedDate)} allTasks={taskForFocus} selectedDate={selectedDate} language={language} t={t} now={now}
            rail={<DayRail selectedDate={selectedDate} selectedWeek={selectedWeek} todayKey={todayKey} cycle={selectedCycle} language={language} t={t} onSelect={setDate} />}
            currentAction={goToday}
            canAdd={canCreateInCycle} onAdd={() => setDialog({ kind: 'focus' })} onEdit={(block) => setDialog({ kind: 'focus', block })} onDelete={deleteFocusWithConfirm} onCommand={focusCommand}
          />
        </div>
      </main>
      <footer className="app-footer"><span>{t('keyboard')}</span><span>{t('shortcuts')}</span>{adapter?.mode === 'demo' ? <span>{t('demoNote')}</span> : <span>{t('cloudNote')}</span>}</footer>
      {flash ? <div className="toast" role="status">{flash}</div> : null}
      {dialog?.kind === 'task' ? <TaskDialog key={`${dialog.task?.id || 'new'}:${dialog.domain}:${dialog.parentId || ''}`} task={dialog.task} domain={dialog.domain} parentId={dialog.parentId} initial={dialog.initial} placement={{ cycleId: selectedCycle?.id, weekKey: selectedWeek, dateKey: selectedDate }} tasks={activeTasks(snapshot)} t={t} onClose={() => setDialog(null)} onSubmit={(input) => submitTask(input, dialog.task, dialog.domain, dialog.parentId)} /> : null}
      {dialog?.kind === 'cycle' ? <CycleDialog key={dialog.cycle?.id || 'new'} cycle={dialog.cycle} initial={dialog.initial} language={language} t={t} onClose={() => setDialog(null)} onSubmit={(input) => submitCycle(input, dialog.cycle)} /> : null}
      {dialog?.kind === 'focus' ? <FocusDialog key={dialog.block?.id || 'new'} block={dialog.block} initial={dialog.initial} tasks={taskForFocus} selectedDate={selectedDate} language={language} t={t} onClose={() => setDialog(null)} onSubmit={(input) => submitFocus(input, dialog.block)} /> : null}
      {dialog?.kind === 'settings' ? <SettingsDialog zone={snapshot.settings.timeZone} language={language} t={t} onClose={() => setDialog(null)} onLanguage={setLanguage} onSubmit={(zone) => { updateSettings(zone); setDialog(null) }} /> : null}
      {dialog?.kind === 'reschedule' ? <RescheduleDialog task={dialog.task} language={language} t={t} zone={currentZone} onClose={() => setDialog(null)} onSubmit={(date) => { rescheduleTask(dialog.task, date); setDialog(null) }} /> : null}
    </div>
  )

  function toggleTask(task: Task) {
    updateSnapshot((current) => updateTask(current, task.id, { checked: !task.checked }), `${t('title')}: ${task.title}`)
  }

  function deleteTaskWithConfirm(task: Task) {
    const current = storedRef.current
    if (!current) return
    const hasChildren = current.snapshot.tasks.some((candidate) => candidate.parentId === task.id && !candidate.archivedAt)
    const message = hasChildren ? t('confirmDeleteWithChildren') : t('confirmDelete')
    if (!window.confirm(message)) return
    updateSnapshot((snapshot) => deleteTask(snapshot, task.id), `${t('delete')}: ${task.title}`)
    if (selectedTaskId === task.id) setSelectedTaskId(null)
  }

  function reorderTask(task: Task, direction: -1 | 1) {
    // 带上来源，冲突时直接加载最新版本后再明确重做，不把排序伪装成表单草稿。
    updateSnapshot((current) => reorderSibling(current, task.id, direction), `${t('title')}: ${task.title}`, reorderOrigin(task, direction))
  }

  function sortTask(task: Task, targetId: string) {
    updateSnapshot((current) => reorderSiblingTo(current, task.id, targetId), `${t('dragTask')}: ${task.title}`)
  }

  function deleteFocusWithConfirm(block: FocusBlock) {
    if (!window.confirm(t('confirmDeleteFocus'))) return
    updateSnapshot((current) => deleteFocusBlock(current, block.id), `${t('delete')}: ${block.title}`)
  }

  function focusCommand(block: FocusBlock, command: 'start' | 'pause' | 'resume' | 'finish') {
    updateSnapshot((current) => setFocusCommand(current, block.id, command), `${t('focus')}: ${block.title}`)
  }

  function updateSettings(zone: string) {
    const current = storedRef.current
    if (!current) return
    const safe = safeTimeZone(zone)
    if (safe !== zone) { setFlash(t('invalidTimeZone')); return }
    const next = cloneSnapshot(current.snapshot)
    next.settings.timeZone = safe
    commitSnapshot(next, `${t('timezone')}: ${safe}`)
  }

  function rescheduleTask(task: Task, target: string) {
    const job = `${t('reschedule')}: ${task.title}`
    updateSnapshot((current) => task.domain === 'weekly' ? rescheduleWeeklyTask(current, task.id, target) : rescheduleDailyTask(current, task.id, target), job)
  }
}

function SetupScreen({ language, setLanguage, t, onDemo }: { language: Language; setLanguage: (language: Language) => void; t: (key: CopyKey) => string; onDemo: () => void }) {
  return <div className="center-screen">
    <div className="setup-card">
      <div className="brand-lockup"><BrandMark /><span><strong>{t('appName')}</strong><small>{t('subtitle')}</small></span></div>
      <div className="eyebrow">{t('connectionMissing')}</div>
      <h1>{t('setupTitle')}</h1>
      <p>{t('setupBody')}</p>
      <div className="setup-actions"><button className="primary-button" onClick={onDemo}>{t('localDemo')}</button><span className="setup-note">{t('setupDocs')}</span></div>
      <div className="language-switch"><button className={language === 'zh' ? 'active' : ''} onClick={() => setLanguage('zh')}>{t('chinese')}</button><button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}>{t('english')}</button></div>
    </div>
  </div>
}

function AuthScreen({ language, setLanguage, t, email, password, setEmail, setPassword, busy, error, onSubmit }: {
  language: Language; setLanguage: (language: Language) => void; t: (key: CopyKey) => string; email: string; password: string; setEmail: (value: string) => void; setPassword: (value: string) => void; busy: boolean; error: string; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  return <div className="center-screen"><div className="setup-card auth-card">
    <div className="brand-lockup"><BrandMark /><span><strong>{t('appName')}</strong><small>{t('subtitle')}</small></span></div>
    <div className="eyebrow">{t('cloud')}</div><h1>{t('authTitle')}</h1><p>{t('authBody')}</p>
    <form onSubmit={onSubmit} className="auth-form" noValidate>
      <label>{t('email')}<input autoFocus type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
      <label>{t('password')}<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
      <button className="primary-button" disabled={busy}>{busy ? t('signingIn') : t('signIn')}</button>
    </form>
    <div className="auth-foot"><span>{t('setupDocs')}</span><div className="language-switch"><button className={language === 'zh' ? 'active' : ''} onClick={() => setLanguage('zh')}>{t('chinese')}</button><button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}>{t('english')}</button></div></div>
  </div></div>
}

function LoadingScreen({ language, t }: { language: Language; t: (key: CopyKey) => string }) {
  return <div className="center-screen"><div className="loading-mark"><BrandMark /><p>{t('loading')}</p><div className="loading-line" /></div><div className="language-switch loading-language"><button className={language === 'zh' ? 'active' : ''}>{t('chinese')}</button><button className={language === 'en' ? 'active' : ''}>{t('english')}</button></div></div>
}

function Header({ language, setLanguage, t, mode, email, saveState, saveMessage, online, onSettings, onRefresh, onLogout }: {
  language: Language; setLanguage: (language: Language) => void; t: (key: CopyKey) => string; mode: 'demo' | 'cloud'; email?: string; saveState: SaveState; saveMessage: string; online: boolean; onSettings: () => void; onRefresh: () => void; onLogout: () => void
}) {
  // 离线优先判断：否则 saveState 仍是 'saved' 时会错误地显示“已保存”。
  const statusKey = !online || saveState === 'offline' ? 'offline' : saveState === 'error' ? 'error' : saveState === 'saving' ? 'saving' : saveState === 'pending' ? 'pending' : 'saved'
  return <header className="top-header">
    <div className="header-left"><div className="header-year">{new Date().getFullYear()}</div><div className="crumb-slash">/</div><div className="brand-lockup compact"><BrandMark /><span><strong>{t('appName')}</strong><small>{t('subtitle')}</small></span></div></div>
    <div className="header-right"><span className={`mode-pill ${mode}`}>{mode === 'demo' ? t('demo') : t('cloud')}</span><span className={`save-indicator ${online ? saveState : 'offline'}`}><span className="status-dot" />{t(statusKey)}</span>
      <button className="icon-button" aria-label={t('settings')} title={t('settings')} onClick={onSettings}><Icon name="sliders" /></button>
      <button className="icon-button" aria-label={t('refresh')} title={t('refresh')} onClick={onRefresh}><Icon name="refresh" /></button>
      <button className="account-button" onClick={onLogout} title={email || (mode === 'demo' ? t('demoNote') : '')}><span className="account-avatar">{email ? email[0].toUpperCase() : mode === 'demo' ? 'D' : '·'}</span><span className="account-label">{email || t('demo')}</span></button>
      <div className="language-switch header-language"><button className={language === 'zh' ? 'active' : ''} onClick={() => setLanguage('zh')}>{t('chinese')}</button><button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}>{t('english')}</button></div>
    </div>
    {saveMessage ? <span className="sr-only" role="status">{saveMessage}</span> : null}
  </header>
}

function CycleRail({ cycles, selectedId, language, t, onSelect, onAdd, onEdit }: { cycles: GoalCycle[]; selectedId?: string; language: Language; t: (key: CopyKey) => string; onSelect: (id: string) => void; onAdd: () => void; onEdit: (cycle: GoalCycle) => void }) {
  return <aside className="period-rail" aria-label={t('periodRail')}><div className="rail-heading">{t('cycles')}</div><div className="rail-items">{cycles.map((cycle) => <div className="rail-item-wrap" key={cycle.id}><button className={`rail-item ${selectedId === cycle.id ? 'selected' : ''}`} aria-current={selectedId === cycle.id ? 'page' : undefined} onClick={() => onSelect(cycle.id)}><span>{cycle.name}</span><small>{cycle.startDate.slice(5)}</small></button>{selectedId === cycle.id ? <button className="rail-edit" aria-label={t('editCycle')} onClick={() => onEdit(cycle)}><Icon name="edit" /></button> : null}</div>)}</div><button className="rail-add" onClick={onAdd}><Icon name="plus" />{t('addCycle')}</button></aside>
}

// 周、日的导航范围来自选中的长期周期；没有周期时保留独立的当前窗口，方便空板继续使用。
const RAIL_ROW_HEIGHT = 52
const RAIL_VIEW_HEIGHT = 480
const RAIL_VIRTUAL_THRESHOLD = 9
const RAIL_OVERSCAN = 4

function useRailWindow<T>(items: T[], selectedIndex: number) {
  const railRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const virtual = items.length > RAIL_VIRTUAL_THRESHOLD
  useLayoutEffect(() => {
    if (!railRef.current) return
    const rail = railRef.current
    const clamped = Math.min(rail.scrollTop, Math.max(0, rail.scrollHeight - rail.clientHeight))
    if (rail.scrollTop !== clamped) rail.scrollTop = clamped
    if (scrollTop !== clamped) setScrollTop(clamped)
  }, [items.length, virtual])
  useLayoutEffect(() => {
    if (!virtual || selectedIndex < 0 || !railRef.current) return
    const rail = railRef.current
    const top = selectedIndex * RAIL_ROW_HEIGHT
    const bottom = top + RAIL_ROW_HEIGHT
    const nextScrollTop = top < rail.scrollTop ? top : bottom > rail.scrollTop + rail.clientHeight ? bottom - rail.clientHeight : rail.scrollTop
    if (nextScrollTop !== rail.scrollTop) {
      rail.scrollTop = nextScrollTop
      setScrollTop(nextScrollTop)
    }
  }, [items.length, selectedIndex, virtual])
  const start = virtual ? Math.max(0, Math.floor(scrollTop / RAIL_ROW_HEIGHT) - RAIL_OVERSCAN) : 0
  const end = virtual ? Math.min(items.length, Math.ceil((scrollTop + RAIL_VIEW_HEIGHT) / RAIL_ROW_HEIGHT) + RAIL_OVERSCAN) : items.length
  return { railRef, onScroll: (event: React.UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop), visible: items.slice(start, end), paddingTop: virtual ? start * RAIL_ROW_HEIGHT : 0, paddingBottom: virtual ? Math.max(0, (items.length - end) * RAIL_ROW_HEIGHT) : 0 }
}

function WeekRail({ selectedWeek, currentWeek, cycle, language, t, onSelect }: { selectedWeek: string; currentWeek: string; cycle?: GoalCycle; language: Language; t: (key: CopyKey) => string; onSelect: (key: string) => void }) {
  const weeks = useMemo(() => cycle ? weekKeysInRange(cycle.startDate, cycle.endDate) : [-2, -1, 0, 1, 2].map((offset) => weekKey(addDays(weekRange(selectedWeek).start, offset * 7))), [cycle?.startDate, cycle?.endDate, selectedWeek])
  const items = useMemo(() => weeks.map((key) => ({ key, start: weekRange(key).start.slice(5), isCurrent: key === currentWeek })), [currentWeek, weeks])
  const selectedIndex = items.findIndex((item) => item.key === selectedWeek)
  const windowed = useRailWindow(items, selectedIndex)
  return <aside className="period-rail" aria-label={t('periodRail')}><div className="rail-heading">{t('weeks')}</div><div className={`rail-items ${weeks.length > 7 ? 'range-items' : ''}`} ref={windowed.railRef} onScroll={windowed.onScroll}>{windowed.paddingTop ? <div className="rail-spacer" style={{ height: windowed.paddingTop }} aria-hidden="true" /> : null}{windowed.visible.map(({ key, start, isCurrent }) => <button className={`rail-item ${selectedWeek === key ? 'selected' : ''} ${isCurrent ? 'is-current' : ''}`} aria-current={selectedWeek === key ? 'page' : undefined} aria-label={isCurrent ? `${key.slice(5)} · ${t('currentWeek')}` : key.slice(5)} key={key} onClick={() => onSelect(key)}><span>{key.slice(5)}{isCurrent ? <i className="current-mark" aria-hidden="true" /> : null}</span><small>{start}</small></button>)}{windowed.paddingBottom ? <div className="rail-spacer" style={{ height: windowed.paddingBottom }} aria-hidden="true" /> : null}</div></aside>
}

function DayRail({ selectedDate, selectedWeek, todayKey, cycle, language, t, onSelect }: { selectedDate: string; selectedWeek: string; todayKey: string; cycle?: GoalCycle; language: Language; t: (key: CopyKey) => string; onSelect: (date: string) => void }) {
  const days = useMemo(() => cycle ? dateKeysInRange(cycle.startDate, cycle.endDate) : Array.from({ length: 7 }, (_, index) => addDays(weekRange(selectedWeek).start, index)), [cycle?.startDate, cycle?.endDate, selectedWeek])
  const items = useMemo(() => days.map((date) => ({ date, label: weekdayShortLabel(date, language), isToday: date === todayKey })), [days, language, todayKey])
  const selectedIndex = items.findIndex((item) => item.date === selectedDate)
  const windowed = useRailWindow(items, selectedIndex)
  return <aside className="period-rail" aria-label={t('periodRail')}><div className="rail-heading">{t('days')}</div><div className={`rail-items ${days.length > 7 ? 'range-items' : ''}`} ref={windowed.railRef} onScroll={windowed.onScroll}>{windowed.paddingTop ? <div className="rail-spacer" style={{ height: windowed.paddingTop }} aria-hidden="true" /> : null}{windowed.visible.map(({ date, label, isToday }) => <button className={`rail-item day-item ${selectedDate === date ? 'selected' : ''} ${isToday ? 'is-current' : ''}`} aria-current={selectedDate === date ? 'page' : undefined} aria-label={isToday ? `${label} ${date.slice(5)} · ${t('currentDay')}` : `${label} ${date.slice(5)}`} key={date} onClick={() => onSelect(date)}><span>{label}{isToday ? <i className="current-mark" aria-hidden="true" /> : null}</span><small>{date.slice(5)}</small></button>)}{windowed.paddingBottom ? <div className="rail-spacer" style={{ height: windowed.paddingBottom }} aria-hidden="true" /> : null}</div></aside>
}

// “回到本周 / 回到今天”：按设计放在面板头部下方、右对齐；图标由“当前”圆点 + 返回箭头组成，
// 可见文字只写“本周 / 今天”，完整语义由 aria-label / title 承担。
function ReturnToCurrent({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return <div className="panel-current"><button className="current-return" onClick={onClick} aria-label={hint} title={hint}><i className="current-mark" aria-hidden="true" /><Icon name="back" />{label}</button></div>
}

function SortableTaskList({ tasks, t, onSort, children }: { tasks: Task[]; t: (key: CopyKey) => string; onSort: (task: Task, targetId: string) => void; children: React.ReactNode }) {
  const mounted = useRef(true)
  // 传感器的结束事件可能晚于列表卸载；切换日期或退出看板后不能再提交旧拖拽。
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const keyboardCoordinates: KeyboardCoordinateGetter = (event, { active, context }) => {
    if (event.code !== 'ArrowUp' && event.code !== 'ArrowDown') return
    event.preventDefault()
    const index = tasks.findIndex((task) => task.id === (context.over?.id ?? active))
    const target = tasks[index + (event.code === 'ArrowDown' ? 1 : -1)]
    const rect = target && context.droppableRects.get(target.id)
    const current = context.collisionRect
    if (index < 0 || !rect || !current) return
    // 长备注会产生高度差很大的卡片；对齐中心才能与键盘的 closestCenter 落点一致。
    return { x: rect.left + (rect.width - current.width) / 2, y: rect.top + (rect.height - current.height) / 2 }
  }
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates, scrollBehavior: 'auto' }),
  )
  const position = (id: string | number) => `${t('dragPosition')}: ${tasks.findIndex((task) => task.id === id) + 1} / ${tasks.length}`
  const announcements: Announcements = {
    onDragStart: ({ active }) => `${t('dragStarted')}: ${tasks.find((task) => task.id === active.id)?.title || ''}. ${position(active.id)}`,
    onDragOver: ({ over }) => over ? position(over.id) : t('dragOutside'),
    onDragEnd: ({ over }) => over ? t('dragEnded') : t('dragCancelled'),
    onDragCancel: () => t('dragCancelled'),
  }
  return <DndContext sensors={sensors}
    collisionDetection={(args) => args.pointerCoordinates ? pointerWithin(args) : closestCenter(args)}
    accessibility={{ screenReaderInstructions: { draggable: t('dragInstructions') }, announcements }}
    onDragEnd={({ active, over }) => {
      if (!mounted.current || !over || active.id === over.id) return
      const task = tasks.find((candidate) => candidate.id === active.id)
      if (task && tasks.some((candidate) => candidate.id === over.id)) onSort(task, String(over.id))
    }}>
    <SortableContext items={tasks} strategy={verticalListSortingStrategy}>{children}</SortableContext>
  </DndContext>
}

function TaskPanel({ domain, title, hint, language, t, tasks, snapshot, timeZone, selectedId, selectedChain, registerRow, rail, currentAction, canAdd, canCreate = true, onAdd, onEdit, onDelete, onToggle, onReorder, onSort, onSelect, onAddSubtask, onReschedule, panelRef }: {
  domain: Domain; title: string; hint: string; language: Language; t: (key: CopyKey) => string; tasks: Task[]; snapshot: BoardSnapshot; timeZone: string; selectedId: string | null; selectedChain: Set<string>; registerRow: (id: string) => (element: HTMLElement | null) => void; rail: React.ReactNode; currentAction?: React.ReactNode; canAdd: boolean; canCreate?: boolean; onAdd: () => void; onEdit: (task: Task) => void; onDelete: (task: Task) => void; onToggle: (task: Task) => void; onReorder: (task: Task, direction: -1 | 1) => void; onSelect: (id: string) => void; onAddSubtask: (task: Task) => void; onReschedule?: (task: Task) => void; panelRef?: (element: HTMLElement | null) => void
  onSort: (task: Task, targetId: string) => void
}) {
  const topLevel = tasks.filter((task) => !task.parentId)
  const addEnabled = canAdd && canCreate
  const carrySource = carriedFromLabels(snapshot)
  return <section className={`panel-shell domain-${domain}`} ref={panelRef} aria-labelledby={`panel-${domain}`}>
    {rail}<div className="paper-panel"><div className="panel-top"><div><div className="eyebrow">{domain === 'long' ? '01' : domain === 'weekly' ? '02' : '03'}</div><h2 id={`panel-${domain}`}>{title}</h2><p>{hint}</p></div><button className="add-button" onClick={onAdd} disabled={!addEnabled}><Icon name="plus" />{t('addTask')}</button></div>
      {currentAction}
      {(domain === 'daily' || domain === 'weekly') && tasks.some((task) => isPastPlacement(task, snapshot.settings.timeZone)) ? <div className="past-note">{t('reschedule')}</div> : null}
      {!canAdd ? <div className="empty-panel"><div className="empty-glyph">○</div><p>{t('noCycles')}</p></div> : topLevel.length === 0 ? <div className="empty-panel"><div className="empty-glyph">—</div><p>{domain === 'long' ? t('emptyLong') : domain === 'weekly' ? t('emptyWeekly') : t('emptyDaily')}</p><button className="text-button" onClick={onAdd} disabled={!addEnabled}>{t('addTask')}</button></div> : <div className="task-list"><SortableTaskList key={topLevel[0].cycleId || topLevel[0].weekKey || topLevel[0].dateKey} tasks={topLevel} t={t} onSort={onSort}>{topLevel.map((task) => <TaskRow key={task.id} task={task} childrenTasks={tasks.filter((candidate) => candidate.parentId === task.id)} timeZone={timeZone} language={language} t={t} selectedId={selectedId} selectedChain={selectedChain} registerRow={registerRow} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} onReorder={onReorder} onSort={onSort} onSelect={onSelect} onAddSubtask={onAddSubtask} onReschedule={onReschedule} carrySource={carrySource} />)}</SortableTaskList></div>}
      <div className="paper-space" />
    </div>
  </section>
}

function TaskRow({ task, childrenTasks, timeZone, language, t, selectedId, selectedChain, registerRow, carrySource, onEdit, onDelete, onToggle, onReorder, onSort, onSelect, onAddSubtask, onReschedule }: {
  task: Task; childrenTasks: Task[]; timeZone: string; language: Language; t: (key: CopyKey) => string; selectedId: string | null; selectedChain: Set<string>; registerRow: (id: string) => (element: HTMLElement | null) => void; carrySource: Map<string, string>; onEdit: (task: Task) => void; onDelete: (task: Task) => void; onToggle: (task: Task) => void; onReorder: (task: Task, direction: -1 | 1) => void; onSelect: (id: string) => void; onAddSubtask: (task: Task) => void; onReschedule?: (task: Task) => void
  onSort: (task: Task, targetId: string) => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  const isPast = isPastPlacement(task, timeZone)
  const carriedFrom = carrySource.get(task.id)
  return <div className={`task-tree ${isDragging ? 'is-dragging' : ''}`} ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }}><div className={`task-row ${selectedId === task.id ? 'selected' : ''} ${selectedChain.has(task.id) ? 'is-linked' : ''} ${task.checked ? 'is-checked' : ''}`} data-task-id={task.id} ref={registerRow(task.id)}>
    <button type="button" className="drag-handle" ref={setActivatorNodeRef} {...attributes} {...listeners} aria-roledescription={t('dragTask')} aria-label={`${t('dragTask')}: ${task.title}`} title={t('dragInstructions')}><Icon name="grip" /></button>
    <button className="task-select" onClick={() => onSelect(task.id)} aria-label={`${t('taskDetails')}: ${task.title}`}><span className={`task-stroke stroke-${task.color}`} /></button>
    <input type="checkbox" checked={task.checked} onChange={() => onToggle(task)} aria-label={`${task.title} · ${task.checked ? t('taskChecked') : t('taskUnchecked')}`} />
    <button className="task-title" onClick={() => { onSelect(task.id); onEdit(task) }} title={t('taskDetails')}><span>{task.title}</span>{task.note ? <small>{task.note}</small> : null}</button>
    {task.upperTaskId ? <span className="link-mark" title={t('association')}><Icon name="link" /></span> : null}
    {carriedFrom ? <span className="carry-tag" title={`${t('carriedFrom')} ${carriedFrom}`}>{carriedFrom.slice(5)}</span> : null}
    <span className="row-break" aria-hidden="true" />
    {isPast && onReschedule ? <button className="row-action reschedule-action" onClick={() => onReschedule(task)}>{t('reschedule')}</button> : null}
    <div className="row-actions">{!task.parentId ? <button className="row-icon" aria-label={t('addSubtask')} title={t('addSubtask')} onClick={() => onAddSubtask(task)}><Icon name="subtask" /></button> : null}<button className="row-icon" aria-label={t('moveUp')} title={t('moveUp')} onClick={() => onReorder(task, -1)}><Icon name="up" /></button><button className="row-icon" aria-label={t('moveDown')} title={t('moveDown')} onClick={() => onReorder(task, 1)}><Icon name="down" /></button><button className="row-icon" aria-label={t('edit')} title={t('edit')} onClick={() => onEdit(task)}><Icon name="edit" /></button><button className="row-icon danger" aria-label={t('delete')} title={t('delete')} onClick={() => onDelete(task)}><Icon name="trash" /></button></div>
  </div>{childrenTasks.length ? <div className="subtask-list"><SortableTaskList tasks={childrenTasks} t={t} onSort={onSort}>{childrenTasks.map((child) => <TaskRow key={child.id} task={child} childrenTasks={[]} timeZone={timeZone} language={language} t={t} selectedId={selectedId} selectedChain={selectedChain} registerRow={registerRow} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} onReorder={onReorder} onSort={onSort} onSelect={onSelect} onAddSubtask={onAddSubtask} onReschedule={onReschedule} carrySource={carrySource} />)}</SortableTaskList></div> : null}</div>
}

function FocusPanel({ blocks, allTasks, selectedDate, language, t, now, rail, currentAction, canAdd = true, onAdd, onEdit, onDelete, onCommand, panelRef }: {
  blocks: FocusBlock[]; allTasks: Task[]; selectedDate: string; language: Language; t: (key: CopyKey) => string; now: number; rail: React.ReactNode; currentAction?: React.ReactNode; canAdd?: boolean; onAdd: () => void; onEdit: (block: FocusBlock) => void; onDelete: (block: FocusBlock) => void; onCommand: (block: FocusBlock, command: 'start' | 'pause' | 'resume' | 'finish') => void; panelRef?: (element: HTMLElement | null) => void
}) {
  return <section className="panel-shell focus-shell" ref={panelRef} aria-labelledby="panel-focus">{rail}<div className="focus-panel"><div className="panel-top"><div><div className="eyebrow">{`04 · ${t('timeLabel')}`}</div><h2 id="panel-focus">{t('focus')}</h2><p>{t('focusHint')}</p></div><button className="add-button light" onClick={onAdd} disabled={!canAdd}><Icon name="plus" />{t('add')}</button></div>{currentAction}<div className="focus-date-label">{formatDateKey(selectedDate, language)} <span>{selectedDate}</span></div>{blocks.length ? <div className="focus-list">{blocks.map((block) => <FocusCard key={block.id} block={block} allTasks={allTasks} language={language} t={t} now={now} onEdit={onEdit} onDelete={onDelete} onCommand={onCommand} />)}</div> : <div className="focus-empty"><div className="empty-glyph">◯</div><p>{t('emptyFocus')}</p><button className="text-button light-text" onClick={onAdd} disabled={!canAdd}>{t('add')}</button></div>}<div className="focus-space" /></div></section>
}

function FocusCard({ block, allTasks, language, t, now, onEdit, onDelete, onCommand }: { block: FocusBlock; allTasks: Task[]; language: Language; t: (key: CopyKey) => string; now: number; onEdit: (block: FocusBlock) => void; onDelete: (block: FocusBlock) => void; onCommand: (block: FocusBlock, command: 'start' | 'pause' | 'resume' | 'finish') => void }) {
  const elapsed = Math.min(elapsedMsAt(block, now), block.durationMinutes * 60_000)
  const status = focusDisplayStatus(block, now)
  const task = allTasks.find((candidate) => candidate.id === block.taskId)
  const subtasks = task ? allTasks.filter((candidate) => candidate.parentId === task.id && !candidate.archivedAt) : []
  const percentage = Math.min(100, Math.round((elapsed / (block.durationMinutes * 60_000)) * 100))
  // 到时间时显示完整时长，避免四舍五入后出现 “0 / 0.1 分钟” 这类与“时间到”矛盾的读数。
  const summary = `${status === 'complete' ? block.durationMinutes : Math.round(elapsed / 60_000)} / ${block.durationMinutes} ${t('minutes')}`
  return <article className={`focus-card ${status === 'finished' || status === 'complete' ? 'muted' : ''} ${status === 'running' ? 'active' : ''}`}>
    <div className="focus-card-head"><span className="focus-status-icon">{status === 'finished' || status === 'complete' ? '✓' : status === 'running' ? '◉' : '○'}</span><div className="focus-card-title"><strong>{block.title}</strong>{task ? <small>{task.title}</small> : null}</div><div className="focus-card-actions">{status === 'running' ? <button className="stop-button" onClick={() => onCommand(block, 'finish')}>{t('stop')}</button> : null}<button className="row-icon light-icon" aria-label={t('edit')} title={t('edit')} onClick={() => onEdit(block)}><Icon name="edit" /></button><button className="row-icon light-icon danger" aria-label={t('delete')} title={t('delete')} onClick={() => onDelete(block)}><Icon name="trash" /></button></div></div>
    {subtasks.length ? <div className="focus-subtasks">{subtasks.map((subtask) => <span key={subtask.id} className={subtask.checked ? 'done' : ''}>□ {subtask.title}</span>)}</div> : null}<div className="focus-time"><span>{status === 'running' ? formatTimer(block, now) : summary}</span><small>{status === 'running' ? t('running') : status === 'paused' ? t('paused') : status === 'complete' ? t('complete') : t('finished')}</small></div>
    <div className="timer-track"><span style={{ width: `${percentage}%` }} /></div>
    <div className="focus-card-foot"><span>{t('elapsed')} {summary}</span><div>{status === 'paused' ? <button className="card-button" onClick={() => onCommand(block, block.elapsedMs > 0 ? 'resume' : 'start')}>{block.elapsedMs > 0 ? t('resume') : t('start')}</button> : status === 'running' ? <button className="card-button" onClick={() => onCommand(block, 'pause')}>{t('pause')}</button> : status === 'complete' ? <button className="card-button" onClick={() => onCommand(block, 'finish')}>{t('finish')}</button> : null}</div></div>
  </article>
}

function formatTimer(block: FocusBlock, now: number): string {
  const remaining = Math.max(0, block.durationMinutes * 60_000 - elapsedMsAt(block, now))
  const totalSeconds = Math.ceil(remaining / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function ConnectorLayer({ stage, snapshot, rowRefs, selectedChain }: { stage: HTMLDivElement | null; snapshot: BoardSnapshot; rowRefs: React.MutableRefObject<Map<string, HTMLElement>>; selectedChain: Set<string> }) {
  const [geometry, setGeometry] = useState({ width: 1, height: 1, paths: [] as Array<{ id: string; d: string; active: boolean }> })
  useLayoutEffect(() => {
    if (!stage) return
    const draw = () => {
      const stageRect = stage.getBoundingClientRect()
      const width = Math.max(1, stage.offsetWidth)
      const height = Math.max(1, stage.offsetHeight)
      const paths: Array<{ id: string; d: string; active: boolean }> = []
      for (const task of snapshot.tasks) {
        if (task.archivedAt || !task.upperTaskId) continue
        const lower = rowRefs.current.get(task.id)
        const upper = rowRefs.current.get(task.upperTaskId)
        if (!lower || !upper) continue
        const lowerRect = lower.getBoundingClientRect()
        const upperRect = upper.getBoundingClientRect()
        const lowerIsRight = lowerRect.left > upperRect.left
        const source = lowerIsRight ? lowerRect.left - stageRect.left : lowerRect.right - stageRect.left
        const target = lowerIsRight ? upperRect.right - stageRect.left : upperRect.left - stageRect.left
        const y1 = lowerRect.top - stageRect.top + lowerRect.height / 2
        const y2 = upperRect.top - stageRect.top + upperRect.height / 2
        const curve = Math.max(24, Math.abs(target - source) * 0.38)
        const d = lowerIsRight ? `M ${source} ${y1} C ${source - curve} ${y1}, ${target + curve} ${y2}, ${target} ${y2}` : `M ${source} ${y1} C ${source + curve} ${y1}, ${target - curve} ${y2}, ${target} ${y2}`
        paths.push({ id: `${task.id}:${task.upperTaskId}`, d, active: selectedChain.has(task.id) && selectedChain.has(task.upperTaskId) })
      }
      setGeometry({ width, height, paths })
    }
    draw()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(draw)
    observer?.observe(stage)
    const scroll = stage.closest('.workspace-scroll')
    scroll?.addEventListener('scroll', draw, { passive: true })
    const mutation = typeof MutationObserver === 'undefined' ? null : new MutationObserver(draw)
    mutation?.observe(stage, { childList: true, subtree: true, attributes: true })
    window.addEventListener('resize', draw)
    return () => { observer?.disconnect(); mutation?.disconnect(); scroll?.removeEventListener('scroll', draw); window.removeEventListener('resize', draw) }
  }, [rowRefs, snapshot, selectedChain, stage])
  return <svg className="connector-layer" width="100%" height="100%" viewBox={`0 0 ${geometry.width} ${geometry.height}`} aria-hidden="true">{geometry.paths.map((path) => <path key={path.id} d={path.d} className={path.active ? 'connector active' : 'connector'} />)}</svg>
}

function TaskChoice({ id, label, value, noneLabel, options, onChange }: { id: string; label: string; value: string; noneLabel: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  const choices = [{ value: '', label: noneLabel }, ...options]
  const selectedIndex = Math.max(0, choices.findIndex((choice) => choice.value === value))
  const selected = choices[selectedIndex]
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    if (!open) return
    setActiveIndex(selectedIndex)
    optionRefs.current[selectedIndex]?.focus()
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open, selectedIndex])

  const choose = (next: string) => {
    onChange(next)
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const move = (direction: -1 | 1) => {
    const next = (activeIndex + direction + choices.length) % choices.length
    setActiveIndex(next)
    optionRefs.current[next]?.focus()
  }

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setOpen(true)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
    }
  }

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
    else if (event.key === 'Home') { event.preventDefault(); setActiveIndex(0); optionRefs.current[0]?.focus() }
    else if (event.key === 'End') { event.preventDefault(); const last = choices.length - 1; setActiveIndex(last); optionRefs.current[last]?.focus() }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(choices[activeIndex].value) }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus() }
    else if (event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      requestAnimationFrame(() => {
        const dialog = rootRef.current?.closest('[role="dialog"]')
        const focusable = dialog ? [...dialog.querySelectorAll<HTMLElement>('button,input,select,textarea,[href]')].filter((candidate) => !candidate.hasAttribute('disabled') && !candidate.closest('[role="listbox"]')) : []
        const index = triggerRef.current ? focusable.indexOf(triggerRef.current) : -1
        focusable[index + (event.shiftKey ? -1 : 1)]?.focus()
      })
    }
  }

  return <div className="choice-field" ref={rootRef}>
    <span className="choice-label" id={`${id}-label`}>{label}</span>
    <button type="button" id={id} ref={triggerRef} className="choice-trigger" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-listbox`} aria-labelledby={`${id}-label`} onClick={() => setOpen((value) => !value)} onKeyDown={onTriggerKeyDown}>
      <span>{selected.label}</span><span className="choice-chevron" aria-hidden="true">⌄</span>
    </button>
    {open ? <div id={`${id}-listbox`} className="choice-menu" role="listbox" aria-labelledby={`${id}-label`} onKeyDown={onListKeyDown}>{choices.map((choice, index) => <button type="button" role="option" aria-selected={choice.value === value} className={`choice-option ${choice.value === value ? 'selected' : ''}`} ref={(element) => { optionRefs.current[index] = element }} key={choice.value || 'none'} onClick={() => choose(choice.value)}>{choice.label}</button>)}</div> : null}
  </div>
}

function TaskDialog({ task, domain, parentId, initial, placement, tasks, t, onClose, onSubmit }: { task?: Task; domain: Domain; parentId?: string; initial?: TaskInput; placement: { cycleId?: string; weekKey?: string; dateKey?: string }; tasks: Task[]; t: (key: CopyKey) => string; onClose: () => void; onSubmit: (input: TaskInput) => void }) {
  const [title, setTitle] = useState(initial?.title || task?.title || '')
  const [note, setNote] = useState(initial?.note ?? task?.note ?? '')
  const [color, setColor] = useState<TaskColor>(initial?.color || task?.color || 'ink')
  const [upperTaskId, setUpperTaskId] = useState(initial?.upperTaskId || task?.upperTaskId || '')
  const [selectedParent, setSelectedParent] = useState(initial?.parentId || parentId || task?.parentId || '')
  // 候选必须与新任务落在同一放置位置，否则校验必然失败（用户会看到无法保存的选项）。
  // 每个域只带一个放置键，因此一次只比较“候选所在域”的那个键：
  // 上级候选属于另一个域（周←长期、日←周），要用该域的键（周期 / 周），不能拿子任务自己的键去比。
  const valueFor = (valueDomain: Domain, source: { cycleId?: string; weekKey?: string; dateKey?: string }) =>
    valueDomain === 'long' ? source.cycleId : valueDomain === 'weekly' ? source.weekKey : source.dateKey
  const selectedPlacement = placement
  const ownPlacement = {
    cycleId: task?.cycleId ?? selectedPlacement.cycleId,
    weekKey: task?.weekKey ?? selectedPlacement.weekKey,
    dateKey: task?.dateKey ?? selectedPlacement.dateKey,
  }
  const upperDomain: Domain = domain === 'weekly' ? 'long' : 'weekly'
  // 校验只要求上级是同域顶层任务，不限制其放置位置；编辑时若当前选中的周期/周与已存在的关联不同，
  // 仍要把现有上级列进候选，否则下拉会显示空白（值不在选项里）。
  // 下拉自身的值优先，其次是已存任务的关联，最后是保留草稿的关联；三者都列进候选才不会显示空白。
  const keptUpperId = upperTaskId || task?.upperTaskId || initial?.upperTaskId
  const upperOptions = tasks.filter((candidate) => !candidate.parentId && !candidate.archivedAt && candidate.domain === upperDomain && candidate.id !== task?.id &&
    (candidate.id === keptUpperId || valueFor(upperDomain, candidate) === valueFor(upperDomain, selectedPlacement)))
  const parentOptions = tasks.filter((candidate) => !candidate.parentId && !candidate.archivedAt && candidate.domain === domain && candidate.id !== task?.id &&
    valueFor(domain, candidate) === valueFor(domain, ownPlacement))
  return <Dialog closeLabel={t('close')} title={task ? t('edit') : parentId ? t('addSubtask') : t('addTask')} onClose={onClose} initialFocus="task-title">
    <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); if (!title.trim()) return; onSubmit({ title, note, color, upperTaskId: selectedParent ? undefined : upperTaskId || undefined, parentId: selectedParent || undefined }) }}>
      <label>{t('title')}<input id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={MAX_TASK_TITLE_LENGTH} required /></label>
      <label>{t('note')}<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={MAX_TASK_NOTE_LENGTH} rows={5} /></label>
      <fieldset className="color-field"><legend>{t('color')}</legend><div className="color-picker">{([['ink', 'colorInk'], ['blue', 'colorBlue'], ['orange', 'colorOrange'], ['green', 'colorGreen'], ['violet', 'colorViolet']] as const).map(([value, label]) => <label className={`color-choice color-${value}`} key={value} title={t(label)}><input type="radio" name="task-color" value={value} checked={color === value} onChange={() => setColor(value)} /><span className="color-swatch" aria-hidden="true" /><span className="sr-only">{t(label)}</span></label>)}</div></fieldset>
      {!parentId && domain !== 'long' ? <TaskChoice id="task-association" label={t('association')} value={upperTaskId} noneLabel={t('none')} options={upperOptions.map((candidate) => ({ value: candidate.id, label: candidate.title }))} onChange={(value) => { setUpperTaskId(value); if (value) setSelectedParent('') }} /> : null}
      {!task && !parentId ? <TaskChoice id="task-parent" label={t('parentTask')} value={selectedParent} noneLabel={t('none')} options={parentOptions.map((candidate) => ({ value: candidate.id, label: candidate.title }))} onChange={(value) => { setSelectedParent(value); if (value) setUpperTaskId('') }} /> : null}
      <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>{t('cancel')}</button><button className="primary-button" type="submit">{t('save')}</button></div>
    </form>
  </Dialog>
}

function CycleDialog({ cycle, initial, language, t, onClose, onSubmit }: { cycle?: GoalCycle; initial?: { name: string; startDate: string; endDate: string }; language: Language; t: (key: CopyKey) => string; onClose: () => void; onSubmit: (input: { name: string; startDate: string; endDate: string }) => void }) {
  const today = todayInTimeZone(safeTimeZone())
  const [name, setName] = useState(initial?.name || cycle?.name || '')
  const [startDate, setStartDate] = useState(initial?.startDate || cycle?.startDate || today)
  const [endDate, setEndDate] = useState(initial?.endDate || cycle?.endDate || addDays(today, 30))
  return <Dialog closeLabel={t('close')} title={cycle ? t('editCycle') : t('addCycle')} onClose={onClose} initialFocus="cycle-name"><form className="dialog-form" onSubmit={(event) => { event.preventDefault(); onSubmit({ name, startDate, endDate }) }}>
    <label>{t('cycleName')}<input id="cycle-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required /></label><div className="field-row"><label>{t('startDate')}<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></label><label>{t('endDate')}<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} required /></label></div><p className="form-hint">{t('rangeHint')}</p><div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>{t('cancel')}</button><button className="primary-button" type="submit">{t('save')}</button></div>
  </form></Dialog>
}

function FocusDialog({ block, initial, tasks, selectedDate, language, t, onClose, onSubmit }: { block?: FocusBlock; initial?: FocusInput; tasks: Task[]; selectedDate: string; language: Language; t: (key: CopyKey) => string; onClose: () => void; onSubmit: (input: FocusInput) => void }) {
  const [title, setTitle] = useState(initial?.title || block?.title || '')
  const [durationMinutes, setDurationMinutes] = useState(initial?.durationMinutes || String(block?.durationMinutes || 45))
  const [taskId, setTaskId] = useState(initial?.taskId || block?.taskId || '')
  const locked = Boolean(block && (block.status !== 'paused' || block.elapsedMs > 0))
  return <Dialog closeLabel={t('close')} title={block ? t('edit') : t('add')} onClose={onClose} initialFocus="focus-title"><form className="dialog-form" onSubmit={(event) => { event.preventDefault(); onSubmit({ title, durationMinutes, taskId: taskId || undefined }) }}>
    <label>{t('focusTitle')}<input id="focus-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} required /></label><label>{t('duration')}<input type="number" min="0.1" max="1440" step="0.1" value={durationMinutes} disabled={locked} onChange={(event) => setDurationMinutes(event.target.value)} required />{locked ? <small className="field-note">{t('focusDurationLocked')}</small> : null}</label><label>{t('focusTask')}<select value={taskId} onChange={(event) => setTaskId(event.target.value)}><option value="">{t('none')}</option>{tasks.filter((task) => task.dateKey === selectedDate || task.id === block?.taskId).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><p className="form-hint">{t('focusDate')}: {formatDateKey(selectedDate, language)}</p><div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>{t('cancel')}</button><button className="primary-button" type="submit">{t('save')}</button></div>
  </form></Dialog>
}

function SettingsDialog({ zone, language, t, onClose, onLanguage, onSubmit }: { zone: string; language: Language; t: (key: CopyKey) => string; onClose: () => void; onLanguage: (language: Language) => void; onSubmit: (zone: string) => void }) {
   const [value, setValue] = useState(zone)
   return <Dialog closeLabel={t('close')} title={t('settings')} onClose={onClose} initialFocus="timezone"><form className="dialog-form" onSubmit={(event) => { event.preventDefault(); onSubmit(value) }}><label>{t('timezone')}<input id="timezone" list="timezone-options" value={value} onChange={(event) => setValue(event.target.value)} maxLength={100} required /><datalist id="timezone-options"><option value="UTC" /><option value="Asia/Shanghai" /><option value="Asia/Tokyo" /><option value="America/New_York" /><option value="America/Los_Angeles" /><option value="Europe/London" /></datalist></label><p className="form-hint">{t('timezoneHint')}</p><div className="setting-language"><span>{t('language')}</span><div className="language-switch"><button type="button" className={language === 'zh' ? 'active' : ''} onClick={() => onLanguage('zh')}>{t('chinese')}</button><button type="button" className={language === 'en' ? 'active' : ''} onClick={() => onLanguage('en')}>{t('english')}</button></div></div><div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>{t('cancel')}</button><button className="primary-button" type="submit">{t('save')}</button></div></form></Dialog>
}

// 日任务默认次日、周任务默认下周；输入框用 min 只允许选更晚的一档，默认值直接确认即可完成顺延。
function nextRescheduleTarget(task: Task, zone: string): { value: string; kind: 'date' | 'week' } {
  if (task.domain === 'weekly') return { value: weekKey(addDays(weekRange(task.weekKey || weekKey(todayInTimeZone(zone))).start, 7)), kind: 'week' }
  return { value: addDays(task.dateKey || todayInTimeZone(zone), 1), kind: 'date' }
}

function RescheduleDialog({ task, language, t, zone, onClose, onSubmit }: { task: Task; language: Language; t: (key: CopyKey) => string; zone: string; onClose: () => void; onSubmit: (target: string) => void }) {
  const target = nextRescheduleTarget(task, zone)
  const [value, setValue] = useState(target.value)
   return <Dialog closeLabel={t('close')} title={t('reschedule')} onClose={onClose} initialFocus="reschedule-target"><form className="dialog-form" onSubmit={(event) => { event.preventDefault(); onSubmit(value) }}><p className="reschedule-copy"><strong>{task.title}</strong><span>{t('rescheduleHint')}</span></p><label>{t('rescheduleTitle')}<input id="reschedule-target" type={target.kind} value={value} min={target.value} onChange={(event) => setValue(event.target.value)} required /></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>{t('cancel')}</button><button className="primary-button" type="submit">{t('reschedule')}</button></div></form></Dialog>
}

function Dialog({ title, closeLabel, children, onClose, initialFocus }: { title: string; closeLabel: string; children: React.ReactNode; onClose: () => void; initialFocus?: string }) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const onCloseRef = useRef(onClose)
  const initialFocusRef = useRef(initialFocus)
  onCloseRef.current = onClose
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = initialFocusRef.current ? document.getElementById(initialFocusRef.current) : dialog.querySelector<HTMLElement>('input,button,select,textarea')
    element?.focus()
    return () => { if (previousFocus?.isConnected) previousFocus.focus() }
  }, [])
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return
    if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return }
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button,input,select,textarea,[href]')].filter((candidate) => !candidate.hasAttribute('disabled'))
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCloseRef.current() }}><div className="dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="dialog-title" onKeyDown={onKeyDown}><div className="dialog-header"><h2 id="dialog-title">{title}</h2><button type="button" className="dialog-close" aria-label={closeLabel} onClick={() => onCloseRef.current()}><Icon name="close" /></button></div>{children}</div></div>
}

/**
 * 品牌标记：与 public/favicon.svg 同一造型（三根递降柱 = 目标→周→日，橙点 = 此刻专注的一步）。
 * 内联 SVG 而非 <img>，以便跟随字号、任意尺寸清晰，并避免额外请求。
 * 图标本身 aria-hidden，品牌名由紧邻的文字承担，屏幕阅读器不会重复朗读。
 */
function BrandMark() {
  return <svg className="brand-mark" width="27" height="27" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect width="32" height="32" rx="7.5" fill="#2c302e" />
    <rect x="6.6" y="6.8" width="4" height="16.4" rx="2" fill="#ffffff" />
    <rect x="12.7" y="10.4" width="4" height="12.8" rx="2" fill="#ffffff" opacity="0.8" />
    <rect x="18.8" y="14" width="4" height="9.2" rx="2" fill="#ffffff" opacity="0.6" />
    <circle cx="24.8" cy="21.6" r="2.5" fill="#df875e" />
  </svg>
}

function Icon({ name }: { name: 'plus' | 'edit' | 'trash' | 'up' | 'down' | 'subtask' | 'link' | 'sliders' | 'refresh' | 'close' | 'back' | 'grip' }) {
  const paths: Record<string, React.ReactNode> = {
    grip: <path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" strokeWidth="3" />,
    plus: <><path d="M12 5v14M5 12h14" /></>, edit: <><path d="M4 16.5V20h3.5L18.7 8.8l-3.5-3.5L4 16.5Z" /><path d="m13.5 6.5 3.5 3.5" /></>, trash: <><path d="M5 7h14M10 11v5M14 11v5M7 7l1 13h8l1-13M9 7V4h6v3" /></>, up: <path d="m6 14 6-6 6 6" />, down: <path d="m6 10 6 6 6-6" />, subtask: <><path d="M5 6h14M5 12h9M5 18h6" /><path d="M17 15v6M14 18h6" /></>, link: <><path d="M9.5 14.5 14.5 9.5" /><path d="M7 17H5.5a3.5 3.5 0 0 1 0-7H9M15 7h1.5a3.5 3.5 0 0 1 0 7H15" /></>, sliders: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="8" cy="18" r="2" /></>, refresh: <><path d="M20 11a8 8 0 0 0-14-4L4 9" /><path d="M4 4v5h5M4 13a8 8 0 0 0 14 4l2-2" /><path d="M20 20v-5h-5" /></>, close: <><path d="m6 6 12 12M18 6 6 18" /></>, back: <><path d="M9.5 5.5 5 10l4.5 4.5" /><path d="M5 10h8.5a4.5 4.5 0 0 1 0 9H9" /></>,
  }
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
