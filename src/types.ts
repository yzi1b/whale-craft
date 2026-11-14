// -*- coding: utf-8 -*-

/** 可安全穿过 DSH 工具边界的 JSON 值。 */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

/** Minecraft 世界坐标的可序列化形式；不要把 Vec3 实例放进工具返回值。 */
export interface BlockPosition {
  x: number
  y: number
  z: number
}

/** 游戏会话 ID：运行时为 16 位十六进制字符串。 */
export type GameSessionId = string

/** 看门狗队列中的稳定事件结构。 */
export interface WatchdogEvent<Content extends JsonObject = JsonObject> {
  timestamp: number
  name: string
  content: Content
  modifiers: Record<string, JsonObject | true>
}

/** DSH 工具执行时本项目实际使用到的最小上下文。 */
export interface ToolExecutionContext {
  signal?: AbortSignal
  agent?: {
    id: string
    status?: string
    session?: {
      header?: { cwd?: string }
    }
  }
}
