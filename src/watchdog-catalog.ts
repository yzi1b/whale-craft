// -*- coding: utf-8 -*-
import type { JsonObject } from './types.ts'

export interface WatchdogItemConfig extends JsonObject {
  record: boolean
  wake: boolean
  delay: number
}

export const WATCHDOG_GLOBAL_DEFAULTS = Object.freeze({
  minInterval: 10_000,
  interruptLevel: 'llm' as const,
  minInterruptInterval: 30_000,
})

export const WATCHDOG_EVENT_DEFAULTS = {
  'harness.heartbeat': { interval: 600_000, record: true, wake: true, delay: 0, modifiers: {} },
  'message.chat': { includeSelf: true, treatSystemAsChat: true, record: true, wake: false, delay: 10_000, modifiers: {
    mention: { keywords: ['deepseek', 'ds', 'harness', 'whale', 'ai', 'agent'], players: [], record: true, wake: true, delay: -1 },
    nearby: { distance: 32, players: [], record: true, wake: true, delay: -1 },
    solo: { count: 2, players: [], record: true, wake: true, delay: -1 },
    player: { players: [], record: true, wake: true, delay: -1 },
  } },
  'message.system': { record: true, wake: false, delay: 10_000, modifiers: {
    playerConnection: { record: true, wake: false, delay: 10_000 },
    'playerConnection.player': { players: [], record: true, wake: false, delay: 10_000 },
    playerDeath: { record: true, wake: false, delay: 10_000 },
    'playerDeath.player': { players: [], record: true, wake: false, delay: 10_000 },
  } },
  'connection.spawn': { record: true, wake: false, delay: 0, modifiers: {} },
  'connection.disconnect': { record: true, wake: true, delay: 0, modifiers: {} },
  'self.death': { record: true, wake: true, delay: 0, modifiers: {} },
  'self.damage': { record: true, wake: false, delay: 0, modifiers: {
    type: { types: [], record: true, wake: true, delay: -1 },
    'type.once': { types: ['*'], resetAfterMs: 4_000, record: true, wake: true, delay: -1 },
  } },
  'self.teleport': { record: true, wake: true, delay: 0, modifiers: {} },
  'self.pushed': { minDistance: 0.2, record: false, wake: false, delay: 0, modifiers: {
    once: { resetAfterMs: 4_000, record: true, wake: true, delay: -1 },
  } },
  'self.fall.start': { minHeight: 3, record: true, wake: true, delay: 0, modifiers: {} },
  'self.fall.end': { record: true, wake: true, delay: 0, modifiers: {} },
  'self.pickup': { record: true, wake: false, delay: 0, modifiers: {} },
} as const

export type WatchdogEventName = keyof typeof WATCHDOG_EVENT_DEFAULTS
export type WatchdogConfig = Record<string, Record<string, unknown>>

export interface WatchdogModifierTraits {
  simplifiable: boolean
}

const WATCHDOG_MODIFIER_TRAITS: Readonly<Record<string, WatchdogModifierTraits>> = Object.freeze({
  'self.damage/type.once': Object.freeze({ simplifiable: false }),
  'self.pushed/once': Object.freeze({ simplifiable: false }),
})

export function watchdogModifierTraits (event: string, modifier: string): WatchdogModifierTraits {
  return WATCHDOG_MODIFIER_TRAITS[`${event}/${modifier}`] ?? { simplifiable: true }
}

export const cloneWatchdogDefaults = (): WatchdogConfig => JSON.parse(JSON.stringify(WATCHDOG_EVENT_DEFAULTS)) as WatchdogConfig

export function splitWatchdogItem (item: string): { event: WatchdogEventName, modifier: string | null } {
  if (Object.hasOwn(WATCHDOG_EVENT_DEFAULTS, item)) return { event: item as WatchdogEventName, modifier: null }
  const slash = item.indexOf('/')
  if (slash > 0) {
    const event = item.slice(0, slash) as WatchdogEventName
    const modifier = item.slice(slash + 1)
    const fact = WATCHDOG_EVENT_DEFAULTS[event]
    if (fact && Object.hasOwn(fact.modifiers, modifier)) return { event, modifier }
  }
  throw new Error(`该事件或修饰不存在：${item}`)
}

export function validateWatchdogPatch (item: string, patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error(`${item} 的配置必须是对象`)
  if (Object.hasOwn(patch, 'modifiers')) throw new Error(`${item} 配置不能直接包含 modifiers`)
  const { event, modifier } = splitWatchdogItem(item)
  const fact = WATCHDOG_EVENT_DEFAULTS[event] as unknown as { modifiers: Record<string, Record<string, unknown>> } & Record<string, unknown>
  const defaults = modifier ? fact.modifiers[modifier] : fact
  if (!defaults) throw new Error(`该事件或修饰不存在：${item}`)
  const out: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(patch)) {
    if (field === 'modifiers' || !Object.hasOwn(defaults, field)) throw new Error(`${item}.${field} 字段不存在`)
    if (['record', 'wake', 'includeSelf', 'treatSystemAsChat'].includes(field) && typeof value !== 'boolean') throw new Error(`${item}.${field} 不接受值 ${JSON.stringify(value)}`)
    if (['delay', 'interval', 'distance', 'minDistance', 'minHeight', 'count', 'resetAfterMs'].includes(field) && !Number.isFinite(value)) throw new Error(`${item}.${field} 不接受值 ${JSON.stringify(value)}`)
    if (field === 'delay' && Number(value) < (modifier ? -1 : 0)) throw new Error(`${item}.delay 不接受值 ${value}`)
    if (field === 'minDistance' && Number(value) < 0) throw new Error(`${item}.minDistance 不接受值 ${value}`)
    if (field === 'minHeight' && Number(value) < 0) throw new Error(`${item}.minHeight 不接受值 ${value}`)
    if (field === 'resetAfterMs' && Number(value) < 1_000) throw new Error(`${item}.resetAfterMs 不接受值 ${value}`)
    if (['keywords', 'players', 'types'].includes(field) && (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))) throw new Error(`${item}.${field} 不接受值 ${JSON.stringify(value)}`)
    out[field] = value
  }
  return out
}

export function eventCatalogMarkdown (query?: string | string[]): string {
  const names = query === undefined ? [] : Array.isArray(query) ? query : [query]
  if (!names.length) return Object.entries(WATCHDOG_EVENT_DEFAULTS).map(([name, value]) => `- ${name}（${Object.keys(value.modifiers).length}修饰）`).join('\n')
  return names.flatMap((raw) => {
    if (!raw.endsWith('/*')) return [raw]
    const event = raw.slice(0, -2)
    const parsed = splitWatchdogItem(event)
    return [event, ...Object.keys(WATCHDOG_EVENT_DEFAULTS[parsed.event].modifiers).map((modifier) => `${event}/${modifier}`)]
  }).map((item) => {
    const { event, modifier } = splitWatchdogItem(item)
    const fact = WATCHDOG_EVENT_DEFAULTS[event] as unknown as { modifiers: Record<string, unknown> } & Record<string, unknown>
    const config = modifier ? fact.modifiers[modifier] : fact
    const traits = modifier ? watchdogModifierTraits(event, modifier) : null
    const simplifiability = traits?.simplifiable === false ? '\n\n**不可精简**' : ''
    const modifiers = modifier ? '' : `\n\n**事件修饰：**\n${Object.keys(fact.modifiers).map((name) => `- ${name}`).join('\n')}`
    return `## \`${item}\` ${modifier ? '事件修饰' : '事件事实'}${simplifiability}\n\n**配置：**\n\n\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\`${modifiers}`
  }).join('\n\n')
}
