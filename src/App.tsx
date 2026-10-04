import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  activeTasks,
  addCycle,
  addDays,
  addFocusBlock,
  addTask,
  carryForwardTasks,
  cloneSnapshot,
  compareDateKeys,
  createFocusBlock,
  createTask,
  cycleForNavigation,
  deleteCycle,
  deleteFocusBlock,
  deleteTask,
  elapsedMsAt,
  MAX_TASK_NOTE_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  MAX_TIMER_MINUTES,
  mergeSnapshots,
  moveDailyTask,
  moveWeeklyTask,
  reapplyReorder,
  reorderCycleTo,
  reorderOrigin,
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
  weekRange,
} from './domain'
import { AuthLifecycle, type AuthIdentity, type AuthTransition } from './auth-flow'
import { copy, type CopyKey } from './i18n'
import { BoardError, isNoticeCode, type NoticeCode } from './notices'
import { createDemoBoardAdapter, createSupabaseBoardAdapter, getSupabaseConfig, type SupabaseBoardAdapter } from './storage'
import {
  buildIndex,
  commandsFor,
  completeCommand,
  fill,
  formatClock,
  fuzzyScore,
  isAnswer,
  isYes,
  lookupRef,
  parseDateArg,
  parseLine,
  parseMinutes,
  parseQuickAdd,
  parseRef,
  parseWeekArg,
  resolveCommand,
  restAfter,
  SCOPE_DOMAIN,
  TASK_COLORS,
  VIEW_KEYS,
  VIEW_SCOPE,
  VIEWS,
  type CommandSpec,
  type MenuItem,
  type Selection,
  type ShellContext,
  type ViewName,
} from './terminal'
import { Banner, Echo, Lines, Menu, Prompt, ShellFrame, Spinner, useStickToBottom, useTheme, type Ask, type AskField, type ExternalMenu, type NavItem, type OutLine } from './Shell'
import { BoardView, Dashboard, Finder, VIEW_LABEL, type BoardActions, type FinderItem } from './BoardViews'
import type { BoardAdapter, BoardSnapshot, Domain, FocusBlock, GoalCycle, Language, StoredBoard, Task, TaskColor } from './types'
import './fonts.css'
import './styles.css'

const LANGUAGE_KEY = 'liubai-taskboard:language:v1'
const UNASSIGNED_CYCLE_ID = '' // 空串不是合法项目 id，避免与已有项目碰撞。
type TaskPlacement = Pick<Task, 'cycleId' | 'weekKey' | 'dateKey'>
type Screen = 'setup' | 'auth' | 'loading' | 'workspace'
type SaveState = 'saved' | 'pending' | 'saving' | 'error' | 'offline'

type TaskInput = {
  title: string
  note: string
  color: TaskColor
  // 日任务给日期、周任务给周次；其余域保持放置不变，因此不写进 input。
  dateKey?: string
  weekKey?: string
  upperTaskId?: string
  parentId?: string
}

type SelectionState = { cycleId: string | null; date: string; week: string }

type FocusInput = { title: string; durationMinutes: string; taskId?: string }

// 失败变更除了快照，还要记住它来自哪个表单与输入值：
// 冲突后绝不整板回写（会覆盖其他设备的新改动），而是让用户在新版本上重新编辑同一份输入。
type DraftOrigin =
  | { kind: 'reorder'; taskId: string; direction: -1 | 1; domain: Domain }
  | { kind: 'task'; input: TaskInput; taskId?: string; domain: Domain; parentId?: string; placement: TaskPlacement }
  | { kind: 'cycle'; input: { name: string; startDate: string; endDate: string }; cycleId?: string }
  | { kind: 'focus'; input: FocusInput; blockId?: string }

type PendingJob = { expectedRevision: number; snapshot: BoardSnapshot; draft: string | null; origin?: DraftOrigin }
type AuthLoad = { userId: string; generation: number; promise: Promise<void> }

type CycleInput = { name: string; startDate: string; endDate: string }
type TaskWizardOptions = { task?: Task; domain: Domain; parentId?: string; initial?: TaskInput; placement?: TaskPlacement }

// 滚动区里的每一条都是一次输出：命令回显 + 结果。视图块在被新视图取代时冻结成当时的快照，
// 之后只读；永远只有最新的视图块是活的。
type FrozenView = { snapshot: BoardSnapshot; selection: Selection; now: number }
type EntryBody =
  | { kind: 'lines'; lines: OutLine[] }
  | { kind: 'view'; view: ViewName; frozen?: FrozenView }
  | { kind: 'help'; context: ShellContext }
type Entry = { id: number; echo?: string; result?: OutLine; body?: EntryBody }
const MAX_ENTRIES = 60

const COLOR_LABEL: Record<TaskColor, CopyKey> = { ink: 'colorInk', blue: 'colorBlue', orange: 'colorOrange', green: 'colorGreen', violet: 'colorViolet' }
const DOMAIN_VIEW: Record<Domain, ViewName> = { long: 'goals', weekly: 'week', daily: 'day' }

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

function dateForWeek(key: string, cycle: GoalCycle | undefined, preferredDate: string): string {
  const range = weekRange(key)
  const start = cycle && compareDateKeys(cycle.startDate, range.start) > 0 ? cycle.startDate : range.start
  const end = cycle && compareDateKeys(cycle.endDate, range.end) < 0 ? cycle.endDate : range.end
  return dateInRange(preferredDate, start, end) ? preferredDate : start
}

function selectionForSnapshot(snapshot: BoardSnapshot, preferredCycleId: string | null, preferredDate: string): { cycleId: string | null; date: string; week: string } {
  if (preferredCycleId === UNASSIGNED_CYCLE_ID) return { cycleId: preferredCycleId, date: preferredDate, week: weekKey(preferredDate) }
  const cycle = cycleForNavigation(snapshot, snapshot.cycles.find((candidate) => candidate.id === preferredCycleId) || snapshot.cycles[0])
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
  const [authBusy, setAuthBusy] = useState(false)
  const [stored, setStored] = useState<StoredBoard | null>(null)
  const storedRef = useRef<StoredBoard | null>(null)
  // 三方合并的 base 必须是「上次与后端一致」的版本：若拿含本地改动的 stored 当 base，
  // mergeSnapshots 会把这些改动当成「本地没改」而直接采用云端，静默丢失。
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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null)
  const [selectedWeek, setSelectedWeek] = useState(() => weekKey(todayInTimeZone(safeTimeZone())))
  const [selectedDate, setSelectedDate] = useState(() => todayInTimeZone(safeTimeZone()))
  const selectionRef = useRef<SelectionState>({ cycleId: null, date: selectedDate, week: selectedWeek })
  const [now, setNow] = useState(() => Date.now())
  const [flash, setFlash] = useState('')
  const theme = useTheme()
  const [entries, setEntries] = useState<Entry[]>([])
  const entryIdRef = useRef(0)
  const [view, setView] = useState<ViewName>('day')
  const viewRef = useRef<ViewName>('day')
  const [ask, setAsk] = useState<Ask | null>(null)
  const askIdRef = useRef(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [navMode, setNavMode] = useState(false)
  const [finder, setFinder] = useState<string | null>(null)
  const [helpMenu, setHelpMenu] = useState<{ entryId: number; index: number } | null>(null)
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null)
  const historyRef = useRef<string[]>([])
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const languageRef = useRef(language)
  languageRef.current = language
  // reopenDraft 是稳定回调，但要打开的是“当下”的编辑流程：用 ref 取每次渲染的最新版本。
  const wizardsRef = useRef<{ task: (options: TaskWizardOptions) => void; cycle: (cycle?: GoalCycle, initial?: CycleInput) => void; focus: (block?: FocusBlock, initial?: FocusInput) => void } | null>(null)
  const confirmRef = useRef<((question: string, onYes: () => void) => void) | null>(null)

  const t = useCallback((key: CopyKey) => copy[language][key], [language])
  // 提示不总是 notice code：适配器返回的诊断文本没有 code，不能假定它一定能本地化。
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

  const pushEntries = useCallback((next: Array<Omit<Entry, 'id'>>) => {
    setEntries((current) => [...current, ...next.map((entry) => ({ ...entry, id: ++entryIdRef.current }))].slice(-MAX_ENTRIES))
  }, [])
  // 只有一行的短结果与回显同排显示（`> /done d1  [x] d1 …`），连续操作不会把视图挤出屏幕。
  const print = useCallback((lines: OutLine[], echo?: string) => {
    if (echo !== undefined && lines.length === 1 && !lines[0].cmd && !lines[0].key && lines[0].text.length <= 72) pushEntries([{ echo, result: lines[0] }])
    else pushEntries([{ echo, body: lines.length ? { kind: 'lines', lines } : undefined }])
  }, [pushEntries])
  const freezeLive = useCallback(() => {
    const board = storedRef.current
    const selection = { ...selectionRef.current }
    const frozenAt = Date.now()
    setEntries((current) => current.flatMap((entry) => {
      if (entry.body?.kind !== 'view' || entry.body.frozen) return [entry]
      return board ? [{ ...entry, body: { ...entry.body, frozen: { snapshot: board.snapshot, selection, now: frozenAt } } }] : []
    }))
  }, [])
  const appendView = useCallback((next: ViewName, echo?: string) => {
    viewRef.current = next
    setView(next)
    pushEntries([{ echo, body: { kind: 'view', view: next } }])
  }, [pushEntries])
  const announceBoard = useCallback((board: StoredBoard, mode: 'demo' | 'cloud') => {
    const words = copy[languageRef.current]
    // 重新载入时旧的活视图属于上一份数据，直接丢弃，避免两个“活”视图同时存在。
    setEntries((current) => current.filter((entry) => entry.body?.kind !== 'view' || entry.body.frozen))
    pushEntries([
      { body: { kind: 'lines', lines: [
        { text: fill(words.boardLoaded, { rev: board.revision, projects: board.snapshot.cycles.length, tasks: activeTasks(board.snapshot).length }), tone: 'ok' },
        ...(mode === 'demo' ? [{ text: words.demoNote, tone: 'dim' as const }] : []),
      ] } },
    ])
    appendView('day')
  }, [appendView, pushEntries])

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
    setEntries([])
    setAsk(null)
    setHelpMenu(null)
    setFinder(null)
    setNavMode(false)
    setExpandedId(null)
    historyRef.current = []
    setSaveMessage('')
    setFailureKind(null)
    setSaveState('saved')
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
      announceBoard(safeBoard, nextAdapter.mode)
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
  }, [announceBoard, authLifecycle, clearPrivateState])

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
    confirmRef.current?.(t('confirmDiscardDirect'), () => void reloadLatest(false))
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
      if (origin.placement.cycleId && !board.cycles.some((cycle) => cycle.id === origin.placement.cycleId)) { setFlash(copy[language].draftTargetMissing); return }
      reconcileSelection(board, origin.placement.cycleId || UNASSIGNED_CYCLE_ID, origin.placement.dateKey || (origin.placement.weekKey ? weekRange(origin.placement.weekKey).start : selectionRef.current.date))
      wizardsRef.current?.task({ task: existing, domain: origin.domain, parentId: origin.parentId, initial: origin.input, placement: origin.placement })
    } else if (origin.kind === 'cycle') {
      const existing = origin.cycleId ? board.cycles.find((cycle) => cycle.id === origin.cycleId) : undefined
      if (origin.cycleId && !existing) { setFlash(copy[language].draftTargetMissing); return }
      wizardsRef.current?.cycle(existing, origin.input)
    } else {
      const existing = origin.blockId ? board.focusBlocks.find((block) => block.id === origin.blockId) : undefined
      if (origin.blockId && !existing) { setFlash(copy[language].draftTargetMissing); return }
      wizardsRef.current?.focus(existing, origin.input)
    }
  }, [language, reloadLatest, reconcileSelection])

  const openDemo = useCallback(() => {
    void openBoard(createDemoBoardAdapter())
  }, [openBoard])

  const signIn = async (email: string, password: string) => {
    const cloud = cloudRef.current
    if (!cloud || !email.trim() || !password) return
    const attempt = authLifecycle.beginLogin()
    if (attempt === null) return
    setAuthBusy(true)
    try {
      const result = await cloud.signIn(email.trim(), password)
      if (!authLifecycle.isLoginCurrent(attempt)) return
      if (!result.ok) {
        print([{ text: result.code ? t(result.code) : result.message || t('invalidCredentials'), tone: 'err' }])
        startLogin(email.trim())
        return
      }
      const transition = authLifecycle.completeLogin(attempt, userRef.current, result.value, screenRef.current, Boolean(storedRef.current))
      if (!transition) return
      applyAuthTransition(cloud, transition)
      print([{ text: fill(t('welcome'), { email: result.value.email || email.trim() }), tone: 'ok' }])
    } catch (caught) {
      if (!authLifecycle.isLoginCurrent(attempt)) return
      if (caught instanceof Error) console.warn('[taskboard]', caught.message)
      print([{ text: t('cloudError'), tone: 'err' }])
      startLogin(email.trim())
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

  // 返回新建或更新的任务 id；失败时返回 null（提示已由保存状态或滚动区给出）。
  const submitTask = (input: TaskInput, existing?: Task, domain?: Domain, parentId?: string, placement?: TaskPlacement): string | null => {
    const current = storedRef.current
    if (!current) return null
    const targetDomain = domain || existing?.domain || 'daily'
    const base = placement || {
      cycleId: existing ? existing.cycleId : selectedCycle?.id,
      weekKey: targetDomain === 'weekly' ? existing?.weekKey || selectedWeek : undefined,
      dateKey: targetDomain === 'daily' ? existing?.dateKey || selectedDate : undefined,
    }
    // 表单里的放置优先于当前选中的日期/周：用户可以在编辑器里直接改期。
    const targetPlacement: TaskPlacement = targetDomain === 'daily' && input.dateKey
      ? { ...base, dateKey: input.dateKey }
      : targetDomain === 'weekly' && input.weekKey
        ? { ...base, weekKey: input.weekKey }
        : base
    if (!existing && targetDomain !== 'long' && selectedCycle) {
      const placeable = targetDomain === 'weekly'
        ? (targetPlacement.weekKey || selectedWeek) >= weekKey(selectedCycle.startDate) && (targetPlacement.weekKey || selectedWeek) <= weekKey(selectedCycle.endDate)
        : dateInRange(targetPlacement.dateKey || selectedDate, selectedCycle.startDate, selectedCycle.endDate)
      if (!placeable) {
        setFlash(t('selectionOutsideCycle'))
        return null
      }
    }
    const draft = `${t('title')}: ${input.title.trim()}`
    const now = new Date().toISOString()
    try {
      let next: BoardSnapshot
      let id = existing?.id
      if (existing) {
        next = updateTask(current.snapshot, existing.id, { title: input.title, note: input.note, color: input.color, upperTaskId: input.parentId ? undefined : input.upperTaskId, parentId: input.parentId }, now)
        // 改日期/周单独走重排：它会带上子任务，并拒绝超出项目周期的放置。
        if (input.dateKey && input.dateKey !== existing.dateKey) next = moveDailyTask(next, existing.id, input.dateKey, now)
        if (input.weekKey && input.weekKey !== existing.weekKey) next = moveWeeklyTask(next, existing.id, input.weekKey, now)
      } else {
        const created = createTask({
          domain: targetDomain,
          title: input.title,
          note: input.note,
          color: input.color,
          parentId: parentId || input.parentId,
          upperTaskId: parentId || input.parentId ? undefined : input.upperTaskId,
          ...targetPlacement,
        })
        id = created.id
        next = addTask(current.snapshot, created)
      }
      return commitSnapshot(next, draft, { kind: 'task', input, taskId: existing?.id, domain: targetDomain, parentId, placement: targetPlacement }) ? id! : null
    } catch (caught) {
      setSaveState('error')
      setSaveMessage(errorNotice(caught, 'noticeTaskSaveFailed'))
      setDraftLabel(draft)
      return null
    }
  }

  const submitCycle = (input: CycleInput, existing?: GoalCycle): boolean => {
    const current = storedRef.current
    if (!current) return false
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
        return true
      }
      return false
    } catch (caught) {
      setSaveState('error'); setSaveMessage(errorNotice(caught, 'noticeCycleSaveFailed')); setDraftLabel(input.name)
      return false
    }
  }

  const submitFocus = (input: FocusInput, existing?: FocusBlock): string | null => {
    const current = storedRef.current
    if (!current) return null
    if (!existing && selectedCycle && !dateInRange(selectedDate, selectedCycle.startDate, selectedCycle.endDate)) {
      setFlash(t('selectionOutsideCycle'))
      return null
    }
    const draft = `${t('focusTitle')}: ${input.title.trim()}`
    try {
      const duration = validateDurationMinutes(input.durationMinutes)
      const created = existing ? undefined : createFocusBlock({ dateKey: selectedDate, title: input.title, taskId: input.taskId || undefined, durationMinutes: duration })
      const next = existing
        ? updateFocusBlock(current.snapshot, existing.id, { title: input.title.trim(), durationMinutes: duration, taskId: input.taskId || undefined })
        : addFocusBlock(current.snapshot, created!)
      return commitSnapshot(next, draft, { kind: 'focus', input, blockId: existing?.id }) ? (existing?.id ?? created!.id) : null
    } catch (caught) {
      setSaveState('error'); setSaveMessage(errorNotice(caught, 'noticeFocusSaveFailed')); setDraftLabel(draft)
      return null
    }
  }


  const snapshot = stored?.snapshot ?? null
  const selectedCycle = snapshot ? (selectedCycleId === UNASSIGNED_CYCLE_ID ? undefined : snapshot.cycles.find((cycle) => cycle.id === selectedCycleId) || snapshot.cycles[0]) : undefined
  const navigationCycle = snapshot ? cycleForNavigation(snapshot, selectedCycle) : undefined
  const currentZone = stored?.snapshot.settings.timeZone || safeTimeZone()
  // “今天”只算一次，供跳转、标签页与状态栏共用（与“正在看的那天”是两件事）。
  const todayKey = todayInTimeZone(currentZone)
  const currentWeekKey = weekKey(todayKey)
  const runningBlock = stored?.snapshot.focusBlocks.find((block) => block.status === 'running')
  const failedOrigin = failedJobRef.current?.origin
  const canReopenDraft = failedOrigin?.kind === 'task' || failedOrigin?.kind === 'cycle' || failedOrigin?.kind === 'focus'
  const context: ShellContext = screen === 'workspace' ? 'board' : 'guest'
  const liveSelection: Selection = useMemo(() => ({ cycleId: selectedCycleId, week: selectedWeek, date: selectedDate }), [selectedCycleId, selectedWeek, selectedDate])

  const selectCycle = (cycleId: string) => { if (snapshot) reconcileSelection(snapshot, cycleId, selectionRef.current.date) }
  const selectWeek = (key: string) => {
    const date = dateForWeek(key, navigationCycle, selectionRef.current.date)
    applySelection({ cycleId: selectedCycle?.id || UNASSIGNED_CYCLE_ID, date, week: key })
  }
  // 返回实际落到的日期：超出项目范围时会被夹回边界，调用方据此提示。
  const setDate = (date: string, allowOutsideCycle = false): string => {
    const nextDate = !allowOutsideCycle && navigationCycle ? clampDate(date, navigationCycle.startDate, navigationCycle.endDate) : date
    applySelection({ cycleId: selectedCycle?.id || UNASSIGNED_CYCLE_ID, date: nextDate, week: weekKey(nextDate) })
    return nextDate
  }
  const currentIndex = () => buildIndex(storedRef.current!.snapshot, selectionRef.current)
  const refFor = (id: string) => (storedRef.current ? buildIndex(storedRef.current.snapshot, selectionRef.current).refOf.get(id) || '' : '')
  const focusPrompt = () => requestAnimationFrame(() => inputRef.current?.focus())

  const showView = (next: ViewName, echo?: string, select?: () => OutLine | void) => {
    if (screenRef.current !== 'workspace') return
    freezeLive()
    const note = select?.()
    setExpandedId(null)
    appendView(next, echo)
    if (note) print([note])
  }
  const goDate = (date: string, allowOutsideCycle = false): OutLine | void => {
    const landed = setDate(date, allowOutsideCycle)
    if (landed !== date) return { text: fill(t('dateClamped'), { date: landed }), tone: 'warn' }
  }
  const clearScreen = () => {
    setEntries([])
    setHelpMenu(null)
    if (screenRef.current === 'workspace') appendView(viewRef.current)
  }

  const openAsk = (spec: Omit<Ask, 'id'>) => {
    setNavMode(false)
    setHelpMenu(null)
    setAsk({
      ...spec,
      id: ++askIdRef.current,
      onDone: (values) => { setAsk(null); spec.onDone(values) },
      onCancel: () => { setAsk(null); print([{ text: t('cancelled'), tone: 'dim' }]); spec.onCancel?.() },
    })
    focusPrompt()
  }
  const confirm = (question: string, onYes: () => void) => openAsk({
    title: question,
    fields: [{ key: 'answer', label: '[y/N]', validate: (value) => (isAnswer(value) ? null : t('answerYesNo')) }],
    onDone: ({ answer }) => { if (isYes(answer)) onYes(); else print([{ text: t('cancelled'), tone: 'dim' }]) },
  })
  confirmRef.current = confirm

  const startLogin = (email?: string) => openAsk({
    fields: [
      { key: 'email', label: 'login', type: 'email', autoComplete: 'username', initial: email || '', placeholder: 'you@example.com', validate: (value) => (/^\S+@\S+\.\S+$/.test(value) ? null : t('emailInvalid')) },
      { key: 'password', label: 'password', type: 'password', autoComplete: 'current-password', placeholder: t('passwordNoEcho'), validate: (value) => (value ? null : t('passwordRequired')) },
    ],
    onDone: ({ email: address, password }) => {
      print([{ text: `login: ${address}`, tone: 'dim' }, { text: 'password:', tone: 'dim' }])
      void signIn(address, password)
    },
  })

  const openTaskWizard = ({ task, domain, parentId, initial, placement }: TaskWizardOptions) => {
    const board = storedRef.current
    if (!board) return
    const tasks = activeTasks(board.snapshot)
    const index = buildIndex(board.snapshot, selectionRef.current)
    const base: TaskPlacement = placement || { cycleId: task ? task.cycleId : selectedCycle?.id, weekKey: task?.weekKey ?? selectionRef.current.week, dateKey: task?.dateKey ?? selectionRef.current.date }
    // 子任务的放置由父任务决定，只有顶层任务能改日期（日）或周次（周）。
    const parent = initial?.parentId ?? (parentId || task?.parentId)
    const canEditDate = domain === 'daily' && !parent
    const canEditWeek = domain === 'weekly' && !parent
    const baseDate = base.dateKey || selectionRef.current.date
    const baseWeek = base.weekKey || selectionRef.current.week
    const keptUpper = initial?.upperTaskId || task?.upperTaskId
    const upperDomain: Domain = domain === 'weekly' ? 'long' : 'weekly'
    const ownCycle = task ? task.cycleId : base.cycleId
    // 候选必须与任务落在同一项目，并与“上级所在域”的放置一致（周←项目、日←同一周）；
    // 改了日期就按新日期所在周重算，已存的关联始终列入，避免显示空白。
    const upperItems = (values: Record<string, string>): MenuItem[] => {
      const date = canEditDate ? parseDateArg(values.date, baseDate, todayKey) : null
      const week = canEditWeek ? parseWeekArg(values.week, baseWeek, currentWeekKey) : null
      const target: TaskPlacement = date ? { ...base, weekKey: weekKey(date), dateKey: date } : week ? { ...base, weekKey: week } : base
      const keyOf = (source: TaskPlacement) => (upperDomain === 'long' ? source.cycleId : source.weekKey)
      const candidates = tasks.filter((candidate) => !candidate.parentId && candidate.domain === upperDomain && candidate.id !== task?.id && candidate.cycleId === ownCycle && (candidate.id === keptUpper || keyOf(candidate) === keyOf(target)))
      return [{ id: 'none', value: '', label: t('none') }, ...candidates.map((candidate) => ({ id: candidate.id, value: candidate.id, label: `${index.refOf.get(candidate.id) ? `${index.refOf.get(candidate.id)}  ` : ''}${candidate.title}` }))]
    }
    const fields: AskField[] = [
      { key: 'title', label: t('title'), initial: initial?.title ?? task?.title ?? '', maxLength: MAX_TASK_TITLE_LENGTH, validate: (value) => (value.trim() ? null : t('titleRequired')) },
      { key: 'note', label: t('note'), type: 'note', initial: initial?.note ?? task?.note ?? '', maxLength: MAX_TASK_NOTE_LENGTH },
      { key: 'color', label: t('color'), initial: initial?.color || task?.color || 'ink', options: TASK_COLORS.map((color) => ({ id: color, value: color, label: `■ ${t(COLOR_LABEL[color])}`, meta: color })) },
    ]
    if (canEditDate) fields.push({ key: 'date', label: t('date'), initial: initial?.dateKey || task?.dateKey || base.dateKey || '', placeholder: 'YYYY-MM-DD · +1 · fri', validate: (value) => (parseDateArg(value, baseDate, todayKey) ? null : t('dateInvalid')) })
    if (canEditWeek) fields.push({ key: 'week', label: t('week'), initial: initial?.weekKey || task?.weekKey || base.weekKey || '', placeholder: '2026-W41 · +1', validate: (value) => (parseWeekArg(value, baseWeek, currentWeekKey) ? null : t('weekInvalid')) })
    if (!parent && domain !== 'long') fields.push({ key: 'upper', label: t('association'), initial: keptUpper || '', options: upperItems })
    const ref = task ? index.refOf.get(task.id) : undefined
    openAsk({
      title: task ? `${t('edit')} ${ref ? `${ref} ` : ''}${task.title}` : `${parentId ? t('addSubtask') : t('addTask')} · ${t(VIEW_LABEL[DOMAIN_VIEW[domain]])}`,
      fields,
      onDone: (values) => {
        const input: TaskInput = {
          title: values.title,
          note: values.note,
          color: values.color as TaskColor,
          dateKey: canEditDate ? parseDateArg(values.date, baseDate, todayKey) || undefined : undefined,
          weekKey: canEditWeek ? parseWeekArg(values.week, baseWeek, currentWeekKey) || undefined : undefined,
          upperTaskId: parent ? undefined : values.upper || undefined,
          parentId: parent || undefined,
        }
        const id = submitTask(input, task, domain, parentId, placement)
        if (id) print([{ text: `${task ? '✓' : '+'} ${refFor(id)} ${input.title.trim()}`.replace('  ', ' '), tone: 'ok' }])
      },
    })
  }

  const openCycleWizard = (cycle?: GoalCycle, initial?: CycleInput) => {
    const parse = (value: string | undefined, base = todayKey) => parseDateArg(value, base, todayKey)
    openAsk({
      title: cycle ? `${t('editCycle')} · ${cycle.name}` : t('addCycle'),
      fields: [
        { key: 'name', label: t('cycleName'), initial: initial?.name ?? cycle?.name ?? '', maxLength: 160, validate: (value) => (value.trim() ? null : t('nameRequired')) },
        { key: 'start', label: t('startDate'), initial: initial?.startDate ?? cycle?.startDate ?? todayKey, validate: (value) => (parse(value) ? null : t('dateInvalid')) },
        { key: 'end', label: t('endDate'), initial: initial?.endDate ?? cycle?.endDate ?? addDays(todayKey, 30), placeholder: '+30', validate: (value, values) => {
          const start = parse(values.start)
          const end = parse(value, start || todayKey)
          return !end ? t('dateInvalid') : start && compareDateKeys(start, end) > 0 ? t('rangeInvalid') : null
        } },
      ],
      onDone: (values) => {
        const startDate = parse(values.start)!
        const input = { name: values.name.trim(), startDate, endDate: parse(values.end, startDate)! }
        if (submitCycle(input, cycle)) print([{ text: `✓ ${input.name}  ${input.startDate} → ${input.endDate}`, tone: 'ok' }])
      },
    })
  }

  const openFocusWizard = (block?: FocusBlock, initial?: FocusInput) => {
    const board = storedRef.current
    if (!board) return
    const locked = Boolean(block && (block.status !== 'paused' || block.elapsedMs > 0))
    const date = block?.dateKey || selectionRef.current.date
    const index = buildIndex(board.snapshot, selectionRef.current)
    const taskItems: MenuItem[] = [{ id: 'none', value: '', label: t('none') }, ...activeTasks(board.snapshot, 'daily').filter((task) => task.dateKey === date || task.id === block?.taskId).map((task) => ({ id: task.id, value: task.id, label: `${index.refOf.get(task.id) ? `${index.refOf.get(task.id)}  ` : ''}${task.title}` }))]
    openAsk({
      title: block ? `${t('edit')} ${index.refOf.get(block.id) || ''} ${block.title}${locked ? ` · ${t('focusDurationLocked')}` : ''}` : `${t('add')} · ${t('navFocus')} ${date.slice(5)}`,
      fields: [
        { key: 'title', label: t('focusTitle'), initial: initial?.title ?? block?.title ?? '', maxLength: 300, validate: (value) => (value.trim() ? null : t('titleRequired')) },
        { key: 'minutes', label: t('duration'), initial: initial?.durationMinutes ?? String(block?.durationMinutes ?? 45), placeholder: '45 · 25m · 1.5h', skip: () => locked, validate: (value) => { const minutes = parseMinutes(value); return minutes && minutes > 0 && minutes <= MAX_TIMER_MINUTES ? null : t('noticeTimerDuration') } },
        { key: 'task', label: t('focusTask'), initial: initial?.taskId ?? block?.taskId ?? '', options: taskItems },
      ],
      onDone: (values) => {
        const input: FocusInput = { title: values.title, durationMinutes: locked && block ? String(block.durationMinutes) : String(parseMinutes(values.minutes)), taskId: values.task || undefined }
        const id = submitFocus(input, block)
        if (id) print([{ text: `${block ? '✓' : '+'} ${refFor(id)} ${input.title.trim()} · ${input.durationMinutes}m`, tone: 'ok' }])
      },
    })
  }
  wizardsRef.current = { task: openTaskWizard, cycle: openCycleWizard, focus: openFocusWizard }

  const resolve = (token: string | undefined) => {
    const ref = parseRef(token, VIEW_SCOPE[viewRef.current])
    if (!ref || !storedRef.current) return null
    const found = lookupRef(currentIndex(), ref)
    return found ? { ref: ref.label, ...found } : null
  }
  const setTaskFields = (task: Task, patch: Partial<Task>) => updateSnapshot((current) => updateTask(current, task.id, patch), `${t('title')}: ${task.title}`)
  const usage = (spec: CommandSpec) => fill(t('usage'), { usage: `/${spec.name}${spec.args ? ` ${spec.args}` : ''}` })

  const quickAdd = (text: string, say: (lines: OutLine[]) => void, fail: (text: string) => void) => {
    const current = viewRef.current
    if (current === 'tree') return fail(t('treeNoAdd'))
    if (current === 'focus') {
      const quick = parseQuickAdd(text, true)
      const linked = quick.upper ? resolve(quick.upper)?.task : undefined
      if (quick.upper && linked?.domain !== 'daily') return fail(fill(t('refMissing'), { ref: quick.upper }))
      const minutes = quick.minutes ?? 45
      const id = submitFocus({ title: quick.title, durationMinutes: String(minutes), taskId: linked?.id })
      return say(id ? [{ text: `+ ${refFor(id)} ${quick.title} · ${minutes}m`, tone: 'ok' }] : [])
    }
    const domain = SCOPE_DOMAIN[VIEW_SCOPE[current] as 'g' | 'w' | 'd']
    if (domain === 'long' && !selectedCycle) return fail(t('noCycles'))
    const quick = parseQuickAdd(text)
    let upperTaskId: string | undefined
    if (quick.upper) {
      const scope = domain === 'daily' ? 'w' : domain === 'weekly' ? 'g' : null
      const ref = parseRef(quick.upper, scope)
      const upper = ref && ref.scope === scope ? lookupRef(currentIndex(), ref)?.task : undefined
      if (!upper || upper.parentId) return fail(fill(t('linkInvalid'), { ref: quick.upper }))
      upperTaskId = upper.id
    }
    const id = submitTask({ title: quick.title, note: '', color: quick.color || 'ink', upperTaskId }, undefined, domain)
    say(id ? [{ text: `+ ${refFor(id)} ${quick.title.trim()}`, tone: 'ok' }] : [])
  }

  const jumpTo = (task: Task) => {
    const board = storedRef.current?.snapshot
    if (!board) return
    const anchor = task.parentId ? board.tasks.find((candidate) => candidate.id === task.parentId) ?? task : task
    const cycle = board.cycles.find((entry) => entry.id === anchor.cycleId)
    const week = anchor.domain === 'weekly' && anchor.weekKey ? anchor.weekKey : anchor.domain === 'daily' && anchor.dateKey ? weekKey(anchor.dateKey) : selectionRef.current.week
    const date = anchor.domain === 'daily' && anchor.dateKey ? anchor.dateKey : dateForWeek(week, cycleForNavigation(board, cycle), selectionRef.current.date)
    const target = DOMAIN_VIEW[anchor.domain]
    const echo = target === 'goals' ? '/goals' : target === 'week' ? `/week ${week}` : `/day ${date}`
    showView(target, echo, () => applySelection({ cycleId: anchor.cycleId ?? UNASSIGNED_CYCLE_ID, date, week }))
    setSelectedTaskId(task.id)
    revealRow(task.id)
  }
  const jumpToBlock = (block: FocusBlock) => {
    showView('focus', `/focus ${block.dateKey}`, () => goDate(block.dateKey, true))
    setSelectedTaskId(block.id)
    revealRow(block.id)
  }
  const revealRow = (id: string) => requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(`.board-view.is-live [data-row-id="${id}"]`)?.scrollIntoView({ block: 'center' })))

  const execute = (raw: string, echo = true) => {
    const line = raw.trim()
    const parsed = parseLine(line)
    setHelpMenu(null)
    if (parsed.kind === 'empty') return
    const shown = echo ? line : undefined
    const say = (lines: OutLine[]) => print(lines, shown)
    const fail = (text: string) => say([{ text, tone: 'err' }])
    if (parsed.kind === 'text') {
      if (screenRef.current !== 'workspace' || !storedRef.current) return fail(fill(t('cmdNotFound'), { cmd: parsed.text.split(/\s+/)[0] }))
      return quickAdd(parsed.text, say, fail)
    }
    const spec = resolveCommand(parsed.name, context)
    if (!spec) return fail(fill(t('cmdUnknown'), { cmd: parsed.name }))
    if (spec.context.length === 1 && spec.context[0] === 'board' && !storedRef.current) return fail(t('loading'))
    const { args, rest } = parsed
    const board = storedRef.current?.snapshot
    switch (spec.name) {
      case 'help': {
        if (args[0]) {
          const target = resolveCommand(args[0].replace(/^\//, ''), context)
          if (!target) return fail(fill(t('cmdUnknown'), { cmd: args[0] }))
          return say([{ text: `/${target.name}${target.args ? ` ${target.args}` : ''}`, tone: 'accent' }, { text: target[language] }, ...(target.aliases?.length ? [{ text: `alias  ${target.aliases.map((alias) => `/${alias}`).join('  ')}`, tone: 'dim' as const }] : [])])
        }
        const id = ++entryIdRef.current
        setEntries((current) => [...current, { id, echo: shown, body: { kind: 'help' as const, context } }].slice(-MAX_ENTRIES))
        setHelpMenu({ entryId: id, index: 0 })
        return
      }
      case 'login':
        if (!config) return fail(t('setupBody'))
        say([])
        return startLogin(args[0])
      case 'demo':
        if (screenRef.current !== 'setup') return fail(t('demoSetupOnly'))
        say([])
        return openDemo()
      case 'goals': return showView('goals', shown)
      case 'week':
      case 'tree': {
        if (!args[0]) return showView(spec.name as ViewName, shown)
        const key = parseWeekArg(args[0], selectionRef.current.week, currentWeekKey)
        if (!key) return fail(usage(spec))
        return showView(spec.name as ViewName, shown, () => selectWeek(key))
      }
      case 'day':
      case 'focus': {
        if (!args[0]) return showView(spec.name as ViewName, shown)
        const date = parseDateArg(args[0], selectionRef.current.date, todayKey)
        if (!date) return fail(usage(spec))
        return showView(spec.name as ViewName, shown, () => goDate(date, spec.name === 'focus'))
      }
      case 'today': {
        const target = viewRef.current === 'week' || viewRef.current === 'focus' ? viewRef.current : 'day'
        return showView(target, shown, () => goDate(todayKey))
      }
      case 'project': {
        const sub = args[0]?.toLowerCase()
        if (!sub) {
          const lines: OutLine[] = board!.cycles.map((cycle, position) => ({ key: `${cycle.id === selectedCycle?.id ? '●' : ' '} ${position + 1}`, text: cycle.name, meta: `${cycle.startDate} → ${cycle.endDate} · ${board!.tasks.filter((task) => !task.archivedAt && task.cycleId === cycle.id).length}`, cmd: `/project ${position + 1}` }))
          if (board!.tasks.some((task) => !task.cycleId && !task.archivedAt)) lines.push({ key: `${selectedCycleId === UNASSIGNED_CYCLE_ID ? '●' : ' '} ~`, text: t('unassignedPlans'), cmd: '/project ~' })
          lines.push({ text: t('projectHint'), tone: 'dim' })
          return say(lines)
        }
        if (sub === 'new' || sub === 'add') { say([]); return openCycleWizard(undefined, rest.includes(' ') ? { name: restAfter(rest), startDate: todayKey, endDate: addDays(todayKey, 30) } : undefined) }
        if (sub === 'edit') { if (!selectedCycle) return fail(t('noCycles')); say([]); return openCycleWizard(selectedCycle) }
        if (sub === 'rm' || sub === 'delete') {
          const cycle = selectedCycle
          if (!cycle) return fail(t('noCycles'))
          if (!online || saveState !== 'saved') return fail(t('deleteCycleBlocked'))
          const confirmedBoard = storedRef.current!
          const taskCount = confirmedBoard.snapshot.tasks.filter((task) => task.cycleId === cycle.id).length
          say([{ text: fill(t('deleteCycleTitle'), { name: cycle.name }), tone: 'warn' }, { text: fill(t('deleteCycleSummary'), { count: taskCount }) }, { text: t('deleteCycleKeepFocus'), tone: 'dim' }, { text: t('deleteCycleWarning'), tone: 'dim' }])
          // 有计划时必须逐字输入项目名；确认期间版本变了由 deleteCycleConfirmed 拒绝，不会扩大删除范围。
          if (taskCount) return openAsk({ title: `${t('deleteCycleConfirmName')} · ${cycle.name}`, fields: [{ key: 'name', label: t('confirmLabel'), validate: (value) => (value === cycle.name ? null : t('deleteCycleNameMismatch')) }], onDone: () => deleteCycleConfirmed(cycle, confirmedBoard) })
          return confirm(fill(t('deleteCycleTitle'), { name: cycle.name }), () => deleteCycleConfirmed(cycle, confirmedBoard))
        }
        if (sub === 'up' || sub === 'down') {
          const at = board!.cycles.findIndex((cycle) => cycle.id === selectedCycle?.id)
          const neighbour = board!.cycles[at + (sub === 'up' ? -1 : 1)]
          if (!selectedCycle || !neighbour) return fail(t('cannotMove'))
          sortCycle(selectedCycle, neighbour.id)
          return say([{ text: `✓ ${selectedCycle.name} ${sub === 'up' ? '↑' : '↓'}`, tone: 'ok' }])
        }
        if (['~', '-', 'none', 'unassigned'].includes(sub)) return showView('goals', shown, () => selectCycle(UNASSIGNED_CYCLE_ID))
        const position = Number(sub)
        const name = rest.toLowerCase()
        const match = Number.isInteger(position) && position >= 1 ? board!.cycles[position - 1]
          : board!.cycles.find((cycle) => cycle.name.toLowerCase() === name) ?? board!.cycles.map((cycle) => ({ cycle, score: fuzzyScore(name, cycle.name) })).filter((entry) => entry.score !== null).sort((a, b) => b.score! - a.score!)[0]?.cycle
        if (!match) return fail(fill(t('projectMissing'), { name: rest }))
        return showView('goals', shown, () => selectCycle(match.id))
      }
      case 'add': {
        if (rest) return quickAdd(rest, say, fail)
        say([])
        if (viewRef.current === 'focus') return openFocusWizard()
        const domain = viewRef.current === 'goals' ? 'long' : viewRef.current === 'week' ? 'weekly' : 'daily'
        if (domain === 'long' && !selectedCycle) return fail(t('noCycles'))
        return openTaskWizard({ domain })
      }
      case 'sub': {
        const target = resolve(args[0])
        if (!target?.task) return fail(fill(t('refMissing'), { ref: args[0] || '' }))
        const parent = target.task
        if (parent.parentId) return fail(t('subOfSub'))
        const placement: TaskPlacement = { cycleId: parent.cycleId, weekKey: parent.weekKey, dateKey: parent.dateKey }
        const title = restAfter(rest)
        const create = (value: string) => {
          const id = submitTask({ title: value, note: '', color: 'ink' }, undefined, parent.domain, parent.id, placement)
          return id ? [{ text: `+ ${refFor(id)} ${value.trim()}`, tone: 'ok' as const }] : []
        }
        if (title) return say(create(title))
        say([])
        return openAsk({ title: `${t('addSubtask')} · ${target.ref} ${parent.title}`, fields: [{ key: 'title', label: t('title'), maxLength: MAX_TASK_TITLE_LENGTH, validate: (value) => (value.trim() ? null : t('titleRequired')) }], onDone: ({ title: value }) => print(create(value)) })
      }
      case 'done': {
        if (!args.length) return fail(usage(spec))
        const targets = args.map((arg) => ({ arg, found: resolve(arg) }))
        const missing = targets.filter((entry) => !entry.found?.task).map((entry) => entry.arg)
        if (missing.length) return fail(fill(t('refMissing'), { ref: missing.join(' ') }))
        const tasks = targets.map((entry) => ({ ref: entry.found!.ref, task: entry.found!.task! }))
        updateSnapshot((current) => tasks.reduce((next, { task }) => updateTask(next, task.id, { checked: !task.checked }), current), `${t('title')}: ${tasks.map(({ task }) => task.title).join(', ')}`)
        return say(tasks.map(({ ref, task }) => ({ text: `${task.checked ? '[ ]' : '[x]'} ${ref} ${task.title}`, tone: task.checked ? 'dim' : 'ok' })))
      }
      case 'edit': {
        const target = resolve(args[0])
        if (!target) return fail(fill(t('refMissing'), { ref: args[0] || '' }))
        say([])
        if (target.block) return openFocusWizard(target.block)
        return openTaskWizard({ task: target.task!, domain: target.task!.domain })
      }
      case 'note': {
        const target = resolve(args[0])
        if (!target?.task) return fail(fill(t('refMissing'), { ref: args[0] || '' }))
        const task = target.task
        const text = restAfter(rest)
        if (text) { setTaskFields(task, { note: text }); return say([{ text: `✓ ${target.ref} ${t('note')}`, tone: 'ok' }]) }
        say([])
        return openAsk({ title: `${t('note')} · ${target.ref} ${task.title}`, fields: [{ key: 'note', label: t('note'), type: 'note', initial: task.note, maxLength: MAX_TASK_NOTE_LENGTH }], onDone: ({ note }) => { setTaskFields(task, { note }); print([{ text: `✓ ${target.ref} ${t('note')}`, tone: 'ok' }]) } })
      }
      case 'color': {
        const target = resolve(args[0])
        if (!target?.task) return fail(fill(t('refMissing'), { ref: args[0] || '' }))
        const task = target.task
        const apply = (color: TaskColor) => { setTaskFields(task, { color }); return [{ text: `■ ${target.ref} ${t(COLOR_LABEL[color])}`, tone: 'ok' as const }] }
        const color = args[1]?.toLowerCase() as TaskColor | undefined
        if (color && TASK_COLORS.includes(color)) return say(apply(color))
        if (color) return fail(usage(spec))
        say([])
        return openAsk({ title: `${t('color')} · ${target.ref} ${task.title}`, fields: [{ key: 'color', label: t('color'), initial: task.color, options: TASK_COLORS.map((value) => ({ id: value, value, label: `■ ${t(COLOR_LABEL[value])}`, meta: value })) }], onDone: ({ color: value }) => print(apply(value as TaskColor)) })
      }
      case 'link': {
        const target = resolve(args[0])
        if (!target?.task) return fail(fill(t('refMissing'), { ref: args[0] || '' }))
        const task = target.task
        if (task.parentId) return fail(t('linkSubtask'))
        if (task.domain === 'long') return fail(t('linkLong'))
        const scope = task.domain === 'daily' ? 'w' : 'g'
        const apply = (upperTaskId: string | undefined) => {
          setTaskFields(task, { upperTaskId })
          const upper = upperTaskId ? storedRef.current!.snapshot.tasks.find((candidate) => candidate.id === upperTaskId) : undefined
          return [{ text: upper ? `↖ ${target.ref} → ${refFor(upper.id)} ${upper.title}` : `↖ ${target.ref} ${t('none')}`, tone: 'ok' as const }]
        }
        const arg = args[1]?.toLowerCase()
        if (!arg) {
          say([])
          const rows = currentIndex()[scope].filter((row) => !row.depth)
          return openAsk({ title: `${t('association')} · ${target.ref} ${task.title}`, fields: [{ key: 'upper', label: t('association'), initial: task.upperTaskId || '', options: [{ id: 'none', value: '', label: t('none') }, ...rows.map((row) => ({ id: row.task.id, value: row.task.id, label: `${row.ref}  ${row.task.title}` }))] }], onDone: ({ upper }) => print(apply(upper || undefined)) })
        }
        if (['none', 'off', '-', '0'].includes(arg)) return say(apply(undefined))
        const ref = parseRef(arg, scope)
        const upper = ref && ref.scope === scope ? lookupRef(currentIndex(), ref)?.task : undefined
        if (!upper || upper.parentId) return fail(fill(t('linkInvalid'), { ref: arg }))
        return say(apply(upper.id))
      }
      case 'mv': {
        const target = resolve(args[0])
        if (!target?.task) return fail(fill(t('refMissing'), { ref: args[0] || '' }))
        const task = target.task
        const arg = args[1]?.toLowerCase()
        if (!arg) return fail(usage(spec))
        if (['up', 'down', 'k', 'j'].includes(arg)) {
          const direction = arg === 'up' || arg === 'k' ? -1 : 1
          reorderTask(task, direction)
          return say([{ text: `${direction < 0 ? '↑' : '↓'} ${target.ref} ${task.title}`, tone: 'ok' }])
        }
        if (arg === 'top' || arg === 'bottom') {
          const siblings = currentIndex()[target.ref[0] as 'g' | 'w' | 'd'].filter((row) => row.task.parentId === task.parentId).map((row) => row.task)
          const anchor = arg === 'top' ? siblings[0] : siblings[siblings.length - 1]
          if (!anchor || anchor.id === task.id) return say([{ text: t('nothingChanged'), tone: 'dim' }])
          sortTask(task, anchor.id)
          return say([{ text: `${arg === 'top' ? '⇡' : '⇣'} ${target.ref} ${task.title}`, tone: 'ok' }])
        }
        if (task.parentId) return fail(t('moveSubtask'))
        if (task.domain === 'daily') {
          const date = parseDateArg(arg, task.dateKey!, todayKey)
          if (!date) return fail(usage(spec))
          updateSnapshot((current) => moveDailyTask(current, task.id, date), `${t('title')}: ${task.title}`)
          return say([{ text: `→ ${target.ref} ${task.title} · ${date}`, tone: 'ok' }])
        }
        if (task.domain === 'weekly') {
          const week = parseWeekArg(arg, task.weekKey!, currentWeekKey)
          if (!week) return fail(usage(spec))
          updateSnapshot((current) => moveWeeklyTask(current, task.id, week), `${t('title')}: ${task.title}`)
          return say([{ text: `→ ${target.ref} ${task.title} · ${week}`, tone: 'ok' }])
        }
        return fail(t('moveLong'))
      }
      case 'defer': {
        const target = resolve(args[0])
        if (!target?.task) return fail(fill(t('refMissing'), { ref: args[0] || '' }))
        const task = target.task
        if (task.parentId || task.domain === 'long') return fail(t('deferInvalid'))
        const value = args[1]
          ? (task.domain === 'weekly' ? parseWeekArg(args[1], task.weekKey!, currentWeekKey) : parseDateArg(args[1], task.dateKey!, todayKey))
          : nextRescheduleTarget(task, currentZone).value
        if (!value) return fail(usage(spec))
        rescheduleTask(task, value)
        return say([{ text: `↷ ${target.ref} ${task.title} → ${value}`, tone: 'ok' }, { text: t('rescheduleHint'), tone: 'dim' }])
      }
      case 'rm': {
        const target = resolve(args[0])
        if (!target) return fail(fill(t('refMissing'), { ref: args[0] || '' }))
        say([])
        if (target.block) {
          const block = target.block
          return confirm(`${t('confirmDeleteFocus')}  ${target.ref} ${block.title}`, () => {
            updateSnapshot((current) => deleteFocusBlock(current, block.id), `${t('delete')}: ${block.title}`)
            print([{ text: `✗ ${target.ref} ${block.title}`, tone: 'dim' }])
          })
        }
        return deleteTaskWithConfirm(target.task!, target.ref)
      }
      case 'start': {
        const minutes = args[1] ? parseMinutes(args[1]) : null
        if (args[1] && !minutes) return fail(t('noticeTimerDuration'))
        if (!args[0]) {
          const block = board!.focusBlocks.find((entry) => entry.dateKey === selectionRef.current.date && entry.status === 'paused')
          if (!block) return fail(t('noBlock'))
          focusCommand(block, block.elapsedMs > 0 ? 'resume' : 'start')
          return say([{ text: `◉ ${refFor(block.id)} ${block.title}`, tone: 'accent' }])
        }
        const target = resolve(args[0])
        if (!target) return fail(fill(t('refMissing'), { ref: args[0] }))
        if (target.block) {
          if (target.block.status === 'finished') return fail(t('blockFinished'))
          if (target.block.status === 'running') return say([{ text: `◉ ${target.ref} ${target.block.title}`, tone: 'accent' }])
          focusCommand(target.block, target.block.elapsedMs > 0 ? 'resume' : 'start')
          return say([{ text: `◉ ${target.ref} ${target.block.title}`, tone: 'accent' }])
        }
        const task = target.task!
        if (task.domain !== 'daily' || !task.dateKey) return fail(t('startDailyOnly'))
        if (selectedCycle && !dateInRange(task.dateKey, selectedCycle.startDate, selectedCycle.endDate)) return fail(t('selectionOutsideCycle'))
        try {
          const block = createFocusBlock({ dateKey: task.dateKey, title: task.title, taskId: task.id, durationMinutes: minutes ?? 45 })
          updateSnapshot((current) => setFocusCommand(addFocusBlock(current, block), block.id, 'start'), `${t('focus')}: ${task.title}`)
          return say([{ text: `◉ ${task.title} · ${block.durationMinutes}m`, tone: 'accent' }, { text: '/focus', cmd: `/focus ${task.dateKey}`, tone: 'dim' }])
        } catch (caught) {
          return fail(noticeLabel(errorNotice(caught, 'noticeFocusSaveFailed')))
        }
      }
      case 'pause':
      case 'resume':
      case 'stop': {
        const blocks = board!.focusBlocks
        const block = spec.name === 'pause' ? blocks.find((entry) => entry.status === 'running')
          : spec.name === 'stop' ? blocks.find((entry) => entry.status === 'running') ?? blocks.find((entry) => entry.status === 'paused' && entry.elapsedMs > 0 && entry.dateKey === selectionRef.current.date)
            : blocks.find((entry) => entry.status === 'paused' && entry.elapsedMs > 0 && entry.dateKey === selectionRef.current.date) ?? blocks.find((entry) => entry.status === 'paused' && entry.elapsedMs > 0)
        if (!block) return fail(t('noRunning'))
        focusCommand(block, spec.name === 'stop' ? 'finish' : spec.name === 'pause' ? 'pause' : 'resume')
        const elapsed = Math.min(elapsedMsAt(block, Date.now()), block.durationMinutes * 60_000)
        return say([{ text: `${spec.name === 'stop' ? '✓' : spec.name === 'pause' ? '◐' : '◉'} ${block.title} · ${formatClock(elapsed)}`, tone: spec.name === 'stop' ? 'ok' : 'accent' }])
      }
      case 'find':
        say([])
        return setFinder(rest)
      case 'sync':
        say([])
        return void reloadLatest(true).then((loaded) => { if (loaded) print([{ text: fill(t('synced'), { rev: storedRef.current?.revision ?? 0 }), tone: 'ok' }]) })
      case 'retry':
        if (!failedJobRef.current) return fail(t('noDraft'))
        retrySave()
        return say([{ text: t('retrying'), tone: 'dim' }])
      case 'reopen':
        say([])
        return void reopenDraft()
      case 'discard':
        if (!failedJobRef.current && !pendingJobRef.current) return fail(t('noDraft'))
        say([])
        return confirm(t('confirmDiscardDraft'), () => void reloadLatest(false))
      case 'status': {
        const pending = failedJobRef.current || pendingJobRef.current
        return say([
          { key: 'save', text: t(statusKey), tone: statusKey === 'saved' ? 'ok' : statusKey === 'error' || statusKey === 'offline' ? 'err' : 'warn' },
          { key: 'rev', text: String(stored?.revision ?? 0) },
          { key: 'mode', text: adapter?.mode === 'demo' ? t('demo') : t('cloud') },
          { key: 'tz', text: currentZone },
          ...(pending?.draft ? [{ key: 'draft', text: pending.draft, tone: 'warn' as const }] : []),
          ...(saveMessage ? [{ key: 'note', text: noticeLabel(saveMessage), tone: 'warn' as const }] : []),
        ])
      }
      case 'tz': {
        if (!args[0]) return say([{ key: 'tz', text: currentZone }, { text: t('timezoneHint'), tone: 'dim' }])
        if (safeTimeZone(args[0]) !== args[0]) return fail(t('invalidTimeZone'))
        updateSettings(args[0])
        return say([{ text: `✓ ${t('timezone')} ${args[0]}`, tone: 'ok' }])
      }
      case 'account':
        if (adapter?.mode !== 'cloud') return fail(t('accountCloudOnly'))
        if (saveState !== 'saved') return fail(t('accountUnsaved'))
        say([])
        return window.location.assign('/account')
      case 'whoami':
        return say([{ text: adapter?.mode === 'demo' ? `demo · ${t('demoNote')}` : user?.email || '—' }])
      case 'theme': {
        const pick = args[0]?.toLowerCase()
        const next = pick === 'dark' || pick === 'light' || pick === 'auto' ? pick : !pick ? (theme.resolved === 'dark' ? 'light' : 'dark') : null
        if (!next) return fail(usage(spec))
        theme.setPref(next)
        return say([{ text: `theme · ${next}`, tone: 'dim' }])
      }
      case 'lang': {
        const pick = args[0]?.toLowerCase()
        const next: Language | null = pick === 'zh' || pick === 'en' ? pick : !pick ? (language === 'zh' ? 'en' : 'zh') : null
        if (!next) return fail(usage(spec))
        setLanguage(next)
        return say([{ text: `lang · ${next}`, tone: 'dim' }])
      }
      case 'clear':
        return clearScreen()
      case 'logout': {
        if (adapter?.mode === 'cloud') {
          return void signOut().then(() => { if (screenRef.current === 'auth') print([{ text: t('loggedOut'), tone: 'dim' }]) })
        }
        clearPrivateState(config ? 'auth' : 'setup')
        return print([{ text: t('loggedOut'), tone: 'dim' }])
      }
      default:
        return fail(fill(t('cmdUnknown'), { cmd: parsed.name }))
    }
  }

  const statusKey = !online || saveState === 'offline' ? 'offline' : saveState === 'error' ? 'error' : saveState === 'saving' ? 'saving' : saveState === 'pending' ? 'pending' : 'saved'
  const statusGlyph = { saved: '●', pending: '○', saving: '◌', error: '✗', offline: '⊘' }[statusKey]

  const enterNav = () => {
    if (screenRef.current !== 'workspace') return
    setNavMode(true)
    inputRef.current?.blur()
    if (!selectedTaskId) {
      const first = document.querySelector<HTMLElement>('.board-view.is-live [data-row-id]')?.dataset.rowId
      if (first) setSelectedTaskId(first)
    }
  }
  const exitNav = (text?: string) => {
    setNavMode(false)
    if (text !== undefined) setPrefill({ text, nonce: Date.now() })
    focusPrompt()
  }
  const stepPeriod = (delta: -1 | 1) => {
    const board = storedRef.current?.snapshot
    if (!board) return
    const current = viewRef.current
    if (current === 'goals') {
      const at = board.cycles.findIndex((cycle) => cycle.id === selectedCycle?.id)
      const next = board.cycles[at + delta]
      if (next) selectCycle(next.id)
    } else if (current === 'week' || current === 'tree') selectWeek(weekKey(addDays(weekRange(selectionRef.current.week).start, delta * 7)))
    else setDate(addDays(selectionRef.current.date, delta))
  }
  const onNavKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const ids = [...document.querySelectorAll<HTMLElement>('.board-view.is-live [data-row-id]')].map((element) => element.dataset.rowId!)
    const at = selectedTaskId ? ids.indexOf(selectedTaskId) : -1
    const ref = selectedTaskId ? refFor(selectedTaskId) : ''
    const task = selectedTaskId ? storedRef.current?.snapshot.tasks.find((candidate) => candidate.id === selectedTaskId) : undefined
    const block = selectedTaskId ? storedRef.current?.snapshot.focusBlocks.find((candidate) => candidate.id === selectedTaskId) : undefined
    const move = (delta: number) => {
      if (!ids.length) return
      const next = ids[at < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, at + delta))]
      setSelectedTaskId(next)
      document.querySelector(`.board-view.is-live [data-row-id="${next}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    const keys: Record<string, () => void> = {
      j: () => move(1), ArrowDown: () => move(1), k: () => move(-1), ArrowUp: () => move(-1),
      g: () => execute('/goals'), w: () => execute('/week'), d: () => execute('/day'), f: () => execute('/focus'), t: () => execute('/tree'),
      h: () => stepPeriod(-1), '[': () => stepPeriod(-1), ArrowLeft: () => stepPeriod(-1),
      l: () => stepPeriod(1), ']': () => stepPeriod(1), ArrowRight: () => stepPeriod(1),
      '.': () => execute('/today'),
      x: () => { if (task) toggleTask(task); else if (block) focusCommand(block, block.status === 'running' ? 'pause' : block.elapsedMs > 0 ? 'resume' : 'start') },
      ' ': () => keys.x(),
      Enter: () => setExpandedId((current) => (current === selectedTaskId ? null : selectedTaskId)),
      e: () => { if (ref) execute(`/edit ${ref}`) },
      s: () => { if (task && !task.parentId && ref) execute(`/sub ${ref}`) },
      J: () => { if (task && ref) execute(`/mv ${ref} down`) },
      K: () => { if (task && ref) execute(`/mv ${ref} up`) },
      r: () => { if (task && ref) execute(`/defer ${ref}`) },
      p: () => { if (ref) execute(`/start ${ref}`) },
      Delete: () => { if (ref) execute(`/rm ${ref}`) },
      Backspace: () => { if (ref) execute(`/rm ${ref}`) },
      '?': () => execute('/help'),
      a: () => exitNav(), n: () => exitNav(), i: () => exitNav(), ':': () => exitNav(), '/': () => exitNav('/'),
      Escape: () => { if (expandedId) setExpandedId(null); else exitNav() },
    }
    const handler = keys[event.key]
    if (!handler) return
    event.preventDefault()
    handler()
  }

  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {})
  keyHandlerRef.current = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      if (screenRef.current !== 'workspace') return
      event.preventDefault()
      setFinder((current) => (current === null ? '' : null))
      return
    }
    if (finder !== null || event.defaultPrevented) return
    const target = event.target as HTMLElement | null
    const typing = target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)
    // 光标已经回到输入框（点击或 Tab）就是命令模式，不能再把字母当导航键吞掉。
    if (navMode && typing) setNavMode(false)
    else if (navMode && screenRef.current === 'workspace') { onNavKey(event); return }
    // 像真终端一样：焦点不在输入框时直接敲字，也落进提示符。
    if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1) inputRef.current?.focus()
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyHandlerRef.current(event)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!flash) return
    print([{ text: flash, tone: 'warn' }])
    setFlash('')
  }, [flash, print])

  const follow = useStickToBottom(`${entries.length}:${entries[entries.length - 1]?.id ?? 0}:${ask?.id ?? 0}`)

  const helpItems = useMemo<MenuItem[]>(() => commandsFor(context).map((command) => ({ id: command.name, label: `/${command.name}${command.args ? ` ${command.args}` : ''}`, hint: command[language], value: `/${command.name}`, run: !command.needsArg })), [context, language])
  const pickHelp = (item: MenuItem) => {
    setHelpMenu(null)
    if (item.run) execute(item.value!)
    else setPrefill({ text: `${item.value} `, nonce: Date.now() })
  }
  const externalMenu: ExternalMenu | null = helpMenu ? { items: helpItems, index: helpMenu.index, setIndex: (index) => setHelpMenu((current) => (current ? { ...current, index } : current)), pick: pickHelp, dismiss: () => setHelpMenu(null) } : null

  const complete = useCallback((input: string): MenuItem[] => {
    const argument = /^\/(\S+)\s+(\S*)$/.exec(input)
    if (argument) {
      const spec = resolveCommand(argument[1], context)
      const options = spec?.name === 'theme' ? ['dark', 'light', 'auto'] : spec?.name === 'lang' ? ['zh', 'en'] : spec?.name === 'project' ? ['new', 'edit', 'rm', 'up', 'down', ...(storedRef.current?.snapshot.cycles.map((_, index) => String(index + 1)) ?? [])] : []
      return options.filter((option) => option.startsWith(argument[2]) && option !== argument[2]).slice(0, 8).map((option) => ({ id: option, label: `/${spec!.name} ${option}`, hint: spec?.name === 'project' && /^\d+$/.test(option) ? storedRef.current?.snapshot.cycles[Number(option) - 1]?.name : undefined, value: `/${spec!.name} ${option}`, run: true }))
    }
    return completeCommand(input, context, language)
  }, [context, language])

  const actions: BoardActions = {
    run: (command) => { execute(command); focusPrompt() },
    toggle: (task) => toggleTask(task),
    select: (id) => { setSelectedTaskId(id); setExpandedId((current) => (current === id ? null : id)) },
    navigate: (patch) => {
      setExpandedId(null)
      if (patch.cycleId !== undefined && patch.cycleId !== null) selectCycle(patch.cycleId)
      else if (patch.week) selectWeek(patch.week)
      else if (patch.date) setDate(patch.date)
    },
    jump: (task) => jumpTo(task),
    focusCommand: (block, command) => focusCommand(block, command),
  }

  const finderItems = (): FinderItem[] => {
    const board = storedRef.current?.snapshot
    if (!board) return []
    const projectName = (task: Task) => board.cycles.find((cycle) => cycle.id === task.cycleId)?.name ?? t('unassignedPlans')
    const items: FinderItem[] = VIEWS.map((name) => ({ id: `view:${name}`, kind: 'view', title: t(VIEW_LABEL[name]), meta: `/${name}`, open: () => execute(`/${name}`) }))
    board.cycles.forEach((cycle, position) => items.push({ id: `project:${cycle.id}`, kind: 'project', title: cycle.name, meta: `${cycle.startDate} → ${cycle.endDate}`, open: () => execute(`/project ${position + 1}`) }))
    for (const task of activeTasks(board)) items.push({ id: task.id, kind: 'task', title: `${task.checked ? '✓ ' : ''}${task.title}`, meta: `${projectName(task)} · ${task.domain === 'long' ? t('navGoals') : task.domain === 'weekly' ? task.weekKey?.slice(5) : task.dateKey?.slice(5)}`, open: () => jumpTo(task) })
    for (const block of board.focusBlocks) items.push({ id: block.id, kind: 'focus', title: block.title, meta: `${block.dateKey.slice(5)} · ${block.durationMinutes}m`, open: () => jumpToBlock(block) })
    return items
  }

  const promptUser = `${screen === 'workspace' ? (adapter?.mode === 'demo' ? 'demo' : user?.email?.split('@')[0] || 'me') : 'guest'}@liubai`
  const nav: NavItem[] = screen === 'workspace'
    ? VIEWS.map((name) => ({ key: VIEW_KEYS[name], label: t(VIEW_LABEL[name]), active: view === name, onSelect: () => { execute(`/${name}`); focusPrompt() } }))
    : screen === 'setup'
      ? [{ key: 'O', label: t('navDemo'), onSelect: () => execute('/demo') }, { key: 'H', label: t('navHelp'), onSelect: () => execute('/help') }]
      : [{ key: 'L', label: t('navLogin'), onSelect: () => execute('/login') }, { key: 'H', label: t('navHelp'), onSelect: () => execute('/help') }]
  const cta = screen === 'workspace'
    ? (adapter?.mode === 'cloud' ? <a className="side-button" href="/account" onClick={(event) => { if (saveState !== 'saved') { event.preventDefault(); execute('/account') } }}>{t('ctaConnect')}</a> : <button type="button" className="side-button" onClick={() => execute('/logout')}>{t('ctaExitDemo')}</button>)
    : screen === 'setup' ? <button type="button" className="side-button" onClick={() => execute('/demo')}>{t('localDemo')}</button>
      : screen === 'auth' ? <button type="button" className="side-button" onClick={() => execute('/login')}>{t('signIn')}</button> : null
  const motd = screen === 'workspace' ? t('motdBoard') : screen === 'setup' ? t('motdSetup') : t('motdAuth')
  const clock = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: currentZone }).format(now)
  const runningRemaining = runningBlock ? runningBlock.durationMinutes * 60_000 - Math.min(elapsedMsAt(runningBlock, now), runningBlock.durationMinutes * 60_000) : 0
  const showSaveNotice = screen === 'workspace' && (saveState === 'error' || saveState === 'offline' || !online)
  const showDraftNotice = screen === 'workspace' && draftLabel && canReopenDraft && (saveState === 'error' || saveState === 'offline')

  const renderBody = (entry: Entry) => {
    const body = entry.body!
    if (body.kind === 'lines') return <Lines lines={body.lines} onCommand={(command) => actions.run(command)} />
    if (body.kind === 'help') {
      const active = helpMenu?.entryId === entry.id
      return <Menu id={`help-${entry.id}`} items={helpItems} index={active ? helpMenu!.index : -1} onPick={pickHelp} onHover={active ? (index) => setHelpMenu({ entryId: entry.id, index }) : undefined} footer={active ? t('hintMenu') : undefined} />
    }
    const frozen = body.frozen
    const board = frozen ? frozen.snapshot : stored?.snapshot
    if (!board) return null
    return <BoardView view={body.view} snapshot={board} selection={frozen ? frozen.selection : liveSelection} language={language} t={t} now={frozen ? frozen.now : now} live={!frozen} cursorId={frozen ? null : selectedTaskId} expandedId={frozen ? null : expandedId} actions={actions} />
  }

  return (
    <ShellFrame nav={nav} cta={cta} homeLabel={t('appName')}>
      <div className={`scrollback ${navMode ? 'is-nav' : ''}`} onMouseUp={(event) => {
        const target = event.target as HTMLElement
        if (window.getSelection()?.toString() || target.closest('button,a,input,textarea,[role="option"]')) return
        if (navMode) exitNav(); else focusPrompt()
      }}>
        <Banner label={t('appName')}><p><Rich text={t('motdTagline')} onCommand={actions.run} /></p><p className="dim"><Rich text={motd} onCommand={actions.run} /></p></Banner>
        {screen === 'workspace' && stored ? <Dashboard snapshot={stored.snapshot} selection={liveSelection} language={language} t={t} now={now} actions={actions} /> : null}
        {entries.map((entry) => <div key={entry.id} className="entry">
          {entry.echo !== undefined ? <Echo text={entry.echo}>{entry.result ? <span className={`tone-${entry.result.tone || 'plain'}`}>{entry.result.text}</span> : null}</Echo> : null}
          {entry.body ? renderBody(entry) : null}
        </div>)}
      </div>
      <div className="console">
        {showSaveNotice ? <div className="notice" role="status">
          <span className="notice-mark">!</span>
          <span>{saveMessage ? noticeLabel(saveMessage) : saveState === 'offline' || !online ? t('offline') : t('error')}</span>
          {failedJobRef.current?.draft && !canReopenDraft ? <span className="notice-draft">{failedJobRef.current.draft}</span> : null}
          {failedJobRef.current && (saveState === 'error' || saveState === 'offline') && failureKind !== 'conflict' ? <button type="button" className="bracket" onClick={() => execute('/retry')}>[{t('retry')}]</button> : null}
          {failureKind === 'conflict' && !failedJobRef.current ? <button type="button" className="bracket" onClick={() => execute('/sync')}>[{t('reloadLatest')}]</button> : null}
          {failureKind === 'conflict' && failedJobRef.current && !canReopenDraft ? <button type="button" className="bracket" onClick={discardDirectConflict}>[{t('reloadLatestDirect')}]</button> : null}
          {failureKind === 'conflict' && canReopenDraft ? <button type="button" className="bracket" onClick={() => execute('/reopen')}>[{t('reopenDraft')}]</button> : null}
        </div> : null}
        {showDraftNotice ? <div className="notice draft" role="status">
          <span className="notice-mark">~</span><span>{t('draftTitle')} · {draftLabel}</span>
          <button type="button" className="bracket" onClick={() => execute('/sync')}>[{t('reloadLatest')}]</button>
          <button type="button" className="bracket dim" onClick={() => execute('/discard')}>[{t('discardDraft')}]</button>
        </div> : null}
        {screen === 'workspace' && runningBlock && runningBlock.dateKey !== selectedDate ? <div className="notice running" role="status">
          <span className="notice-mark">◉</span><span>{t('runningElsewhere')} · {runningBlock.dateKey}</span>
          <button type="button" className="bracket" onClick={() => jumpToBlock(runningBlock)}>[{t('jumpFocus')}]</button>
        </div> : null}
        {screen !== 'workspace' && saveState === 'error' && saveMessage ? <div className="notice" role="alert"><span className="notice-mark">✗</span><span>{noticeLabel(saveMessage)}</span></div> : null}
        <Prompt user={promptUser} ask={ask} busy={authBusy ? <><Spinner /> {t('authenticating')}</> : screen === 'loading' ? <><Spinner /> {t('loading')}</> : null}
          placeholder={screen === 'workspace' ? fill(t('placeholderBoard'), { view: t(VIEW_LABEL[view]) }) : screen === 'setup' ? '/demo' : '/login'}
          history={historyRef.current} copy={{ hintCommand: navMode ? '' : screen === 'workspace' ? t('hintBoard') : t('hintCommand'), hintAsk: t('hintAsk'), hintChoice: t('hintChoice'), hintNote: t('hintNote'), hintMenu: t('hintMenu'), noMatch: t('finderEmpty') }}
          complete={complete} menu={externalMenu} inputRef={inputRef} prefill={prefill} onGrow={follow} onSubmit={(line) => execute(line)} onNav={enterNav} onClear={clearScreen} />
      </div>
      <footer className="statusline">
        <span className={`sl-mode ${navMode ? 'is-nav' : ''}`}>{navMode ? 'NAV' : screen === 'workspace' ? 'CMD' : 'TTY'}</span>
        <span className="sl-path">{screen === 'workspace' && stored ? `${selectedCycle?.name ?? t('unassignedPlans')} › ${selectedWeek.slice(5)} › ${selectedDate.slice(5)}` : `${t('appName')} · ${screen === 'setup' ? t('connectionMissing') : t('connectionReady')}`}</span>
        <span className="sl-spacer" />
        {screen === 'workspace' && runningBlock ? <button type="button" className="sl-item sl-running" onClick={() => jumpToBlock(runningBlock)}>◉ {formatClock(runningRemaining)}</button> : null}
        {screen === 'workspace' ? <button type="button" className={`sl-item sl-save is-${statusKey}`} onClick={() => execute('/status')}>{statusGlyph} {t(statusKey)}</button> : null}
        {screen === 'workspace' ? <span className="sl-item">{adapter?.mode === 'demo' ? t('demo') : t('cloud')}</span> : null}
        <button type="button" className="sl-item" onClick={() => execute(`/lang ${language === 'zh' ? 'en' : 'zh'}`)}>{t('langShort')}</button>
        <button type="button" className="sl-item" aria-label="theme" onClick={() => execute('/theme')}>{theme.resolved === 'dark' ? '◐' : '◑'}</button>
        {screen === 'workspace' ? <span className="sl-item sl-clock">{clock}</span> : null}
        <span className="sl-item sl-hint">{navMode ? t('navHint') : screen === 'workspace' ? 'esc nav · ⌘K' : ''}</span>
      </footer>
      {finder !== null ? <Finder user={promptUser} items={finderItems()} initialQuery={finder} t={t} onClose={() => { setFinder(null); focusPrompt() }} /> : null}
    </ShellFrame>
  )

  function toggleTask(task: Task) {
    updateSnapshot((current) => updateTask(current, task.id, { checked: !task.checked }), `${t('title')}: ${task.title}`)
  }

  function deleteTaskWithConfirm(task: Task, ref: string) {
    const current = storedRef.current
    if (!current) return
    const hasChildren = current.snapshot.tasks.some((candidate) => candidate.parentId === task.id && !candidate.archivedAt)
    const message = hasChildren ? t('confirmDeleteWithChildren') : t('confirmDelete')
    confirm(`${message}  ${ref} ${task.title}`, () => {
      updateSnapshot((snapshot) => deleteTask(snapshot, task.id), `${t('delete')}: ${task.title}`)
      if (selectedTaskId === task.id) setSelectedTaskId(null)
      print([{ text: `✗ ${ref} ${task.title}`, tone: 'dim' }])
    })
  }

  function deleteCycleConfirmed(cycle: GoalCycle, confirmedBoard: StoredBoard) {
    const current = storedRef.current
    if (!current) return
    // 不吞掉尚未保存的改动，也不把旧确认扩大成对最新任务集合的删除。
    if (!navigator.onLine || saveInFlightRef.current || pendingJobRef.current || failedJobRef.current) {
      setFlash(t('deleteCycleBlocked'))
      return
    }
    if (current !== confirmedBoard) { setFlash(t('deleteCycleChanged')); return }
    try {
      const next = deleteCycle(current.snapshot, cycle.id)
      if (commitSnapshot(next, `${t('deleteCycle')}: ${cycle.name}`)) {
        reconcileSelection(next, next.cycles[0]?.id || UNASSIGNED_CYCLE_ID)
        setSelectedTaskId(null)
        print([{ text: `✗ ${cycle.name}`, tone: 'dim' }])
      }
    } catch (caught) {
      setFlash(noticeLabel(errorNotice(caught, 'noticeOperationFailed')))
    }
  }

  function reorderTask(task: Task, direction: -1 | 1) {
    // 带上来源，冲突时直接加载最新版本后再明确重做，不把排序伪装成表单草稿。
    updateSnapshot((current) => reorderSibling(current, task.id, direction), `${t('title')}: ${task.title}`, reorderOrigin(task, direction))
  }

  function sortTask(task: Task, targetId: string) {
    updateSnapshot((current) => reorderSiblingTo(current, task.id, targetId), `${t('dragTask')}: ${task.title}`)
  }

  function sortCycle(cycle: GoalCycle, targetId: string) {
    updateSnapshot((current) => reorderCycleTo(current, cycle.id, targetId), `${t('dragCycle')}: ${cycle.name}`)
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

// 顺延只允许往后：min 挡住选了也必然失败的过去日期，默认值取次日/下周让用户直接确认。
function nextRescheduleTarget(task: Task, zone: string): { value: string; kind: 'date' | 'week' } {
  if (task.domain === 'weekly') return { value: weekKey(addDays(weekRange(task.weekKey || weekKey(todayInTimeZone(zone))).start, 7)), kind: 'week' }
  return { value: addDays(task.dateKey || todayInTimeZone(zone), 1), kind: 'date' }
}

/** 输出里的 `/命令` 都可以点：点一下等于把它敲进提示符。 */
function Rich({ text, onCommand }: { text: string; onCommand: (command: string) => void }) {
  return <>{text.split(/(\/[a-z]+)/g).map((part, index) => (/^\/[a-z]+$/.test(part) ? <button key={index} type="button" className="inline-cmd" onClick={() => onCommand(part)}>{part}</button> : part))}</>
}
