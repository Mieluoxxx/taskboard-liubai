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
  private activeCommand: { kind: 'login'; attempt: number } | { kind: 'logout'; generation: number } | null = null
  private activeLogin: { attempt: number; invalidated: boolean } | null = null

  generation(): number {
    return this.authGeneration
  }

  isCurrent(generation: number): boolean {
    return generation === this.authGeneration
  }

  beginLogin(): number | null {
    if (this.activeCommand) return null
    const attempt = ++this.loginAttempt
    this.activeCommand = { kind: 'login', attempt }
    this.activeLogin = { attempt, invalidated: false }
    return attempt
  }

  isLoginCurrent(attempt: number): boolean {
    return this.activeCommand?.kind === 'login' && this.activeCommand.attempt === attempt && this.activeLogin?.attempt === attempt && !this.activeLogin.invalidated
  }

  finishLogin(attempt: number): boolean {
    if (this.activeCommand?.kind !== 'login' || this.activeCommand.attempt !== attempt) return false
    this.activeLogin = null
    this.activeCommand = null
    return true
  }

  beginLogout(): number | null {
    if (this.activeCommand) return null
    this.loginAttempt += 1
    const generation = ++this.authGeneration
    this.activeCommand = { kind: 'logout', generation }
    return generation
  }

  finishLogout(generation: number): boolean {
    if (this.activeCommand?.kind !== 'logout' || this.activeCommand.generation !== generation) return false
    this.activeCommand = null
    return true
  }

  invalidate(): number {
    this.loginAttempt += 1
    this.activeCommand = null
    this.activeLogin = null
    return ++this.authGeneration
  }

  receiveAuthEvent(current: AuthIdentity | null, next: AuthIdentity | null, screen: AuthScreen, hasBoard: boolean): AuthTransition {
    const changed = current?.id !== next?.id
    const activeLogin = this.activeLogin
    if (changed && this.activeCommand?.kind === 'login' && activeLogin) {
      if (!next) activeLogin.invalidated = true
    }
    else if (changed) {
      this.loginAttempt += 1
    }
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
    if (current && current.id !== next.id) return null
    return this.accept(current, next, screen, hasBoard, false)
  }
}
