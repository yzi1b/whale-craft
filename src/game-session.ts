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

  close (reason: string, options: GameSessionCloseOptions = {}, now = Date.now()): boolean {
    if (!this.active) return false
    this.endedAt = now
    this.endReason = reason
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
