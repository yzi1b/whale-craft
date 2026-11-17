// -*- coding: utf-8 -*-
import { randomBytes } from 'node:crypto'
import type { GameSessionId } from './types.ts'
import { buildGameSessionCloseNotice } from './game-session-close.ts'
import type { GameSessionCloseKind, GameSessionCloseNotice } from './game-session-close.ts'

export interface GameSessionWatchdog {
  armed: boolean
  disarm: (reason?: string, options?: { fromJob?: boolean }) => unknown
  status: () => Record<string, unknown>
  wait: (ms: number, signal?: AbortSignal | null) => Promise<{ waitedMs: number, interrupted: boolean, reason: string | null }>
}

export interface GameSessionWatchdogEngine {
  observe: (name: string, content: unknown, context?: Record<string, unknown>) => unknown
  setConfig: (config: Record<string, Record<string, unknown>>) => void
  read: (count: number, consume: boolean) => unknown
}

export interface GameSessionResources {
  watchdog: GameSessionWatchdog
  watchdogEngine: GameSessionWatchdogEngine
  watchdogScene?: Record<string, Record<string, unknown>>
  watchdogFocuses?: Map<string, { sensitive: boolean, config: Record<string, Record<string, unknown>> }>
  server?: string | null
  onCloseNotice?: (notice: GameSessionCloseNotice) => void
}

export interface GameSessionCloseOptions {
  kind?: GameSessionCloseKind
  fromWatchdogJob?: boolean
  notify?: boolean
  attempts?: number | null
  lastReconnectError?: string | null
}

interface FocusExpiry {
  expiresAt: number
  timer: NodeJS.Timeout | null
  onExpire: (name: string) => void
}

const MAX_TIMER_MS = 2_147_483_647

export const GAME_SESSION_ID_PATTERN = /^[0-9a-f]{16}$/

export function createGameSessionId (): GameSessionId {
  return randomBytes(8).toString('hex')
}

export class GameSessionState {
  readonly id: GameSessionId
  readonly startedAt: number
  readonly watchdog: GameSessionWatchdog
  readonly watchdogEngine: GameSessionWatchdogEngine
  readonly watchdogScene: Record<string, Record<string, unknown>>
  readonly watchdogFocuses: Map<string, { sensitive: boolean, config: Record<string, Record<string, unknown>> }>
  readonly server: string | null
  readonly onCloseNotice: ((notice: GameSessionCloseNotice) => void) | null
  endedAt: number | null = null
  endReason: string | null = null
  private readonly focusExpiries = new Map<string, FocusExpiry>()

  constructor (resources: GameSessionResources, now = Date.now()) {
    this.id = createGameSessionId()
    this.startedAt = now
    this.watchdog = resources.watchdog
    this.watchdogEngine = resources.watchdogEngine
    this.watchdogScene = resources.watchdogScene ?? {}
    this.watchdogFocuses = resources.watchdogFocuses ?? new Map()
    this.server = resources.server ?? null
    this.onCloseNotice = resources.onCloseNotice ?? null
  }

  get active (): boolean { return this.endedAt === null }

  setWatchdogFocusExpiry (name: string, dieTime: number, onExpire: (name: string) => void, now = Date.now()): void {
    this.clearWatchdogFocusExpiry(name)
    if (dieTime < 0) return
    const expiry: FocusExpiry = { expiresAt: now + dieTime, timer: null, onExpire }
    this.focusExpiries.set(name, expiry)
    this.armWatchdogFocusExpiry(name, expiry)
  }

  watchdogFocusDieTime (name: string, now = Date.now()): number {
    const expiry = this.focusExpiries.get(name)
    return expiry ? Math.max(0, expiry.expiresAt - now) : -1
  }

  removeWatchdogFocus (name: string): boolean {
    this.clearWatchdogFocusExpiry(name)
    return this.watchdogFocuses.delete(name)
  }

  private clearWatchdogFocusExpiry (name: string): void {
    const expiry = this.focusExpiries.get(name)
    if (expiry?.timer) clearTimeout(expiry.timer)
    this.focusExpiries.delete(name)
  }

  private armWatchdogFocusExpiry (name: string, expiry: FocusExpiry): void {
    const remaining = expiry.expiresAt - Date.now()
    if (remaining <= 0) {
      this.focusExpiries.delete(name)
      if (this.watchdogFocuses.delete(name)) {
        try { expiry.onExpire(name) } catch {}
      }
      return
    }
    expiry.timer = setTimeout(() => {
      if (this.focusExpiries.get(name) === expiry) this.armWatchdogFocusExpiry(name, expiry)
    }, Math.min(remaining, MAX_TIMER_MS))
    expiry.timer.unref()
  }

  close (reason: string, options: GameSessionCloseOptions = {}, now = Date.now()): boolean {
    if (!this.active) return false
    this.endedAt = now
    this.endReason = reason
    for (const name of this.focusExpiries.keys()) this.clearWatchdogFocusExpiry(name)
    this.watchdog.disarm(reason, { fromJob: options.fromWatchdogJob === true })
    if (options.notify !== false && this.onCloseNotice !== null) {
      try {
        this.onCloseNotice(buildGameSessionCloseNotice({
          gameSessionId: this.id,
          kind: options.kind ?? 'connection-lost',
          reason,
          server: this.server,
          startedAt: this.startedAt,
          endedAt: now,
          ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
          ...(options.lastReconnectError !== undefined ? { lastReconnectError: options.lastReconnectError } : {}),
        }))
      } catch {}
    }
    return true
  }
}
