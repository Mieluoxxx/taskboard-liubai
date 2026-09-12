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
  private activeCommand: 'login' | 'logout' | null = null
  private activeLogin: { attempt: number; userId: string | null; email: string } | null = null

  generation(): number {
    return this.authGeneration
  }

  isCurrent(generation: number): boolean {
    return generation === this.authGeneration
  }

  beginLogin(currentUserId: string | null, email: string): number | null {
    if (this.activeCommand) return null
    const attempt = ++this.loginAttempt
    this.activeCommand = 'login'
    this.activeLogin = { attempt, userId: currentUserId, email: email.trim().toLowerCase() }
    return attempt
  }

  isLoginCurrent(attempt: number): boolean {
    return this.activeLogin?.attempt === attempt
  }

  finishLogin(attempt: number): boolean {
    if (!this.isLoginCurrent(attempt) || this.activeCommand !== 'login') return false
    this.activeLogin = null
    this.activeCommand = null
    return true
  }

  beginLogout(): number | null {
    if (this.activeCommand) return null
    this.loginAttempt += 1
    this.activeCommand = 'logout'
    return ++this.authGeneration
  }

  finishLogout(generation: number): boolean {
    if (this.activeCommand !== 'logout') return false
    this.activeCommand = null
    return this.isCurrent(generation)
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
    const belongsToLogin = Boolean(
      changed && activeLogin &&
      ((activeLogin.userId === null && current === null && next?.email?.toLowerCase() === activeLogin.email) || activeLogin.userId === next?.id),
    )
    if (this.activeCommand === 'logout' && !next) this.activeCommand = null
    else if (belongsToLogin && next) this.activeLogin!.userId = next.id
    else if (changed) {
      this.loginAttempt += 1
      this.activeCommand = null
      this.activeLogin = null
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
    this.activeLogin = null
    this.activeCommand = null
    return this.accept(current, next, screen, hasBoard, false)
  }
}
