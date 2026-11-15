// -*- coding: utf-8 -*-
import type { JsonObject, WatchdogEvent } from './types.ts'
import { cloneWatchdogDefaults, type WatchdogConfig, type WatchdogEventName } from './watchdog-catalog.ts'

type ModifierPayload = JsonObject | true
type WakeHandler = (event: WatchdogEvent, pendingCount: number) => void
type SuppressedHandler = (count: number) => void

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const text = (value: unknown): string => String(value ?? '')
const lower = (value: unknown): string => text(value).toLowerCase()
const selectedPlayer = (players: unknown, player: string): boolean => !Array.isArray(players) || players.length === 0 || players.some((value) => lower(value) === lower(player))

function parsePlayerConnection (value: unknown): { player: string, kind: 'join' | 'leave' } | null {
  const body = text(value).trim()
  for (const [pattern, kind] of [
    [/^(.+?) (?:joined the game|加入了游戏)$/, 'join'],
    [/^(.+?) (?:left the game|离开了游戏)$/, 'leave'],
  ] as const) {
    const match = body.match(pattern)
    if (match?.[1]) return { player: match[1], kind }
  }
  return null
}

function parsePlayerDeath (value: unknown): { player: string, message: string } | null {
  const body = text(value).trim()
  const match = body.match(/^([^ ]+) (?:died|was |fell |hit |tried |blew |burned |went |walked |starved |suffocated |drowned |experienced |discovered |froze |withered )/i)
    ?? body.match(/^(.+?)(?:死了|死亡|被.+杀死|摔死|淹死|烧死|饿死|窒息)/)
  return match?.[1] ? { player: match[1], message: body } : null
}

export class WatchdogEngine {
  config: WatchdogConfig
  readonly queue: WatchdogEvent[] = []
  private readonly onWake: WakeHandler | undefined
  private readonly now: () => number
  private readonly maxQueue: number
  private readonly onSuppressed: SuppressedHandler | undefined
  private readonly pending: Array<{ due: number, event: WatchdogEvent }> = []
  private readonly damageRounds = new Map<string, { lastAt: number, count: number, damageSum: number }>()
  private heartbeatAt: number

  constructor (
    config: WatchdogConfig = cloneWatchdogDefaults(),
    onWake?: WakeHandler,
    now: () => number = Date.now,
    maxQueue = 200,
    onSuppressed?: SuppressedHandler,
  ) {
    this.config = clone(config)
    this.onWake = onWake
    this.now = now
    this.maxQueue = maxQueue
    this.onSuppressed = onSuppressed
    this.heartbeatAt = now()
  }

  setConfig (config: WatchdogConfig): void { this.config = clone(config) }

  observe (name: WatchdogEventName, content: JsonObject, context: Record<string, unknown> = {}): WatchdogEvent {
    const config = this.config[name]
    if (!config) throw new Error(`该事件或修饰不存在：${name}`)
    const timestamp = this.now()
    const selfChat = name === 'message.chat' && context.isSelf === true
    const modifiers = selfChat ? {} : this.modifiers(name, content, context, timestamp)
    let record = config.record === true
    let wake = config.wake === true
    if (selfChat && config.includeSelf !== true) {
      record = false
      wake = false
    }
    let delay = Number(config.delay ?? 0)
    const configuredModifiers = config.modifiers as Record<string, Record<string, unknown>>
    for (const modifier of Object.keys(modifiers)) {
      const modifierConfig = configuredModifiers[modifier]
      if (!modifierConfig) continue
      record ||= modifierConfig.record === true
      wake ||= modifierConfig.wake === true
      const modifierDelay = Number(modifierConfig.delay)
      if (modifierDelay >= 0) delay = Math.min(delay, modifierDelay)
    }
    if (wake) record = true
    const event: WatchdogEvent = { timestamp, name, content: clone(content), modifiers }
    if (record) {
      this.queue.push(event)
      if (this.queue.length > this.maxQueue) this.queue.splice(0, this.queue.length - this.maxQueue)
    }
    if (wake) this.pending.push({ due: timestamp + delay, event })
    this.flush(timestamp)
    return event
  }

  tick (online: boolean): void {
    const heartbeat = this.config['harness.heartbeat']
    const interval = Number(heartbeat?.interval ?? 0)
    const now = this.now()
    if (online && interval > 0 && now - this.heartbeatAt >= interval) {
      this.heartbeatAt = now
      this.observe('harness.heartbeat', { interval })
    }
    this.flush(now)
  }

  flush (now = this.now()): void {
    const due = this.pending.find((entry) => entry.due <= now)
    if (!due) return
    const count = this.pending.length
    this.pending.splice(0)
    this.onWake?.(due.event, count)
  }

  read (count = -1, consume = true): { queueCountBeforeConsume: number, selectedCount: number, consumedCount: number, queueCountAfterConsume: number, events: JsonObject[] } {
    if (!Number.isInteger(count)) throw new Error('count 必须是整数')
    const before = this.queue.length
    const size = count < 0 ? before : Math.min(count, before)
    const selected = this.queue.slice(0, size)
    if (consume) this.queue.splice(0, size)
    const seen = new Set<string>()
    const events = selected.map((event) => {
      const modifiers: Record<string, ModifierPayload> = {}
      for (const [name, payload] of Object.entries(event.modifiers)) {
        const key = `${event.name}/${name}/${JSON.stringify(payload)}`
        if (!seen.has(key)) { seen.add(key); modifiers[name] = payload }
      }
      return { time: new Date(event.timestamp).toLocaleString(), name: event.name, content: event.content, modifiers } as JsonObject
    })
    return { queueCountBeforeConsume: before, selectedCount: size, consumedCount: consume ? size : 0, queueCountAfterConsume: this.queue.length, events }
  }

  private modifiers (name: WatchdogEventName, content: JsonObject, context: Record<string, unknown>, timestamp: number): Record<string, ModifierPayload> {
    const out: Record<string, ModifierPayload> = {}
    const config = this.config[name]?.modifiers as Record<string, Record<string, unknown>>
    if (name === 'message.chat') {
      const playerObject = content.player as JsonObject | undefined
      const player = text(playerObject?.name)
      const body = lower(content.content)
      const mention = config.mention!
      const keyword = (mention.keywords as string[]).find((value) => body.includes(lower(value)))
      if (keyword && selectedPlayer(mention.players, player)) out.mention = { keyword }
      const distance = Number(context.distance)
      const nearby = config.nearby!
      if (Number.isFinite(distance) && Number(nearby.distance) >= 0 && Math.floor(distance) <= Number(nearby.distance) && selectedPlayer(nearby.players, player)) out.nearby = { distance: Math.floor(distance) }
      const onlineCount = Number(context.onlineCount)
      const solo = config.solo!
      if (Number(solo.count) > 0 && Number.isFinite(onlineCount) && onlineCount <= Number(solo.count) && selectedPlayer(solo.players, player)) out.solo = { count: onlineCount }
      const watched = config.player!
      if ((watched.players as string[]).length && selectedPlayer(watched.players, player)) out.player = true
    } else if (name === 'message.system') {
      const connection = parsePlayerConnection(content.content)
      const death = connection ? null : parsePlayerDeath(content.content)
      if (connection) {
        out.playerConnection = connection
        const watched = config['playerConnection.player']!
        if ((watched.players as string[]).length && selectedPlayer(watched.players, connection.player)) out['playerConnection.player'] = connection
      } else if (death) {
        out.playerDeath = death
        const watched = config['playerDeath.player']!
        if ((watched.players as string[]).length && selectedPlayer(watched.players, death.player)) out['playerDeath.player'] = death
      }
    } else if (name === 'self.damage' && typeof content.type === 'string') {
      const damageType = content.type
      const exact = config.type!
      const exactTypes = exact.types as string[]
      if (exactTypes.includes('*') || exactTypes.includes(damageType)) out.type = { type: damageType }
      else {
        const once = config['type.once']!
        const onceTypes = once.types as string[]
        if (onceTypes.includes('*') || onceTypes.includes(damageType)) {
          const previous = this.damageRounds.get(damageType)
          if (!previous || timestamp - previous.lastAt >= Number(once.resetAfterMs)) {
            out['type.once'] = { type: damageType, count: previous?.count ?? -1, damageSum: previous?.damageSum ?? -1 }
            this.damageRounds.set(damageType, { lastAt: timestamp, count: 0, damageSum: 0 })
          } else this.onSuppressed?.(1)
          const round = this.damageRounds.get(damageType)
          if (round) { round.lastAt = timestamp; round.count++; round.damageSum += Number(content.damage) || 0 }
        }
      }
    }
    return out
  }
}
