// -*- coding: utf-8 -*-
import type { GameSessionId } from './types.ts'

export type GameSessionCloseKind =
  | 'assistant-disconnect'
  | 'user-stop'
  | 'kicked'
  | 'connection-lost'
  | 'reconnect-failed'
  | 'archived'
  | 'runtime-shutdown'
  | 'watchdog-cancelled'
  | 'server-switch'

export type GameSessionCloseDelivery = 'wake' | 'defer'

export interface GameSessionCloseInput {
  gameSessionId: GameSessionId
  kind: GameSessionCloseKind
  reason: string
  server?: string | null
  startedAt: number
  endedAt: number
  attempts?: number | null
  lastReconnectError?: string | null
}

export interface GameSessionCloseNotice extends GameSessionCloseInput {
  delivery: GameSessionCloseDelivery
  summary: string
  text: string
}

const DEFERRED_KINDS = new Set<GameSessionCloseKind>(['archived', 'runtime-shutdown'])

export function sanitizeGameSessionCloseText (value: unknown, maxLength = 500): string {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(password|passwd|access[_-]?token|refresh[_-]?token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
  return (text || '连接结束').slice(0, maxLength)
}

function formatDuration (milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const minuteRest = minutes % 60
  return minuteRest > 0 ? `${hours} 小时 ${minuteRest} 分` : `${hours} 小时`
}

function kindText (input: GameSessionCloseInput): string {
  switch (input.kind) {
    case 'assistant-disconnect':
      return '这是你主动执行的退出。停止仍以本局在线状态为前提的子代理或后台任务；不要自行重新连接。只有用户再次要求进入服务器时，才建立新的游戏会话。向用户简短确认已经退出。'
    case 'user-stop':
      return '这是用户主动停止了游戏会话。立即停止刚才的游戏任务，不要自行重新连接，也不要把这次停止当作需要排障的异常。向用户简短确认游戏会话已经停止。'
    case 'kicked':
      return '你被服务器踢出了游戏。向用户说明服务器给出的原因；不要假装仍然在线，也不要自行反复重连。如果原因表明需要用户处理（白名单、封禁、登录冲突、认证失效等），明确告诉用户需要做什么；否则询问用户是否要重新连接。'
    case 'connection-lost':
      return 'Minecraft 连接已经异常结束，并且不会自动重连。向用户说明已知原因；不要继续执行游戏内操作。如果问题可能通过重新连接解决，询问用户是否要重新连接；如果需要用户处理，先说明处理办法。'
    case 'reconnect-failed': {
      const attempts = Number.isInteger(input.attempts) && Number(input.attempts) > 0 ? Number(input.attempts) : null
      const lastError = input.lastReconnectError ? sanitizeGameSessionCloseText(input.lastReconnectError) : null
      return `Minecraft 连接中断后，自动重连${attempts === null ? '' : ` ${attempts} 次`}仍然失败，原游戏会话已经结束。${lastError ? `最后一次已知错误：${lastError}。` : ''}不要继续执行游戏内操作，也不要再次自动发起连接；向用户说明情况并询问是否稍后手动重试。`
    }
    case 'archived':
      return '承载本次 Minecraft 游戏的对话会话正在归档，因此游戏连接和插件拥有的相关后台任务已经停止。不要重新连接，也不要继续刚才的游戏任务。'
    case 'runtime-shutdown':
      return '承载本次 Minecraft 游戏的运行实例正在关闭，因此游戏连接和事件监听已经停止。不要尝试恢复任务或自行重新连接。'
    case 'watchdog-cancelled':
      return '看门狗后台任务被停止。由于看门狗与游戏会话强绑定，游戏连接也已一并关闭。不要继续依赖旧会话状态执行操作；如果这不是预期行为，向用户说明情况并询问是否重新连接。'
    case 'server-switch':
      return '原 Minecraft 游戏会话因切换服务器而结束。新服务器使用新的游戏会话 ID；不要把旧会话的在线状态、结构化事件队列、场景或注意配置带入新会话。'
  }
}

export function buildGameSessionCloseNotice (input: GameSessionCloseInput): GameSessionCloseNotice {
  const reason = sanitizeGameSessionCloseText(input.reason)
  const server = input.server ? sanitizeGameSessionCloseText(input.server, 240) : null
  const stateText = input.kind === 'server-switch'
    ? '原游戏会话的看门狗、结构化事件队列、场景配置和注意配置均已关闭；机器人已经切换到新的连接，新连接属于新的游戏会话。'
    : '机器人连接、看门狗和本游戏会话的结构化事件队列均已关闭。建立新的游戏会话前，不要调用需要在线角色的观察或交互工具；仍可使用 mc_status、mc_connect 以及离线可用的配置或诊断工具。'
  const lines = [
    '【Minecraft 游戏会话已结束】',
    `游戏会话 ID：${input.gameSessionId}`,
    ...(server ? [`服务器：${server}`] : []),
    `持续时间：${formatDuration(input.endedAt - input.startedAt)}`,
    `原因：${reason}`,
    '',
    stateText,
    '',
    kindText({ ...input, reason, server }),
  ]
  return {
    ...input,
    reason,
    server,
    delivery: DEFERRED_KINDS.has(input.kind) ? 'defer' : 'wake',
    summary: `Minecraft 游戏会话已结束：${reason}`.slice(0, 120),
    text: lines.join('\n'),
  }
}
