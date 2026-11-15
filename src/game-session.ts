// -*- coding: utf-8 -*-
import { randomBytes } from 'node:crypto'
import type { GameSessionId } from './types.ts'

export interface GameSessionWatchdog {
  armed: boolean
  disarm: (reason?: string, options?: { notify?: boolean, fromJob?: boolean }) => unknown
  status: () => Record<string, unknown>
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
  endedAt: number | null = null
  endReason: string | null = null

  constructor (resources: GameSessionResources, now = Date.now()) {
    this.id = createGameSessionId()
    this.startedAt = now
    this.watchdog = resources.watchdog
    this.watchdogEngine = resources.watchdogEngine
    this.watchdogScene = resources.watchdogScene ?? {}
    this.watchdogFocuses = resources.watchdogFocuses ?? new Map()
  }

  get active (): boolean { return this.endedAt === null }

  close (reason: string, options: { fromWatchdogJob?: boolean } = {}, now = Date.now()): boolean {
    if (!this.active) return false
    this.endedAt = now
    this.endReason = reason
    this.watchdog.disarm(reason, { notify: false, fromJob: options.fromWatchdogJob === true })
    return true
  }
}
