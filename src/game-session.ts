// -*- coding: utf-8 -*-
import { randomBytes } from 'node:crypto'
import type { GameSessionId } from './types.ts'

export const GAME_SESSION_ID_PATTERN = /^[0-9a-f]{16}$/

export function createGameSessionId (): GameSessionId {
  return randomBytes(8).toString('hex')
}

export class GameSessionState {
  readonly id: GameSessionId
  readonly startedAt: number
  endedAt: number | null = null
  endReason: string | null = null

  constructor (now = Date.now()) {
    this.id = createGameSessionId()
    this.startedAt = now
  }

  get active (): boolean { return this.endedAt === null }

  end (reason: string, now = Date.now()): void {
    if (!this.active) return
    this.endedAt = now
    this.endReason = reason
  }
}
