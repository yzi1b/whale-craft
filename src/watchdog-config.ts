// -*- coding: utf-8 -*-
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WATCHDOG_GLOBAL_DEFAULTS, cloneWatchdogDefaults, splitWatchdogItem, validateWatchdogPatch, type WatchdogConfig } from './watchdog-catalog.ts'

export interface FocusConfig {
  sensitive: boolean
  config: Record<string, Record<string, unknown>>
}

interface StoredWatchdogConfig {
  version: 1
  type: 'base'
  config: Record<string, Record<string, unknown>>
  global: { minInterval: number, interruptLevel: 'never' | 'llm' | 'toolCall', minInterruptInterval: number }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export function editWatchdogLayer (target: Record<string, Record<string, unknown>>, input: Record<string, unknown>, merge = true): { changed: string[], removed: string[] } {
  if (!merge) for (const key of Object.keys(target)) delete target[key]
  const changed: string[] = []
  const removed: string[] = []
  for (const [item, patch] of Object.entries(input)) {
    splitWatchdogItem(item)
    if (patch === null) {
      if (Object.hasOwn(target, item)) delete target[item]
      removed.push(item)
    } else {
      target[item] = validateWatchdogPatch(item, patch)
      changed.push(item)
    }
  }
  return { changed, removed }
}

function applyLayer (base: WatchdogConfig, layer: Record<string, Record<string, unknown>>): WatchdogConfig {
  const output = clone(base)
  for (const [item, patch] of Object.entries(layer)) {
    const { event, modifier } = splitWatchdogItem(item)
    const fact = output[event]!
    const target = modifier ? (fact.modifiers as Record<string, Record<string, unknown>>)[modifier]! : fact
    Object.assign(target, patch)
  }
  return output
}

const HIGHER_IS_SENSITIVE = new Set(['distance', 'count', 'resetAfterMs'])

function applyFocus (base: WatchdogConfig, focus: FocusConfig): WatchdogConfig {
  const output = clone(base)
  for (const [item, patch] of Object.entries(focus.config)) {
    const { event, modifier } = splitWatchdogItem(item)
    const fact = output[event]!
    const target = modifier ? (fact.modifiers as Record<string, Record<string, unknown>>)[modifier]! : fact
    for (const [field, value] of Object.entries(patch)) {
      const current = target[field]
      if (typeof current === 'boolean' && typeof value === 'boolean') target[field] = focus.sensitive ? current || value : current && value
      else if (Array.isArray(current) && Array.isArray(value)) target[field] = focus.sensitive ? [...new Set([...current, ...value])] : current.filter((entry) => value.includes(entry))
      else if (typeof current === 'number' && typeof value === 'number') {
        const higher = HIGHER_IS_SENSITIVE.has(field)
        target[field] = focus.sensitive === higher ? Math.max(current, value) : Math.min(current, value)
      } else target[field] = value
    }
  }
  return output
}

export class WatchdogConfigStore {
  readonly file: string
  private data: StoredWatchdogConfig

  constructor (stateDir: string) {
    this.file = join(stateDir, 'watchdog.json')
    this.data = { version: 1, type: 'base', config: {}, global: clone(WATCHDOG_GLOBAL_DEFAULTS) }
    this.load()
  }

  get base (): Record<string, Record<string, unknown>> { return clone(this.data.config) }
  get global (): StoredWatchdogConfig['global'] { return clone(this.data.global) }

  effective (scene: Record<string, Record<string, unknown>>, focuses: Map<string, FocusConfig>): WatchdogConfig {
    let output = applyLayer(cloneWatchdogDefaults(), this.data.config)
    output = applyLayer(output, scene)
    for (const focus of focuses.values()) output = applyFocus(output, focus)
    return output
  }

  editBase (input: Record<string, unknown>): { changed: string[], removed: string[], config: Record<string, Record<string, unknown>> } {
    const result = editWatchdogLayer(this.data.config, input)
    this.save()
    return { ...result, config: this.base }
  }

  editGlobal (patch: Record<string, unknown>): { ok: true, changed: string[], global: StoredWatchdogConfig['global'] } {
    const changed: string[] = []
    for (const [field, value] of Object.entries(patch)) {
      if (!Object.hasOwn(WATCHDOG_GLOBAL_DEFAULTS, field)) throw new Error(`${field} 字段不存在`)
      const valid = field === 'interruptLevel'
        ? ['never', 'llm', 'toolCall'].includes(String(value))
        : Number.isFinite(value) && Number(value) >= (field === 'minInterruptInterval' ? 10_000 : 5_000)
      if (!valid) throw new Error(`${field} 不接受值 ${JSON.stringify(value)}`)
      ;(this.data.global as unknown as Record<string, unknown>)[field] = value
      changed.push(field)
    }
    if (changed.length) this.save()
    return { ok: true, changed, global: this.global }
  }

  private load (): void {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredWatchdogConfig>
      if (parsed.version === 1 && parsed.type === 'base' && parsed.config && parsed.global) {
        this.data = { version: 1, type: 'base', config: parsed.config, global: { ...WATCHDOG_GLOBAL_DEFAULTS, ...parsed.global } }
      }
    } catch {}
  }

  private save (): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
  }
}
