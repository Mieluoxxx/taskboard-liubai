import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OAuthAuthorizationDetails, OAuthGrant, SupabaseClient, User } from '@supabase/supabase-js'
import { createSupabaseBoardAdapter, getSupabaseConfig, type SupabaseBoardAdapter } from './storage'
import { copy, type CopyKey } from './i18n'
import { createAuthorizationLoader } from './auth-flow'
import { validateStoredBoard } from './domain'
import { restoreTrash, type RestoreTarget, type TrashEntry } from './agent-operations'
import { commandsFor, completeCommand, fill, isAnswer, isYes, parseDateArg, parseLine, parseWeekArg, resolveCommand, type MenuItem } from './terminal'
import { Banner, Echo, Lines, Menu, Prompt, ShellFrame, Spinner, useStickToBottom, useTheme, type Ask, type OutLine } from './Shell'
import type { Language, StoredBoard } from './types'
import './fonts.css'
import './styles.css'

type Translate = (key: CopyKey) => string
type Audit = { id: number; occurred_at: string; client_id: string | null; action: string; object_kind: string; object_id: string | null; result: string }
type Entry = { id: number; echo?: string; lines?: OutLine[]; help?: boolean }
/** 账户区注册给提示符的命令处理器：返回 false 表示不认识，交回外层报错。 */
type AccountCommand = (name: string, args: string[]) => boolean
type Shell = { print: (lines: OutLine[], echo?: string) => void; ask: (spec: Omit<Ask, 'id'>) => void; confirm: (question: string, onYes: () => void) => void }

const PAGE = 20

async function rpc<T>(client: SupabaseClient, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.rpc(name, args)
  if (result.error) throw result.error
  return result.data as T
}

function redirectToClient(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Invalid OAuth redirect')
  window.location.assign(url.href)
}

function stamp(value: string): string {
  return new Date(value).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function AccountPage() {
  const theme = useTheme()
  const [language, setLanguage] = useState<Language>(() => { try { return localStorage.getItem('liubai-taskboard:language:v1') === 'en' ? 'en' : 'zh' } catch { return 'zh' } })
  const t = useCallback<Translate>((key) => copy[language][key], [language])
  const cloud = useMemo(() => { const config = getSupabaseConfig(); return config ? createSupabaseBoardAdapter(config) : null }, [])
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [entries, setEntries] = useState<Entry[]>([])
  const entryId = useRef(0)
  const [ask, setAsk] = useState<Ask | null>(null)
  const askId = useRef(0)
  const [helpIndex, setHelpIndex] = useState<number | null>(null)
  const history = useRef<string[]>([])
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const commandRef = useRef<AccountCommand | null>(null)
  const follow = useStickToBottom(`${entries.length}:${ask?.id ?? 0}`)

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
    try { localStorage.setItem('liubai-taskboard:language:v1', language) } catch { /* 浏览器可能拒绝持久化。 */ }
  }, [language])
  useEffect(() => {
    if (!cloud) { setReady(true); return }
    let active = true
    let version = 0
    const { data } = cloud.client.auth.onAuthStateChange((_event, session) => {
      version++
      if (active) { setUser(session?.user || null); setReady(true) }
    })
    const initial = version
    void cloud.client.auth.getSession().then(({ data }) => {
      if (active && initial === version) { setUser(data.session?.user || null); setReady(true) }
    }, () => { if (active) { print([{ text: t('invalidCredentials'), tone: 'err' }]); setReady(true) } })
    return () => { active = false; data.subscription.unsubscribe() }
  }, [cloud])

  const print = useCallback((lines: OutLine[], echo?: string) => {
    setEntries((current) => [...current, { id: ++entryId.current, echo, lines }].slice(-80))
  }, [])
  const openAsk = useCallback((spec: Omit<Ask, 'id'>) => {
    setHelpIndex(null)
    setAsk({ ...spec, id: ++askId.current, onDone: (values) => { setAsk(null); spec.onDone(values) }, onCancel: () => { setAsk(null); print([{ text: copy[language].cancelled, tone: 'dim' }]); spec.onCancel?.() } })
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [language, print])
  const confirm = useCallback((question: string, onYes: () => void) => openAsk({
    title: question,
    fields: [{ key: 'answer', label: '[y/N]', validate: (value) => (isAnswer(value) ? null : copy[language].answerYesNo) }],
    onDone: ({ answer }) => { if (isYes(answer)) onYes(); else print([{ text: copy[language].cancelled, tone: 'dim' }]) },
  }), [language, openAsk, print])
  const shell = useMemo<Shell>(() => ({ print, ask: openAsk, confirm }), [print, openAsk, confirm])

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
  async function signIn(email: string, password: string) {
    if (!cloud || busy) return
    setBusy(true)
    let ok = false
    try { const result = await cloud.signIn(email.trim(), password); ok = result.ok }
    catch { ok = false }
    finally { setBusy(false) }
    if (ok) print([{ text: fill(t('welcome'), { email: email.trim() }), tone: 'ok' }])
    else { print([{ text: t('invalidCredentials'), tone: 'err' }]); startLogin(email.trim()) }
  }

  const context = 'account' as const
  const helpItems = useMemo<MenuItem[]>(() => commandsFor(context).map((command) => ({ id: command.name, label: `/${command.name}${command.args ? ` ${command.args}` : ''}`, hint: command[language], value: `/${command.name}`, run: !command.needsArg })), [language])
  const execute = (raw: string) => {
    const line = raw.trim()
    const parsed = parseLine(line)
    setHelpIndex(null)
    if (parsed.kind === 'empty') return
    const fail = (text: string) => print([{ text, tone: 'err' }], line)
    if (parsed.kind === 'text') return fail(fill(t('cmdNotFound'), { cmd: parsed.text.split(/\s+/)[0] }))
    const spec = resolveCommand(parsed.name, context)
    if (!spec) return fail(fill(t('cmdUnknown'), { cmd: parsed.name }))
    switch (spec.name) {
      case 'help':
        setEntries((current) => [...current, { id: ++entryId.current, echo: line, help: true }])
        return setHelpIndex(0)
      case 'login':
        if (!cloud) return fail(t('setupBody'))
        if (user) return print([{ text: user.email || '', tone: 'dim' }], line)
        print([], line)
        return startLogin(parsed.args[0])
      case 'board':
        print([], line)
        return window.location.assign('/')
      case 'whoami':
        return print([{ text: user?.email || 'guest' }], line)
      case 'theme': {
        const pick = parsed.args[0]?.toLowerCase()
        const next = pick === 'dark' || pick === 'light' || pick === 'auto' ? pick : !pick ? (theme.resolved === 'dark' ? 'light' : 'dark') : null
        if (!next) return fail(fill(t('usage'), { usage: '/theme [dark|light|auto]' }))
        theme.setPref(next)
        return print([{ text: `theme · ${next}`, tone: 'dim' }], line)
      }
      case 'lang': {
        const pick = parsed.args[0]?.toLowerCase()
        const next: Language | null = pick === 'zh' || pick === 'en' ? pick : !pick ? (language === 'zh' ? 'en' : 'zh') : null
        if (!next) return fail(fill(t('usage'), { usage: '/lang [zh|en]' }))
        setLanguage(next)
        return print([{ text: `lang · ${next}`, tone: 'dim' }], line)
      }
      case 'clear':
        return setEntries([])
      default:
        if (!user) return fail(fill(t('cmdNotFound'), { cmd: `/${spec.name}` }))
        print([], line)
        if (!commandRef.current?.(spec.name, parsed.args)) print([{ text: fill(t('cmdUnknown'), { cmd: spec.name }), tone: 'err' }])
    }
  }

  const complete = useCallback((input: string) => completeCommand(input, context, language), [language])
  const pickHelp = (item: MenuItem) => { setHelpIndex(null); if (item.run) execute(item.value!); else execute(`/help ${item.id}`) }
  const lastHelp = [...entries].reverse().find((entry) => entry.help)?.id

  return <ShellFrame homeLabel={t('appName')} nav={[{ key: 'B', label: t('backToBoard'), href: '/' }, { key: 'A', label: t('accountNav'), active: true }]}
    cta={user ? <button type="button" className="side-button" onClick={() => execute('/logout')}>{t('logout')}</button> : cloud && ready ? <button type="button" className="side-button" onClick={() => execute('/login')}>{t('signIn')}</button> : null}>
    <div className="scrollback" onMouseUp={(event) => { if (!window.getSelection()?.toString() && !(event.target as HTMLElement).closest('button,a,input,textarea,[role="option"]')) inputRef.current?.focus() }}>
      <Banner label={t('appName')}><p>{t('accountTools')}</p><p className="dim">{t('accountMotd')}</p></Banner>
      <section className="account">
        {!cloud ? <Lines lines={[{ text: t('setupBody'), tone: 'err' }]} /> : !ready ? <div className="out-line"><Spinner /> <span className="tone-dim">{t('loading')}</span></div> : user ? <AccountContent key={user.id} cloud={cloud} user={user} t={t} shell={shell} commandRef={commandRef} onCommand={execute} /> : <Lines lines={[{ text: t('authBody'), tone: 'dim' }, { text: '/login', cmd: '/login' }]} onCommand={execute} />}
      </section>
      {entries.map((entry) => <div key={entry.id} className="entry">
        {entry.echo !== undefined ? <Echo text={entry.echo} /> : null}
        {entry.help ? <Menu id={`help-${entry.id}`} items={helpItems} index={entry.id === lastHelp && helpIndex !== null ? helpIndex : -1} onPick={pickHelp} footer={entry.id === lastHelp && helpIndex !== null ? t('hintMenu') : undefined} /> : null}
        {entry.lines?.length ? <Lines lines={entry.lines} onCommand={execute} /> : null}
      </div>)}
    </div>
    <div className="console">
      <Prompt user={`${user?.email?.split('@')[0] || 'guest'}@liubai`} ask={ask} busy={busy ? <><Spinner /> {t('authenticating')}</> : null} placeholder={user ? '/help' : '/login'} history={history.current}
        copy={{ hintCommand: t('hintCommand'), hintAsk: t('hintAsk'), hintChoice: t('hintChoice'), hintNote: t('hintNote'), hintMenu: t('hintMenu'), noMatch: t('finderEmpty') }}
        complete={complete} inputRef={inputRef} onGrow={follow} onSubmit={execute} onClear={() => setEntries([])}
        menu={helpIndex !== null ? { items: helpItems, index: helpIndex, setIndex: setHelpIndex, pick: pickHelp, dismiss: () => setHelpIndex(null) } : null} />
    </div>
    <footer className="statusline">
      <span className="sl-mode">TTY</span>
      <span className="sl-path">{t('appName')} › {t('accountNav')}</span>
      <span className="sl-spacer" />
      <span className="sl-item">{user?.email || 'guest'}</span>
      <button type="button" className="sl-item" onClick={() => execute(`/lang ${language === 'zh' ? 'en' : 'zh'}`)}>{t('langShort')}</button>
      <button type="button" className="sl-item" aria-label="theme" onClick={() => execute('/theme')}>{theme.resolved === 'dark' ? '◐' : '◑'}</button>
    </footer>
  </ShellFrame>
}

function AccountContent({ cloud, user, t, shell, commandRef, onCommand }: { cloud: SupabaseBoardAdapter; user: User; t: Translate; shell: Shell; commandRef: React.MutableRefObject<AccountCommand | null>; onCommand: (command: string) => void }) {
  const authorizationId = useMemo(() => new URLSearchParams(window.location.search).get('authorization_id'), [])
  const consentRoute = window.location.pathname === '/oauth/consent'
  const [loadAuthorization] = useState(() => createAuthorizationLoader((id: string) => cloud.client.auth.oauth.getAuthorizationDetails(id)))
  const [details, setDetails] = useState<OAuthAuthorizationDetails | null>(null)
  const [client, setClient] = useState<SupabaseClient | null>(null)
  const [board, setBoard] = useState<StoredBoard | null>(null)
  const [grants, setGrants] = useState<OAuthGrant[]>([])
  const [trash, setTrash] = useState<TrashEntry[]>([])
  const [audit, setAudit] = useState<Audit[]>([])
  const [trashOffset, setTrashOffset] = useState(0)
  const [auditOffset, setAuditOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const asked = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const report = useCallback((error: unknown) => {
    if (!alive.current) return
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    shell.print([{ text: t(code === 'PT409' ? 'noticeConflictCloud' : code === '42501' ? 'noticeSessionExpired' : 'accountOperationFailed'), tone: 'err' }])
  }, [shell, t])
  useEffect(() => {
    let active = true
    void cloud.getBoardAdapterForCurrentSession(user.id).then((adapter) => {
      if (active) { if (adapter) setClient(adapter.client); else shell.print([{ text: t('noticeSessionExpired'), tone: 'err' }]) }
    }, report)
    return () => { active = false }
  }, [cloud, user.id, report])
  const currentUser = useCallback(async () => {
    const result = await cloud.client.auth.getUser()
    if (result.error || result.data.user?.id !== user.id || !alive.current) throw new Error('Session changed')
  }, [cloud, user.id])
  const refresh = useCallback(async () => {
    if (!client) return
    const [rows, grantsResult, trashRows, auditRows] = await Promise.all([
      rpc<unknown[]>(client, 'get_private_board'), cloud.client.auth.oauth.listGrants(),
      rpc<TrashEntry[]>(client, 'get_board_trash', { p_limit: PAGE, p_offset: trashOffset }),
      rpc<Audit[]>(client, 'get_board_audit', { p_limit: PAGE, p_offset: auditOffset }),
    ])
    await currentUser()
    if (grantsResult.error) throw grantsResult.error
    setBoard(validateStoredBoard(rows[0])); setGrants(grantsResult.data); setTrash(trashRows); setAudit(auditRows)
  }, [client, cloud, trashOffset, auditOffset, currentUser])
  useEffect(() => {
    if (!consentRoute) void refresh().catch(report)
  }, [consentRoute, refresh, report])
  useEffect(() => {
    if (!consentRoute) return
    if (!authorizationId || authorizationId.length > 400) { shell.print([{ text: t('accountAuthorizationInvalid'), tone: 'err' }]); return }
    let active = true
    void loadAuthorization(authorizationId).then(async ({ data, error }) => {
      if (!active) return
      if (error || !data) { shell.print([{ text: t('accountAuthorizationInvalid'), tone: 'err' }]); return }
      await currentUser()
      if (!active) return
      if ('authorization_id' in data) setDetails(data)
      else redirectToClient(data.redirect_url)
    }).catch((error) => { if (active) report(error) })
    return () => { active = false }
  }, [consentRoute, authorizationId, loadAuthorization, currentUser, report])
  async function run(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try { await currentUser(); await work(); if (alive.current) shell.print([{ text: `✓ ${t('accountDone')}`, tone: 'ok' }]) }
    catch (error) { report(error) }
    finally { if (alive.current) setBusy(false) }
  }
  async function consent(approve: boolean) {
    if (!details) return
    const result = approve
      ? await cloud.client.auth.oauth.approveAuthorization(details.authorization_id, { skipBrowserRedirect: true })
      : await cloud.client.auth.oauth.denyAuthorization(details.authorization_id, { skipBrowserRedirect: true })
    if (result.error) throw result.error
    await currentUser()
    redirectToClient(result.data.redirect_url)
  }
  async function restore(entry: TrashEntry, target: RestoreTarget) {
    if (!client) return
    const latest = validateStoredBoard((await rpc<unknown[]>(client, 'get_private_board'))[0])
    const snapshot = restoreTrash(latest.snapshot, entry, target)
    const requestId = crypto.randomUUID()
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ id: entry.id, target, snapshot })))
    const fingerprint = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
    await rpc(client, 'commit_agent_board', { p_expected_revision: latest.revision, p_snapshot: snapshot, p_request_id: requestId, p_fingerprint: fingerprint, p_restore_ids: [entry.id] })
    await refresh()
  }

  const askConsent = () => {
    if (!details) return
    shell.confirm(fill(t('accountAllowQuestion'), { name: details.client.name }), () => void run(() => consent(true)))
  }
  // 授权详情一到就把问题放进提示符：这一页唯一要做的决定就是 y 或 n。
  useEffect(() => { if (details && !asked.current) { asked.current = true; askConsent() } }, [details])

  const revoke = (grant: OAuthGrant) => shell.confirm(`${t('accountRevokeConfirm')}  ${grant.client.name}`, () => void run(async () => {
    const result = await cloud.client.auth.oauth.revokeGrant({ clientId: grant.client.id })
    if (result.error) throw result.error
    await refresh()
  }))
  const purge = (entry: TrashEntry) => {
    if (!client) return
    shell.confirm(t('accountPurgeConfirm'), () => void run(async () => { await rpc(client, 'purge_board_trash', { p_id: entry.id }); await refresh() }))
  }
  // 原项目已不存在时必须选新项目；选了新项目，日/周计划还需要新的日期或周次，与原表单的必填规则一致。
  const startRestore = (entry: TrashEntry) => {
    const missingProject = entry.payload.tasks.some((task) => task.cycleId && !entry.payload.cycles.some((cycle) => cycle.id === task.cycleId) && !board?.snapshot.cycles.some((cycle) => cycle.id === task.cycleId))
    const choosesProject = !entry.payload.cycles.length && entry.payload.tasks.length > 0
    if (!choosesProject) return void run(() => restore(entry, {}))
    const today = new Date().toISOString().slice(0, 10)
    const projects: MenuItem[] = [...(missingProject ? [] : [{ id: 'original', value: '', label: t('accountOriginalPlacement') }]), ...(board?.snapshot.cycles.map((cycle) => ({ id: cycle.id, value: cycle.id, label: cycle.name, meta: `${cycle.startDate} → ${cycle.endDate}` })) ?? [])]
    shell.ask({
      title: `${t('accountRestore')} · ${names(entry)[0] || entry.id}`,
      fields: [
        { key: 'cycleId', label: t('accountRestoreProject'), options: projects },
        { key: 'date', label: t('date'), placeholder: 'YYYY-MM-DD', skip: (values) => !values.cycleId || !entry.payload.tasks.some((task) => task.domain === 'daily'), validate: (value) => (parseDateArg(value, today, today) ? null : t('dateInvalid')) },
        { key: 'week', label: t('week'), placeholder: '2026-W41', skip: (values) => !values.cycleId || !entry.payload.tasks.some((task) => task.domain === 'weekly'), validate: (value) => (parseWeekArg(value, `${today.slice(0, 4)}-W01`, `${today.slice(0, 4)}-W01`) ? null : t('weekInvalid')) },
      ],
      onDone: (values) => {
        const target: RestoreTarget = {
          ...(values.cycleId ? { cycleId: values.cycleId } : {}),
          ...(values.date ? { dateKey: parseDateArg(values.date, today, today)! } : {}),
          ...(values.week ? { weekKey: parseWeekArg(values.week, `${today.slice(0, 4)}-W01`, `${today.slice(0, 4)}-W01`)! } : {}),
        }
        void run(() => restore(entry, target))
      },
    })
  }
  const pick = <T,>(list: T[], value: string | undefined): T | undefined => { const index = Number(value); return Number.isInteger(index) && index >= 1 ? list[index - 1] : undefined }

  commandRef.current = (name, args) => {
    if (name === 'logout') { void run(async () => { const result = await cloud.signOut(); if (!result.ok) throw result }); return true }
    if (name === 'allow' || name === 'deny') {
      if (!details) { shell.print([{ text: t('accountAuthorizationInvalid'), tone: 'err' }]); return true }
      if (name === 'deny') void run(() => consent(false)); else askConsent()
      return true
    }
    if (name === 'refresh') { void run(refresh); return true }
    if (name === 'revoke') { const grant = pick(grants, args[0]); if (grant) revoke(grant); else shell.print([{ text: fill(t('refMissing'), { ref: args[0] || '' }), tone: 'err' }]); return true }
    if (name === 'restore' || name === 'purge') {
      const entry = pick(trash, args[0])
      if (!entry) shell.print([{ text: fill(t('refMissing'), { ref: args[0] || '' }), tone: 'err' }])
      else if (name === 'restore') startRestore(entry)
      else purge(entry)
      return true
    }
    if (name === 'more') {
      const back = args[1] === 'prev' || args[1] === '-'
      const step = (offset: number, count: number) => (back ? Math.max(0, offset - PAGE) : count < PAGE || offset >= 10000 ? offset : offset + PAGE)
      if (args[0] === 'trash') setTrashOffset((offset) => step(offset, trash.length))
      else if (args[0] === 'audit') setAuditOffset((offset) => step(offset, audit.length))
      else return false
      return true
    }
    return false
  }

  const Head = ({ text, meta }: { text: string; meta?: string }) => <div className="view-head account-head"><span className="view-title">{text}</span>{meta ? <span className="view-meta">{meta}</span> : null}</div>
  const Bracket = ({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) => <button type="button" className={`bracket ${danger ? 'danger' : ''}`} disabled={busy} onClick={onClick}>[{label}]</button>

  if (consentRoute) return <div className="account-block">
    <Head text={t('accountAuthorize')} meta={user.email} />
    {details ? <>
      <Lines lines={[
        { key: 'client', text: details.client.name },
        { key: t('accountClientId'), text: details.client.id, tone: 'dim' },
        { key: t('accountRedirect'), text: details.redirect_uri, tone: 'dim' },
        { text: `! ${t('accountUnverifiedClient')}`, tone: 'warn' },
        { text: t('accountConsentScope'), tone: 'warn' },
        { text: t('accountConsentDuration'), tone: 'dim' },
      ]} />
      <div className="account-actions"><Bracket label={`n ${t('accountDeny')}`} onClick={() => onCommand('/deny')} /><Bracket label={`y ${t('accountAllow')}`} onClick={() => onCommand('/allow')} /></div>
    </> : <div className="out-line"><Spinner /> <span className="tone-dim">{t('loading')}</span></div>}
  </div>

  return <>
    <div className="account-block">
      <Head text={t('accountConnect')} meta={user.email} />
      <Lines lines={[{ text: t('accountConnectHint'), tone: 'dim' }, { key: 'mcp', text: `${window.location.origin}/api/mcp` }]} />
      <div className="account-actions"><Bracket label={t('refresh')} onClick={() => onCommand('/refresh')} /></div>
    </div>
    <div className="account-block">
      <Head text={t('accountAuthorizations')} meta={String(grants.length)} />
      {grants.length ? grants.map((grant, index) => <div className="account-row" key={grant.client.id}>
        <span className="row-ref">{index + 1}</span>
        <span className="account-main"><span className="row-text">{grant.client.name}</span><small className="row-note">{grant.client.id} · {t('accountGrantedAt')} {stamp(grant.granted_at)}</small></span>
        <Bracket label={t('accountRevoke')} danger onClick={() => onCommand(`/revoke ${index + 1}`)} />
      </div>) : <div className="view-empty">{t('accountEmpty')}</div>}
    </div>
    <div className="account-block">
      <Head text={t('accountTrash')} meta={`${trashOffset + 1}–${trashOffset + trash.length}`} />
      <Lines lines={[{ text: t('accountTrashHint'), tone: 'dim' }]} />
      {trash.map((entry, index) => {
        const all = names(entry)
        return <div className="account-row" key={entry.id}>
          <span className="row-ref">{index + 1}</span>
          <span className="account-main"><span className="row-text">{all[0] || entry.id}</span><small className="row-note">{t('accountDeletedAt')} {stamp(entry.deleted_at)} · {t('accountExpiresAt')} {stamp(entry.expires_at)} · {t('accountDeletedObjects')} ({all.length}){all.length > 1 ? `\n${all.slice(1, 6).join(' · ')}${all.length > 6 ? ' …' : ''}` : ''}</small></span>
          <span className="account-acts"><Bracket label={t('accountRestore')} onClick={() => onCommand(`/restore ${index + 1}`)} /><Bracket label={t('permanentlyDelete')} danger onClick={() => onCommand(`/purge ${index + 1}`)} /></span>
        </div>
      })}
      {!trash.length ? <div className="view-empty">{t('accountEmpty')}</div> : null}
      <div className="account-actions"><Bracket label={`‹ ${t('previous')}`} onClick={() => onCommand('/more trash prev')} /><Bracket label={`${t('next')} ›`} onClick={() => onCommand('/more trash')} /></div>
    </div>
    <div className="account-block">
      <Head text={t('accountAudit')} meta={`${auditOffset + 1}–${auditOffset + audit.length}`} />
      <Lines lines={[{ text: t('accountAuditHint'), tone: 'dim' }, ...audit.map((item) => ({ key: stamp(item.occurred_at), text: `${item.action} · ${item.object_kind} · ${item.object_id || '—'}`, meta: `${item.client_id || t('accountDirectUser')} · ${item.result}` }))]} />
      {!audit.length ? <div className="view-empty">{t('accountEmpty')}</div> : null}
      <div className="account-actions"><Bracket label={`‹ ${t('previous')}`} onClick={() => onCommand('/more audit prev')} /><Bracket label={`${t('next')} ›`} onClick={() => onCommand('/more audit')} /></div>
    </div>
  </>
}

function names(entry: TrashEntry): string[] {
  return [...entry.payload.cycles.map((item) => item.name), ...entry.payload.tasks.map((item) => item.title), ...entry.payload.focusBlocks.map((item) => item.title)]
}
