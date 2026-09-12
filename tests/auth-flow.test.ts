import assert from 'node:assert/strict'
import test from 'node:test'
import { AuthLifecycle } from '../src/auth-flow'

const A = { id: 'user-a', email: 'a@example.test' }
const B = { id: 'user-b', email: 'b@example.test' }

test('a successful login loads once and same-user auth events do not start another load', () => {
  const lifecycle = new AuthLifecycle()
  const attempt = lifecycle.beginLogin()
  assert.ok(attempt)
  const login = lifecycle.completeLogin(attempt, null, A, 'auth', false)
  assert.equal(login?.shouldClear, 'loading')
  assert.equal(login?.shouldLoad, true)
  assert.equal(lifecycle.finishLogin(attempt), true)

  const refreshed = lifecycle.receiveAuthEvent(A, A, 'workspace', true)
  assert.equal(refreshed.changed, false)
  assert.equal(refreshed.shouldLoad, false)
  assert.equal(refreshed.generation, login?.generation)
})

test('a SIGNED_IN event before the delayed login response keeps the command locked', async () => {
  const lifecycle = new AuthLifecycle()
  const attempt = lifecycle.beginLogin()
  assert.ok(attempt)
  let resolveLogin!: (identity: typeof A) => void
  const response = new Promise<typeof A>((resolve) => { resolveLogin = resolve })
  assert.equal(lifecycle.beginLogin(), null)

  const event = lifecycle.receiveAuthEvent(null, A, 'auth', false)
  assert.equal(event.changed, true)
  assert.equal(lifecycle.isLoginCurrent(attempt), true)
  assert.equal(lifecycle.beginLogout(), null)
  resolveLogin(A)
  const result = lifecycle.completeLogin(attempt, A, await response, 'workspace', true)
  assert.ok(result)
  assert.equal(result.changed, false)
  assert.equal(result.shouldLoad, false)
  assert.equal(lifecycle.isLoginCurrent(attempt), true)
  assert.equal(lifecycle.finishLogin(attempt), true)
})

test('a failed same-user load can be retried while stale account generations become invalid', () => {
  const lifecycle = new AuthLifecycle()
  const first = lifecycle.beginLogin()
  assert.ok(first)
  const firstLogin = lifecycle.completeLogin(first, null, A, 'auth', false)
  assert.ok(firstLogin)
  assert.equal(lifecycle.finishLogin(first), true)

  const retry = lifecycle.beginLogin()
  assert.ok(retry)
  const retryLogin = lifecycle.completeLogin(retry, A, A, 'auth', false)
  assert.equal(retryLogin?.shouldLoad, true)
  assert.ok(retryLogin)
  assert.equal(retryLogin.generation, firstLogin.generation)

  const switched = lifecycle.receiveAuthEvent(A, B, 'loading', false)
  assert.equal(switched.shouldClear, 'loading')
  assert.equal(lifecycle.isCurrent(retryLogin.generation), false)
  assert.equal(lifecycle.isCurrent(switched.generation), true)
})

test('logout invalidates pending login work and releases only its own command lock', () => {
  const lifecycle = new AuthLifecycle()
  const attempt = lifecycle.beginLogin()
  assert.ok(attempt)
  assert.equal(lifecycle.beginLogout(), null)
  const generation = lifecycle.invalidate()
  assert.equal(lifecycle.isLoginCurrent(attempt), false)
  assert.equal(lifecycle.isCurrent(generation), true)
  const logout = lifecycle.beginLogout()
  assert.ok(logout)
  lifecycle.receiveAuthEvent(A, null, 'workspace', true)
  assert.equal(lifecycle.beginLogin(), null)
  assert.equal(lifecycle.finishLogout(logout), true)
  const login = lifecycle.beginLogin()
  assert.ok(login)
  assert.equal(lifecycle.finishLogin(login), true)
})
