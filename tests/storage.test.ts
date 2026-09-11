import assert from 'node:assert/strict'
import test from 'node:test'
import { createDemoBoardAdapter } from '../src/storage'
import { cloneSnapshot } from '../src/domain'

class MemoryStorage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

test('demo adapter uses compare-and-swap and rejects stale whole-board writes', async () => {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  storage.clear()
  const first = createDemoBoardAdapter()
  const second = createDemoBoardAdapter()
  const loadedA = await first.load()
  const loadedB = await second.load()
  assert.equal(loadedA.ok, true)
  assert.equal(loadedB.ok, true)
  if (!loadedA.ok || !loadedB.ok) return
  const boardA = cloneSnapshot(loadedA.value.snapshot)
  boardA.settings.timeZone = 'UTC'
  const saved = await second.save(loadedB.value.revision, boardA)
  assert.equal(saved.ok, true)
  const stale = await first.save(loadedA.value.revision, loadedA.value.snapshot)
  assert.equal(stale.ok, false)
  if (stale.ok) return
  assert.equal(stale.kind, 'conflict')
})

test('demo saves serialize through the shared Web Lock, which is what prevents cross-tab overwrites', async () => {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  storage.clear()
  // The write path is synchronous, so two saves can never interleave inside one JS task.
  // What actually protects a second tab is the shared lock, so assert that contract directly
  // instead of pretending a Promise.all race exercises serialization.
  const requested: string[] = []
  const tails = new Map<string, Promise<unknown>>()
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      onLine: true,
      locks: {
        // The critical section is synchronous, so an overlap counter here could never exceed 1 and
        // would be vacuous. What is worth asserting is that every demo save takes the shared lock,
        // and that two saves from one revision cannot both win.
        request: (name: string, callback: () => unknown) => {
          requested.push(name)
          const previous = tails.get(name) ?? Promise.resolve()
          const run = previous.then(callback, callback)
          tails.set(name, run.catch(() => undefined))
          return run
        },
      },
    },
    configurable: true,
  })
  try {
    const adapter = createDemoBoardAdapter()
    const loaded = await adapter.load()
    assert.equal(loaded.ok, true)
    if (!loaded.ok) return
    // Two saves from the same revision: the lock must serialize them, so exactly one wins the CAS.
    const results = await Promise.all([
      adapter.save(loaded.value.revision, loaded.value.snapshot),
      adapter.save(loaded.value.revision, loaded.value.snapshot),
    ])
    assert.ok(requested.length >= 2 && requested.every((name) => name === 'liubai-taskboard:demo-board'), `every demo save must take the shared lock: ${requested.join(',')}`)
    assert.equal(results.filter((result) => result.ok).length, 1, 'exactly one concurrent save may win')
    const saved = await adapter.save(loaded.value.revision + 1, loaded.value.snapshot)
    assert.equal(saved.ok, true)
    if (!saved.ok) return
    const stored = JSON.parse(storage.getItem('liubai-taskboard:demo-board:v1') as string)
    assert.equal(stored.revision, saved.value.revision, 'the stored revision must match the last successful save')
  } finally {
    Reflect.deleteProperty(globalThis, 'navigator')
  }
})

test('without Web Locks the demo adapter still saves, falling back to a plain read-check-write', async () => {
  const storage = new MemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  storage.clear()
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
  try {
    const adapter = createDemoBoardAdapter()
    const loaded = await adapter.load()
    assert.equal(loaded.ok, true)
    if (!loaded.ok) return
    const saved = await adapter.save(loaded.value.revision, loaded.value.snapshot)
    assert.equal(saved.ok, true)
    // the CAS check still runs even on the fallback path
    const stale = await adapter.save(loaded.value.revision, loaded.value.snapshot)
    assert.equal(stale.ok, false)
  } finally {
    Reflect.deleteProperty(globalThis, 'navigator')
  }
})
