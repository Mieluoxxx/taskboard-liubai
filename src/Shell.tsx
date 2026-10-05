import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { fuzzyScore, renderBanner, type MenuItem } from './terminal'

export type FieldType = 'text' | 'email' | 'password' | 'note'

export interface AskField {
  key: string
  label: string
  type?: FieldType
  initial?: string
  placeholder?: string
  /** 有选项即为选择题：输入只用于筛选，回车取高亮项。函数形式按前面已答的值现算候选。 */
  options?: MenuItem[] | ((values: Record<string, string>) => MenuItem[])
  autoComplete?: string
  maxLength?: number
  validate?: (value: string, values: Record<string, string>) => string | null
  skip?: (values: Record<string, string>) => boolean
}

export interface Ask {
  id: number
  title?: string
  fields: AskField[]
  onDone: (values: Record<string, string>) => void
  onCancel?: () => void
}

export interface ExternalMenu {
  items: MenuItem[]
  index: number
  setIndex: (index: number) => void
  pick: (item: MenuItem) => void
  dismiss: () => void
}

export interface PromptCopy {
  hintCommand: string
  hintAsk: string
  hintChoice: string
  hintNote: string
  hintMenu: string
  noMatch: string
}

export type OutTone = 'ok' | 'err' | 'warn' | 'dim' | 'accent'
export interface OutLine { text: string; tone?: OutTone; cmd?: string; key?: string; meta?: string }

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

export function Spinner() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const id = window.setInterval(() => setFrame((value) => (value + 1) % SPINNER.length), 90)
    return () => window.clearInterval(id)
  }, [])
  return <span className="spinner" aria-hidden="true">{SPINNER[frame]}</span>
}

/**
 * 品牌标记：与 public/favicon.svg 同一造型（三根递降柱 = 目标→周→日，橙点 = 此刻专注的一步），
 * 终端里改成像素块：直角、无圆角，与等宽字的栅格对齐。内联 SVG 跟随字色，屏幕阅读器不朗读。
 */
export function BrandMark() {
  return <svg className="brand-mark" width="56" height="56" viewBox="0 0 32 32" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
    <rect x="3" y="4" width="5" height="21" fill="currentColor" />
    <rect x="11" y="9" width="5" height="16" fill="currentColor" opacity="0.78" />
    <rect x="19" y="14" width="5" height="11" fill="currentColor" opacity="0.56" />
    <rect x="26" y="20" width="5" height="5" className="brand-dot" />
  </svg>
}

const BANNER = renderBanner()

export function Banner({ label, children }: { label: string; children?: ReactNode }) {
  return <header className="banner">
    <pre className="banner-art" role="img" aria-label={label}>{BANNER.join('\n')}</pre>
    {children ? <div className="motd">{children}</div> : null}
  </header>
}

export interface NavItem { key: string; label: string; active?: boolean; href?: string; onSelect?: () => void }

export function ShellFrame({ nav, cta, homeLabel, children }: { nav: NavItem[]; cta?: ReactNode; homeLabel: string; children: ReactNode }) {
  return <div className="shell">
    <aside className="shell-side">
      <a className="side-mark" href="/" aria-label={homeLabel}><BrandMark /></a>
      <nav className="side-nav" aria-label={homeLabel}>
        {nav.map((item) => {
          const body = <><span className="side-key" aria-hidden="true">[{item.key}]</span><span>{item.label}</span></>
          return item.href
            ? <a key={item.key} className={`side-link ${item.active ? 'active' : ''}`} href={item.href} aria-current={item.active ? 'page' : undefined}>{body}</a>
            : <button key={item.key} type="button" className={`side-link ${item.active ? 'active' : ''}`} aria-current={item.active ? 'page' : undefined} onClick={item.onSelect}>{body}</button>
        })}
      </nav>
      {cta ? <div className="side-cta">{cta}</div> : null}
    </aside>
    <main className="shell-main">{children}</main>
  </div>
}

export function Echo({ text, label, children }: { text: string; label?: string; children?: ReactNode }) {
  return <div className="echo">
    <span className="echo-chip">{label ? <span className="echo-user">{label}</span> : null}<span className="echo-caret" aria-hidden="true">&gt;</span> {text}</span>
    {children ? <span className="echo-result">{children}</span> : null}
  </div>
}

export function Lines({ lines, onCommand }: { lines: OutLine[]; onCommand?: (command: string) => void }) {
  return <div className="out-lines">{lines.map((line, index) => <div key={index} className={`out-line ${line.tone ? `tone-${line.tone}` : ''}`}>
    {line.key !== undefined ? <span className="out-key">{line.key}</span> : null}
    {line.cmd && onCommand ? <button type="button" className="out-cmd" onClick={() => onCommand(line.cmd!)}>{line.text}</button> : <span className="out-text">{line.text}</span>}
    {line.meta ? <span className="out-meta">{line.meta}</span> : null}
  </div>)}</div>
}

export function Menu({ id, items, index, onPick, onHover, footer }: { id: string; items: MenuItem[]; index: number; onPick: (item: MenuItem) => void; onHover?: (index: number) => void; footer?: string }) {
  const listRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => { listRef.current?.querySelector<HTMLElement>('.menu-row.active')?.scrollIntoView({ block: 'nearest' }) }, [index])
  return <div className="menu" ref={listRef}>
    <div role="listbox" id={id}>
      {items.map((item, itemIndex) => <div key={item.id} id={`${id}-${itemIndex}`} role="option" aria-selected={itemIndex === index} className={`menu-row ${itemIndex === index ? 'active' : ''}`}
        onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => onHover?.(itemIndex)} onClick={() => onPick(item)}>
        <span className="menu-label">{item.label}</span>{item.hint ? <span className="menu-hint">{item.hint}</span> : null}{item.meta ? <span className="menu-meta">{item.meta}</span> : null}
      </div>)}
    </div>
    {footer ? <div className="menu-foot">{footer}</div> : null}
  </div>
}

function firstStep(ask: Ask | null, from: number, values: Record<string, string>): number {
  if (!ask) return 0
  let step = from
  while (step < ask.fields.length && ask.fields[step].skip?.(values)) step++
  return step
}

function optionValue(item: MenuItem): string { return item.value ?? item.id }

function optionsOf(field: AskField | undefined, values: Record<string, string>): MenuItem[] | undefined {
  return typeof field?.options === 'function' ? field.options(values) : field?.options
}

interface PromptProps {
  user: string
  ask: Ask | null
  busy: ReactNode
  placeholder?: string
  history: string[]
  copy: PromptCopy
  complete: (input: string) => MenuItem[]
  menu: ExternalMenu | null
  inputRef: React.MutableRefObject<HTMLInputElement | HTMLTextAreaElement | null>
  /** 外部把一段文字放进提示符（帮助菜单里选了需要参数的命令）；nonce 变化才生效。 */
  prefill?: { text: string; nonce: number } | null
  onSubmit: (line: string) => void
  onNav?: () => void
  onClear?: () => void
}

/**
 * 唯一的输入面：命令、登录、编辑表单都在这一行里一步一步问。
 * 密码字段不回显、不进历史，也不留在组件状态里（每次提问结束都清空）。
 */
export function Prompt({ user, ask, busy, placeholder, history, copy, complete, menu, inputRef, prefill, onSubmit, onNav, onClear }: PromptProps) {
  const [value, setValue] = useState('')
  const [step, setStep] = useState(0)
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [menuIndex, setMenuIndex] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [filtering, setFiltering] = useState(false)
  const historyIndex = useRef(-1)
  const stash = useRef('')

  useEffect(() => {
    const start = firstStep(ask, 0, {})
    setStep(start)
    setValues({})
    setError('')
    setFiltering(false)
    setMenuIndex(0)
    const field = ask?.fields[start]
    const options = optionsOf(field, {})
    setValue(field && !options ? field.initial ?? '' : '')
    if (options) setMenuIndex(Math.max(0, options.findIndex((item) => optionValue(item) === field?.initial)))
    // 换题即清空输入与已答内容：取消或完成后，密码不会留在状态里。
  }, [ask])

  useEffect(() => {
    if (!prefill || ask) return
    setValue(prefill.text)
    setDismissed(null)
    inputRef.current?.focus()
  }, [prefill?.nonce])

  // 单行与多行（备注）是两个不同的元素，换题后焦点要跟过去，否则回车落到页面上。
  useEffect(() => { if (ask) inputRef.current?.focus() }, [ask, step, inputRef])

  const field = ask?.fields[step]
  const choice = useMemo(() => optionsOf(field, values), [field, values])
  const choiceItems = useMemo(() => {
    if (!choice) return []
    if (!filtering || !value.trim()) return choice
    return choice.map((item) => ({ item, score: fuzzyScore(value, `${item.label} ${item.hint || ''} ${item.meta || ''} ${optionValue(item)}`) })).filter((entry) => entry.score !== null).sort((a, b) => b.score! - a.score!).map((entry) => entry.item)
  }, [choice, filtering, value])
  const completions = useMemo(() => (!ask && dismissed !== value ? complete(value) : []), [ask, complete, dismissed, value])
  const external = !ask && !value && menu ? menu : null
  const activeItems = choice ? choiceItems : completions
  const listId = choice ? 'prompt-choices' : 'prompt-completions'

  useEffect(() => { setMenuIndex((index) => Math.min(index, Math.max(0, activeItems.length - 1))) }, [activeItems.length])

  const finishField = (raw: string) => {
    if (!ask || !field) return
    const answer = field.type === 'note' ? raw.replace(/\s+$/, '') : field.type === 'password' ? raw : raw.trim()
    const problem = field.validate?.(answer, values) ?? null
    if (problem) { setError(problem); return }
    const nextValues = { ...values, [field.key]: answer }
    const next = firstStep(ask, step + 1, nextValues)
    if (next >= ask.fields.length) {
      setValues({})
      setValue('')
      ask.onDone(nextValues)
      return
    }
    const nextField = ask.fields[next]
    const nextOptions = optionsOf(nextField, nextValues)
    setValues(nextValues)
    setStep(next)
    setError('')
    setFiltering(false)
    setValue(nextOptions ? '' : nextField.initial ?? '')
    setMenuIndex(nextOptions ? Math.max(0, nextOptions.findIndex((item) => optionValue(item) === nextField.initial)) : 0)
  }

  const cancel = () => {
    setValues({})
    setValue('')
    ask?.onCancel?.()
  }

  const submitCommand = (line: string) => {
    const trimmed = line.trim()
    if (trimmed && history[history.length - 1] !== trimmed) {
      history.push(trimmed)
      if (history.length > 200) history.shift()
    }
    historyIndex.current = -1
    setValue('')
    setDismissed(null)
    onSubmit(trimmed)
  }

  const pickCompletion = (item: MenuItem) => {
    const next = item.value ?? item.label
    if (item.run) submitCommand(next)
    else { setValue(`${next} `); setDismissed(null) }
    inputRef.current?.focus()
  }

  const pickChoice = (item: MenuItem) => finishField(optionValue(item))

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (busy) { if (event.key === 'Enter') event.preventDefault(); return }
    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey
    if (ctrl && event.key.toLowerCase() === 'c') {
      if (ask) { event.preventDefault(); cancel() } else if (value) { event.preventDefault(); setValue('') }
      return
    }
    if (ctrl && event.key.toLowerCase() === 'l') { event.preventDefault(); onClear?.(); return }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (completions.length) setDismissed(value)
      else if (ask) cancel()
      else if (external) external.dismiss()
      else if (value) setValue('')
      else onNav?.()
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const delta = event.key === 'ArrowUp' ? -1 : 1
      if (activeItems.length) {
        event.preventDefault()
        setMenuIndex((index) => (index + delta + activeItems.length) % activeItems.length)
        return
      }
      if (external) {
        event.preventDefault()
        external.setIndex((external.index + delta + external.items.length) % external.items.length)
        return
      }
      if (!ask && history.length && !(field?.type === 'note')) {
        event.preventDefault()
        if (historyIndex.current === -1) { if (delta > 0) return; stash.current = value; historyIndex.current = history.length }
        const next = historyIndex.current + delta
        if (next >= history.length) { historyIndex.current = -1; setValue(stash.current); return }
        historyIndex.current = Math.max(0, next)
        setValue(history[historyIndex.current])
      }
      return
    }
    if (event.key === 'Tab' && !event.shiftKey && activeItems.length) {
      event.preventDefault()
      const item = activeItems[menuIndex]
      if (choice) pickChoice(item)
      else { setValue(`${item.value ?? item.label}${item.run ? '' : ' '}`); setDismissed(item.run ? `${item.value}` : null) }
      return
    }
    if (event.key === 'Enter' && !(field?.type === 'note' && event.shiftKey) && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (choice) {
        const item = choiceItems[menuIndex]
        if (item) pickChoice(item)
        else setError(copy.noMatch)
        return
      }
      if (ask) { finishField(value); return }
      if (completions.length && value !== completions[menuIndex]?.value) { pickCompletion(completions[menuIndex]); return }
      if (external) { external.pick(external.items[external.index]); return }
      submitCommand(value)
    }
  }

  const label = field ? field.label : user
  const priorFields = ask ? ask.fields.slice(0, step).filter((candidate) => candidate.key in values) : []
  const hint = busy ? '' : choice ? copy.hintChoice : field?.type === 'note' ? copy.hintNote : ask ? copy.hintAsk : external ? copy.hintMenu : copy.hintCommand
  const previousUsername = ask && field?.type === 'password' ? ask.fields.slice(0, step).find((candidate) => candidate.autoComplete === 'username') : undefined
  const common = {
    id: 'prompt-input',
    className: `prompt-input ${field?.type === 'password' ? 'is-secret' : ''}`,
    value,
    readOnly: Boolean(busy),
    autoComplete: field?.autoComplete || 'off',
    spellCheck: false,
    autoCapitalize: 'off',
    maxLength: field?.maxLength,
    placeholder: field ? field.placeholder || '' : placeholder,
    'aria-label': field ? `${ask?.title ? `${ask.title} · ` : ''}${field.label}` : `${user} >`,
    'aria-controls': activeItems.length ? listId : undefined,
    'aria-activedescendant': activeItems.length ? `${listId}-${menuIndex}` : undefined,
    'aria-expanded': activeItems.length ? true : undefined,
    role: activeItems.length || choice ? 'combobox' : undefined,
    onKeyDown,
  }

  return <div className={`prompt ${busy ? 'is-busy' : ''} ${ask ? 'has-ask' : ''}`}>
    {ask ? <div className="ask-transcript">
      {ask.title ? <div className="ask-title">{ask.title}</div> : null}
      {priorFields.map((prior) => <div className="ask-line" key={prior.key}><span className="prompt-label">{prior.label}:</span> <span>{prior.type === 'password' ? '' : optionsOf(prior, values)?.find((item) => optionValue(item) === values[prior.key])?.label ?? values[prior.key]}</span></div>)}
    </div> : null}
    {activeItems.length ? <Menu id={listId} items={activeItems} index={menuIndex} onHover={setMenuIndex} onPick={choice ? pickChoice : pickCompletion} /> : null}
    <form className="prompt-line" onSubmit={(event) => event.preventDefault()} onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); inputRef.current?.focus() } }}>
      {busy ? <span className="prompt-busy" role="status">{busy}</span> : <label className="prompt-label" htmlFor="prompt-input">{label}{field ? ':' : <span className="prompt-caret"> &gt;</span>}</label>}
      {previousUsername ? <input type="email" name="username" autoComplete="username" value={values[previousUsername.key] || ''} readOnly hidden /> : null}
      {field?.type === 'password' ? <span className="secret-caret" aria-hidden="true">▌</span> : null}
      {field?.type === 'note'
        ? <textarea {...common} ref={(element) => { inputRef.current = element }} rows={Math.min(8, Math.max(1, value.split('\n').length))} onChange={(event) => { setValue(event.target.value); setError('') }} />
        : <input {...common} ref={(element) => { inputRef.current = element }} type={field?.type === 'password' ? 'password' : field?.type === 'email' ? 'email' : 'text'} name={field?.type === 'password' ? 'password' : field?.type === 'email' ? 'username' : 'command'}
          onChange={(event) => { setValue(event.target.value); setError(''); setFiltering(true); setDismissed(null); historyIndex.current = -1; if (choice || !ask) setMenuIndex(0) }} />}
    </form>
    {error ? <div className="prompt-error" role="alert">✗ {error}</div> : null}
    {hint ? <div className="prompt-hint">{hint}</div> : null}
  </div>
}

export type ThemePref = 'auto' | 'dark' | 'light'
const THEME_KEY = 'liubai-taskboard:theme:v1'

function readTheme(): ThemePref {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'dark' || stored === 'light' ? stored : 'auto'
  } catch { return 'auto' }
}

function systemTheme(): 'dark' | 'light' {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function useTheme(): { pref: ThemePref; resolved: 'dark' | 'light'; setPref: (pref: ThemePref) => void } {
  const [pref, setPref] = useState<ThemePref>(readTheme)
  const [system, setSystem] = useState<'dark' | 'light'>(systemTheme)
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const query = matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setSystem(query.matches ? 'light' : 'dark')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  const resolved = pref === 'auto' ? system : pref
  useEffect(() => {
    document.documentElement.dataset.theme = resolved
    try { if (pref === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, pref) } catch { /* 隐私模式可能拒绝写入偏好。 */ }
  }, [pref, resolved])
  return { pref, resolved, setPref }
}

export interface Output { id: number; echo?: string; lines: OutLine[] }
export type Page = { id: number; echo?: string } & ({ kind: 'help' } | { kind: 'lines'; lines: OutLine[] })

/**
 * 没有滚动区：屏幕上只有当前场景和「上一条命令」。短结果留在提示符上方；长输出（多于 3 行，
 * 或带可点的命令行、键值行）换成整页盖住场景，下一条命令或 esc 收起。
 * 不带回显的结果（提问答完、保存提示）沿用上一条回显，和触发它的命令待在一起。
 */
export function useOutput() {
  const [output, setOutput] = useState<Output | null>(null)
  const [page, setPage] = useState<Page | null>(null)
  const sequence = useRef(0)
  const print = useCallback((lines: OutLine[], echo?: string) => {
    const id = ++sequence.current
    if (lines.length > 3 || lines.some((line) => line.cmd || line.key !== undefined)) {
      setPage({ id, echo, kind: 'lines', lines })
      setOutput(null)
      return
    }
    setPage(null)
    setOutput((current) => ({ id, echo: echo ?? current?.echo, lines }))
  }, [])
  const showHelp = useCallback((echo?: string) => {
    setPage({ id: ++sequence.current, echo, kind: 'help' })
    setOutput(null)
  }, [])
  const closePage = useCallback(() => setPage(null), [])
  const clear = useCallback(() => { setOutput(null); setPage(null) }, [])
  return { output, page, print, showHelp, closePage, clear }
}

/** 提示符上方的一条输出：只有一行短结果时与回显同排（`> /done d1  [x] d1 …`）。 */
export function OutputStrip({ output, onCommand }: { output: Output | null; onCommand: (command: string) => void }) {
  if (!output || (output.echo === undefined && !output.lines.length)) return null
  const only = output.lines.length === 1 ? output.lines[0] : undefined
  const inline = output.echo !== undefined && only && only.text.length <= 72
  return <div className="output" role="status" aria-live="polite">
    {output.echo !== undefined ? <Echo text={output.echo}>{inline ? <span className={`tone-${only.tone || 'plain'}`}>{only.text}</span> : null}</Echo> : null}
    {!inline && output.lines.length ? <Lines lines={output.lines} onCommand={onCommand} /> : null}
  </div>
}

export function PageHead({ echo, hint }: { echo?: string; hint: string }) {
  return <div className="page-head">{echo !== undefined ? <Echo text={echo} /> : <span />}<span className="page-hint">{hint}</span></div>
}

/** 场景按字符格排版：像终端的 $COLUMNS，量出容器一行放得下多少个半角字符。 */
export function useColumns(ref: RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = useState(80)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const probe = document.createElement('span')
    probe.textContent = '0'.repeat(100)
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;letter-spacing:0'
    element.appendChild(probe)
    const measure = () => {
      const cell = probe.getBoundingClientRect().width / 100
      if (cell) setColumns(Math.max(20, Math.floor(element.clientWidth / cell)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    // 自托管字体晚于首帧到达，换字体后字宽会变。
    void document.fonts?.ready.then(measure)
    return () => { observer.disconnect(); probe.remove() }
  }, [ref])
  return columns
}
