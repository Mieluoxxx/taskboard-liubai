import assert from 'node:assert/strict'
import test from 'node:test'
import { copy, text } from '../src/i18n'
import { BoardError, isNoticeCode, noticeCopy, type NoticeCode } from '../src/notices'
import { createDemoBoardAdapter } from '../src/storage'
import { addFocusBlock, createFocusBlock, emptySnapshot, setFocusCommand, validateDurationMinutes } from '../src/domain'

const LOCALES = ['zh', 'en'] as const

test('every notice code is translated in both languages and never leaks the other language', () => {
  const codes = Object.keys(noticeCopy.zh) as NoticeCode[]
  assert.ok(codes.length > 0)
  for (const locale of LOCALES) {
    for (const code of codes) {
      assert.ok(isNoticeCode(code))
      assert.ok(Object.hasOwn(copy[locale], code), `missing ${locale} copy for ${code}`)
      const value = text(locale, code)
      assert.equal(typeof value, 'string')
      assert.ok(value.trim().length > 0, `empty ${locale} copy for ${code}`)
      if (locale === 'en') assert.ok(!/[\u4e00-\u9fff]/.test(value), `English notice still contains Chinese: ${code}`)
      else assert.ok(!/[A-Za-z]{4,}/.test(value), `Chinese notice still contains English prose: ${code}`)
    }
  }
})

test('zh and en dictionaries expose exactly the same keys', () => {
  const zh = Object.keys(copy.zh).sort()
  const en = Object.keys(copy.en).sort()
  assert.deepEqual(zh, en)
})

test('user-facing domain failures carry a notice code instead of a fixed-language sentence', () => {
  let snapshot = emptySnapshot('UTC')
  snapshot = addFocusBlock(snapshot, createFocusBlock({ dateKey: '2025-01-15', title: 'first', durationMinutes: 45 }))
  snapshot = setFocusCommand(snapshot, snapshot.focusBlocks[0].id, 'start', '2025-01-15T12:00:00.000Z')
  snapshot = addFocusBlock(snapshot, createFocusBlock({ dateKey: '2025-01-15', title: 'second', durationMinutes: 45 }))

  assert.throws(
    () => setFocusCommand(snapshot, snapshot.focusBlocks[1].id, 'start', '2025-01-15T12:05:00.000Z'),
    (error: unknown) => error instanceof BoardError && error.code === 'noticeTimerBusy',
  )
  assert.throws(
    () => validateDurationMinutes(0),
    (error: unknown) => error instanceof BoardError && error.code === 'noticeTimerDuration',
  )
})

test('adapter failures expose a notice code so the UI can render the active language', async () => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      get length() { return values.size },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, String(value)),
    },
    configurable: true,
  })
  values.clear()
  const first = createDemoBoardAdapter()
  const second = createDemoBoardAdapter()
  const loadedA = await first.load()
  const loadedB = await second.load()
  assert.equal(loadedA.ok && loadedB.ok, true)
  if (!loadedA.ok || !loadedB.ok) return
  const saved = await second.save(loadedB.value.revision, loadedB.value.snapshot)
  assert.equal(saved.ok, true)
  const stale = await first.save(loadedA.value.revision, loadedA.value.snapshot)
  assert.equal(stale.ok, false)
  if (stale.ok) return
  assert.equal(stale.kind, 'conflict')
  assert.equal(stale.code, 'noticeConflictDemo')
  assert.equal(isNoticeCode(stale.code), true)
  assert.ok(!/[\u4e00-\u9fff]/.test(stale.message), 'diagnostic message should stay language-neutral')
})

test('the cloud adapter refuses to commit while offline and reports the offline notice code', async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true })
  try {
    const { createSupabaseBoardAdapter, getSupabaseConfig } = await import('../src/storage')
    const adapter = createSupabaseBoardAdapter({ url: 'https://example.supabase.co', key: 'anon-key-stand-in' })
    const result = await adapter.save(0, emptySnapshot('UTC'))
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.kind, 'offline')
    assert.equal(result.code, 'noticeOffline')
    // A missing/unsafe client config must never be treated as a working cloud connection.
    assert.equal(getSupabaseConfig(), null)
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  }
})

test('user-visible strings come from the dictionary, not from inline language branches', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  // Locale identifiers and class toggles are legitimate; inline sentences are not.
  const allowed = /^(?:[a-z]{2}(?:-[A-Z]{2})?|active|)$/
  const branches = [...source.matchAll(/language === 'zh' \? '([^']*)' : '([^']*)'/g)]
  assert.ok(branches.length > 0, 'expected some locale branches to exist')
  for (const [, zh, en] of branches) {
    assert.ok(allowed.test(zh), `inline Chinese UI string leaked into App.tsx: ${zh}`)
    assert.ok(allowed.test(en), `inline English UI string leaked into App.tsx: ${en}`)
  }
  assert.ok(!/[\u4e00-\u9fff]/.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')), 'App.tsx contains hardcoded Chinese text outside comments')

  // A bare `new Error('sentence')` surfaces verbatim through noticeLabel, so it can never be localized.
  // User-facing failures must be BoardError with a notice code; Error is only for internal invariants.
  const bareErrors = [...source.matchAll(/new Error\('([^']+)'/g)].map(([, message]) => message)
  assert.deepEqual(bareErrors, [], `App.tsx throws untranslatable user-facing errors: ${bareErrors.join(' | ')}`)
  const flashLiterals = [...source.matchAll(/setFlash\('([^']+)'/g)].map(([, message]) => message)
  assert.deepEqual(flashLiterals, [], `App.tsx flashes untranslatable text: ${flashLiterals.join(' | ')}`)
})

test('every adapter failure carries a registered notice code, so no raw message can be rendered', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/storage.ts', import.meta.url), 'utf8')
  // Each `ok: false` return must set `code:` to a registered NoticeCode; `noticeText` falls back to
  // `message` when a code is missing, which would print an English sentence to a Chinese user.
  const failures = [...source.matchAll(/ok:\s*false[^}]*}/g)].map(([block]) => block)
  assert.ok(failures.length >= 8, `expected the adapter to have several failure returns, saw ${failures.length}`)
  for (const block of failures) {
    const code = /code:\s*'([^']+)'/.exec(block)?.[1]
    assert.ok(code, `adapter failure without a notice code: ${block.trim()}`)
    assert.ok(isNoticeCode(code), `adapter failure uses an unregistered notice code: ${code}`)
  }
})

test('no source file throws a bare sentence that reaches the UI', async () => {
  const { readFile } = await import('node:fs/promises')
  // App.tsx renders `errorNotice`/`noticeText` results, and domain/storage feed them. Any bare
  // `new Error('sentence')` there is a localization hole; date helpers are internal invariants.
  for (const file of ['../src/App.tsx', '../src/storage.ts']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8')
    // Match any quote style so `new Error("...")` and template literals cannot slip through.
    const bare = [...source.matchAll(/new Error\(\s*['"`]([^'"`]+)/g)].map(([, message]) => message)
    assert.deepEqual(bare, [], `${file} throws untranslatable user-facing errors: ${bare.join(' | ')}`)
  }
  const domain = await readFile(new URL('../src/domain.ts', import.meta.url), 'utf8')
  const domainBare = [...domain.matchAll(/new Error\(\s*['"`]([^'"`]+)/g)].map(([, message]) => message)
  // domain.ts may only keep arithmetic invariants (date/week math), never validation messages.
  for (const message of domainBare) {
    assert.ok(/date|week|calendar/i.test(message), `domain.ts has a user-facing sentence without a notice code: ${message}`)
  }
})
