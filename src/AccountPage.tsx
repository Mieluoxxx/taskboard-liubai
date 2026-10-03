import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OAuthAuthorizationDetails, OAuthGrant, SupabaseClient, User } from '@supabase/supabase-js'
import { createSupabaseBoardAdapter, getSupabaseConfig, type SupabaseBoardAdapter } from './storage'
import { copy, type CopyKey } from './i18n'
import { createAuthorizationLoader } from './auth-flow'
import { validateStoredBoard } from './domain'
import { restoreTrash, type RestoreTarget, type TrashEntry } from './agent-operations'
import type { Language, StoredBoard } from './types'
import './fonts.css'
import './styles.css'
import './account.css'

type Translate = (key: CopyKey) => string
type Audit = { id: number; occurred_at: string; client_id: string | null; action: string; object_kind: string; object_id: string | null; result: string }

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

export default function AccountPage() {
  const [language, setLanguage] = useState<Language>(() => { try { return localStorage.getItem('liubai-taskboard:language:v1') === 'en' ? 'en' : 'zh' } catch { return 'zh' } })
  const t = useCallback<Translate>((key) => copy[language][key], [language])
  const cloud = useMemo(() => { const config = getSupabaseConfig(); return config ? createSupabaseBoardAdapter(config) : null }, [])
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
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
      if (active) { setUser(session?.user || null); setPassword(''); setReady(true) }
    })
    const initial = version
    void cloud.client.auth.getSession().then(({ data }) => {
      if (active && initial === version) { setUser(data.session?.user || null); setReady(true) }
    }, () => { if (active) { setError(true); setReady(true) } })
    return () => { active = false; data.subscription.unsubscribe() }
  }, [cloud])
  async function signIn(event: React.FormEvent) {
    event.preventDefault()
    if (!cloud || busy) return
    setBusy(true); setError(false)
    try { const result = await cloud.signIn(email.trim(), password); setError(!result.ok) }
    catch { setError(true) }
    finally { setPassword(''); setBusy(false) }
  }
  return <main className="account-page">
    <header className="account-header"><a href="/">{t('appName')} / {t('backToBoard')}</a><div className="language-switch"><button onClick={() => setLanguage('zh')} aria-pressed={language === 'zh'}>{t('chinese')}</button><button onClick={() => setLanguage('en')} aria-pressed={language === 'en'}>{t('english')}</button></div></header>
    <h1>{t('accountTools')}</h1>
    {!cloud ? <p role="alert">{t('setupBody')}</p> : !ready ? <p role="status">{t('loading')}</p> : !user ? <section className="account-section"><h2>{t('authTitle')}</h2><p>{t('authBody')}</p><form onSubmit={signIn} className="auth-form"><label>{t('email')}<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>{t('password')}<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error ? <p className="form-error" role="alert">{t('invalidCredentials')}</p> : null}<button className="primary-button" disabled={busy}>{busy ? t('signingIn') : t('signIn')}</button></form></section> : <AccountContent key={user.id} cloud={cloud} user={user} t={t} />}
  </main>
}

function AccountContent({ cloud, user, t }: { cloud: SupabaseBoardAdapter; user: User; t: Translate }) {
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
  const [status, setStatus] = useState<CopyKey | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const report = useCallback((error: unknown) => {
    if (!alive.current) return
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    setStatus(code === 'PT409' ? 'noticeConflictCloud' : code === '42501' ? 'noticeSessionExpired' : 'accountOperationFailed')
  }, [])
  useEffect(() => {
    let active = true
    void cloud.getBoardAdapterForCurrentSession(user.id).then((adapter) => {
      if (active) { if (adapter) setClient(adapter.client); else setStatus('noticeSessionExpired') }
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
      rpc<TrashEntry[]>(client, 'get_board_trash', { p_limit: 20, p_offset: trashOffset }),
      rpc<Audit[]>(client, 'get_board_audit', { p_limit: 20, p_offset: auditOffset }),
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
    if (!authorizationId || authorizationId.length > 400) { setStatus('accountAuthorizationInvalid'); return }
    let active = true
    void loadAuthorization(authorizationId).then(async ({ data, error }) => {
      if (!active) return
      if (error || !data) { setStatus('accountAuthorizationInvalid'); return }
      await currentUser()
      if (!active) return
      if ('authorization_id' in data) setDetails(data)
      else redirectToClient(data.redirect_url)
    }).catch((error) => { if (active) report(error) })
    return () => { active = false }
  }, [consentRoute, authorizationId, loadAuthorization, currentUser, report])
  async function run(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setStatus(null)
    try { await currentUser(); await work(); if (alive.current) setStatus('accountDone') }
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
  return <>
    <div className="account-identity"><span>{user.email}</span><button className="text-button" disabled={busy} onClick={() => void run(async () => { const result = await cloud.signOut(); if (!result.ok) throw result })}>{t('logout')}</button></div>
    {status ? <p className={status === 'accountDone' ? 'account-status' : 'form-error'} role={status === 'accountDone' ? 'status' : 'alert'}>{t(status)}</p> : null}
    {consentRoute ? <section className="account-section">
      <h2>{t('accountAuthorize')}</h2>
      {details ? <><h3>{details.client.name}</h3><dl><dt>{t('accountClientId')}</dt><dd><code>{details.client.id}</code></dd><dt>{t('accountRedirect')}</dt><dd><code>{details.redirect_uri}</code></dd></dl><p>{t('accountUnverifiedClient')}</p><p className="account-warning">{t('accountConsentScope')}</p><p>{t('accountConsentDuration')}</p><div className="account-actions"><button className="secondary-button" disabled={busy} onClick={() => void run(() => consent(false))}>{t('accountDeny')}</button><button className="primary-button" disabled={busy} onClick={() => void run(() => consent(true))}>{t('accountAllow')}</button></div></> : !status ? <p role="status">{t('loading')}</p> : null}
    </section> : <>
      <section className="account-section"><h2>{t('accountConnect')}</h2><p>{t('accountConnectHint')}</p><code className="account-endpoint">{window.location.origin}/api/mcp</code><button className="text-button" disabled={busy} onClick={() => void run(refresh)}>{t('refresh')}</button></section>
      <section className="account-section"><h2>{t('accountAuthorizations')}</h2>{grants.length ? grants.map((grant) => <div className="account-row" key={grant.client.id}><div><strong>{grant.client.name}</strong><small>{grant.client.id}</small><small>{new Date(grant.granted_at).toLocaleString()}</small></div><button className="secondary-button" disabled={busy} onClick={() => { if (window.confirm(`${t('accountRevokeConfirm')}\n${grant.client.name}`)) void run(async () => { const result = await cloud.client.auth.oauth.revokeGrant({ clientId: grant.client.id }); if (result.error) throw result.error; await refresh() }) }}>{t('accountRevoke')}</button></div>) : <p>{t('accountEmpty')}</p>}</section>
      <section className="account-section"><h2>{t('accountTrash')}</h2><p>{t('accountTrashHint')}</p>{trash.map((entry) => <TrashCard key={entry.id} entry={entry} board={board} t={t} busy={busy} onRestore={(target) => void run(() => restore(entry, target))} onPurge={() => { if (client && window.confirm(t('accountPurgeConfirm'))) void run(async () => { await rpc(client, 'purge_board_trash', { p_id: entry.id }); await refresh() }) }} />)}{!trash.length ? <p>{t('accountEmpty')}</p> : null}<Pager offset={trashOffset} count={trash.length} busy={busy} t={t} change={setTrashOffset} /></section>
      <section className="account-section"><h2>{t('accountAudit')}</h2><p>{t('accountAuditHint')}</p>{audit.map((item) => <div className="account-audit" key={item.id}><time>{new Date(item.occurred_at).toLocaleString()}</time><code>{item.action} · {item.object_kind} · {item.object_id || '—'}</code><small>{item.client_id || t('accountDirectUser')} · {item.result}</small></div>)}{!audit.length ? <p>{t('accountEmpty')}</p> : null}<Pager offset={auditOffset} count={audit.length} busy={busy} t={t} change={setAuditOffset} /></section>
    </>}
  </>
}

function Pager({ offset, count, busy, t, change }: { offset: number; count: number; busy: boolean; t: Translate; change: (offset: number) => void }) {
  return <div className="account-actions"><button className="secondary-button" disabled={busy || offset === 0} onClick={() => change(Math.max(0, offset - 20))}>{t('previous')}</button><button className="secondary-button" disabled={busy || count < 20 || offset >= 10000} onClick={() => change(offset + 20)}>{t('next')}</button></div>
}

function TrashCard({ entry, board, t, busy, onRestore, onPurge }: { entry: TrashEntry; board: StoredBoard | null; t: Translate; busy: boolean; onRestore: (target: RestoreTarget) => void; onPurge: () => void }) {
  const [cycleId, setCycleId] = useState('')
  const [dateKey, setDateKey] = useState('')
  const [week, setWeek] = useState('')
  const names = [...entry.payload.cycles.map((item) => item.name), ...entry.payload.tasks.map((item) => item.title), ...entry.payload.focusBlocks.map((item) => item.title)]
  const missingProject = entry.payload.tasks.some((task) => task.cycleId && !entry.payload.cycles.some((cycle) => cycle.id === task.cycleId) && !board?.snapshot.cycles.some((cycle) => cycle.id === task.cycleId))
  return <article className="account-trash-card"><h3>{names[0] || entry.id}</h3><p>{t('accountDeletedAt')} {new Date(entry.deleted_at).toLocaleString()} · {t('accountExpiresAt')} {new Date(entry.expires_at).toLocaleString()}</p><details><summary>{t('accountDeletedObjects')} ({names.length})</summary><ul>{names.map((name, index) => <li key={index}>{name}</li>)}</ul></details>
    <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); onRestore({ ...(cycleId ? { cycleId } : {}), ...(dateKey ? { dateKey } : {}), ...(week ? { weekKey: week } : {}) }) }}>
      {!entry.payload.cycles.length && entry.payload.tasks.length ? <label>{t('accountRestoreProject')}<select value={cycleId} required={missingProject} onChange={(event) => setCycleId(event.target.value)}><option value="">{t('accountOriginalPlacement')}</option>{board?.snapshot.cycles.map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name}</option>)}</select></label> : null}
      {cycleId ? <div className="field-row">{entry.payload.tasks.some((task) => task.domain === 'daily') ? <label>{t('date')}<input type="date" value={dateKey} onChange={(event) => setDateKey(event.target.value)} required /></label> : null}{entry.payload.tasks.some((task) => task.domain === 'weekly') ? <label>{t('week')}<input type="week" value={week} onChange={(event) => setWeek(event.target.value)} required /></label> : null}</div> : null}
      <div className="account-actions"><button className="primary-button" disabled={busy || !board}>{t('accountRestore')}</button><button type="button" className="secondary-button danger" disabled={busy} onClick={onPurge}>{t('permanentlyDelete')}</button></div>
    </form></article>
}
