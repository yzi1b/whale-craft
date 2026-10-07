// -*- coding: utf-8 -*-
/**
 * whale_craft / express-server.mjs —— 桌面模式的「发布区独立端口」托管服务
 * ============================================================================
 * 用户 2026-10-07 定：桌面版没有稳定可配的 base ⇒ 插件**自起一个只监听 localhost 的 http 服务**，
 * 直接托管 `.express/` 文件，地址 `http://localhost:<port>/<工作区uuid>/<剩余路径>`。
 *
 * 🔴 安全策略：**只绑回环**（{@link EXPRESS_HOST}）；`localhost` 在部分环境先解析到 `::1`，
 *    故尽力再补绑一个 `::1`（失败就算了，绝不改绑 0.0.0.0 之类对外地址）。
 *    另做一道最小 Host 回环栅栏（防 DNS-rebinding：外部域名解析到 127.0.0.1 也拒）。
 *
 * 出错（EADDRINUSE / EACCES…）**不抛** —— 落 `status.error`，交 UI 红字与 `mc_kit_express` 文案处理。
 * 真正的文件读写在 index.js（`serveSharedFile`）；本模块只管「起/停/探端口」这层壳。
 * ============================================================================
 */
import { createServer } from 'node:http'
import { EXPRESS_HOST } from './express.mjs'

/** 回环 IPv6（`localhost` 可能先解析到它）；尽力补绑，失败无妨。 */
const LOOPBACK_V6 = '::1'

/** Host 头是不是回环（含端口写法；IPv6 带方括号）。空 Host 视为不合法 → 拒。 */
export function hostIsLoopback (value) {
  let host = String(value ?? '').trim().toLowerCase()
  if (!host) return false
  const br = /^\[(.+)\](?::\d+)?$/.exec(host)
  if (br) host = br[1]
  else host = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** `server.listen(port, host)` 的 Promise 化（监听成功 / 出错各 settle 一次） */
function listen (server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { cleanup(); reject(err) }
    const onListening = () => { cleanup(); resolve() }
    const cleanup = () => { server.off('error', onError); server.off('listening', onListening) }
    server.once('error', onError)
    server.once('listening', onListening)
    try { server.listen(port, host) } catch (e) { cleanup(); reject(e) }
  })
}

/** 关闭一个可能没起来的 server（幂等、不抛） */
function closeQuietly (server) {
  return new Promise((resolve) => {
    try { server.close(() => resolve()) } catch { resolve() }
  })
}

/** 错误码（EADDRINUSE 之类）→ 短标记，供 UI/日志展示 */
function errorTag (e) {
  const code = String(e?.code ?? '').trim()
  if (code) return code
  return String(e?.message ?? e ?? 'unknown')
}

/** 探测端口能否在本机回环上绑定（一次性 bind + 立即 close）。返回 `true`/`false`。 */
export async function portAvailable (port) {
  const probe = createServer()
  try {
    await listen(probe, port, EXPRESS_HOST)
  } catch {
    await closeQuietly(probe)
    return false
  }
  await closeQuietly(probe)
  return true
}

/**
 * 桌面模式的发布区托管服务（生命周期由 index.js 的 `syncExpressServer` 驱动）。
 */
export class ExpressShareServer {
  /**
   * @param {{ handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void, logger?: ((msg: string) => void) | null }} opts
   */
  constructor ({ handler, logger = null } = {}) {
    this.handler = handler
    this.logger = logger
    /** 正在监听的回环 server（v4，可能加一个 v6） */
    this.servers = []
    /** 真正在监听的端口（没起来 = null） */
    this.port = null
    /** 期望监听的端口（最近一次 start 的入参；失败时仍是它） */
    this.wantPort = null
    /** 上次失败的短标记（成功后清空） */
    this.error = null
  }

  get listening () { return this.servers.length > 0 }

  /** 给 API / 工具读的状态快照 */
  get status () {
    return { listening: this.listening, port: this.port, wantPort: this.wantPort, error: this.error }
  }

  _log (msg) { try { this.logger?.(msg) } catch { /* 日志失败不影响服务 */ } }

  _wrap () {
    return createServer((req, res) => {
      if (!hostIsLoopback(req.headers?.host)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      try { this.handler(req, res) } catch (e) {
        this._log(`发布区独立端口处理失败：${e?.message ?? e}`)
        try {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('internal error')
        } catch { /* 头已发出就算了 */ }
      }
    })
  }

  /**
   * 起（或换端口重启）服务。返回是否监听成功；失败信息落在 `status.error`，**不抛**。
   * @param {number} port
   * @returns {Promise<boolean>}
   */
  async start (port) {
    this.wantPort = port
    await this.stop()
    this.error = null
    const v4 = this._wrap()
    try {
      await listen(v4, port, EXPRESS_HOST)
    } catch (e) {
      this.error = errorTag(e)
      await closeQuietly(v4)
      this.port = null
      this._log(`发布区独立端口起不来（${this.error}）：${EXPRESS_HOST}:${port}（desktop 模式，换端口或释放占用）`)
      return false
    }
    this.servers.push(v4)
    this.port = port
    // 尽力再绑 `::1`（`localhost` 可能先解析到它）；失败无妨，v4 已够本机访问
    try {
      const v6 = this._wrap()
      await listen(v6, port, LOOPBACK_V6)
      this.servers.push(v6)
    } catch { /* 没有 IPv6 回环就算了 */ }
    this._log(`发布区独立端口已监听 http://localhost:${port}（desktop 模式）`)
    return true
  }

  /** 停掉全部监听（幂等）。 */
  async stop () {
    const list = this.servers
    this.servers = []
    this.port = null
    await Promise.all(list.map((s) => closeQuietly(s)))
  }
}
