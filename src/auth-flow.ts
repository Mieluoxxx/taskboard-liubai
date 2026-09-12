export interface AuthIdentity {
  id: string
  email?: string
}

export type AuthScreen = 'setup' | 'auth' | 'loading' | 'workspace'

export interface AuthTransition {
  user: AuthIdentity | null
  changed: boolean
  generation: number
  shouldClear: 'auth' | 'loading' | null
  shouldLoad: boolean
}

export class AuthLifecycle {
  private authGeneration = 0
  private loginAttempt = 0

  generation(): number {
    return this.authGeneration
  }

  isCurrent(generation: number): boolean {
    return generation === this.authGeneration
  }

  beginLogin(): number {
    return ++this.loginAttempt
  }

  isLoginCurrent(attempt: number): boolean {
    return attempt === this.loginAttempt
  }

  invalidate(): number {
    this.loginAttempt += 1
    return ++this.authGeneration
  }

  receiveAuthEvent(current: AuthIdentity | null, next: AuthIdentity | null, screen: AuthScreen, hasBoard: boolean): AuthTransition {
    if (current?.id !== next?.id) this.loginAttempt += 1
    return this.accept(current, next, screen, hasBoard, false)
  }

  accept(current: AuthIdentity | null, next: AuthIdentity | null, screen: AuthScreen, hasBoard: boolean, forceLoad: boolean): AuthTransition {
    const changed = current?.id !== next?.id
    if (changed) this.authGeneration += 1
    return {
      user: next,
      changed,
      generation: this.authGeneration,
      shouldClear: next ? (changed ? 'loading' : null) : 'auth',
      shouldLoad: Boolean(next && (changed || forceLoad || screen !== 'workspace' || !hasBoard)),
    }
  }

  completeLogin(attempt: number, current: AuthIdentity | null, next: AuthIdentity, screen: AuthScreen, hasBoard: boolean): AuthTransition | null {
    if (!this.isLoginCurrent(attempt)) return null
    return this.accept(current, next, screen, hasBoard, true)
  }
}
