// -*- coding: utf-8 -*-
import type { BlockPosition, JsonObject } from './types.ts'

export interface FallSample {
  position: BlockPosition
  velocityY: number
  onGround: boolean
  safeDescent: boolean
  at: number
}

export interface FallObservation {
  kind: 'start' | 'end'
  content: JsonObject
}

interface ActiveFall {
  from: BlockPosition
  startedAt: number
  announced: boolean
  lastPosition: BlockPosition
  lastVelocityY: number
}

const clonePosition = (position: BlockPosition): BlockPosition => ({ x: position.x, y: position.y, z: position.z })
const jsonPosition = (position: BlockPosition): JsonObject => ({ x: position.x, y: position.y, z: position.z })
const rounded = (value: number, digits = 1): number => Number(value.toFixed(digits))

export class FallTracker {
  private previous: { position: BlockPosition, at: number } | null = null
  private active: ActiveFall | null = null

  reset (position: BlockPosition | null = null, at = Date.now()): void {
    this.active = null
    this.previous = position ? { position: clonePosition(position), at } : null
  }

  sample (sample: FallSample, minHeight: number): FallObservation[] {
    const position = clonePosition(sample.position)
    const threshold = Math.max(0, Number.isFinite(minHeight) ? minHeight : 0)
    const falling = !sample.onGround && !sample.safeDescent && sample.velocityY < -0.01
    const observations: FallObservation[] = []

    if (!falling) {
      if (this.active?.announced) {
        observations.push({
          kind: 'end',
          content: {
            from: jsonPosition(this.active.from),
            to: jsonPosition(position),
            height: rounded(Math.max(0, this.active.from.y - position.y)),
            durationMs: Math.max(0, sample.at - this.active.startedAt),
            impactVelocityY: rounded(this.active.lastVelocityY, 3),
          },
        })
      }
      this.active = null
      this.previous = { position, at: sample.at }
      return observations
    }

    if (!this.active) {
      const previous = this.previous
      const from = previous && previous.position.y >= position.y ? previous.position : position
      this.active = {
        from: clonePosition(from),
        startedAt: previous?.at ?? sample.at,
        announced: false,
        lastPosition: position,
        lastVelocityY: sample.velocityY,
      }
    }

    const fall = this.active
    const height = Math.max(0, fall.from.y - position.y)
    if (!fall.announced && height >= threshold) {
      fall.announced = true
      observations.push({
        kind: 'start',
        content: {
          from: jsonPosition(fall.from),
          position: jsonPosition(position),
          height: rounded(height),
          elapsedMs: Math.max(0, sample.at - fall.startedAt),
          velocityY: rounded(sample.velocityY, 3),
        },
      })
    }
    fall.lastPosition = position
    fall.lastVelocityY = sample.velocityY
    this.previous = { position, at: sample.at }
    return observations
  }
}
