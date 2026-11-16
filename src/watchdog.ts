// -*- coding: utf-8 -*-
/**
 * 游戏会话看门狗运行壳。
 *
 * 事件匹配、修饰、延迟、心跳和队列全部由 WatchdogEngine 负责；本类只负责：
 * 宿主 job、定时 tick、提醒间隔合并，以及插件 notice 投递。
 */

import { userMessage } from './user-message.mjs'
import type { WatchdogEvent } from './types.ts'

interface WatchdogAgent {
  id?: string
  status?: string
  steer?: (message: unknown) => unknown
}

interface WatchdogEngineView {
  config: Record<string, Record<string, unknown>>
  tick: (online: boolean) => void
}

interface WatchdogSession {
  agentId?: string
  bot?: { online?: boolean }
  watchdogEngine?: WatchdogEngineView | null
}

interface JobResult {
  status: string
  detail: string
  output: string
}

interface JobsService {
  start: (spec: Record<string, unknown>) => unknown
  kill: (id: string, caller: string | null, reason: string) => unknown
}

interface SessionController {
  prompt: (request: Record<string, unknown>, signal: AbortSignal) => unknown
}

interface WatchdogContext {
  get: (name: string) => unknown
}

interface WatchdogOptions {
  ctx: WatchdogContext
  sess: WatchdogSession
  agent?: WatchdogAgent | null
  promptSignal?: AbortSignal | null
  tickMs?: number
  onCancel?: ((reason: string) => void) | null
}

interface GlobalSettings {
  minInterval?: number
}

interface PendingNotice {
  event: WatchdogEvent
  count: number
}

interface LogEntry {
  at: number
  kind: string
  text: string
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

export class Watchdog {
  readonly ctx: WatchdogContext
  readonly sess: WatchdogSession
  agent: WatchdogAgent | null
  readonly onCancel: ((reason: string) => void) | null
  readonly tickMs: number
  readonly promptSignal: AbortSignal
  jobId: string | null = null
  jobOwnerId: string | null = null
  armed = false
  startedAt = 0
  tickTimer: NodeJS.Timeout | null = null
  lastWakeAt = 0
  lastWakeKind: string | null = null
  readonly stats = { fired: 0, injected: 0, dropped: 0, suppressed: 0 }
  readonly log: LogEntry[] = []
  readonly maxLog = 200
  gate: (() => boolean) | null = null
  private lastNotifyAt = 0
  private pendingNotice: PendingNotice | null = null
  private notifyTimer: NodeJS.Timeout | null = null
  private resolveJob: ((result: JobResult) => void) | null = null

  constructor ({ ctx, sess, agent = null, promptSignal = null, tickMs = 1000, onCancel = null }: WatchdogOptions) {
    this.ctx = ctx
    this.sess = sess
    this.agent = agent
    this.onCancel = typeof onCancel === 'function' ? onCancel : null
    this.tickMs = Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 1000
    this.promptSignal = promptSignal ?? new AbortController().signal
  }

  status (): Record<string, unknown> {
    return {
      armed: this.armed,
      jobId: this.jobId,
      startedAt: this.startedAt || null,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      pending: this.pendingNotice?.count ?? 0,
      lastWakeAt: this.lastWakeAt || null,
      lastWakeKind: this.lastWakeKind,
      stats: { ...this.stats },
    }
  }

  notifyEvent (event: WatchdogEvent, pendingCount = 1, global: GlobalSettings = {}): void {
    const now = Date.now()
    const minInterval = Math.max(5_000, Number(global.minInterval ?? 10_000))
    const due = Math.max(now, this.lastNotifyAt + minInterval)
    if (due > now) {
      if (this.pendingNotice) this.pendingNotice.count += pendingCount
      else this.pendingNotice = { event, count: pendingCount }
      if (!this.notifyTimer) {
        this.notifyTimer = setTimeout(() => {
          this.notifyTimer = null
          const pending = this.pendingNotice
          this.pendingNotice = null
          if (pending && this.armed) this.sendEvent(pending.event, pending.count)
        }, due - now)
        this.notifyTimer.unref()
      }
      return
    }
    this.sendEvent(event, pendingCount)
  }

  private sendEvent (event: WatchdogEvent, pendingCount: number): void {
    const extra = pendingCount > 1 ? `；另有 ${pendingCount - 1} 个事件一并到达` : ''
    this.inject(`【MC 看门狗｜${event.name}】${JSON.stringify(event.content)}${extra}\n请读取 mc_watchdog_queue 检查完整事件队列。`, event.name)
    const now = Date.now()
    this.lastNotifyAt = now
    this.lastWakeAt = now
    this.lastWakeKind = event.name
    this.stats.fired++
  }

  arm (): Record<string, unknown> {
    if (this.armed) return this.status()
    this.armed = true
    this.startedAt = Date.now()
    this.startJob()
    this.tickTimer = setInterval(() => {
      try { this.sess.watchdogEngine?.tick(Boolean(this.sess.bot?.online)) } catch (error) {
        this.record('lifecycle', `事件引擎 tick 出错：${errorText(error)}`)
      }
    }, this.tickMs)
    this.tickTimer.unref()
    const heartbeatMs = Number(this.sess.watchdogEngine?.config['harness.heartbeat']?.interval ?? 0)
    this.record('lifecycle', `看门狗已挂载（${heartbeatMs > 0 ? `心跳 ${heartbeatMs / 1000}s` : '无心跳'}）`)
    return this.status()
  }

  disarm (reason = '主动关闭', { fromJob = false }: { fromJob?: boolean } = {}): Record<string, unknown> {
    if (!this.armed) {
      this.settleJob(reason)
      return { alreadyOff: true, ...this.status() }
    }
    const jobId = this.jobId
    this.teardown(reason)
    if (jobId && !fromJob) {
      try { (this.ctx.get('jobs') as JobsService | undefined)?.kill(jobId, this.jobOwnerId ?? this.ownerId(), reason) } catch {}
    }
    this.settleJob(fromJob ? `被取消（${reason}）` : `已停止（${reason}）`)
    return { ...this.status(), reason }
  }

  private teardown (reason: string): void {
    if (!this.armed) return
    this.armed = false
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null }
    if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null }
    this.pendingNotice = null
    this.startedAt = 0
    this.record('lifecycle', `看门狗已卸载：${reason}`)
  }

  private settleJob (detail: string, status = 'killed'): void {
    const resolve = this.resolveJob
    this.resolveJob = null
    this.jobId = null
    this.jobOwnerId = null
    if (!resolve) return
    try { resolve({ status, detail, output: this.log.slice(-30).map((event) => event.text).join('\n') }) } catch {}
  }

  private ownerId (): string | null { return this.agent?.id ?? this.sess.agentId ?? null }

  private startJob (): void {
    const jobs = this.ctx.get('jobs') as JobsService | undefined
    if (!jobs) {
      this.record('lifecycle', '宿主没有 jobs 服务：看门狗以“无 job”模式运行')
      return
    }
    const ownerId = this.ownerId()
    if (!ownerId) {
      this.record('lifecycle', '拿不到会话 id：不挂无主 job，以“无 job”模式运行')
      return
    }
    try {
      this.jobOwnerId = ownerId
      this.jobId = String(jobs.start({
        kind: 'mc-watch',
        label: 'MC 看门狗（整局存活）',
        owner: ownerId,
        run: () => ({
          cancel: (value: unknown) => {
            const reason = value ? `被取消（${String(value)}）` : '被取消'
            if (this.onCancel) this.onCancel(reason)
            else this.record('lifecycle', `后台 job 请求关闭，但没有游戏会话关闭入口：${reason}`)
          },
          done: new Promise<JobResult>((resolve) => { this.resolveJob = resolve }),
          readOutput: () => {
            const text = this.log.slice(-30).map((event) => `[${new Date(event.at).toISOString().slice(11, 19)}] (${event.kind}) ${event.text}`).join('\n')
            return text || '（暂无事件）'
          },
        }),
      }))
    } catch (error) {
      this.record('lifecycle', `挂 job 失败（降级为无 job 模式）：${errorText(error)}`)
      this.jobId = null
      this.jobOwnerId = null
    }
  }

  private record (kind: string, text: string): void {
    this.log.push({ at: Date.now(), kind, text })
    if (this.log.length > this.maxLog) this.log.splice(0, this.log.length - this.maxLog)
  }

  private inject (text: string, kind: string): void {
    if (this.gate) {
      let allowed = true
      try { allowed = this.gate() !== false } catch { allowed = true }
      if (!allowed) {
        this.stats.dropped++
        this.record('lifecycle', `会话已不在 MC 模式 → 丢弃这次注入（${kind}）`)
        return
      }
    }
    const running = this.agent?.status === 'running'
    if (this.agent?.steer) {
      try {
        this.agent.steer(userMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin:whale_craft', form: 'notice', summary: `MC 看门狗：${kind}`.slice(0, 120) },
        }))
        this.stats.injected++
        this.record('lifecycle', `已注入 steer（${running ? '运行中→下一步插话' : '空闲→起一轮'}｜${kind}）`)
        return
      } catch (error) {
        this.record('lifecycle', `steer 注入失败，回退 prompt：${errorText(error)}`)
      }
    }
    const sessionController = this.ctx.get('sessionController') as SessionController | undefined
    if (!sessionController?.prompt) {
      this.record('lifecycle', `无法注入（没有 agent.steer，也没有 sessionController.prompt）：${text.slice(0, 60)}…`)
      return
    }
    const label = running ? '运行中→steer' : '空闲→拍一轮'
    try {
      const result = sessionController.prompt({
        requestId: `mc-wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId: this.agent?.id ?? this.sess.agentId,
        mode: 'steer',
        content: [{ type: 'text', text }],
      }, this.promptSignal)
      this.stats.injected++
      this.record('lifecycle', `已注入（回退 prompt｜${label}｜${kind}）`)
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        Promise.resolve(result).catch((error: unknown) => {
          this.stats.injected--
          this.record('lifecycle', `注入异步失败（${label}）：${errorText(error)}`)
        })
      }
    } catch (error) {
      this.record('lifecycle', `注入失败（${label}）：${errorText(error)}`)
    }
  }
}
